use crate::models::{AgentSummary, DaySummary, ModelSummary, RecordFilter, UsageRecord, UsageSummary};
use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, OpenFlags};
use std::collections::HashMap;
use std::path::Path;

pub struct UsageDb {
    conn: Connection,
}

#[derive(Debug, Clone, Default)]
pub struct ScanFileMeta {
    pub mtime_ms: i64,
    pub size: i64,
    #[allow(dead_code)]
    pub last_offset: i64,
}

#[allow(dead_code)]
impl UsageDb {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                agent TEXT NOT NULL,
                session_id TEXT NOT NULL,
                project TEXT,
                model TEXT NOT NULL,
                provider TEXT,
                timestamp TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL,
                source_file TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_records_agent ON records(agent);
             CREATE INDEX IF NOT EXISTS idx_records_model ON records(model);
             CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);
             CREATE INDEX IF NOT EXISTS idx_records_project ON records(project);
             CREATE INDEX IF NOT EXISTS idx_records_source ON records(source_file);
             CREATE TABLE IF NOT EXISTS scan_files (
                agent TEXT NOT NULL,
                source_file TEXT NOT NULL,
                mtime_ms INTEGER NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0,
                last_offset INTEGER NOT NULL DEFAULT 0,
                scanned_at TEXT,
                PRIMARY KEY (agent, source_file)
             );
             CREATE TABLE IF NOT EXISTS balance_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                checked_at TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                key_id TEXT NOT NULL,
                key_name TEXT NOT NULL,
                success INTEGER NOT NULL DEFAULT 0,
                available REAL,
                total REAL,
                currency TEXT,
                windows_json TEXT,
                message TEXT NOT NULL DEFAULT '',
                raw_json TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_balance_checked ON balance_snapshots(checked_at DESC);
             CREATE INDEX IF NOT EXISTS idx_balance_key ON balance_snapshots(provider_id, key_id, checked_at DESC);
            ",
        )?;
        // Repair legacy empty model labels.
        let _ = conn.execute(
            "UPDATE records SET model = '<unknown>' WHERE TRIM(model) = '' OR model IS NULL",
            [],
        );
        Ok(Self { conn })
    }

    pub fn insert_balance_snapshots(&self, results: &[crate::models::BalanceResult]) -> Result<()> {
        let checked_at = Utc::now().to_rfc3339();
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO balance_snapshots
                 (checked_at, provider_id, provider_type, key_id, key_name, success,
                  available, total, currency, windows_json, message, raw_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for r in results {
                let windows_json = serde_json::to_string(&r.windows).unwrap_or_else(|_| "[]".into());
                let raw_json = r
                    .raw
                    .as_ref()
                    .map(|v| serde_json::to_string(v).unwrap_or_default());
                stmt.execute(rusqlite::params![
                    &checked_at,
                    &r.provider_id,
                    &r.provider_type,
                    &r.key_id,
                    &r.key_name,
                    if r.success { 1i64 } else { 0i64 },
                    r.available,
                    r.total,
                    r.currency.as_deref(),
                    windows_json,
                    &r.message,
                    raw_json,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Latest snapshot per (provider_id, key_id).
    pub fn latest_balance_results(&self) -> Result<Vec<crate::models::BalanceResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT b.provider_id, b.provider_type, b.key_id, b.key_name, b.success,
                    b.available, b.total, b.currency, b.windows_json, b.message, b.raw_json, b.checked_at
             FROM balance_snapshots b
             INNER JOIN (
               SELECT provider_id, key_id, MAX(checked_at) AS max_at
               FROM balance_snapshots
               GROUP BY provider_id, key_id
             ) t ON b.provider_id = t.provider_id AND b.key_id = t.key_id AND b.checked_at = t.max_at
             ORDER BY b.provider_id, b.key_name",
        )?;
        let rows = stmt.query_map([], |row| {
            let success: i64 = row.get(4)?;
            let windows_json: String = row.get(8)?;
            let raw_json: Option<String> = row.get(10)?;
            let windows: Vec<crate::models::BalanceWindow> =
                serde_json::from_str(&windows_json).unwrap_or_default();
            let raw = raw_json.and_then(|s| serde_json::from_str(&s).ok());
            Ok(crate::models::BalanceResult {
                provider_id: row.get(0)?,
                provider_type: row.get(1)?,
                key_id: row.get(2)?,
                key_name: row.get(3)?,
                success: success != 0,
                available: row.get(5)?,
                total: row.get(6)?,
                currency: row.get(7)?,
                windows,
                message: row.get(9)?,
                raw,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn latest_balance_checked_at(&self) -> Result<Option<DateTime<Utc>>> {
        let mut stmt = self
            .conn
            .prepare("SELECT MAX(checked_at) FROM balance_snapshots")?;
        let val: Option<String> = stmt.query_row([], |row| row.get(0)).optional()?;
        Ok(val.and_then(|s| s.parse::<DateTime<Utc>>().ok()))
    }

    pub fn clear_agent(&self, agent: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM records WHERE agent = ?1", [agent])?;
        self.conn
            .execute("DELETE FROM scan_files WHERE agent = ?1", [agent])?;
        Ok(())
    }

    pub fn clear_all(&self) -> Result<()> {
        self.conn.execute("DELETE FROM records", [])?;
        self.conn.execute("DELETE FROM scan_files", [])?;
        Ok(())
    }

    pub fn delete_by_source(&self, agent: &str, source_file: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM records WHERE agent = ?1 AND source_file = ?2",
            rusqlite::params![agent, source_file],
        )?;
        Ok(())
    }

    /// Remove records whose source_file is no longer present in `keep`.
    pub fn prune_missing_sources(&self, agent: &str, keep: &std::collections::HashSet<String>) -> Result<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT source_file FROM records WHERE agent = ?1 AND source_file != ''",
        )?;
        let existing: Vec<String> = stmt
            .query_map([agent], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut removed = 0usize;
        for src in existing {
            if !keep.contains(&src) {
                self.delete_by_source(agent, &src)?;
                self.conn.execute(
                    "DELETE FROM scan_files WHERE agent = ?1 AND source_file = ?2",
                    rusqlite::params![agent, src],
                )?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    pub fn get_scan_file(&self, agent: &str, source_file: &str) -> Result<Option<ScanFileMeta>> {
        let mut stmt = self.conn.prepare(
            "SELECT mtime_ms, size, last_offset FROM scan_files WHERE agent = ?1 AND source_file = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![agent, source_file])?;
        if let Some(row) = rows.next()? {
            Ok(Some(ScanFileMeta {
                mtime_ms: row.get::<_, i64>(0)?,
                size: row.get::<_, i64>(1)?,
                last_offset: row.get::<_, i64>(2)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn upsert_scan_file(
        &self,
        agent: &str,
        source_file: &str,
        mtime_ms: i64,
        size: i64,
        last_offset: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO scan_files (agent, source_file, mtime_ms, size, last_offset, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(agent, source_file) DO UPDATE SET
               mtime_ms = excluded.mtime_ms,
               size = excluded.size,
               last_offset = excluded.last_offset,
               scanned_at = excluded.scanned_at",
            rusqlite::params![
                agent,
                source_file,
                mtime_ms,
                size,
                last_offset,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn insert_record(&self, record: &UsageRecord) -> Result<()> {
        let model = if record.model.trim().is_empty() {
            "<unknown>"
        } else {
            record.model.as_str()
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO records
             (id, agent, session_id, project, model, provider, timestamp,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              reasoning_tokens, cost_usd, source_file)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                &record.id,
                &record.agent,
                &record.session_id,
                record.project.as_deref().unwrap_or(""),
                model,
                record.provider.as_deref().unwrap_or(""),
                &record.timestamp.to_rfc3339(),
                record.input_tokens as i64,
                record.output_tokens as i64,
                record.cache_read_tokens as i64,
                record.cache_creation_tokens as i64,
                record.reasoning_tokens as i64,
                record.cost_usd,
                &record.source_file,
            ],
        )?;
        Ok(())
    }

    /// One-shot cleanup for already-imported empty model names.
    pub fn normalize_empty_models(&self) -> Result<usize> {
        let n = self.conn.execute(
            "UPDATE records SET model = '<unknown>' WHERE TRIM(model) = '' OR model IS NULL",
            [],
        )?;
        Ok(n)
    }

    pub fn total_record_count(&self) -> Result<u64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))?;
        Ok(n as u64)
    }

    /// Stream all records for cost recalculation.
    pub fn for_each_record<F>(&self, mut f: F) -> Result<usize>
    where
        F: FnMut(&UsageRecord) -> Result<()>,
    {
        let mut stmt = self.conn.prepare(
            "SELECT id, agent, session_id, project, model, provider, timestamp,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    reasoning_tokens, cost_usd, source_file
             FROM records",
        )?;
        let rows = stmt.query_map([], parse_record)?;
        let mut n = 0usize;
        for row in rows {
            let rec = row?;
            f(&rec)?;
            n += 1;
        }
        Ok(n)
    }

    pub fn update_cost(&self, id: &str, cost: Option<f64>) -> Result<()> {
        self.conn.execute(
            "UPDATE records SET cost_usd = ?1 WHERE id = ?2",
            rusqlite::params![cost, id],
        )?;
        Ok(())
    }

    pub fn begin_tx(&self) -> Result<()> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        Ok(())
    }

    pub fn commit_tx(&self) -> Result<()> {
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }

    pub fn rollback_tx(&self) -> Result<()> {
        let _ = self.conn.execute_batch("ROLLBACK");
        Ok(())
    }

    pub fn insert_records(&self, records: &[UsageRecord]) -> Result<()> {
        for record in records {
            self.insert_record(record)?;
        }
        Ok(())
    }

    pub fn get_records(
        &self,
        filter: &RecordFilter,
        limit: u64,
        offset: u64,
    ) -> Result<Vec<UsageRecord>> {
        let (where_sql, params) = build_filter_sql(filter);
        // Use only anonymous `?` placeholders — never mix with `?1`/`?2`, which
        // would collide with earlier filter binds and break LIMIT/OFFSET.
        let query = format!(
            "SELECT id, agent, session_id, project, model, provider, timestamp,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    reasoning_tokens, cost_usd, source_file
             FROM records
             {where_sql}
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?"
        );

        let mut stmt = self.conn.prepare(&query)?;
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = params
            .into_iter()
            .map(|p| Box::new(p) as Box<dyn rusqlite::ToSql>)
            .collect();
        values.push(Box::new(limit as i64));
        values.push(Box::new(offset as i64));
        let refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();

        let rows = stmt.query_map(refs.as_slice(), parse_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Distinct models for filter dropdowns (optionally scoped by other filters except model).
    pub fn list_models(&self, filter: &RecordFilter) -> Result<Vec<String>> {
        let mut f = filter.clone();
        f.models = None;
        let (where_sql, params) = build_filter_sql(&f);
        let sql = format!(
            "SELECT DISTINCT model FROM records {where_sql} ORDER BY model COLLATE NOCASE"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> =
            params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_projects(&self, filter: &RecordFilter) -> Result<Vec<String>> {
        let mut f = filter.clone();
        f.project = None;
        let (where_sql, params) = build_filter_sql(&f);
        let where_extra = if where_sql.is_empty() {
            "WHERE project IS NOT NULL AND project != ''".to_string()
        } else {
            format!("{where_sql} AND project IS NOT NULL AND project != ''")
        };
        let sql = format!(
            "SELECT DISTINCT project FROM records {where_extra} ORDER BY project COLLATE NOCASE"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> =
            params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_summary(&self, filter: &RecordFilter) -> Result<UsageSummary> {
        let (where_sql, params) = build_filter_sql(filter);

        let total_sql = format!(
            "SELECT
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_creation_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cost_usd), 0),
                COUNT(*),
                COUNT(DISTINCT session_id)
             FROM records {where_sql}"
        );

        let mut stmt = self.conn.prepare(&total_sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let (total_input, total_output, total_cache_read, total_cache_creation, total_reasoning, total_cost, records, sessions) = stmt.query_row(param_refs.as_slice(), |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, f64>(5)?,
                row.get::<_, i64>(6)? as u64,
                row.get::<_, i64>(7)? as u64,
            ))
        })?;

        let mut summary = UsageSummary {
            total_input,
            total_output,
            total_cache_read,
            total_cache_creation,
            total_reasoning,
            total_cost_usd: total_cost,
            sessions,
            records,
            by_agent: HashMap::new(),
            by_model: HashMap::new(),
            by_day: HashMap::new(),
        };

        summary.by_agent = self.group_by_agent(filter)?;
        summary.by_model = self.group_by_model(filter)?;
        summary.by_day = self.group_by_day(filter)?;

        Ok(summary)
    }

    pub fn count_records(&self, filter: &RecordFilter) -> Result<u64> {
        let (where_sql, params) = build_filter_sql(filter);
        let sql = format!("SELECT COUNT(*) FROM records {where_sql}");
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let count = stmt.query_row(param_refs.as_slice(), |row| row.get::<_, i64>(0))?;
        Ok(count as u64)
    }

    fn group_by_agent(&self, filter: &RecordFilter) -> Result<HashMap<String, AgentSummary>> {
        let (where_sql, params) = build_filter_sql(filter);
        let sql = format!(
            "SELECT agent,
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0),
                    COALESCE(SUM(cache_creation_tokens), 0),
                    COALESCE(SUM(reasoning_tokens), 0),
                    COALESCE(SUM(cost_usd), 0),
                    COUNT(*)
             FROM records {where_sql}
             GROUP BY agent"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)? as u64,
                row.get::<_, f64>(6)?,
                row.get::<_, i64>(7)? as u64,
            ))
        })?;

        let mut map = HashMap::new();
        for row in rows {
            let (agent, input, output, cache_read, cache_creation, reasoning, cost, count) = row?;
            map.insert(
                agent.clone(),
                AgentSummary {
                    agent,
                    total_input: input,
                    total_output: output,
                    total_cache_read: cache_read,
                    total_cache_creation: cache_creation,
                    total_reasoning: reasoning,
                    total_cost_usd: cost,
                    records: count,
                },
            );
        }
        Ok(map)
    }

    fn group_by_model(&self, filter: &RecordFilter) -> Result<HashMap<String, ModelSummary>> {
        let (where_sql, params) = build_filter_sql(filter);
        // Aggregate by model only. Grouping by (model, provider) and then keying the
        // HashMap by model alone used to drop all but one provider slice — e.g.
        // grok-4.5/zai (5 rows) overwrote grok-4.5/opencode-go (263 rows).
        let sql = format!(
            "SELECT model,
                    CASE
                      WHEN COUNT(DISTINCT provider) = 1 THEN MIN(provider)
                      ELSE NULL
                    END,
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0),
                    COALESCE(SUM(cache_creation_tokens), 0),
                    COALESCE(SUM(reasoning_tokens), 0),
                    COALESCE(SUM(cost_usd), 0),
                    COUNT(*)
             FROM records {where_sql}
             GROUP BY model"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)? as u64,
                row.get::<_, i64>(6)? as u64,
                row.get::<_, f64>(7)?,
                row.get::<_, i64>(8)? as u64,
            ))
        })?;

        let mut map = HashMap::new();
        for row in rows {
            let (model, provider, input, output, cache_read, cache_creation, reasoning, cost, count) = row?;
            map.insert(
                model.clone(),
                ModelSummary {
                    model,
                    provider,
                    total_input: input,
                    total_output: output,
                    total_cache_read: cache_read,
                    total_cache_creation: cache_creation,
                    total_reasoning: reasoning,
                    total_cost_usd: cost,
                    records: count,
                },
            );
        }
        Ok(map)
    }

    fn group_by_day(&self, filter: &RecordFilter) -> Result<HashMap<String, DaySummary>> {
        let (where_sql, params) = build_filter_sql(filter);
        let sql = format!(
            "SELECT substr(timestamp, 1, 10) as day,
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0),
                    COALESCE(SUM(cache_creation_tokens), 0),
                    COALESCE(SUM(reasoning_tokens), 0),
                    COALESCE(SUM(cost_usd), 0),
                    COUNT(*)
             FROM records {where_sql}
             GROUP BY day"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
                row.get::<_, i64>(4)? as u64,
                row.get::<_, i64>(5)? as u64,
                row.get::<_, f64>(6)?,
                row.get::<_, i64>(7)? as u64,
            ))
        })?;

        let mut map = HashMap::new();
        for row in rows {
            let (day, input, output, cache_read, cache_creation, reasoning, cost, count) = row?;
            map.insert(
                day.clone(),
                DaySummary {
                    day,
                    total_input: input,
                    total_output: output,
                    total_cache_read: cache_read,
                    total_cache_creation: cache_creation,
                    total_reasoning: reasoning,
                    total_cost_usd: cost,
                    records: count,
                },
            );
        }
        Ok(map)
    }
}

fn build_filter_sql(filter: &RecordFilter) -> (String, Vec<String>) {
    let mut conditions = Vec::new();
    let mut params = Vec::new();

    if let Some(agents) = &filter.agents {
        if !agents.is_empty() {
            let placeholders: Vec<String> = (0..agents.len()).map(|_| "?".to_string()).collect();
            conditions.push(format!("agent IN ({})", placeholders.join(", ")));
            params.extend(agents.iter().cloned());
        }
    }

    if let Some(models) = &filter.models {
        if !models.is_empty() {
            let placeholders: Vec<String> = (0..models.len()).map(|_| "?".to_string()).collect();
            conditions.push(format!("model IN ({})", placeholders.join(", ")));
            params.extend(models.iter().cloned());
        }
    }

    if let Some(from) = filter.from {
        conditions.push("timestamp >= ?".to_string());
        params.push(from.to_rfc3339());
    }

    if let Some(to) = filter.to {
        conditions.push("timestamp <= ?".to_string());
        params.push(to.to_rfc3339());
    }

    if let Some(proj) = &filter.project {
        if !proj.is_empty() {
            conditions.push("project LIKE ?".to_string());
            params.push(format!("%{}%", proj));
        }
    }

    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    (where_sql, params)
}

fn parse_u64(row: &rusqlite::Row, idx: usize) -> Result<u64, rusqlite::Error> {
    match row.get::<_, Option<i64>>(idx) {
        Ok(Some(n)) => Ok(n.max(0) as u64),
        Ok(None) => Ok(0),
        Err(_) => {
            let s: Option<String> = row.get(idx)?;
            Ok(s.and_then(|v| v.parse::<u64>().ok()).unwrap_or(0))
        }
    }
}

fn parse_f64(row: &rusqlite::Row, idx: usize) -> Result<Option<f64>, rusqlite::Error> {
    match row.get::<_, Option<f64>>(idx) {
        Ok(c) => Ok(c.filter(|v| *v != 0.0)),
        Err(_) => {
            let s: Option<String> = row.get(idx)?;
            Ok(s.and_then(|v| v.parse::<f64>().ok()).filter(|v| *v != 0.0))
        }
    }
}

fn parse_record(row: &rusqlite::Row) -> Result<UsageRecord, rusqlite::Error> {
    let cost = parse_f64(row, 12)?;
    let ts: String = row.get(6)?;
    Ok(UsageRecord {
        id: row.get(0)?,
        agent: row.get(1)?,
        session_id: row.get(2)?,
        project: {
            let p: Option<String> = row.get(3)?;
            p.filter(|s| !s.is_empty())
        },
        provider: {
            let p: Option<String> = row.get(5)?;
            p.filter(|s| !s.is_empty())
        },
        model: row.get(4)?,
        timestamp: ts.parse::<DateTime<Utc>>().unwrap_or_else(|_| Utc::now()),
        input_tokens: parse_u64(row, 7)?,
        output_tokens: parse_u64(row, 8)?,
        cache_read_tokens: parse_u64(row, 9)?,
        cache_creation_tokens: parse_u64(row, 10)?,
        reasoning_tokens: parse_u64(row, 11)?,
        cost_usd: cost,
        source_file: row.get(13)?,
    })
}
