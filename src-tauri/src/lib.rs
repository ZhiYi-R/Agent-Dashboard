mod balance;
mod collectors;
mod db;
mod models;
mod pricing;
mod state;
mod update;

use crate::collectors::{all_collectors, FileScanPlan};
use crate::db::UsageDb;
use crate::models::{
    AgentDef, AppSettings, BalanceHistoryFilter, BalanceProvider, BalanceResult,
    BalanceSnapshotPoint, RecordFilter, UpdateCheckResult, UsageRecord, UsageSummary,
};
use crate::pricing::PriceCache;
use crate::state::{data_dir, list_agents, save_settings, AppState};
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn get_agents(state: State<AppState>) -> Vec<AgentDef> {
    let settings = state.settings.lock().unwrap();
    list_agents(&settings)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings_cmd(
    app: AppHandle,
    state: State<AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let overrides_changed = {
        let prev = state.settings.lock().unwrap();
        prev.model_overrides != settings.model_overrides
    };
    save_settings(&dir.join("settings.json"), &settings).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;

    // Model override changes must reprice existing rows without a full rescan.
    if overrides_changed {
        let prices = state.price_cache.lock().unwrap().clone();
        let settings = state.settings.lock().unwrap().clone();
        let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
        recalculate_costs(&db, &prices, &settings).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_records(
    state: State<AppState>,
    filter: RecordFilter,
    limit: u64,
    offset: u64,
) -> Result<Vec<UsageRecord>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.get_records(&filter, limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_summary(state: State<AppState>, filter: RecordFilter) -> Result<UsageSummary, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.get_summary(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
fn count_records(state: State<AppState>, filter: RecordFilter) -> Result<u64, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.count_records(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_filter_models(state: State<AppState>, filter: RecordFilter) -> Result<Vec<String>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_models(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_filter_projects(
    state: State<AppState>,
    filter: RecordFilter,
) -> Result<Vec<String>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_projects(&filter).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    agent: String,
    count: usize,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFinished {
    total: usize,
    errors: Vec<String>,
}

#[tauri::command]
fn start_scan(app: AppHandle, state: State<AppState>, full: Option<bool>) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    let prices = state.price_cache.lock().unwrap().clone();
    let db_path = state.db_path.clone();
    let force_full = full.unwrap_or(false);

    std::thread::spawn(move || {
        let app2 = app.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_scan(app2, &db_path, &settings, &prices, force_full)
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = app.emit(
                    "scan-finished",
                    ScanFinished {
                        total: 0,
                        errors: vec![format!("scan failed: {}", e)],
                    },
                );
            }
            Err(_) => {
                let _ = app.emit(
                    "scan-finished",
                    ScanFinished {
                        total: 0,
                        errors: vec!["scan thread panicked".to_string()],
                    },
                );
            }
        }
    });

    Ok(())
}

fn run_scan(
    app: AppHandle,
    db_path: &std::path::Path,
    settings: &AppSettings,
    prices: &PriceCache,
    force_full: bool,
) -> anyhow::Result<()> {
    let db = UsageDb::open(db_path)?;
    let mut total = 0usize;
    let mut errors = Vec::new();

    for collector in all_collectors() {
        if !collector.agent_settings(settings).enabled {
            continue;
        }

        if force_full {
            db.clear_agent(collector.id())?;
        }

        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                agent: collector.name().to_string(),
                count: 0,
                error: None,
            },
        );

        let mut count = 0usize;
        let mut last_emit = 0usize;
        let seen_sources: Rc<RefCell<HashSet<String>>> = Rc::new(RefCell::new(HashSet::new()));
        let agent_id = collector.id().to_string();
        let seen_for_sink = Rc::clone(&seen_sources);

        let mut sink = |rec: UsageRecord| -> anyhow::Result<()> {
            if !rec.source_file.is_empty() {
                seen_for_sink.borrow_mut().insert(rec.source_file.clone());
            }
            db.insert_record(&rec)?;
            count += 1;
            total += 1;
            // Throttle UI events — full scans can emit tens of thousands of rows.
            if count - last_emit >= 500 {
                let _ = app.emit(
                    "scan-progress",
                    ScanProgress {
                        agent: collector.name().to_string(),
                        count,
                        error: None,
                    },
                );
                last_emit = count;
            }
            Ok(())
        };

        // File planner: skip unchanged, tail append-only growth, full on shrink/rewrite.
        let mut pending_meta: Vec<(String, i64, i64, i64)> = Vec::new();
        let seen_for_planner = Rc::clone(&seen_sources);
        let mut planner = |source: &str, mtime_ms: u64, size: u64| -> FileScanPlan {
            seen_for_planner.borrow_mut().insert(source.to_string());
            if force_full {
                pending_meta.push((
                    source.to_string(),
                    mtime_ms as i64,
                    size as i64,
                    size as i64,
                ));
                // Full rescan deletes rows for this source before re-insert.
                let _ = db.delete_by_source(&agent_id, source);
                return FileScanPlan::Full;
            }
            match db.get_scan_file(&agent_id, source) {
                Ok(Some(meta)) if meta.mtime_ms == mtime_ms as i64 && meta.size == size as i64 => {
                    FileScanPlan::Skip
                }
                Ok(Some(meta))
                    if size as i64 > meta.size && meta.size >= 0 && source.ends_with(".jsonl") =>
                {
                    // Append-only jsonl growth — tail read, keep existing rows.
                    pending_meta.push((
                        source.to_string(),
                        mtime_ms as i64,
                        size as i64,
                        size as i64,
                    ));
                    FileScanPlan::Tail {
                        offset: meta.size as u64,
                    }
                }
                _ => {
                    // New, shrunk, or metadata missing — full file rebuild.
                    let _ = db.delete_by_source(&agent_id, source);
                    pending_meta.push((
                        source.to_string(),
                        mtime_ms as i64,
                        size as i64,
                        size as i64,
                    ));
                    FileScanPlan::Full
                }
            }
        };

        match collector.collect(settings, prices, &mut sink, &mut planner) {
            Ok(()) => {
                for (src, mtime, size, offset) in pending_meta {
                    let _ = db.upsert_scan_file(&agent_id, &src, mtime, size, offset);
                }
                if !force_full {
                    let keep = seen_sources.borrow().clone();
                    let _ = db.prune_missing_sources(&agent_id, &keep);
                }
                let _ = app.emit(
                    "scan-progress",
                    ScanProgress {
                        agent: collector.name().to_string(),
                        count,
                        error: None,
                    },
                );
            }
            Err(e) => {
                let msg = format!("{}: {}", collector.name(), e);
                errors.push(msg.clone());
                let _ = app.emit(
                    "scan-progress",
                    ScanProgress {
                        agent: collector.name().to_string(),
                        count,
                        error: Some(msg),
                    },
                );
            }
        }
    }

    app.emit("scan-finished", ScanFinished { total, errors })?;

    Ok(())
}

fn recalculate_costs(
    db: &UsageDb,
    prices: &PriceCache,
    settings: &AppSettings,
) -> anyhow::Result<usize> {
    db.begin_tx()?;
    let result = (|| {
        let mut updated = 0usize;
        db.for_each_record(|rec| {
            let cost = prices.cost_for(rec, &settings.model_overrides);
            db.update_cost(&rec.id, cost)?;
            updated += 1;
            Ok(())
        })?;
        Ok(updated)
    })();
    match result {
        Ok(n) => {
            db.commit_tx()?;
            Ok(n)
        }
        Err(e) => {
            let _ = db.rollback_tx();
            Err(e)
        }
    }
}

#[tauri::command]
fn recalculate_costs_cmd(state: State<AppState>) -> Result<usize, String> {
    let prices = state.price_cache.lock().unwrap().clone();
    let settings = state.settings.lock().unwrap().clone();
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    recalculate_costs(&db, &prices, &settings).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceSyncProgress {
    count: usize,
    total: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceSyncFinished {
    count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceSyncError {
    error: String,
}

#[tauri::command]
fn start_sync(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let pc = Arc::clone(&state.price_cache);
    let app = app.clone();

    std::thread::spawn(move || {
        let _ = app.emit(
            "price-sync-progress",
            PriceSyncProgress { count: 0, total: 0 },
        );

        let dir = match data_dir(&app) {
            Ok(d) => d,
            Err(e) => {
                let _ = app.emit(
                    "price-sync-error",
                    PriceSyncError {
                        error: e.to_string(),
                    },
                );
                return;
            }
        };

        let mut cache = pc.lock().unwrap().clone();
        match cache.sync() {
            Ok(count) => {
                if let Err(e) = cache.save(&dir.join("prices.json")) {
                    let _ = app.emit(
                        "price-sync-error",
                        PriceSyncError {
                            error: e.to_string(),
                        },
                    );
                    return;
                }
                // Reprice stored records against the new catalog.
                if let Ok(db) = UsageDb::open(&dir.join("usage.db")) {
                    // settings are not in this closure — load from app state via path only prices.
                    // Cost uses prices + overrides; load settings.json for overrides.
                    if let Ok(settings) = crate::state::load_settings(&dir.join("settings.json")) {
                        let _ = recalculate_costs(&db, &cache, &settings);
                    }
                }
                *pc.lock().unwrap() = cache;
                let _ = app.emit(
                    "price-sync-progress",
                    PriceSyncProgress {
                        count,
                        total: count.max(1),
                    },
                );
                let _ = app.emit("price-sync-finished", PriceSyncFinished { count });
            }
            Err(e) => {
                let _ = app.emit(
                    "price-sync-error",
                    PriceSyncError {
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn get_prices(state: State<AppState>) -> PriceCache {
    state.price_cache.lock().unwrap().clone()
}

#[tauri::command]
fn check_balances(state: State<AppState>) -> Result<Vec<BalanceResult>, String> {
    let settings = state.settings.lock().unwrap().clone();
    let results = balance::check_all(&settings.balance_providers);
    if let Ok(db) = UsageDb::open(&state.db_path) {
        let _ = db.insert_balance_snapshots(&results);
    }
    Ok(results)
}

#[tauri::command]
fn check_balance_provider(
    state: State<AppState>,
    provider_id: String,
) -> Result<Vec<BalanceResult>, String> {
    let settings = state.settings.lock().unwrap().clone();
    let provider = settings
        .balance_providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("provider not found: {}", provider_id))?;
    let results: Vec<BalanceResult> = provider
        .keys
        .iter()
        .map(|k| balance::check_one(provider, k))
        .collect();
    if let Ok(db) = UsageDb::open(&state.db_path) {
        let _ = db.insert_balance_snapshots(&results);
    }
    Ok(results)
}

#[tauri::command]
fn get_latest_balances(state: State<AppState>) -> Result<Vec<BalanceResult>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.latest_balance_results().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_balance_checked_at(state: State<AppState>) -> Result<Option<String>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    Ok(db
        .latest_balance_checked_at()
        .map_err(|e| e.to_string())?
        .map(|t| t.to_rfc3339()))
}

#[tauri::command]
fn get_balance_history(
    state: State<AppState>,
    filter: BalanceHistoryFilter,
) -> Result<Vec<BalanceSnapshotPoint>, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.balance_history(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_record_count_total(state: State<AppState>) -> Result<u64, String> {
    let db = UsageDb::open(&state.db_path).map_err(|e| e.to_string())?;
    db.total_record_count().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_version() -> String {
    update::current_version()
}

#[tauri::command]
fn check_for_updates() -> Result<UpdateCheckResult, String> {
    update::check_latest_release()
}

/// Validate settings payload still deserializes as BalanceProvider list helpers for frontend.
#[allow(dead_code)]
fn _assert_balance_types(_: BalanceProvider) {}

fn maybe_refresh_balances_on_startup(app: &AppHandle, state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    if settings.balance_providers.is_empty() {
        return;
    }
    let mins = settings.balance_refresh_minutes;
    // 0 means never auto; still load from DB on frontend.
    if mins == 0 {
        return;
    }
    let db_path = state.db_path.clone();
    let interval = std::time::Duration::from_secs(mins.saturating_mul(60).max(60));
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(db) = UsageDb::open(&db_path) else {
            return;
        };
        let need = match db.latest_balance_checked_at() {
            Ok(Some(at)) => {
                let age = chrono::Utc::now().signed_duration_since(at);
                age.to_std().map(|d| d >= interval).unwrap_or(true)
            }
            _ => true,
        };
        if !need {
            return;
        }
        let results = balance::check_all(&settings.balance_providers);
        let _ = db.insert_balance_snapshots(&results);
        let _ = app.emit("balance-refreshed", results);
    });
}

fn maybe_import_on_startup(app: &AppHandle, state: &AppState) {
    let db_path = state.db_path.clone();
    let Ok(db) = UsageDb::open(&db_path) else {
        return;
    };
    let count = db.total_record_count().unwrap_or(0);
    if count > 0 {
        return;
    }
    let settings = state.settings.lock().unwrap().clone();
    let prices = state.price_cache.lock().unwrap().clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = app.emit(
            "scan-progress",
            ScanProgress {
                agent: "Initial import".into(),
                count: 0,
                error: None,
            },
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_scan(app.clone(), &db_path, &settings, &prices, true)
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = app.emit(
                    "scan-finished",
                    ScanFinished {
                        total: 0,
                        errors: vec![format!("initial import failed: {}", e)],
                    },
                );
            }
            Err(_) => {
                let _ = app.emit(
                    "scan-finished",
                    ScanFinished {
                        total: 0,
                        errors: vec!["initial import panicked".into()],
                    },
                );
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_state = AppState::new(app.handle())?;
            // Repair empty models once at open.
            if let Ok(db) = UsageDb::open(&app_state.db_path) {
                let _ = db.normalize_empty_models();
            }
            maybe_import_on_startup(app.handle(), &app_state);
            maybe_refresh_balances_on_startup(app.handle(), &app_state);
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_agents,
            get_settings,
            save_settings_cmd,
            get_records,
            get_summary,
            count_records,
            list_filter_models,
            list_filter_projects,
            start_scan,
            start_sync,
            get_prices,
            check_balances,
            check_balance_provider,
            get_latest_balances,
            get_balance_checked_at,
            get_balance_history,
            get_record_count_total,
            get_app_version,
            check_for_updates,
            recalculate_costs_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
