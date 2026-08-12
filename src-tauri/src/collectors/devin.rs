use super::{ensure_model, should_scan_source, Collector, FilePlanner, resolve_path};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Context;
use chrono::{TimeZone, Utc};
use rusqlite::OpenFlags;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub struct DevinCollector;

impl Collector for DevinCollector {
    fn id(&self) -> &'static str {
        "devin"
    }
    fn name(&self) -> &'static str {
        "Devin CLI"
    }
    fn default_path(&self) -> Option<String> {
        Some("~/.local/share/devin/cli".to_string())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let base = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("Devin path not configured and default not found")?;
        let base = PathBuf::from(base);
        if !base.exists() {
            return Ok(());
        }
        // Treat sessions.db as the primary watermark for the whole agent tree.
        let db_path = base.join("sessions.db");
        if db_path.exists() {
            if !should_scan_source(&db_path, planner)? {
                return Ok(());
            }
        }

        // Load session metadata from sessions.db
        let mut sessions = HashMap::new();
        let db_path = base.join("sessions.db");
        if db_path.exists() {
            if let Ok(conn) = rusqlite::Connection::open_with_flags(
                &db_path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                let mut stmt = conn.prepare(
                    "SELECT id, working_directory, model, title, created_at, last_activity_at, hidden FROM sessions",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                })?;
                for row in rows {
                    let (id, wd, model, title, created, last, hidden) = row?;
                    if hidden.unwrap_or(0) == 1 {
                        continue;
                    }
                    sessions.insert(id, (wd, model, title, created, last));
                }
            }
        }

        let transcripts_dir = base.join("transcripts");
        if !transcripts_dir.exists() {
            return Ok(());
        }

        for entry in fs::read_dir(&transcripts_dir)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }

            let session_id = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();

            let data = fs::read_to_string(&path)?;
            let Ok(transcript): Result<Value, _> = serde_json::from_str(&data) else { continue };

            let agent_model = transcript
                .get("agent")
                .and_then(|a| a.get("model_name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();

            let (project, fallback_model, _title, _created, _last) = sessions
                .get(&session_id)
                .cloned()
                .unwrap_or((None, None, None, None, None));

            let steps = transcript.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();

            for step in steps {
                if step
                    .get("metadata")
                    .and_then(|m| m.get("is_user_input"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }

                let metrics = step
                    .get("metrics")
                    .or_else(|| step.get("metadata").and_then(|m| m.get("metrics")))
                    .cloned()
                    .unwrap_or_default();

                let input = metrics
                    .get("prompt_tokens")
                    .or_else(|| metrics.get("input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output = metrics
                    .get("completion_tokens")
                    .or_else(|| metrics.get("output_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_read = metrics
                    .get("cached_tokens")
                    .or_else(|| metrics.get("cache_read_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = metrics
                    .get("extra")
                    .and_then(|e| e.get("cache_creation_input_tokens"))
                    .or_else(|| metrics.get("cache_creation_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let acu_cost = step
                    .get("metadata")
                    .and_then(|m| m.get("committed_acu_cost"))
                    .or_else(|| step.get("extra").and_then(|e| e.get("committed_acu_cost")))
                    .and_then(|v| v.as_f64())
                    .filter(|v| v.is_finite() && *v >= 0.0);

                if input == 0 && output == 0 && acu_cost.is_none() {
                    continue;
                }

                let model = step
                    .get("metadata")
                    .and_then(|m| m.get("generation_model"))
                    .or_else(|| step.get("extra").and_then(|e| e.get("generation_model")))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty() && s != "adaptive")
                    .unwrap_or_else(|| fallback_model.clone().unwrap_or_else(|| agent_model.clone()));

                let ts = step
                    .get("metadata")
                    .and_then(|m| m.get("created_at"))
                    .or_else(|| step.get("extra").and_then(|e| e.get("created_at")))
                    .and_then(|v| v.as_i64())
                    .and_then(|ms| Utc.timestamp_millis_opt(ms).single())
                    .unwrap_or_else(Utc::now);

                let step_id = step
                    .get("step_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let cost = None;

                let mut rec = UsageRecord {
                    id: format!("devin:{}:{}", session_id, step_id),
                    agent: "devin".to_string(),
                    session_id: session_id.clone(),
                    project: project.clone(),
                    model: ensure_model(model),
                    provider: Some("devin".to_string()),
                    timestamp: ts,
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_creation_tokens: cache_creation,
                    reasoning_tokens: 0,
                    cost_usd: None,
                    source_file: path.to_string_lossy().into_owned(),
                };

                // Compute cost from catalog if token metrics present
                rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides).or(cost);
                sink(rec)?;
            }
        }

        Ok(())
    }
}
