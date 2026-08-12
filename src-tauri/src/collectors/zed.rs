use super::{ensure_model, should_scan_source, Collector, FilePlanner, resolve_path};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Context;
use chrono::{DateTime, Utc};
use rusqlite::OpenFlags;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

pub struct ZedCollector;

impl Collector for ZedCollector {
    fn id(&self) -> &'static str {
        "zed"
    }
    fn name(&self) -> &'static str {
        "Zed Agent"
    }
    fn default_path(&self) -> Option<String> {
        Some(if cfg!(windows) {
            "%LOCALAPPDATA%\\Zed\\threads\\threads.db".to_string()
        } else if cfg!(target_os = "macos") {
            "~/Library/Application Support/Zed/threads/threads.db".to_string()
        } else {
            "~/.local/share/zed/threads/threads.db".to_string()
        })
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let path = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("Zed db path not configured and default not found")?;
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

        let mut stmt = conn.prepare(
            "SELECT id, summary, updated_at, data_type, data FROM threads",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        })?;

        for row in rows {
            let (id, summary, updated_at, data_type, data) = row?;

            let bytes = match data_type.as_deref() {
                Some("zstd") => match zstd::decode_all(data.as_slice()) {
                    Ok(b) => b,
                    Err(_) => continue,
                },
                // legacy uncompressed json rows
                Some("json") | None => data,
                _ => data,
            };

            let Ok(thread_val): Result<Value, _> = serde_json::from_slice(&bytes) else {
                continue;
            };

            let ts = DateTime::parse_from_rfc3339(&updated_at)
                .map(|d| d.with_timezone(&Utc))
                .or_else(|_| {
                    thread_val
                        .get("updated_at")
                        .and_then(|v| v.as_str())
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.with_timezone(&Utc))
                        .ok_or(())
                })
                .unwrap_or_else(|_| Utc::now());

            let (provider, model) = parse_model(&thread_val);
            let project = summary
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    thread_val
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });

            // Per-request map (preferred). Cache fields may be omitted when zero.
            let mut sum_input = 0u64;
            let mut sum_output = 0u64;
            let mut sum_cache_read = 0u64;
            let mut sum_cache_creation = 0u64;
            let mut emitted = 0usize;

            let request_map = thread_val
                .get("request_token_usage")
                .or_else(|| thread_val.get("requestTokenUsage"))
                .and_then(|v| v.as_object());

            if let Some(map) = request_map {
                for (request_id, usage_val) in map {
                    let usage = parse_token_usage(usage_val);
                    if usage.is_empty() {
                        continue;
                    }
                    sum_input = sum_input.saturating_add(usage.input_tokens);
                    sum_output = sum_output.saturating_add(usage.output_tokens);
                    sum_cache_read = sum_cache_read.saturating_add(usage.cache_read_tokens);
                    sum_cache_creation =
                        sum_cache_creation.saturating_add(usage.cache_creation_tokens);
                    emitted += 1;

                    let mut rec = UsageRecord {
                        id: format!("zed:{}:{}", id, request_id),
                        agent: "zed".to_string(),
                        session_id: id.clone(),
                        project: project.clone(),
                        model: ensure_model(model.clone()),
                        provider: provider.clone(),
                        timestamp: ts,
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_read_tokens: usage.cache_read_tokens,
                        cache_creation_tokens: usage.cache_creation_tokens,
                        reasoning_tokens: usage.reasoning_tokens,
                        cost_usd: None,
                        source_file: path.clone(),
                    };
                    rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                    sink(rec)?;
                }
            }

            // request_token_usage is keyed by user message and often under-counts tool
            // rounds. Top up with cumulative - sum(request) remainder when present.
            let cumulative = thread_val
                .get("cumulative_token_usage")
                .or_else(|| thread_val.get("cumulativeTokenUsage"))
                .map(parse_token_usage)
                .unwrap_or_default();

            if !cumulative.is_empty() {
                let rem_input = cumulative.input_tokens.saturating_sub(sum_input);
                let rem_output = cumulative.output_tokens.saturating_sub(sum_output);
                let rem_cr = cumulative
                    .cache_read_tokens
                    .saturating_sub(sum_cache_read);
                let rem_cc = cumulative
                    .cache_creation_tokens
                    .saturating_sub(sum_cache_creation);
                let rem_reason = cumulative.reasoning_tokens; // not tracked in request sum

                if rem_input > 0
                    || rem_output > 0
                    || rem_cr > 0
                    || rem_cc > 0
                    || (emitted == 0 && rem_reason > 0)
                {
                    let mut rec = UsageRecord {
                        id: format!("zed:{}:cumulative-remainder", id),
                        agent: "zed".to_string(),
                        session_id: id.clone(),
                        project: project.clone(),
                        model: ensure_model(model.clone()),
                        provider: provider.clone(),
                        timestamp: ts,
                        input_tokens: if emitted == 0 {
                            cumulative.input_tokens
                        } else {
                            rem_input
                        },
                        output_tokens: if emitted == 0 {
                            cumulative.output_tokens
                        } else {
                            rem_output
                        },
                        cache_read_tokens: if emitted == 0 {
                            cumulative.cache_read_tokens
                        } else {
                            rem_cr
                        },
                        cache_creation_tokens: if emitted == 0 {
                            cumulative.cache_creation_tokens
                        } else {
                            rem_cc
                        },
                        reasoning_tokens: if emitted == 0 {
                            cumulative.reasoning_tokens
                        } else {
                            rem_reason
                        },
                        cost_usd: None,
                        source_file: path.clone(),
                    };
                    // When we already emitted requests, only attach remainder deltas.
                    if emitted > 0 {
                        rec.reasoning_tokens = 0;
                    }
                    rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                    sink(rec)?;
                }
            }
        }

        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct TokenUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    reasoning_tokens: u64,
}

impl TokenUsage {
    fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_creation_tokens == 0
            && self.reasoning_tokens == 0
    }
}

fn u64_field(v: &Value, keys: &[&str]) -> u64 {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(|x| x.as_u64()) {
            return n;
        }
        if let Some(n) = v.get(*k).and_then(|x| x.as_i64()) {
            return n.max(0) as u64;
        }
        if let Some(n) = v.get(*k).and_then(|x| x.as_f64()) {
            return n.max(0.0) as u64;
        }
    }
    0
}

/// Flexible parse: snake_case / camelCase / OpenAI-style aliases.
/// Zero-valued cache fields are often omitted by Zed serialization.
fn parse_token_usage(v: &Value) -> TokenUsage {
    if !v.is_object() {
        return TokenUsage::default();
    }
    TokenUsage {
        input_tokens: u64_field(
            v,
            &[
                "input_tokens",
                "inputTokens",
                "prompt_tokens",
                "promptTokens",
            ],
        ),
        output_tokens: u64_field(
            v,
            &[
                "output_tokens",
                "outputTokens",
                "completion_tokens",
                "completionTokens",
            ],
        ),
        cache_read_tokens: u64_field(
            v,
            &[
                "cache_read_input_tokens",
                "cacheReadInputTokens",
                "cache_read_tokens",
                "cacheReadTokens",
                "cached_input_tokens",
                "cachedInputTokens",
                "cached_tokens",
                "cachedTokens",
            ],
        ),
        cache_creation_tokens: u64_field(
            v,
            &[
                "cache_creation_input_tokens",
                "cacheCreationInputTokens",
                "cache_creation_tokens",
                "cacheCreationTokens",
                "cache_write_tokens",
                "cacheWriteTokens",
                "cache_write_input_tokens",
                "cacheWriteInputTokens",
            ],
        ),
        reasoning_tokens: u64_field(
            v,
            &[
                "reasoning_tokens",
                "reasoningTokens",
                "reasoning_output_tokens",
                "reasoningOutputTokens",
            ],
        ),
    }
}

fn parse_model(thread: &Value) -> (Option<String>, String) {
    let model_obj = thread.get("model");
    let provider = model_obj
        .and_then(|m| m.get("provider"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            model_obj
                .and_then(|m| m.get("provider_id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });
    let model = model_obj
        .and_then(|m| {
            m.get("model")
                .or_else(|| m.get("id"))
                .or_else(|| m.get("name"))
        })
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    (provider, model)
}

// Keep Deserialize types for potential future strict parse; silence unused warning.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
struct _ZedThreadLegacy {
    #[serde(default)]
    model: HashMap<String, Value>,
}
