use super::{Collector, FilePlanner};
use crate::models::{AppSettings, UsageRecord};
use crate::pricing::PriceCache;

pub struct DevinDesktopCollector;

impl Collector for DevinDesktopCollector {
    fn id(&self) -> &'static str {
        "devin_desktop"
    }
    fn name(&self) -> &'static str {
        "Devin Desktop"
    }
    fn default_path(&self) -> Option<String> {
        // Cascade trajectories are encoded protobuf files (*.pb).
        Some("~/.codeium/windsurf/cascade".to_string())
    }

    fn collect(
        &self,
        _settings: &AppSettings,
        _prices: &PriceCache,
        _sink: &mut dyn FnMut(UsageRecord) -> anyhow::Result<()>,
        _planner: &mut FilePlanner<'_>,
    ) -> anyhow::Result<()> {
        // Devin Desktop does not currently expose per-token local usage.
        // We keep the collector slot for future support (e.g. Cascade analytics API or local logs).
        Ok(())
    }
}
