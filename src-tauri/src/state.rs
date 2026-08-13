use crate::collectors::{all_collectors, resolve_path};
use crate::db::UsageDb;
use crate::models::{AgentDef, AgentSettings, AppSettings};
use crate::pricing::PriceCache;
use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub db_path: PathBuf,
    pub price_cache: Arc<Mutex<PriceCache>>,
    pub settings: Arc<Mutex<AppSettings>>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self> {
        let data_dir = app.path().app_data_dir()?;
        let db_path = data_dir.join("usage.db");
        let _db = UsageDb::open(&db_path)?;

        let price_path = data_dir.join("prices.json");
        let price_cache = if price_path.exists() {
            PriceCache::load(&price_path)?
        } else {
            let cache = PriceCache::load(&price_path)?; // falls back to bundled
            cache.save(&price_path)?;
            cache
        };

        let settings = load_settings(&data_dir.join("settings.json"))?;

        Ok(Self {
            db_path,
            price_cache: Arc::new(Mutex::new(price_cache)),
            settings: Arc::new(Mutex::new(settings)),
        })
    }
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

pub fn load_settings(path: &std::path::Path) -> Result<AppSettings> {
    if !path.exists() {
        return Ok(default_settings());
    }
    let data = std::fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(default_settings());
    }
    Ok(serde_json::from_str(&data)?)
}

pub fn save_settings(path: &std::path::Path, settings: &AppSettings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, data)?;
    Ok(())
}

pub fn default_settings() -> AppSettings {
    let mut agents = HashMap::new();
    for c in all_collectors() {
        agents.insert(
            c.id().to_string(),
            AgentSettings {
                enabled: true,
                path: None,
            },
        );
    }
    AppSettings {
        agents,
        price_sync_days: 1,
        include_free_models: false,
        model_overrides: HashMap::new(),
        balance_providers: Vec::new(),
        balance_refresh_minutes: 15,
        usage_refresh_minutes: 30,
    }
}

pub fn list_agents(settings: &AppSettings) -> Vec<AgentDef> {
    all_collectors()
        .into_iter()
        .map(|c| {
            let s = settings.agent(c.id());
            let resolved = resolve_path(&s, c.default_path().as_deref());
            let detected = resolved
                .as_ref()
                .map(|p| std::path::Path::new(p).exists())
                .unwrap_or(false);
            AgentDef {
                id: c.id().to_string(),
                name: c.name().to_string(),
                default_path: c.default_path(),
                enabled: s.enabled,
                detected,
                path: resolved
                    .or_else(|| s.path.clone())
                    .or_else(|| c.default_path()),
            }
        })
        .collect()
}
