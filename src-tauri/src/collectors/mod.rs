use crate::models::{AgentSettings, AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Result;

pub mod claude;
pub mod codex;
pub mod kimi;
pub mod opencode;
pub mod zcode;
pub mod zed;

/// Whether a source file should be scanned (and how).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileScanPlan {
    /// Unchanged since last scan — skip entirely.
    Skip,
    /// Read only bytes after last_offset (append-only jsonl).
    Tail { offset: u64 },
    /// Re-parse the whole file (and caller should delete old rows for this source).
    Full,
}

/// Callback used by collectors to ask the scan engine about a file.
/// Returns how to process it. Collectors that only have a single DB path
/// can ignore this and always emit records (engine still upserts by id).
pub type FilePlanner<'a> = dyn FnMut(&str, u64, u64) -> FileScanPlan + 'a;

pub trait Collector: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn default_path(&self) -> Option<String>;
    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> Result<()>;
    fn agent_settings<'a>(&self, settings: &'a AppSettings) -> crate::models::AgentSettings {
        settings.agent(self.id())
    }
}

/// Ask the planner whether `path` needs scanning (no file open).
/// Returns `true` if the file should be processed (Full/Tail), `false` if Skip.
pub fn should_scan_source(path: &std::path::Path, planner: &mut FilePlanner<'_>) -> Result<bool> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();
    let source = path.to_string_lossy().into_owned();
    Ok(!matches!(
        planner(&source, mtime_ms, size),
        FileScanPlan::Skip
    ))
}

/// Helper for jsonl collectors: open file according to plan.
pub fn plan_and_open_jsonl(
    path: &std::path::Path,
    planner: &mut FilePlanner<'_>,
) -> Result<Option<(std::fs::File, u64, u64, u64, bool)>> {
    let meta = std::fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();
    let source = path.to_string_lossy().into_owned();
    let plan = planner(&source, mtime_ms, size);
    match plan {
        FileScanPlan::Skip => Ok(None),
        FileScanPlan::Full => {
            let f = std::fs::File::open(path)?;
            Ok(Some((f, mtime_ms, size, 0, true)))
        }
        FileScanPlan::Tail { offset } => {
            let mut f = std::fs::File::open(path)?;
            if offset > 0 && offset <= size {
                let start = rewind_to_line_start(&mut f, offset)?;
                Ok(Some((f, mtime_ms, size, start, false)))
            } else {
                // offset invalid / truncated -> full
                Ok(Some((f, mtime_ms, size, 0, true)))
            }
        }
    }
}

fn rewind_to_line_start(file: &mut std::fs::File, offset: u64) -> Result<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let mut pos = offset;
    let mut byte = [0u8; 1];
    while pos > 0 {
        pos -= 1;
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            let start = pos + 1;
            file.seek(SeekFrom::Start(start))?;
            return Ok(start);
        }
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "agent-statistics-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn tail_rewinds_to_incomplete_line_start() {
        let path = temp_file("tail", b"complete\npartial-rest\n");
        let offset = b"complete\npartial".len() as u64;
        let mut planner = |_: &str, _: u64, _: u64| FileScanPlan::Tail { offset };
        let (mut file, _, _, start, full) =
            plan_and_open_jsonl(&path, &mut planner).unwrap().unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(start, b"complete\n".len() as u64);
        assert!(!full);
        assert_eq!(contents, "partial-rest\n");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_tail_offset_falls_back_to_full_scan() {
        let path = temp_file("tail-full", b"complete\n");
        let mut planner = |_: &str, _: u64, _: u64| FileScanPlan::Tail { offset: 99 };
        let (mut file, _, _, start, full) =
            plan_and_open_jsonl(&path, &mut planner).unwrap().unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(start, 0);
        assert!(full);
        assert_eq!(contents, "complete\n");
        std::fs::remove_file(path).unwrap();
    }
}

pub fn complete_jsonl_offset(path: &std::path::Path, size: u64) -> u64 {
    use std::io::{Read, Seek, SeekFrom};

    if size == 0 || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return size;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return size;
    };
    let mut remaining = size;
    let mut buffer = vec![0u8; 8192];
    while remaining > 0 {
        let chunk_size = remaining.min(buffer.len() as u64) as usize;
        remaining -= chunk_size as u64;
        if file.seek(SeekFrom::Start(remaining)).is_err()
            || file.read_exact(&mut buffer[..chunk_size]).is_err()
        {
            return size;
        }
        if let Some(index) = buffer[..chunk_size].iter().rposition(|byte| *byte == b'\n') {
            return remaining + index as u64 + 1;
        }
    }
    0
}

pub fn all_collectors() -> Vec<Box<dyn Collector>> {
    vec![
        Box::new(claude::ClaudeCollector),
        Box::new(codex::CodexCollector),
        Box::new(zcode::ZCodeCollector),
        Box::new(opencode::OpenCodeCollector),
        Box::new(kimi::KimiCollector),
        Box::new(zed::ZedCollector),
    ]
}

pub fn resolve_path(settings: &AgentSettings, default: Option<&str>) -> Option<String> {
    let raw = settings
        .path
        .clone()
        .filter(|p| !p.trim().is_empty())
        .or_else(|| default.map(|s| s.to_string()))?;
    Some(expand_path(&raw).unwrap_or(raw))
}

pub fn home_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().or_else(|| {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(std::path::PathBuf::from)
            .ok()
    })
}

pub fn expand_path(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }

    // Expand leading environment variables like %LOCALAPPDATA%\... or %LOCALAPPDATA%/...
    let first = path.split("\\").next().or_else(|| path.split('/').next())?;
    if first.starts_with('%') && first.ends_with('%') && first.len() > 2 {
        let var = &first[1..first.len() - 1];
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                let rest = path.strip_prefix(first)?;
                let rest = rest
                    .strip_prefix("\\")
                    .or_else(|| rest.strip_prefix('/'))
                    .unwrap_or(rest);
                return Some(
                    std::path::Path::new(&val)
                        .join(rest)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }

    // Expand ~/ or ~\ to home directory
    if path.starts_with("~/") || path.starts_with("~\\") {
        let rest = &path[2..];
        return home_dir().map(|h| h.join(rest).to_string_lossy().into_owned());
    }

    Some(path.to_string())
}

pub fn normalize_model(model: &str) -> String {
    let t = model.trim();
    if t.is_empty() {
        "<unknown>".to_string()
    } else {
        t.to_string()
    }
}

/// Ensure non-empty model label before insert.
pub fn ensure_model(model: String) -> String {
    if model.trim().is_empty() {
        "<unknown>".to_string()
    } else {
        model
    }
}
