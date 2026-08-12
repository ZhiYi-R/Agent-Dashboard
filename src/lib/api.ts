import { invoke } from "@tauri-apps/api/core";
import type {
  AgentDef,
  AppSettings,
  BalanceResult,
  PriceCache,
  RecordFilter,
  UsageRecord,
  UsageSummary,
} from "@/types";

export const getAgents = (): Promise<AgentDef[]> => invoke("get_agents");

export const startScan = (full = false): Promise<void> =>
  invoke("start_scan", { full });

export const startSync = (): Promise<void> => invoke("start_sync");

export const recalculateCosts = (): Promise<number> =>
  invoke("recalculate_costs_cmd");

export const getRecords = (
  filter: RecordFilter,
  limit: number,
  offset: number
): Promise<UsageRecord[]> =>
  invoke("get_records", { filter, limit, offset });

export const countRecords = (filter: RecordFilter): Promise<number> =>
  invoke("count_records", { filter });

export const getSummary = (filter: RecordFilter): Promise<UsageSummary> =>
  invoke("get_summary", { filter });

export const listFilterModels = (filter: RecordFilter): Promise<string[]> =>
  invoke("list_filter_models", { filter });

export const listFilterProjects = (filter: RecordFilter): Promise<string[]> =>
  invoke("list_filter_projects", { filter });

export const getSettings = (): Promise<AppSettings> => invoke("get_settings");

export const saveSettings = (settings: AppSettings): Promise<void> =>
  invoke("save_settings_cmd", { settings });

export const getPrices = (): Promise<PriceCache> => invoke("get_prices");

export const checkBalances = (): Promise<BalanceResult[]> =>
  invoke("check_balances");

export const checkBalanceProvider = (
  providerId: string
): Promise<BalanceResult[]> =>
  invoke("check_balance_provider", { providerId });

export const getLatestBalances = (): Promise<BalanceResult[]> =>
  invoke("get_latest_balances");

export const getBalanceCheckedAt = (): Promise<string | null> =>
  invoke("get_balance_checked_at");

export const getRecordCountTotal = (): Promise<number> =>
  invoke("get_record_count_total");
