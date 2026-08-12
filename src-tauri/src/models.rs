use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub agent: String,
    pub session_id: String,
    pub project: Option<String>,
    pub model: String,
    pub provider: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
    pub cost_usd: Option<f64>,
    pub source_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_creation: u64,
    pub total_reasoning: u64,
    pub total_cost_usd: f64,
    pub sessions: u64,
    pub records: u64,
    pub by_agent: HashMap<String, AgentSummary>,
    pub by_model: HashMap<String, ModelSummary>,
    pub by_day: HashMap<String, DaySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub agent: String,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_creation: u64,
    pub total_reasoning: u64,
    pub total_cost_usd: f64,
    pub records: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub model: String,
    pub provider: Option<String>,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_creation: u64,
    pub total_reasoning: u64,
    pub total_cost_usd: f64,
    pub records: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub day: String,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cache_creation: u64,
    pub total_reasoning: u64,
    pub total_cost_usd: f64,
    pub records: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
    #[serde(default)]
    pub reasoning: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub enabled: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    pub aliases: Vec<String>,
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    pub cache_write: Option<f64>,
    #[serde(default)]
    pub reasoning: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BalanceProviderType {
    Newapi,
    Sub2api,
    ClaudeCodeHub,
    KimiCode,
    BigmodelCoding,
    ZaiCoding,
    Deepseek,
}

impl BalanceProviderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Newapi => "newapi",
            Self::Sub2api => "sub2api",
            Self::ClaudeCodeHub => "claude-code-hub",
            Self::KimiCode => "kimi-code",
            Self::BigmodelCoding => "bigmodel-coding",
            Self::ZaiCoding => "zai-coding",
            Self::Deepseek => "deepseek",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceKey {
    pub id: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceProvider {
    pub id: String,
    pub name: String,
    pub provider_type: BalanceProviderType,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub keys: Vec<BalanceKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BalanceWindow {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceResult {
    pub provider_id: String,
    pub provider_type: String,
    pub key_id: String,
    pub key_name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<BalanceWindow>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub agents: HashMap<String, AgentSettings>,
    pub price_sync_days: u64,
    pub include_free_models: bool,
    pub model_overrides: HashMap<String, ModelOverride>,
    #[serde(default)]
    pub balance_providers: Vec<BalanceProvider>,
    /// 0 = off. Minutes between automatic balance checks.
    #[serde(default)]
    pub balance_refresh_minutes: u64,
    /// 0 = off. Minutes between automatic incremental usage scans.
    #[serde(default)]
    pub usage_refresh_minutes: u64,
}

impl AppSettings {
    pub fn agent(&self, id: &str) -> AgentSettings {
        self.agents.get(id).cloned().unwrap_or(AgentSettings {
            enabled: true,
            path: None,
        })
    }

    #[allow(dead_code)]
    pub fn override_for(&self, raw_model: &str) -> Option<&ModelOverride> {
        let raw = raw_model.to_lowercase().replace(' ', "-");
        if let Some(o) = self.model_overrides.get(&raw) {
            return Some(o);
        }
        for (key, o) in &self.model_overrides {
            if key.to_lowercase().replace(' ', "-") == raw {
                return Some(o);
            }
            for a in &o.aliases {
                if a.to_lowercase().replace(' ', "-") == raw {
                    return Some(o);
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: String,
    pub name: String,
    pub default_path: Option<String>,
    pub enabled: bool,
    pub detected: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordFilter {
    pub agents: Option<Vec<String>>,
    pub models: Option<Vec<String>>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub project: Option<String>,
}

#[allow(dead_code)]
impl UsageSummary {
    pub fn from_records(records: &[UsageRecord]) -> Self {
        let mut summary = UsageSummary::default();
        summary.records = records.len() as u64;
        let mut session_ids = std::collections::HashSet::new();

        for r in records {
            session_ids.insert(r.session_id.clone());
            summary.total_input += r.input_tokens;
            summary.total_output += r.output_tokens;
            summary.total_cache_read += r.cache_read_tokens;
            summary.total_cache_creation += r.cache_creation_tokens;
            summary.total_reasoning += r.reasoning_tokens;
            summary.total_cost_usd += r.cost_usd.unwrap_or(0.0);

            let agent = summary.by_agent.entry(r.agent.clone()).or_default();
            agent.agent = r.agent.clone();
            agent.total_input += r.input_tokens;
            agent.total_output += r.output_tokens;
            agent.total_cost_usd += r.cost_usd.unwrap_or(0.0);
            agent.records += 1;

            let model = summary.by_model.entry(r.model.clone()).or_default();
            model.model = r.model.clone();
            model.provider = r.provider.clone();
            model.total_input += r.input_tokens;
            model.total_output += r.output_tokens;
            model.total_cost_usd += r.cost_usd.unwrap_or(0.0);
            model.records += 1;

            let day = r.timestamp.format("%Y-%m-%d").to_string();
            let d = summary.by_day.entry(day.clone()).or_default();
            d.day = day;
            d.total_input += r.input_tokens;
            d.total_output += r.output_tokens;
            d.total_cost_usd += r.cost_usd.unwrap_or(0.0);
            d.records += 1;
        }

        summary.sessions = session_ids.len() as u64;
        summary
    }
}
