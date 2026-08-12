use crate::models::{ModelOverride, ModelPrice, UsageRecord};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const CATALOG_URL: &str = "https://models.dev/catalog.json";
const BUNDLED_PRICES: &str = include_str!("../prices.json");

#[derive(Debug, Clone, Deserialize)]
struct CatalogProviderModel {
    // Model short id within the provider (e.g. "glm-5").
    // The full id is provider.id + "/" + short id.
    id: String,
    #[serde(default)]
    cost: Option<CatalogCost>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogProvider {
    // Provider id (e.g. "zhipuai").
    id: String,
    #[serde(default)]
    models: HashMap<String, CatalogProviderModel>,
}

#[derive(Debug, Clone, Deserialize)]
struct CatalogCost {
    input: f64,
    output: f64,
    #[serde(default)]
    cache_read: Option<f64>,
    #[serde(default)]
    cache_write: Option<f64>,
    #[serde(default)]
    reasoning: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct Catalog {
    #[serde(default)]
    providers: HashMap<String, CatalogProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PriceCache {
    pub prices: HashMap<String, ModelPrice>,
    pub synced_at: Option<DateTime<Utc>>,
    #[serde(skip)]
    index: HashMap<String, String>,
}

impl PriceCache {
    pub fn sync(&mut self) -> Result<usize> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        let catalog: Catalog = client
            .get(CATALOG_URL)
            .send()?
            .error_for_status()?
            .json()?;

        self.prices.clear();
        for (_, provider) in catalog.providers {
            for (_, model) in provider.models {
                let Some(cost) = model.cost else {
                    continue;
                };
                if provider.id.is_empty() || model.id.is_empty() {
                    continue;
                }
                let full_id = format!("{}/{}", provider.id, model.id);
                self.prices.insert(
                    full_id.clone(),
                    ModelPrice {
                        id: full_id,
                        provider: provider.id.clone(),
                        model: model.id.clone(),
                        input: cost.input,
                        output: cost.output,
                        cache_read: cost.cache_read,
                        cache_write: cost.cache_write,
                        reasoning: cost.reasoning,
                    },
                );
            }
        }

        self.build_index();
        self.synced_at = Some(Utc::now());
        Ok(self.prices.len())
    }

    pub fn load(path: &std::path::Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::bundled());
        }
        let data = std::fs::read_to_string(path)?;
        if data.trim().is_empty() {
            return Ok(Self::bundled());
        }
        let mut cache: PriceCache = serde_json::from_str(&data)
            .with_context(|| format!("failed to parse price cache at {}", path.display()))?;
        cache.build_index();
        Ok(cache)
    }

    pub fn bundled() -> Self {
        let mut cache: PriceCache = serde_json::from_str(BUNDLED_PRICES).unwrap_or_default();
        cache.build_index();
        cache
    }

    pub fn save(&self, path: &std::path::Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(self)?;
        std::fs::write(path, data)?;
        Ok(())
    }

    fn build_index(&mut self) {
        self.index.clear();
        for (id, price) in &self.prices {
            // Full id
            self.index.insert(id.to_lowercase(), id.clone());
            // provider/model short forms
            self.index.insert(price.model.to_lowercase(), id.clone());
            self.index
                .insert(format!("{}/{}", price.provider, price.model).to_lowercase(), id.clone());
        }
    }

    pub fn find_price(&self, model: &str, provider_hint: Option<&str>, agent: &str) -> Option<&ModelPrice> {
        let raw = model.to_lowercase().replace(' ', "-");

        // Direct hit on full or short id
        if let Some(id) = self.index.get(&raw) {
            return self.prices.get(id);
        }

        // If it already contains a slash, prefer exact provider/model
        if let Some(slash) = raw.find('/') {
            let _provider = &raw[..slash];
            let model_name = &raw[slash + 1..];
            if let Some(id) = self.index.get(&format!("{}/{}", _provider, model_name)) {
                return self.prices.get(id);
            }
            if let Some(id) = self.index.get(model_name) {
                return self.prices.get(id);
            }
        }

        // Provider hints based on agent/source
        let preferred_providers: Vec<&str> = match agent {
            "claude" | "claude-code" => vec!["anthropic"],
            "codex" => vec!["openai"],
            "zcode" => vec!["zai", "zhipuai", "zhipuai-coding-plan"],
            "kimi" | "kimi-code" => vec!["moonshotai", "moonshotai-cn", "kimi-for-coding"],
            "opencode" => vec!["anthropic", "openai", "moonshotai", "zai"],
            _ => vec![],
        };

        if let Some(hint) = provider_hint {
            if let Some(id) = self.index.get(&format!("{}/{}", hint.to_lowercase(), raw)) {
                return self.prices.get(id);
            }
        }

        for p in &preferred_providers {
            if let Some(id) = self.index.get(&format!("{}/{}", p, raw)) {
                return self.prices.get(id);
            }
        }

        // Fallback: look for any price whose model name contains the record model
        for (_id, price) in &self.prices {
            if price.model.to_lowercase().contains(&raw) || raw.contains(&price.model.to_lowercase())
            {
                if preferred_providers.is_empty() || preferred_providers.contains(&price.provider.as_str()) {
                    return Some(price);
                }
            }
        }

        // If a provider hint is given, accept any model from that provider
        if let Some(hint) = provider_hint {
            for (_id, price) in &self.prices {
                if price.provider == hint.to_lowercase() && (price.model.to_lowercase().contains(&raw) || raw.contains(&price.model.to_lowercase())) {
                    return Some(price);
                }
            }
        }

        None
    }
}

fn find_override<'a>(
    overrides: &'a HashMap<String, ModelOverride>,
    raw_model: &str,
) -> Option<&'a ModelOverride> {
    let raw = raw_model.to_lowercase().replace(' ', "-");
    if let Some(o) = overrides.get(&raw) {
        return Some(o);
    }
    for (key, o) in overrides {
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

impl PriceCache {
    pub fn cost_for(
        &self,
        record: &UsageRecord,
        overrides: &HashMap<String, ModelOverride>,
    ) -> Option<f64> {
        if let Some(over) = find_override(overrides, &record.model) {
            let input = record
                .input_tokens
                .saturating_sub(record.cache_read_tokens + record.cache_creation_tokens)
                as f64;
            let fresh_cost = input * over.input / 1_000_000.0;
            let output_cost = record.output_tokens as f64 * over.output / 1_000_000.0;
            let cache_read_cost =
                record.cache_read_tokens as f64 * over.cache_read.unwrap_or(0.0) / 1_000_000.0;
            let cache_creation_cost =
                record.cache_creation_tokens as f64 * over.cache_write.unwrap_or(0.0) / 1_000_000.0;
            let reasoning_cost =
                record.reasoning_tokens as f64 * over.reasoning.unwrap_or(over.output) / 1_000_000.0;

            return Some(
                fresh_cost + output_cost + cache_read_cost + cache_creation_cost + reasoning_cost,
            );
        }

        let price = self.find_price(&record.model, record.provider.as_deref(), &record.agent)?;

        let input = record
            .input_tokens
            .saturating_sub(record.cache_read_tokens + record.cache_creation_tokens)
            as f64;
        let fresh_cost = input * price.input / 1_000_000.0;
        let output_cost = record.output_tokens as f64 * price.output / 1_000_000.0;
        let cache_read_cost =
            record.cache_read_tokens as f64 * price.cache_read.unwrap_or(0.0) / 1_000_000.0;
        let cache_creation_cost =
            record.cache_creation_tokens as f64 * price.cache_write.unwrap_or(0.0) / 1_000_000.0;
        let reasoning_cost =
            record.reasoning_tokens as f64 * price.reasoning.unwrap_or(price.output) / 1_000_000.0;

        Some(fresh_cost + output_cost + cache_read_cost + cache_creation_cost + reasoning_cost)
    }
}
