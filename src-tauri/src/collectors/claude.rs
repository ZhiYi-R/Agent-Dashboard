use super::{normalize_model, plan_and_open_jsonl, resolve_path, Collector, FilePlanner};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use walkdir::WalkDir;

pub struct ClaudeCollector;

impl Collector for ClaudeCollector {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn name(&self) -> &'static str {
        "Claude Code"
    }
    fn default_path(&self) -> Option<String> {
        Some("~/.claude/projects".to_string())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> Result<()> {
        let base = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("Claude Code path not configured and default not found")?;
        let base = PathBuf::from(base);
        if !base.exists() {
            return Ok(());
        }

        for entry in WalkDir::new(&base)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
            })
        {
            let session_id = entry
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let project = entry
                .path()
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().into_owned());
            let source_file = entry.path().to_string_lossy().into_owned();

            let Some((file, _mtime, _size, _offset, _full)) =
                plan_and_open_jsonl(entry.path(), planner)?
            else {
                continue;
            };

            let reader = BufReader::new(file);
            let mut seen = HashSet::new();

            for line in reader.lines() {
                let line = match line {
                    Ok(l) if l.trim().is_empty() => continue,
                    Ok(l) => l,
                    Err(_) => continue,
                };
                let Ok(val): Result<Value, _> = serde_json::from_str(&line) else {
                    continue;
                };

                if val.get("type").and_then(|v| v.as_str()) != Some("assistant") {
                    continue;
                }

                let message_id = val
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if message_id.is_empty() || !seen.insert(message_id.clone()) {
                    continue;
                }

                let model = val
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|v| v.as_str())
                    .map(normalize_model)
                    .unwrap_or_default();

                let usage = val.get("message").and_then(|m| m.get("usage"));
                let input = usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output = usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read = usage
                    .and_then(|u| u.get("cache_read_input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = usage
                    .and_then(|u| u.get("cache_creation_input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let ts = val
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(Utc::now);

                let mut rec = UsageRecord {
                    id: format!("claude:{}:{}", session_id, message_id),
                    agent: "claude".to_string(),
                    session_id: session_id.clone(),
                    project: project.clone(),
                    model,
                    provider: Some("anthropic".to_string()),
                    timestamp: ts,
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_creation_tokens: cache_creation,
                    reasoning_tokens: 0,
                    cost_usd: None,
                    source_file: source_file.clone(),
                };
                rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                sink(rec)?;
            }
        }

        Ok(())
    }
}
