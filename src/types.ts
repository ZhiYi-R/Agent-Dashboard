export interface UsageRecord {
  id: string;
  agent: string;
  sessionId: string;
  project?: string;
  model: string;
  provider?: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd?: number;
  sourceFile: string;
}

export interface UsageSummary {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalReasoning: number;
  totalCostUsd: number;
  sessions: number;
  records: number;
  byAgent: Record<string, AgentSummary>;
  byModel: Record<string, ModelSummary>;
  byDay: Record<string, DaySummary>;
}

export interface AgentSummary {
  agent: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalReasoning: number;
  totalCostUsd: number;
  records: number;
}

export interface ModelSummary {
  model: string;
  provider?: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalReasoning: number;
  totalCostUsd: number;
  records: number;
}

export interface DaySummary {
  day: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalReasoning: number;
  totalCostUsd: number;
  records: number;
}

export interface AgentDef {
  id: string;
  name: string;
  defaultPath?: string;
  enabled: boolean;
  detected: boolean;
  path?: string;
}

export interface AgentSettings {
  enabled: boolean;
  path?: string;
}

export interface ModelOverride {
  aliases: string[];
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Provider type = API contract. A provider instance can hold many keys. */
export type BalanceProviderType =
  | "newapi"
  | "sub2api"
  | "claude-code-hub"
  | "kimi-code"
  | "bigmodel-coding"
  | "zai-coding"
  | "deepseek";

export interface BalanceKey {
  id: string;
  name: string;
  key: string;
}

export interface BalanceProvider {
  id: string;
  name: string;
  providerType: BalanceProviderType;
  /** Required for self-hosted types (newapi / sub2api / claude-code-hub). */
  baseUrl?: string;
  keys: BalanceKey[];
}

export interface BalanceWindow {
  name: string;
  usedPercent?: number;
  remaining?: number;
  total?: number;
  unit?: string;
  resetAt?: string;
}

export interface BalanceResult {
  providerId: string;
  providerType: string;
  keyId: string;
  keyName: string;
  success: boolean;
  available?: number;
  total?: number;
  currency?: string;
  windows?: BalanceWindow[];
  message: string;
  raw?: unknown;
}

export interface AppSettings {
  agents: Record<string, AgentSettings>;
  priceSyncDays: number;
  includeFreeModels: boolean;
  modelOverrides: Record<string, ModelOverride>;
  balanceProviders: BalanceProvider[];
  /**
   * Auto-refresh balance/quota interval in minutes.
   * 0 = disabled. Typical: 5 / 15 / 30 / 60.
   */
  balanceRefreshMinutes: number;
  /**
   * Auto incremental usage scan interval in minutes.
   * 0 = disabled. Typical: 15 / 30 / 60.
   */
  usageRefreshMinutes: number;
}

export interface RecordFilter {
  agents?: string[];
  models?: string[];
  from?: string;
  to?: string;
  project?: string;
}

export interface ScanResult {
  records: number;
  errors: string[];
  byAgent: Record<string, number>;
}

export interface PriceCache {
  prices: Record<string, ModelPrice>;
  syncedAt?: string;
}

export interface ModelPrice {
  id: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export const BALANCE_PROVIDER_META: Record<
  BalanceProviderType,
  { label: string; needsBaseUrl: boolean; defaultBaseUrl?: string; keyHint: string }
> = {
  newapi: {
    label: "NewAPI",
    needsBaseUrl: true,
    keyHint: "sk-...",
  },
  sub2api: {
    label: "Sub2API",
    needsBaseUrl: true,
    keyHint: "API Key",
  },
  "claude-code-hub": {
    label: "Claude Code Hub",
    needsBaseUrl: true,
    keyHint: "sk-...",
  },
  "kimi-code": {
    label: "Kimi Coding Plan",
    needsBaseUrl: false,
    defaultBaseUrl: "https://api.kimi.com/coding/v1",
    keyHint: "sk-kimi-...",
  },
  "bigmodel-coding": {
    label: "BigModel Coding (CN)",
    needsBaseUrl: false,
    defaultBaseUrl: "https://open.bigmodel.cn",
    keyHint: "API Key",
  },
  "zai-coding": {
    label: "Z.ai Coding Plan",
    needsBaseUrl: false,
    defaultBaseUrl: "https://api.z.ai",
    keyHint: "API Key",
  },
  deepseek: {
    label: "DeepSeek",
    needsBaseUrl: false,
    defaultBaseUrl: "https://api.deepseek.com",
    keyHint: "sk-...",
  },
};
