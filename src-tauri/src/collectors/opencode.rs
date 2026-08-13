use super::{ensure_model, home_dir, resolve_path, should_scan_source, Collector, FilePlanner};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Context;
use chrono::{TimeZone, Utc};
use rusqlite::OpenFlags;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct OpenCodeCollector;

impl Collector for OpenCodeCollector {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn name(&self) -> &'static str {
        "OpenCode"
    }
    fn default_path(&self) -> Option<String> {
        opencode_db_path().map(|path| path.to_string_lossy().into_owned())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let path = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("OpenCode db path not configured and default not found")?;
        if !std::path::Path::new(&path).exists() {
            return Ok(());
        }
        if !should_scan_source(std::path::Path::new(&path), planner)? {
            return Ok(());
        }

        let conn = rusqlite::Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        // Try the v2 session table with pre-aggregated token columns
        if conn
            .prepare("SELECT id, directory, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session")
            .is_ok()
        {
            let mut stmt = conn.prepare(
                "SELECT id, directory, title, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated FROM session",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            })?;

            for row in rows {
                let (id, directory, _title, model_json, input, output, reasoning, cache_read, cache_write, _created, updated) =
                    row?;

                let (model, provider) = parse_model_json(model_json.as_deref());
                let ts = Utc.timestamp_millis_opt(updated).single().unwrap_or_else(Utc::now);

                let mut rec = UsageRecord {
                    id: format!("opencode:{}", id),
                    agent: "opencode".to_string(),
                    session_id: id,
                    project: directory,
                    model: ensure_model(model),
                    provider,
                    timestamp: ts,
                    input_tokens: input as u64,
                    output_tokens: output as u64,
                    cache_read_tokens: cache_read as u64,
                    cache_creation_tokens: cache_write as u64,
                    reasoning_tokens: reasoning as u64,
                    cost_usd: None,
                    source_file: path.clone(),
                };
                rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                sink(rec)?;
            }
        }

        Ok(())
    }
}

fn opencode_db_path() -> Option<PathBuf> {
    opencode_data_dir().map(|dir| dir.join("opencode").join("opencode.db"))
}

fn opencode_data_dir() -> Option<PathBuf> {
    let xdg_data_home = std::env::var_os("XDG_DATA_HOME");
    let home = home_dir();
    opencode_data_dir_from(xdg_data_home.as_deref().map(Path::new), home.as_deref())
}

fn opencode_data_dir_from(xdg_data_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    xdg_data_home
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| home.map(|path| path.join(".local").join("share")))
}

fn parse_model_json(json: Option<&str>) -> (String, Option<String>) {
    let Some(s) = json else {
        return (String::new(), None);
    };
    let Ok(val) = serde_json::from_str::<Value>(s) else {
        return (s.to_string(), None);
    };
    let provider = val
        .get("providerID")
        .or_else(|| val.get("provider"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model = val
        .get("id")
        .or_else(|| val.get("model"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    (model, provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_custom_xdg_data_home() {
        let path = opencode_data_dir_from(
            Some(Path::new("/custom/data")),
            Some(Path::new("/home/tester")),
        );
        assert_eq!(path, Some(PathBuf::from("/custom/data")));
    }

    #[test]
    fn falls_back_to_home_local_share() {
        let path = opencode_data_dir_from(None, Some(Path::new("/home/tester")));
        assert_eq!(path, Some(PathBuf::from("/home/tester/.local/share")));
    }

    #[test]
    fn ignores_empty_xdg_data_home() {
        let path = opencode_data_dir_from(Some(Path::new("")), Some(Path::new("/home/tester")));
        assert_eq!(path, Some(PathBuf::from("/home/tester/.local/share")));
    }
}
