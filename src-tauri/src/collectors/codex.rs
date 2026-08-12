use super::{
    ensure_model, plan_and_open_jsonl, Collector, FilePlanner, normalize_model, resolve_path,
};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Context;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

pub struct CodexCollector;

impl Collector for CodexCollector {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn name(&self) -> &'static str {
        "OpenAI Codex"
    }
    fn default_path(&self) -> Option<String> {
        Some("~/.codex/sessions".to_string())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let base = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("Codex path not configured and default not found")?;
        let base = PathBuf::from(base);
        if !base.exists() {
            return Ok(());
        }

        for entry in walkdir::WalkDir::new(&base)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && e.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
                    && e.path()
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.starts_with("rollout-"))
                        .unwrap_or(false)
            })
        {
            let session_id = entry
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
                .replace("rollout-", "");
            let source_file = entry.path().to_string_lossy().into_owned();

            let Some((file, _mtime, _size, _offset, _full)) =
                plan_and_open_jsonl(entry.path(), planner)?
            else {
                continue;
            };
            let reader = BufReader::new(file);

            let mut cwd: Option<String> = None;
            let mut current_model = String::new();
            let mut provider = String::from("openai");
            let mut seen = HashSet::new();

            for line in reader.lines() {
                let line = match line {
                    Ok(l) if l.trim().is_empty() => continue,
                    Ok(l) => l,
                    Err(_) => continue,
                };
                let Ok(val): Result<Value, _> = serde_json::from_str(&line) else { continue };

                let ts = val
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(Utc::now);

                match val.get("type").and_then(|v| v.as_str()) {
                    Some("session_meta") => {
                        if let Some(payload) = val.get("payload") {
                            cwd = payload.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
                            provider = payload
                                .get("model_provider")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "openai".to_string());
                        }
                    }
                    Some("turn_context") => {
                        if let Some(payload) = val.get("payload") {
                            current_model = payload
                                .get("model")
                                .and_then(|v| v.as_str())
                                .map(normalize_model)
                                .unwrap_or_default();
                        }
                    }
                    Some("event_msg") => {
                        let Some(payload) = val.get("payload") else { continue };
                        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                            continue;
                        }
                        let Some(info) = payload.get("info") else { continue };
                        let Some(last) = info.get("last_token_usage") else { continue };

                        // Deduplicate by turn-ish key: session + timestamp + model
                        let dedupe = format!("{}:{}", ts.to_rfc3339(), current_model);
                        if !seen.insert(dedupe) {
                            continue;
                        }

                        // Codex / OpenAI semantics:
                        //   input_tokens = full prompt size (fresh + cached)
                        //   cached_input_tokens ⊆ input_tokens
                        // Pricing subtracts cache_read from input for "fresh" billing.
                        let input = last
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let output = last
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let cache_read = last
                            .get("cached_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0)
                            .min(input);
                        let reasoning = last
                            .get("reasoning_output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);

                        let mut rec = UsageRecord {
                            id: format!("codex:{}:{}", session_id, ts.timestamp_millis()),
                            agent: "codex".to_string(),
                            session_id: session_id.clone(),
                            project: cwd.clone(),
                            model: ensure_model(current_model.clone()),
                            provider: Some(provider.clone()),
                            timestamp: ts,
                            input_tokens: input,
                            output_tokens: output,
                            cache_read_tokens: cache_read,
                            cache_creation_tokens: 0,
                            reasoning_tokens: reasoning,
                            cost_usd: None,
                            source_file: source_file.clone(),
                        };
                        rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                        sink(rec)?;
                    }
                    _ => {}
                }
            }
        }

        Ok(())
    }
}
