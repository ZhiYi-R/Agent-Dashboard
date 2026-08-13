use super::{ensure_model, home_dir, plan_and_open_jsonl, resolve_path, Collector, FilePlanner};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;
use chrono::{TimeZone, Utc};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub struct KimiCollector;

impl Collector for KimiCollector {
    fn id(&self) -> &'static str {
        "kimi"
    }
    fn name(&self) -> &'static str {
        "Kimi Code"
    }
    fn default_path(&self) -> Option<String> {
        Some("~/.kimi-code/sessions".to_string())
    }

    fn collect(
        &self,
        settings: &AppSettings,
        prices: &PriceCache,
        sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        let agent = settings.agent(self.id());
        let custom = agent
            .path
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .and_then(|raw| resolve_path(&agent, Some(raw)));

        let roots = if let Some(custom) = custom {
            vec![PathBuf::from(custom)]
        } else {
            default_session_roots()
        };

        // Resolve display names / config table keys → real model ids.
        // Only reads [models.*] (+ secondary_model); never keeps api_key values.
        let model_catalog = load_kimi_model_catalog(&roots);

        let mut project_map = HashMap::<String, String>::new();
        let mut seen_sources = HashSet::<String>::new();

        for root in roots {
            if !root.exists() {
                continue;
            }

            // session_index.jsonl lives next to the sessions directory
            if let Some(home) = root.parent() {
                load_session_index(home, &mut project_map);
            }

            for entry in walkdir::WalkDir::new(&root)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file() && is_wire_jsonl(e.path()))
            {
                let path = entry.path();
                let source_file = path.to_string_lossy().into_owned();
                // Dedup when the same tree is reachable via multiple roots/symlinks.
                let source_key = normalize_source_key(&source_file);
                if !seen_sources.insert(source_key) {
                    continue;
                }

                let session_id = extract_session_id(path).unwrap_or_else(|| {
                    path.parent()
                        .and_then(|p| p.file_name())
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "unknown".to_string())
                });
                let agent_name = extract_agent_name(path).unwrap_or_else(|| "main".to_string());
                let project = project_map
                    .get(&session_id)
                    .cloned()
                    .or_else(|| infer_project_from_path(path));

                let Some((file, _mtime, _size, _offset, _full)) =
                    plan_and_open_jsonl(path, planner)?
                else {
                    continue;
                };
                let reader = BufReader::new(file);
                let mut line_no: u64 = 0;

                for line in reader.lines() {
                    line_no += 1;
                    let line = match line {
                        Ok(l) if l.trim().is_empty() => continue,
                        Ok(l) => l,
                        Err(_) => continue,
                    };
                    let Ok(val): Result<Value, _> = serde_json::from_str(&line) else {
                        continue;
                    };

                    let Some(parsed) = parse_kimi_usage(&val) else {
                        continue;
                    };

                    let model_raw = parsed.model_raw.clone().unwrap_or_default();
                    let resolved = model_catalog.resolve(&model_raw);
                    let model = ensure_model(resolved.model_id);
                    let provider = resolved
                        .provider
                        .or_else(|| Some(guess_provider(&Some(model.clone()))));
                    let ts = parsed.timestamp.unwrap_or_else(Utc::now);

                    let mut rec = UsageRecord {
                        id: format!(
                            "kimi:{}:{}:{}:{}",
                            session_id,
                            agent_name,
                            ts.timestamp_millis(),
                            line_no
                        ),
                        agent: "kimi".to_string(),
                        session_id: session_id.clone(),
                        project: project.clone(),
                        model,
                        provider,
                        timestamp: ts,
                        input_tokens: parsed.input_tokens,
                        output_tokens: parsed.output_tokens,
                        cache_read_tokens: parsed.cache_read_tokens,
                        cache_creation_tokens: parsed.cache_creation_tokens,
                        reasoning_tokens: parsed.reasoning_tokens,
                        cost_usd: None,
                        source_file: source_file.clone(),
                    };
                    rec.cost_usd = prices.cost_for(&rec, &settings.model_overrides);
                    sink(rec)?;
                }
            }
        }

        Ok(())
    }
}

struct ParsedUsage {
    model_raw: Option<String>,
    timestamp: Option<chrono::DateTime<Utc>>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    reasoning_tokens: u64,
}

/// Modern Kimi Code `usage.record` (top-level) + optional payload wrap + legacy StatusUpdate.
fn parse_kimi_usage(val: &Value) -> Option<ParsedUsage> {
    let ty = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if ty == "usage.record" {
        // Prefer top-level (current wire format). Fall back to payload for older builds.
        let scope = val
            .get("usageScope")
            .or_else(|| val.get("payload").and_then(|p| p.get("usageScope")))
            .and_then(|v| v.as_str());
        // Only count turn-scoped usage. `session` is a cumulative snapshot and would double-count.
        // Missing scope is treated as turn for forward/backward compatibility.
        if matches!(scope, Some("session")) {
            return None;
        }

        let usage = val
            .get("usage")
            .or_else(|| val.get("payload").and_then(|p| p.get("usage")))?;
        let model = val
            .get("model")
            .or_else(|| val.get("payload").and_then(|p| p.get("model")))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let ts = parse_timestamp(val).or_else(|| val.get("payload").and_then(parse_timestamp));

        return Some(tokens_from_usage(usage, model, ts));
    }

    if ty == "StatusUpdate" || ty == "status_update" {
        let payload = val.get("payload").unwrap_or(val);
        let usage = payload
            .get("token_usage")
            .or_else(|| payload.get("usage"))
            .or_else(|| val.get("token_usage"))?;
        let model = payload
            .get("model")
            .or_else(|| val.get("model"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let ts = parse_timestamp(val).or_else(|| parse_timestamp(payload));
        return Some(tokens_from_usage(usage, model, ts));
    }

    None
}

fn tokens_from_usage(
    usage: &Value,
    model: Option<String>,
    timestamp: Option<chrono::DateTime<Utc>>,
) -> ParsedUsage {
    let u64_field = |keys: &[&str]| -> u64 {
        for k in keys {
            if let Some(v) = usage.get(*k).and_then(|v| v.as_u64()) {
                return v;
            }
            if let Some(v) = usage.get(*k).and_then(|v| v.as_f64()) {
                return v.max(0.0) as u64;
            }
            if let Some(v) = usage.get(*k).and_then(|v| v.as_i64()) {
                return v.max(0) as u64;
            }
        }
        0
    };

    // Modern: inputOther / inputCacheRead / inputCacheCreation / output
    // Legacy snake_case: input_other / input_cache_read / input_cache_creation
    // Also accept common aliases if present.
    let input_tokens = u64_field(&[
        "inputOther",
        "input_other",
        "input",
        "input_tokens",
        "prompt_tokens",
    ]);
    let output_tokens = u64_field(&["output", "output_tokens", "completion_tokens"]);
    let cache_read_tokens = u64_field(&[
        "inputCacheRead",
        "input_cache_read",
        "cache_read",
        "cache_read_tokens",
    ]);
    let cache_creation_tokens = u64_field(&[
        "inputCacheCreation",
        "input_cache_creation",
        "cache_creation",
        "cache_write",
        "cache_write_tokens",
    ]);
    let reasoning_tokens = u64_field(&["reasoning", "reasoning_tokens", "thinking"]);

    ParsedUsage {
        model_raw: model,
        timestamp,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        reasoning_tokens,
    }
}

fn parse_timestamp(val: &Value) -> Option<chrono::DateTime<Utc>> {
    if let Some(ms) = val.get("time").and_then(|v| v.as_i64()) {
        return Utc.timestamp_millis_opt(ms).single();
    }
    if let Some(ms) = val.get("time").and_then(|v| v.as_f64()) {
        return Utc.timestamp_millis_opt(ms as i64).single();
    }
    // Some older events use seconds as float under "timestamp"
    if let Some(ts) = val.get("timestamp").and_then(|v| v.as_f64()) {
        if ts > 1e12 {
            return Utc.timestamp_millis_opt(ts as i64).single();
        }
        return Utc.timestamp_millis_opt((ts * 1000.0) as i64).single();
    }
    if let Some(ms) = val.get("timestamp").and_then(|v| v.as_i64()) {
        if ms > 1_000_000_000_000 {
            return Utc.timestamp_millis_opt(ms).single();
        }
        return Utc.timestamp_opt(ms, 0).single();
    }
    None
}

fn is_wire_jsonl(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("wire.jsonl"))
        .unwrap_or(false)
}

/// Prefer `session_<uuid>` path segment; fall back to parent-of-agents uuid dir (legacy).
fn extract_session_id(path: &Path) -> Option<String> {
    let mut comps: Vec<String> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
        .collect();
    // Drop the filename
    if comps
        .last()
        .map(|s| s.eq_ignore_ascii_case("wire.jsonl"))
        .unwrap_or(false)
    {
        comps.pop();
    }

    for c in comps.iter().rev() {
        if c.starts_with("session_") {
            return Some(c.clone());
        }
    }

    // Legacy: ~/.kimi/sessions/<hash>/<uuid>/wire.jsonl
    // After dropping wire.jsonl, last is uuid, previous may be hash.
    if let Some(last) = comps.last() {
        if looks_like_uuid(last) {
            return Some(last.clone());
        }
    }
    None
}

fn extract_agent_name(path: &Path) -> Option<String> {
    // .../agents/<name>/wire.jsonl
    let mut iter = path.components().rev();
    let _file = iter.next()?;
    let agent = iter.next()?.as_os_str().to_str()?.to_string();
    let agents_dir = iter.next()?.as_os_str().to_str()?;
    if agents_dir.eq_ignore_ascii_case("agents") {
        return Some(agent);
    }
    None
}

fn looks_like_uuid(s: &str) -> bool {
    let s = s.trim();
    if s.len() != 36 {
        return false;
    }
    let b = s.as_bytes();
    b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
}

fn load_session_index(home: &Path, map: &mut HashMap<String, String>) {
    let index = home.join("session_index.jsonl");
    let Ok(file) = std::fs::File::open(&index) else {
        return;
    };
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val): Result<Value, _> = serde_json::from_str(&line) else {
            continue;
        };
        let Some(sid) = val.get("sessionId").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some(wd) = val.get("workDir").and_then(|v| v.as_str()) {
            if !wd.trim().is_empty() {
                map.insert(sid.to_string(), normalize_workdir(wd));
            }
        }
    }
}

fn normalize_workdir(wd: &str) -> String {
    // Prefer forward slashes for stable display; keep drive letters.
    wd.replace('\\', "/")
}

/// When index is missing, use workspace folder name from `wd_<name>_<hash>`.
fn infer_project_from_path(path: &Path) -> Option<String> {
    for c in path.components() {
        if let Some(s) = c.as_os_str().to_str() {
            if let Some(rest) = s.strip_prefix("wd_") {
                // wd_agentstatistics_9f6e2e4e2ef2 → agentstatistics
                if let Some((name, _hash)) = rest.rsplit_once('_') {
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
                return Some(rest.to_string());
            }
        }
    }
    None
}

fn guess_provider(model: &Option<String>) -> String {
    let Some(m) = model.as_deref() else {
        return "moonshotai".to_string();
    };
    let lower = m.to_ascii_lowercase();
    if lower.contains("moonshot") || lower.starts_with("kimi-code") || lower.starts_with("kimi/") {
        return "moonshotai".to_string();
    }
    if let Some((provider, _)) = m.split_once('/') {
        if !provider.is_empty() {
            // managed:kimi-code → moonshotai-ish
            if provider.starts_with("managed:") {
                return "moonshotai".to_string();
            }
            return provider.to_string();
        }
    }
    "moonshotai".to_string()
}

#[derive(Debug, Clone, Default)]
struct ResolvedModel {
    model_id: String,
    provider: Option<String>,
}

#[derive(Debug, Default)]
struct KimiModelCatalog {
    /// lowercase alias → (canonical model id, provider)
    by_alias: HashMap<String, (String, Option<String>)>,
    secondary_model: Option<String>,
}

impl KimiModelCatalog {
    fn resolve(&self, raw: &str) -> ResolvedModel {
        let raw = raw.trim();
        if raw.is_empty() {
            return ResolvedModel {
                model_id: String::new(),
                provider: None,
            };
        }

        // Built-in secondary agent marker → secondary_model.model (often a table key)
        if raw == "__secondary__" {
            if let Some(sec) = &self.secondary_model {
                return self.resolve(sec);
            }
            return ResolvedModel {
                model_id: raw.to_string(),
                provider: None,
            };
        }

        let key = normalize_alias(raw);
        if let Some((id, prov)) = self.by_alias.get(&key) {
            return ResolvedModel {
                model_id: id.clone(),
                provider: prov
                    .clone()
                    .or_else(|| Some(guess_provider(&Some(id.clone())))),
            };
        }

        // Unconfigured provider/model table-key style: keep short model id if possible
        if let Some((prov, mid)) = raw.split_once('/') {
            if !prov.is_empty() && !mid.is_empty() {
                return ResolvedModel {
                    model_id: mid.to_string(),
                    provider: Some(prov.to_string()),
                };
            }
        }

        ResolvedModel {
            model_id: raw.to_string(),
            provider: Some(guess_provider(&Some(raw.to_string()))),
        }
    }

    fn insert_alias(&mut self, alias: &str, model_id: &str, provider: Option<String>) {
        let alias = alias.trim();
        let model_id = model_id.trim();
        if alias.is_empty() || model_id.is_empty() {
            return;
        }
        // First write wins so earlier configs aren't clobbered by later ones
        // for the same alias; still allow same alias → same id re-insert.
        let k = normalize_alias(alias);
        if let Some((existing, _)) = self.by_alias.get(&k) {
            if existing != model_id {
                return;
            }
        }
        self.by_alias.insert(k, (model_id.to_string(), provider));
    }
}

fn normalize_alias(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

/// Homes that may contain `config.toml` (never logs secret values).
fn kimi_config_paths(session_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut push = |p: PathBuf| {
        if p.as_os_str().is_empty() {
            return;
        }
        let key = normalize_source_key(&p.to_string_lossy());
        if paths
            .iter()
            .any(|e: &PathBuf| normalize_source_key(&e.to_string_lossy()) == key)
        {
            return;
        }
        paths.push(p);
    };

    if let Ok(home) = std::env::var("KIMI_CODE_HOME") {
        let home = home.trim();
        if !home.is_empty() {
            push(PathBuf::from(home).join("config.toml"));
        }
    }
    if let Some(h) = home_dir() {
        push(h.join(".kimi-code").join("config.toml"));
        push(h.join(".kimi").join("config.toml"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            push(PathBuf::from(appdata).join("Kimi Code").join("config.toml"));
        }
    }
    // config.toml next to any session root we scan
    for root in session_roots {
        if let Some(home) = root.parent() {
            push(home.join("config.toml"));
        }
    }
    paths
}

fn load_kimi_model_catalog(session_roots: &[PathBuf]) -> KimiModelCatalog {
    let mut catalog = KimiModelCatalog::default();
    for path in kimi_config_paths(session_roots) {
        if !path.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        merge_kimi_config_models(&text, &mut catalog);
    }
    catalog
}

/// Parse only model-related tables from Kimi `config.toml`.
/// Intentionally ignores providers' `api_key` / oauth secrets — we never store them.
fn merge_kimi_config_models(text: &str, catalog: &mut KimiModelCatalog) {
    let mut section = String::new();
    // pending model table fields
    let mut table_key: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut display_name: Option<String> = None;

    let flush = |catalog: &mut KimiModelCatalog,
                 table_key: &mut Option<String>,
                 provider: &mut Option<String>,
                 model: &mut Option<String>,
                 display_name: &mut Option<String>| {
        let Some(tk) = table_key.take() else {
            *provider = None;
            *model = None;
            *display_name = None;
            return;
        };
        let prov = provider.take();
        let mid = model.take();
        let disp = display_name.take();

        // Kimi config shape:
        //   [models."moonshot_api/k3-256k"]  ← table key / config name
        //   provider = "moonshot_api"
        //   model = "k3-256k"                ← real Model ID
        //   display_name = "K3 256K"         ← UI name
        // Wire often stores table key or display_name; we map those → model field.
        let model_id = if let Some(m) = mid.as_ref() {
            m.clone()
        } else if let Some((_, after)) = tk.split_once('/') {
            after.to_string()
        } else {
            tk.clone()
        };

        let prov_out = prov
            .clone()
            .or_else(|| tk.split_once('/').map(|(p, _)| p.to_string()));

        // Aliases that should resolve to the Model ID
        catalog.insert_alias(&tk, &model_id, prov_out.clone());
        catalog.insert_alias(&model_id, &model_id, prov_out.clone());
        if let (Some(p), Some(m)) = (prov.as_ref(), mid.as_ref()) {
            catalog.insert_alias(&format!("{p}/{m}"), &model_id, prov_out.clone());
        }
        if let Some(d) = disp.as_ref() {
            catalog.insert_alias(d, &model_id, prov_out);
        }
    };

    for raw in text.lines() {
        let line = strip_toml_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }

        if let Some(sec) = parse_toml_table_header(&line) {
            flush(
                catalog,
                &mut table_key,
                &mut provider,
                &mut model,
                &mut display_name,
            );
            section = sec;
            if let Some(key) = section.strip_prefix("models.") {
                table_key = Some(unquote_toml_key(key));
                provider = None;
                model = None;
                display_name = None;
            } else {
                table_key = None;
            }
            continue;
        }

        let Some((key, value)) = parse_toml_key_value(&line) else {
            continue;
        };
        let key_l = key.to_ascii_lowercase();

        // Never retain secret material
        if is_secret_toml_key(&key_l) {
            continue;
        }

        if section == "secondary_model" && key_l == "model" {
            if let Some(v) = parse_toml_string_value(&value) {
                catalog.secondary_model = Some(v);
            }
            continue;
        }

        if table_key.is_some() {
            match key_l.as_str() {
                "provider" => provider = parse_toml_string_value(&value),
                "model" => model = parse_toml_string_value(&value),
                "display_name" => display_name = parse_toml_string_value(&value),
                _ => {}
            }
        }
    }
    flush(
        catalog,
        &mut table_key,
        &mut provider,
        &mut model,
        &mut display_name,
    );
}

fn is_secret_toml_key(key: &str) -> bool {
    key.contains("api_key")
        || key.contains("apikey")
        || key == "key"
        || key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("credential")
        || key == "reasoning_key" // not a model id; skip
}

fn strip_toml_comment(line: &str) -> String {
    // naive: split on # not inside quotes
    let mut out = String::with_capacity(line.len());
    let mut in_str = false;
    let mut quote = '\0';
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == quote {
                in_str = false;
            }
            continue;
        }
        if c == '"' || c == '\'' {
            in_str = true;
            quote = c;
            out.push(c);
            continue;
        }
        if c == '#' {
            break;
        }
        out.push(c);
    }
    out
}

fn parse_toml_table_header(line: &str) -> Option<String> {
    let line = line.trim();
    if line.starts_with("[[") {
        // array of tables — ignore for models
        return None;
    }
    if let Some(inner) = line.strip_prefix('[')?.strip_suffix(']') {
        return Some(inner.trim().to_string());
    }
    None
}

fn unquote_toml_key(key: &str) -> String {
    let key = key.trim();
    // models."Grok 4.5" or models.foo
    if let Some(rest) = key.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        return rest.replace("\\\"", "\"");
    }
    if let Some(rest) = key.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        return rest.to_string();
    }
    // dotted bare key already stripped to last segment? keep full
    key.to_string()
}

fn parse_toml_key_value(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.starts_with('[') {
        return None;
    }
    let eq = line.find('=')?;
    let key = line[..eq].trim().to_string();
    let value = line[eq + 1..].trim().to_string();
    if key.is_empty() {
        return None;
    }
    Some((key, value))
}

fn parse_toml_string_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        let inner = &value[1..value.len() - 1];
        return Some(inner.replace("\\\"", "\"").replace("\\\\", "\\"));
    }
    // bare
    if value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false") {
        return None;
    }
    Some(value.to_string())
}

fn normalize_source_key(s: &str) -> String {
    let mut out = s.replace('\\', "/");
    // Windows path case-insensitive
    if cfg!(windows) {
        out = out.to_ascii_lowercase();
    }
    out
}

fn default_session_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push_unique = |p: PathBuf| {
        if p.as_os_str().is_empty() {
            return;
        }
        let key = normalize_source_key(&p.to_string_lossy());
        if roots
            .iter()
            .any(|existing: &PathBuf| normalize_source_key(&existing.to_string_lossy()) == key)
        {
            return;
        }
        roots.push(p);
    };

    // KIMI_CODE_HOME override (official env)
    if let Ok(home) = std::env::var("KIMI_CODE_HOME") {
        let home = home.trim();
        if !home.is_empty() {
            push_unique(PathBuf::from(home).join("sessions"));
        }
    }

    if let Some(h) = home_dir() {
        // Modern CLI home
        push_unique(h.join(".kimi-code").join("sessions"));
        // Legacy kimi-cli
        push_unique(h.join(".kimi").join("sessions"));
    }

    // Desktop / migrated install on Windows
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            push_unique(PathBuf::from(appdata).join("Kimi Code").join("sessions"));
        }
    }
    if let Some(h) = home_dir() {
        // Non-Windows-ish fallback for "Roaming/Kimi Code"
        push_unique(
            h.join("AppData")
                .join("Roaming")
                .join("Kimi Code")
                .join("sessions"),
        );
    }

    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_modern_top_level_turn() {
        let v = json!({
            "type": "usage.record",
            "model": "opencode-go/deepseek-v4-flash",
            "usage": {
                "inputOther": 100,
                "output": 20,
                "inputCacheRead": 50,
                "inputCacheCreation": 0
            },
            "usageScope": "turn",
            "time": 1785948130441i64
        });
        let p = parse_kimi_usage(&v).expect("parse");
        assert_eq!(p.input_tokens, 100);
        assert_eq!(p.output_tokens, 20);
        assert_eq!(p.cache_read_tokens, 50);
        assert_eq!(
            p.model_raw.as_deref(),
            Some("opencode-go/deepseek-v4-flash")
        );
    }

    #[test]
    fn skips_session_scope() {
        let v = json!({
            "type": "usage.record",
            "model": "x",
            "usage": { "inputOther": 1, "output": 1 },
            "usageScope": "session",
            "time": 1
        });
        assert!(parse_kimi_usage(&v).is_none());
    }

    #[test]
    fn extracts_session_and_agent() {
        let p = PathBuf::from("sessions")
            .join("wd_foo_abc")
            .join("session_e4e2aab9-0ec6-4887-9880-cac6c72ff01c")
            .join("agents")
            .join("main")
            .join("wire.jsonl");
        assert_eq!(
            extract_session_id(&p).as_deref(),
            Some("session_e4e2aab9-0ec6-4887-9880-cac6c72ff01c")
        );
        assert_eq!(extract_agent_name(&p).as_deref(), Some("main"));
    }

    #[test]
    fn resolves_display_name_and_secondary_from_config() {
        let toml = r#"
default_model = "Grok 4.5"

[providers.Grok]
type = "openai"
api_key = "sk-SHOULD-NOT-BE-STORED"
base_url = "https://example.com/v1"

[models."Grok 4.5"]
provider = "Grok"
model = "grok-4.5"
display_name = "Grok 4.5"

[models."moonshot_api/k3-256k"]
provider = "moonshot_api"
model = "k3-256k"
display_name = "K3 256K"

[models."opencode-go/deepseek-v4-flash"]
provider = "opencode-go"
model = "deepseek-v4-flash"
display_name = "DeepSeek V4 Flash (New)"

[models."opencode-go/hy3"]
provider = "opencode-go"
model = "hy3"
display_name = "Hy3"

[secondary_model]
model = "opencode-go/hy3"
"#;
        let mut cat = KimiModelCatalog::default();
        merge_kimi_config_models(toml, &mut cat);

        // table key / display_name → model field (Model ID)
        let r = cat.resolve("Grok 4.5");
        assert_eq!(r.model_id, "grok-4.5");
        assert_eq!(r.provider.as_deref(), Some("Grok"));

        let r = cat.resolve("moonshot_api/k3-256k");
        assert_eq!(r.model_id, "k3-256k");
        assert_eq!(r.provider.as_deref(), Some("moonshot_api"));

        let r = cat.resolve("K3 256K");
        assert_eq!(r.model_id, "k3-256k");

        let r = cat.resolve("DeepSeek V4 Flash (New)");
        assert_eq!(r.model_id, "deepseek-v4-flash");
        assert_eq!(r.provider.as_deref(), Some("opencode-go"));

        // secondary points at table key → Model ID
        let r = cat.resolve("__secondary__");
        assert_eq!(r.model_id, "hy3");
        assert_eq!(r.provider.as_deref(), Some("opencode-go"));

        // already a table key
        let r = cat.resolve("opencode-go/deepseek-v4-flash");
        assert_eq!(r.model_id, "deepseek-v4-flash");

        // already the model field
        let r = cat.resolve("k3-256k");
        assert_eq!(r.model_id, "k3-256k");

        // secret must not appear in catalog aliases
        let blob = format!("{:?}", cat.by_alias);
        assert!(!blob.contains("SHOULD-NOT-BE-STORED"));
        assert!(!blob.contains("sk-"));
    }
}
