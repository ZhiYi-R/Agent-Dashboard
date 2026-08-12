use crate::models::{
    BalanceKey, BalanceProvider, BalanceProviderType, BalanceResult, BalanceWindow,
};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;

pub fn check_all(providers: &[BalanceProvider]) -> Vec<BalanceResult> {
    let mut out = Vec::new();
    for p in providers {
        for k in &p.keys {
            out.push(check_one(p, k));
        }
    }
    out
}

pub fn check_one(provider: &BalanceProvider, key: &BalanceKey) -> BalanceResult {
    let base = |r: BalanceResult| r;
    match query(provider, key) {
        Ok(mut r) => {
            r.provider_id = provider.id.clone();
            r.provider_type = provider.provider_type.as_str().to_string();
            r.key_id = key.id.clone();
            r.key_name = key.name.clone();
            r.success = true;
            base(r)
        }
        Err(e) => BalanceResult {
            provider_id: provider.id.clone(),
            provider_type: provider.provider_type.as_str().to_string(),
            key_id: key.id.clone(),
            key_name: key.name.clone(),
            success: false,
            available: None,
            total: None,
            currency: None,
            windows: vec![],
            message: e.to_string(),
            raw: None,
        },
    }
}

fn query(provider: &BalanceProvider, key: &BalanceKey) -> Result<BalanceResult> {
    if key.key.trim().is_empty() {
        return Err(anyhow!("API key is empty"));
    }
    match provider.provider_type {
        BalanceProviderType::Newapi | BalanceProviderType::ClaudeCodeHub => {
            query_newapi_like(provider, key)
        }
        BalanceProviderType::Sub2api => query_sub2api(provider, key),
        BalanceProviderType::KimiCode => query_kimi_code(provider, key),
        BalanceProviderType::BigmodelCoding => {
            query_zhipu_monitor("https://open.bigmodel.cn", provider, key)
        }
        BalanceProviderType::ZaiCoding => {
            query_zhipu_monitor("https://api.z.ai", provider, key)
        }
        BalanceProviderType::Deepseek => query_deepseek(provider, key),
    }
}

fn require_base_url(provider: &BalanceProvider) -> Result<String> {
    let url = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("baseUrl is required for this provider type"))?;
    Ok(url.trim_end_matches('/').to_string())
}

fn http_get_json(url: &str, bearer: &str) -> Result<(u16, Value)> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("build http client")?;

    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", bearer.trim()))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .send()
        .with_context(|| format!("request {}", url))?;

    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    if text.trim().is_empty() {
        return Err(anyhow!("HTTP {} empty body", status));
    }
    let json: Value = serde_json::from_str(&text)
        .with_context(|| format!("HTTP {} invalid json: {}", status, truncate(&text, 200)))?;
    if status >= 400 {
        let msg = json
            .get("message")
            .or_else(|| json.get("msg"))
            .or_else(|| json.pointer("/error/message"))
            .and_then(|v| v.as_str())
            .unwrap_or("request failed");
        return Err(anyhow!("HTTP {}: {}", status, msg));
    }
    Ok((status, json))
}

fn empty_result() -> BalanceResult {
    BalanceResult {
        provider_id: String::new(),
        provider_type: String::new(),
        key_id: String::new(),
        key_name: String::new(),
        success: true,
        available: None,
        total: None,
        currency: None,
        windows: vec![],
        message: String::new(),
        raw: None,
    }
}

/// NewAPI / Claude Code Hub (probe NewAPI-compatible path)
fn query_newapi_like(provider: &BalanceProvider, key: &BalanceKey) -> Result<BalanceResult> {
    let base = require_base_url(provider)?;
    let url = format!("{}/api/usage/token", base);
    let (_status, json) = http_get_json(&url, &key.key)?;

    // NewAPI: { code: true, data: { total_granted, total_used, total_available, ... } }
    // Some forks: { success: true, data: ... } or data at top level
    let data = json
        .get("data")
        .cloned()
        .unwrap_or_else(|| json.clone());

    let total_granted = num_f64(&data, &["total_granted", "totalGranted"]);
    let total_used = num_f64(&data, &["total_used", "totalUsed"]);
    let total_available = num_f64(&data, &["total_available", "totalAvailable"]);
    let unlimited = data
        .get("unlimited_quota")
        .or_else(|| data.get("unlimitedQuota"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // NewAPI quota unit: commonly 500000 = $1 (instance-dependent)
    const QUOTA_PER_USD: f64 = 500_000.0;
    let to_usd = |q: f64| q / QUOTA_PER_USD;

    let mut r = empty_result();
    r.raw = Some(json);
    if unlimited {
        r.available = Some(f64::INFINITY);
        r.total = total_granted.map(to_usd);
        r.currency = Some("USD".into());
        r.message = "unlimited quota".into();
    } else {
        r.available = total_available.map(to_usd);
        r.total = total_granted.map(to_usd);
        r.currency = Some("USD".into());
        let used = total_used.map(to_usd).unwrap_or(0.0);
        r.message = format!(
            "available ≈ ${:.4} (used ≈ ${:.4}; quota÷{:.0})",
            r.available.unwrap_or(0.0),
            used,
            QUOTA_PER_USD
        );
    }
    if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
        r.message = format!("{} · {}", name, r.message);
    }
    Ok(r)
}

fn query_sub2api(provider: &BalanceProvider, key: &BalanceKey) -> Result<BalanceResult> {
    let base = require_base_url(provider)?;
    let url = format!("{}/backend-api/wham/usage", base);
    let (_status, json) = http_get_json(&url, &key.key)?;

    let mut r = empty_result();
    r.raw = Some(json.clone());

    // Prefer sub2api extension object when present
    if let Some(s2) = json.get("sub2api") {
        r.available = num_f64(s2, &["daily_remaining_usd", "dailyRemainingUsd"]);
        r.total = num_f64(s2, &["daily_limit_usd", "dailyLimitUsd"]);
        r.currency = Some("USD".into());
        let used = num_f64(s2, &["daily_used_usd", "dailyUsedUsd"]);
        let wallet = num_f64(s2, &["wallet_balance_usd", "walletBalanceUsd"]);
        let reset = s2
            .get("reset_at")
            .or_else(|| s2.get("resetAt"))
            .and_then(ts_to_string);

        r.windows.push(BalanceWindow {
            name: "Daily".into(),
            used_percent: match (used, r.total) {
                (Some(u), Some(t)) if t > 0.0 => Some((u / t) * 100.0),
                _ => None,
            },
            remaining: r.available,
            total: r.total,
            unit: Some("USD".into()),
            reset_at: reset,
        });
        if let Some(w) = wallet {
            r.windows.push(BalanceWindow {
                name: "Wallet".into(),
                used_percent: None,
                remaining: Some(w),
                total: None,
                unit: Some("USD".into()),
                reset_at: None,
            });
            r.message = format!(
                "daily remaining ${:.2} · wallet ${:.2}",
                r.available.unwrap_or(0.0),
                w
            );
        } else {
            r.message = format!("daily remaining ${:.2}", r.available.unwrap_or(0.0));
        }
        return Ok(r);
    }

    // Fallback: ChatGPT-style rate_limit.primary_window
    if let Some(pw) = json.pointer("/rate_limit/primary_window") {
        let used_pct = num_f64(pw, &["used_percent", "usedPercent"]);
        let reset = pw
            .get("reset_at")
            .or_else(|| pw.get("resetAt"))
            .and_then(ts_to_string);
        r.windows.push(BalanceWindow {
            name: "Primary".into(),
            used_percent: used_pct,
            remaining: used_pct.map(|p| 100.0 - p),
            total: Some(100.0),
            unit: Some("%".into()),
            reset_at: reset,
        });
        r.message = format!(
            "used {:.1}%",
            used_pct.unwrap_or(0.0)
        );
        return Ok(r);
    }

    r.message = "unexpected response shape".into();
    Ok(r)
}

fn query_kimi_code(provider: &BalanceProvider, key: &BalanceKey) -> Result<BalanceResult> {
    let base = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.kimi.com/coding/v1")
        .trim_end_matches('/');
    let url = format!("{}/usages", base);
    let (_status, json) = http_get_json(&url, &key.key)?;

    let mut r = empty_result();
    r.raw = Some(json.clone());

    // Top-level usage ≈ weekly (often percentage semantics)
    if let Some(usage) = json.get("usage") {
        let limit = num_f64(usage, &["limit"]);
        let used = num_f64(usage, &["used"]);
        let remaining = num_f64(usage, &["remaining"]);
        let reset = usage
            .get("resetTime")
            .or_else(|| usage.get("reset_time"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // When limit≈100 treat as percent
        let used_pct = match (used, limit) {
            (Some(u), Some(l)) if (90.0..=110.0).contains(&l) => Some(u),
            (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
            _ => remaining.map(|rem| 100.0 - rem),
        };

        r.windows.push(BalanceWindow {
            name: "Weekly".into(),
            used_percent: used_pct,
            remaining,
            total: limit,
            unit: Some("%".into()),
            reset_at: reset,
        });
    }

    // limits[]: duration 300 TIME_UNIT_MINUTE => 5h window
    if let Some(arr) = json.get("limits").and_then(|v| v.as_array()) {
        for item in arr {
            let duration = item
                .pointer("/window/duration")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let unit = item
                .pointer("/window/timeUnit")
                .or_else(|| item.pointer("/window/time_unit"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let detail = item.get("detail").cloned().unwrap_or(Value::Null);
            let limit = num_f64(&detail, &["limit"]);
            let used = num_f64(&detail, &["used"]);
            let remaining = num_f64(&detail, &["remaining"]);
            let reset = detail
                .get("resetTime")
                .or_else(|| detail.get("reset_time"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let name = if duration == 300
                && (unit.contains("MINUTE") || unit.contains("Minute") || unit.is_empty())
            {
                "5h".to_string()
            } else {
                format!("{}×{}", duration, unit)
            };

            let used_pct = match (used, limit) {
                (Some(u), Some(l)) if (90.0..=110.0).contains(&l) => Some(u),
                (Some(u), Some(l)) if l > 0.0 => Some(u / l * 100.0),
                _ => remaining.map(|rem| 100.0 - rem),
            };

            r.windows.push(BalanceWindow {
                name,
                used_percent: used_pct,
                remaining,
                total: limit,
                unit: Some("%".into()),
                reset_at: reset,
            });
        }
    }

    let weekly_left = r
        .windows
        .iter()
        .find(|w| w.name == "Weekly")
        .and_then(|w| w.used_percent)
        .map(|p| 100.0 - p);
    let five_left = r
        .windows
        .iter()
        .find(|w| w.name == "5h")
        .and_then(|w| w.used_percent)
        .map(|p| 100.0 - p);

    r.message = match (weekly_left, five_left) {
        (Some(w), Some(f)) => format!("weekly {:.0}% left · 5h {:.0}% left", w, f),
        (Some(w), None) => format!("weekly {:.0}% left", w),
        (None, Some(f)) => format!("5h {:.0}% left", f),
        _ => "ok".into(),
    };
    Ok(r)
}

fn query_zhipu_monitor(
    default_host: &str,
    provider: &BalanceProvider,
    key: &BalanceKey,
) -> Result<BalanceResult> {
    let host = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_host)
        .trim_end_matches('/');
    let url = format!("{}/api/monitor/usage/quota/limit", host);
    let (_status, json) = http_get_json(&url, &key.key)?;

    let mut r = empty_result();
    r.raw = Some(json.clone());

    let data = json.get("data").cloned().unwrap_or_else(|| json.clone());
    let level = data
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let mut token_limits: Vec<&Value> = data
        .get("limits")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter(|l| l.get("type").and_then(|t| t.as_str()) == Some("TOKENS_LIMIT"))
                .collect()
        })
        .unwrap_or_default();

    token_limits.sort_by_key(|l| {
        l.get("nextResetTime")
            .or_else(|| l.get("next_reset_time"))
            .and_then(|v| v.as_i64())
            .unwrap_or(i64::MAX)
    });

    if let Some(hour5) = token_limits.first() {
        r.windows.push(token_limit_window("5h", hour5));
    }
    if let Some(weekly) = token_limits.get(1) {
        r.windows.push(token_limit_window("Weekly", weekly));
    }
    if let Some(monthly) = token_limits.get(2) {
        r.windows.push(token_limit_window("Monthly", monthly));
    }

    if let Some(mcp) = data
        .get("limits")
        .and_then(|v| v.as_array())
        .and_then(|a| {
            a.iter()
                .find(|l| l.get("type").and_then(|t| t.as_str()) == Some("TIME_LIMIT"))
        })
    {
        let remaining = num_f64(mcp, &["remaining"]);
        let total = num_f64(mcp, &["usage"]);
        let used = num_f64(mcp, &["currentValue", "current_value"]);
        r.windows.push(BalanceWindow {
            name: "MCP monthly".into(),
            used_percent: match (used, total) {
                (Some(u), Some(t)) if t > 0.0 => Some(u / t * 100.0),
                _ => num_f64(mcp, &["percentage"]),
            },
            remaining,
            total,
            unit: Some("calls".into()),
            reset_at: None,
        });
    }

    let parts: Vec<String> = r
        .windows
        .iter()
        .filter_map(|w| {
            w.used_percent
                .map(|p| format!("{} {:.0}% used", w.name, p))
        })
        .collect();
    r.message = if parts.is_empty() {
        format!("plan: {}", level)
    } else {
        format!("plan {} · {}", level, parts.join(" · "))
    };
    Ok(r)
}

fn token_limit_window(name: &str, v: &Value) -> BalanceWindow {
    let pct = num_f64(v, &["percentage"]);
    let reset = v
        .get("nextResetTime")
        .or_else(|| v.get("next_reset_time"))
        .and_then(ts_to_string);
    BalanceWindow {
        name: name.into(),
        used_percent: pct,
        remaining: pct.map(|p| 100.0 - p),
        total: Some(100.0),
        unit: Some("%".into()),
        reset_at: reset,
    }
}

fn query_deepseek(provider: &BalanceProvider, key: &BalanceKey) -> Result<BalanceResult> {
    let base = provider
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.deepseek.com")
        .trim_end_matches('/');
    let url = format!("{}/user/balance", base);
    let (_status, json) = http_get_json(&url, &key.key)?;

    let mut r = empty_result();
    r.raw = Some(json.clone());

    let available_flag = json
        .get("is_available")
        .or_else(|| json.get("isAvailable"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let infos = json
        .get("balance_infos")
        .or_else(|| json.get("balanceInfos"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Prefer USD, else first entry
    let pick = infos
        .iter()
        .find(|i| {
            i.get("currency")
                .and_then(|c| c.as_str())
                .map(|c| c.eq_ignore_ascii_case("USD"))
                .unwrap_or(false)
        })
        .or_else(|| infos.first());

    if let Some(info) = pick {
        let currency = info
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("USD")
            .to_string();
        let total = parse_money(info.get("total_balance").or_else(|| info.get("totalBalance")));
        let granted =
            parse_money(info.get("granted_balance").or_else(|| info.get("grantedBalance")));
        let topped = parse_money(
            info.get("topped_up_balance")
                .or_else(|| info.get("toppedUpBalance")),
        );

        r.available = total;
        r.total = total;
        r.currency = Some(currency.clone());
        if let Some(g) = granted {
            r.windows.push(BalanceWindow {
                name: "Granted".into(),
                used_percent: None,
                remaining: Some(g),
                total: None,
                unit: Some(currency.clone()),
                reset_at: None,
            });
        }
        if let Some(t) = topped {
            r.windows.push(BalanceWindow {
                name: "Topped-up".into(),
                used_percent: None,
                remaining: Some(t),
                total: None,
                unit: Some(currency.clone()),
                reset_at: None,
            });
        }
        r.message = format!(
            "{} {:.2} total (available for API: {})",
            currency,
            total.unwrap_or(0.0),
            if available_flag { "yes" } else { "no" }
        );
    } else {
        r.message = if available_flag {
            "no balance_infos".into()
        } else {
            "balance unavailable for API calls".into()
        };
        if !available_flag {
            return Err(anyhow!("{}", r.message));
        }
    }
    Ok(r)
}

fn num_f64(v: &Value, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(n) = v.get(*k) {
            if let Some(f) = n.as_f64() {
                return Some(f);
            }
            if let Some(i) = n.as_i64() {
                return Some(i as f64);
            }
            if let Some(u) = n.as_u64() {
                return Some(u as f64);
            }
            if let Some(s) = n.as_str() {
                if let Ok(f) = s.parse::<f64>() {
                    return Some(f);
                }
            }
        }
    }
    None
}

fn parse_money(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    if let Some(f) = v.as_f64() {
        return Some(f);
    }
    if let Some(s) = v.as_str() {
        return s.parse().ok();
    }
    None
}

fn ts_to_string(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(n) = v.as_i64() {
        // seconds or millis
        let secs = if n > 10_000_000_000 { n / 1000 } else { n };
        if let Some(dt) = chrono::DateTime::from_timestamp(secs, 0) {
            return Some(dt.to_rfc3339());
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{}…", t)
    }
}
