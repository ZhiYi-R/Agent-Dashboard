use super::{ensure_model, resolve_path, should_scan_source, Collector, FilePlanner};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use anyhow::Context;
use chrono::{TimeZone, Utc};
use rusqlite::OpenFlags;

pub struct ZCodeCollector;

impl Collector for ZCodeCollector {
    fn id(&self) -> &'static str {
        "zcode"
    }
    fn name(&self) -> &'static str {
        "ZCode"
    }
    fn default_path(&self) -> Option<String> {
        Some("~/.zcode/cli/db/db.sqlite".to_string())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let path = resolve_path(&settings.agent(self.id()), self.default_path().as_deref())
            .context("ZCode db path not configured and default not found")?;
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
            "SELECT mu.id, mu.session_id, mu.model_id, mu.input_tokens, mu.output_tokens,
                    mu.reasoning_tokens, mu.cache_creation_input_tokens, mu.cache_read_input_tokens,
                    mu.started_at, mu.completed_at, s.directory
             FROM model_usage mu
             LEFT JOIN session s ON s.id = mu.session_id",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })?;

        for row in rows {
            let (
                id,
                session_id,
                model_id,
                input,
                output,
                reasoning,
                cache_creation,
                cache_read,
                started,
                completed,
                dir,
            ) = row?;

            // In ZCode, input_tokens includes cache read/creation. Back them out for fresh input.
            let fresh_input = (input - cache_creation - cache_read).max(0) as u64;

            let ts_ms = completed.unwrap_or(started);
            let ts = Utc
                .timestamp_millis_opt(ts_ms)
                .single()
                .unwrap_or_else(Utc::now);

            let mut rec = UsageRecord {
                id: format!("zcode:{}", id),
                agent: "zcode".to_string(),
                session_id,
                project: dir,
                model: ensure_model(model_id.clone()),
                provider: Some("zai".to_string()),
                timestamp: ts,
                input_tokens: fresh_input as u64,
                output_tokens: output as u64,
                cache_read_tokens: cache_read as u64,
                cache_creation_tokens: cache_creation as u64,
                reasoning_tokens: reasoning as u64,
                cost_usd: None,
                source_file: path.clone(),
            };
            rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
            sink(rec)?;
        }

        Ok(())
    }
}
