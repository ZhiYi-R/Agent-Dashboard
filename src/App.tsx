import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  checkForUpdates,
  countRecords,
  getAgents,
  getAppVersion,
  getPrices,
  getRecords,
  getSettings,
  getSummary,
  listFilterModels,
  listFilterProjects,
  saveSettings,
  startScan,
  startSync,
} from "@/lib/api";
import type {
  AgentDef,
  AgentSummary,
  AppSettings,
  ModelSummary,
  RecordFilter,
  UpdateCheckResult,
  UsageRecord,
  UsageSummary,
} from "@/types";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { ModelOverridesEditor } from "@/components/model-overrides";
import { BalanceTab } from "@/components/balance-tab";
import { FilterBar } from "@/components/filter-bar";
import { TitleBar } from "@/components/title-bar";
import { VirtualTableBody } from "@/components/virtual-table-body";
import { fillDayGaps } from "@/lib/date-range";
import { ExternalLink, Pencil, RefreshCw, Save, X } from "lucide-react";
import { useI18n, useT, type Locale } from "@/i18n";

import {
  Bar,
  ComposedChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PAGE_SIZE = 50;

function formatNumber(n: number) {
  return n.toLocaleString("en-US");
}

function formatCost(n?: number) {
  if (n === undefined || n === null) return "--";
  return `$${n.toFixed(2)}`;
}

function formatTokens(n?: number) {
  if (n === undefined || n === null) return "--";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toString();
}

function formatPercent(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return "--";
  return `${(n * 100).toFixed(1)}%`;
}

export default function App() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [filter, setFilter] = useState<RecordFilter>({});
  const [offset, setOffset] = useState(0);
  const [filterModels, setFilterModels] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);
  const [scanProgress, setScanProgress] = useState<Record<string, { agent: string; count: number; error?: string }>>({});
  const [priceProgress, setPriceProgress] = useState<{ count: number; total: number } | null>(null);
  const [balanceAutoToken, setBalanceAutoToken] = useState(0);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(
    null
  );
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [scanErrors, setScanErrors] = useState<string[]>([]);
  const latestRefreshRef = useRef<() => void>(() => {});
  const handleScanRef = useRef<(full?: boolean) => void>(() => {});
  const scanningRef = useRef(false);
  const dashboardRefreshInFlightRef = useRef(false);
  const countRefreshInFlightRef = useRef(false);
  const pendingRefreshRef = useRef<{
    kind: "full" | "records";
    offset: number;
    filter: RecordFilter;
    allowDuringScan?: boolean;
  } | null>(null);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const skipOffsetRefreshRef = useRef(false);
  const scanFilterRef = useRef("");

  const load = async () => {
    setLoading(true);
    try {
      const [a, s, ver] = await Promise.all([
        getAgents(),
        getSettings(),
        getAppVersion().catch(() => ""),
      ]);
      setAgents(a);
      setAppVersion(ver);
      setSettings({
        ...s,
        balanceProviders: s.balanceProviders ?? [],
        modelOverrides: s.modelOverrides ?? {},
        balanceRefreshMinutes: s.balanceRefreshMinutes ?? 15,
        usageRefreshMinutes: s.usageRefreshMinutes ?? 30,
      });
    } catch (e) {
      setRefreshError(String(e));
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckUpdates = async () => {
    setUpdateChecking(true);
    setUpdateError(null);
    try {
      const res = await checkForUpdates();
      setUpdateResult(res);
      if (res.currentVersion) setAppVersion(res.currentVersion);
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setUpdateChecking(false);
    }
  };

  const clearUsageView = () => {
    setRecords([]);
    setRecordCount(0);
    setSummary(null);
    setFilterModels([]);
    setFilterProjects([]);
    setOffset(0);
  };

  const stopLiveRefresh = () => {
    if (liveRefreshTimerRef.current != null) {
      window.clearInterval(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = null;
    }
  };

  /** Full dashboard refresh (records + heavy summary). */
  const refreshData = async (
    nextOffset = offset,
    nextFilter = filter,
    opts?: { allowDuringScan?: boolean }
  ) => {
    if (scanningRef.current && !opts?.allowDuringScan) return;
    if (dashboardRefreshInFlightRef.current) {
      pendingRefreshRef.current = {
        kind: "full",
        offset: nextOffset,
        filter: nextFilter,
        allowDuringScan: opts?.allowDuringScan,
      };
      return;
    }
    dashboardRefreshInFlightRef.current = true;
    setRefreshError(null);
    try {
      const [recs, sum] = await Promise.all([
        getRecords(nextFilter, PAGE_SIZE, nextOffset),
        getSummary(nextFilter),
      ]);
      setRecords(recs);
      setRecordCount(sum.records);
      setSummary(sum);
    } catch (e) {
      const message = String(e);
      setRefreshError(message);
      console.error("refresh failed:", e);
    } finally {
      dashboardRefreshInFlightRef.current = false;
      const pending = pendingRefreshRef.current;
      pendingRefreshRef.current = null;
      if (pending && (!scanningRef.current || pending.allowDuringScan)) {
        if (pending.kind === "full") {
          void refreshData(pending.offset, pending.filter, {
            allowDuringScan: pending.allowDuringScan,
          });
        } else {
          void refreshRecords(pending.offset, pending.filter);
        }
      }
    }
  };

  const refreshRecords = async (nextOffset = offset, nextFilter = filter) => {
    if (scanningRef.current) return;
    if (dashboardRefreshInFlightRef.current) {
      pendingRefreshRef.current = {
        kind: "records",
        offset: nextOffset,
        filter: nextFilter,
      };
      return;
    }
    try {
      dashboardRefreshInFlightRef.current = true;
      const recs = await getRecords(nextFilter, PAGE_SIZE, nextOffset);
      setRecords(recs);
    } catch (e) {
      const message = String(e);
      setRefreshError(message);
      console.error("records refresh failed:", e);
    } finally {
      dashboardRefreshInFlightRef.current = false;
      const pending = pendingRefreshRef.current;
      pendingRefreshRef.current = null;
      if (pending && (!scanningRef.current || pending.allowDuringScan)) {
        if (pending.kind === "full") {
          void refreshData(pending.offset, pending.filter, {
            allowDuringScan: pending.allowDuringScan,
          });
        } else {
          void refreshRecords(pending.offset, pending.filter);
        }
      }
    }
  };

  /** Cheap mid-scan tick: only COUNT(*) so the UI numbers move without full re-agg. */
  const refreshCountOnly = async (nextFilter = filter) => {
    if (countRefreshInFlightRef.current) return;
    countRefreshInFlightRef.current = true;
    try {
      const total = await countRecords(nextFilter);
      setRecordCount(total);
    } catch (e) {
      console.error("count refresh failed:", e);
    } finally {
      countRefreshInFlightRef.current = false;
    }
  };

  useEffect(() => {
    latestRefreshRef.current = () => {
      void refreshData(offsetRef.current, filterRef.current);
    };
  }, [offset, filter]);

  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);

  // Auto incremental usage scan (configurable interval, 0 = off).
  useEffect(() => {
    const mins = settings?.usageRefreshMinutes ?? 0;
    if (!mins || mins <= 0) return;
    const id = window.setInterval(() => {
      if (scanningRef.current) return;
      handleScanRef.current(false);
    }, mins * 60_000);
    return () => window.clearInterval(id);
  }, [settings?.usageRefreshMinutes]);

  // Auto balance refresh token — BalanceTab listens and rechecks.
  useEffect(() => {
    const mins = settings?.balanceRefreshMinutes ?? 0;
    if (!mins || mins <= 0) return;
    const id = window.setInterval(() => {
      setBalanceAutoToken((t) => t + 1);
    }, mins * 60_000);
    return () => window.clearInterval(id);
  }, [settings?.balanceRefreshMinutes]);

  useEffect(() => {
    load();

    const unlisten: Promise<(() => void)>[] = [];
    unlisten.push(
      listen<{ agent: string; count: number; error?: string }>("scan-progress", (event) => {
        const { agent, count, error } = event.payload;
        setScanProgress((prev) => ({ ...prev, [agent]: { agent, count, error } }));
        if (error) {
          setScanErrors((prev) => [...new Set([...prev, `${agent}: ${error}`])]);
          console.error("scan error:", agent, error);
        }
      })
    );
    unlisten.push(
      listen<{ total: number; errors: string[] }>("scan-finished", (event) => {
        stopLiveRefresh();
        if (event.payload.errors.length > 0) {
          setScanErrors((prev) => [...new Set([...prev, ...event.payload.errors])]);
        }
        const filterChangedDuringScan =
          scanFilterRef.current !== JSON.stringify(filterRef.current);
        if (filterChangedDuringScan && offsetRef.current !== 0) {
          skipOffsetRefreshRef.current = true;
          setOffset(0);
        }
        scanningRef.current = false;
        setScanning(false);
        setScanProgress({});
        // Final full refresh after scan completes.
        void (async () => {
          try {
            const a = await getAgents();
            setAgents(a);
          } catch (e) {
            console.error(e);
          }
          await refreshData(
            filterChangedDuringScan ? 0 : offsetRef.current,
            filterRef.current,
            {
              allowDuringScan: true,
            }
          );
          const f = filterRef.current;
          try {
            const [ms, ps] = await Promise.all([
              listFilterModels(f),
              listFilterProjects(f),
            ]);
            if (scanningRef.current) return;
            setFilterModels(ms);
            setFilterProjects(ps);
          } catch (e) {
            console.error(e);
          }
        })();
      })
    );
    unlisten.push(
      listen<{ count: number; total: number }>("price-sync-progress", (event) => {
        setPriceProgress({ count: event.payload.count, total: event.payload.total });
      })
    );
    unlisten.push(
      listen<{ count: number }>("price-sync-finished", () => {
        setSyncing(false);
        setPriceProgress(null);
        void getPrices().then(() => refreshData());
      })
    );
    unlisten.push(
      listen<{ error: string }>("price-sync-error", (event) => {
        setSyncing(false);
        setPriceProgress(null);
        console.error(event.payload.error);
      })
    );

    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
      stopLiveRefresh();
    };
  }, []);

  // Debounce filter-driven summary/records refresh to avoid hammering SQLite.
  useEffect(() => {
    if (!settings) return;
    if (scanningRef.current) return;
    if (offsetRef.current !== 0) skipOffsetRefreshRef.current = true;
    setOffset(0);
    const handle = window.setTimeout(() => {
      if (scanningRef.current) return;
      void refreshData(0, filter);
      void Promise.all([
        listFilterModels(filter),
        listFilterProjects(filter),
      ])
        .then(([ms, ps]) => {
          if (scanningRef.current) return;
          setFilterModels(ms);
          setFilterProjects(ps);
        })
        .catch(console.error);
    }, 180);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, settings]);

  useEffect(() => {
    if (!settings) return;
    if (skipOffsetRefreshRef.current) {
      skipOffsetRefreshRef.current = false;
      return;
    }
    if (scanningRef.current) return;
    void refreshRecords(offset, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const handleScan = async (full = false) => {
    // Mark scanning before any awaits so concurrent refreshes bail out.
    stopLiveRefresh();
    scanFilterRef.current = JSON.stringify(filter);
    scanningRef.current = true;
    setScanning(true);
    setScanErrors([]);
    setScanProgress({});
    if (full) {
      // Full scan rebuilds the DB — drop stale overview/records immediately.
      clearUsageView();
    }
    try {
      await startScan(full);
      // Staged live updates while scanning:
      // - every 1.5s: cheap COUNT so the UI is clearly alive
      // - every 4th tick (~6s): full summary (records + by-agent/model/day)
      // Why not 800ms full refresh? getSummary runs several full-table GROUP BYs
      // while the scanner is writing; requests pile up and the main thread janks.
      let tick = 0;
      liveRefreshTimerRef.current = window.setInterval(() => {
        if (!scanningRef.current) {
          stopLiveRefresh();
          return;
        }
        tick += 1;
        const f = filterRef.current;
        if (tick % 4 === 0) {
          void refreshData(offsetRef.current, f, { allowDuringScan: true });
        } else {
          void refreshCountOnly(f);
        }
      }, 1500);
    } catch (e) {
      console.error(e);
      stopLiveRefresh();
      scanningRef.current = false;
      setScanning(false);
      setScanProgress({});
      // Recover view if the scan never started.
      latestRefreshRef.current();
    }
  };
  handleScanRef.current = (full = false) => {
    void handleScan(full);
  };

  const handleSync = async () => {
    setSyncing(true);
    setPriceProgress(null);
    try {
      await startSync();
    } catch (e) {
      console.error(e);
      setSyncing(false);
      setPriceProgress(null);
    }
  };

  const chartData = useMemo(() => {
    if (!summary) return [];
    return fillDayGaps(summary.byDay, filter.from, filter.to);
  }, [summary, filter.from, filter.to]);

  // Token total for ranking. OpenAI/Codex: input already includes cache_read;
  // Anthropic-style: input is fresh-only and cache is additive.
  const tokenUsage = (s: AgentSummary | ModelSummary) => {
    const cachePart = s.totalCacheRead + s.totalCacheCreation;
    const inputAll =
      cachePart > 0 && s.totalCacheRead <= s.totalInput
        ? s.totalInput
        : s.totalInput + cachePart;
    return inputAll + s.totalOutput + s.totalReasoning;
  };

  // Cache hit rate = cache_read / total_input_context.
  // Codex: input = fresh + cache → denom is totalInput.
  // Claude-style: input is fresh → denom is input + cache_read (+ creation).
  const cacheHitRate = (s: AgentSummary | ModelSummary) => {
    if (s.totalCacheRead <= 0) return 0;
    if (s.totalCacheRead <= s.totalInput) {
      return s.totalInput > 0 ? s.totalCacheRead / s.totalInput : 0;
    }
    const denom = s.totalInput + s.totalCacheRead + s.totalCacheCreation;
    return denom > 0 ? s.totalCacheRead / denom : 0;
  };

  const agentSummaries = useMemo(() => {
    if (!summary) return [];
    return Object.values(summary.byAgent).sort((a, b) => tokenUsage(b) - tokenUsage(a));
  }, [summary]);

  const modelSummaries = useMemo(() => {
    if (!summary) return [];
    return Object.values(summary.byModel).sort((a, b) => tokenUsage(b) - tokenUsage(a));
  }, [summary]);

  const totalPages = Math.max(1, Math.ceil(recordCount / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const enterSettingsEdit = () => {
    if (!settings) return;
    setSettingsDraft({
      ...settings,
      agents: { ...settings.agents },
      modelOverrides: { ...settings.modelOverrides },
      balanceProviders: settings.balanceProviders ?? [],
    });
    setSettingsEditing(true);
  };

  const cancelSettingsEdit = () => {
    setSettingsDraft(null);
    setSettingsEditing(false);
  };

  const saveSettingsEdit = async () => {
    if (!settingsDraft) return;
    await saveSettings(settingsDraft);
    setSettings(settingsDraft);
    setSettingsEditing(false);
    setSettingsDraft(null);
    // refresh agent list (enabled paths)
    const a = await getAgents();
    setAgents(a);
  };

  const enabledAgentCount = Math.max(1, agents.filter((a) => a.enabled).length);
  const agentsDone = Object.keys(scanProgress).length;
  const scanPct = Math.min(
    100,
    Math.round((agentsDone / enabledAgentCount) * 100)
  );
  const scanEntries = Object.values(scanProgress);
  const lastScan =
    scanEntries.length > 0 ? scanEntries[scanEntries.length - 1] : undefined;
  const scanRows = scanEntries.reduce((n, p) => n + (p.count || 0), 0);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <TitleBar />

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <TabsList>
            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
            <TabsTrigger value="records">{t("tabs.records")}</TabsTrigger>
            <TabsTrigger value="balance">{t("tabs.balance")}</TabsTrigger>
            <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            {scanning && (
              <div className="flex w-56 flex-col gap-1">
                <div className="flex justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate">
                    {lastScan?.agent ?? t("scan.scanning")}
                    {scanRows > 0
                      ? ` · ${t("scan.rows", { n: formatNumber(scanRows) })}`
                      : ""}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {agentsDone}/{enabledAgentCount}
                  </span>
                </div>
                <Progress value={scanPct} />
              </div>
            )}
            {priceProgress && (
              <div className="flex w-36 flex-col gap-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{t("scan.prices")}</span>
                  <span>
                    {Math.round(
                      (priceProgress.count / Math.max(1, priceProgress.total)) * 100
                    )}
                    %
                  </span>
                </div>
                <Progress
                  value={
                    (priceProgress.count / Math.max(1, priceProgress.total)) * 100
                  }
                />
              </div>
            )}
            <Button
              onClick={handleSync}
              disabled={syncing}
              variant="outline"
              size="sm"
            >
              {syncing ? t("actions.syncing") : t("actions.syncPrices")}
            </Button>
            <Button
              onClick={() => handleScan(true)}
              disabled={scanning}
              variant="outline"
              size="sm"
            >
              {t("actions.fullScan")}
            </Button>
            <Button
              onClick={() => handleScan(false)}
              disabled={scanning}
              size="sm"
            >
              {scanning ? t("actions.scanning") : t("actions.scan")}
            </Button>
          </div>
        </div>

        {refreshError && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <span>{t("errors.refresh")}: {refreshError}</span>
            <Button variant="ghost" size="sm" onClick={() => setRefreshError(null)}>
              {t("actions.reset")}
            </Button>
          </div>
        )}
        {scanErrors.length > 0 && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div>
              <div className="font-medium">{t("errors.scan")}</div>
              <div>{scanErrors.join("; ")}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setScanErrors([])}>
              {t("actions.reset")}
            </Button>
          </div>
        )}
        {loading && !summary ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="min-h-0 flex-1 w-full" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            <TabsContent
              value="overview"
              className="mt-0 flex min-h-0 flex-1 flex-col gap-3 data-[state=inactive]:hidden"
            >
              <FilterBar
                filter={filter}
                onChange={setFilter}
                agents={agents}
                models={filterModels}
                projects={filterProjects}
              />
              <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {(
                  [
                    [t("overview.records"), formatNumber(summary?.records ?? 0)],
                    [t("overview.sessions"), formatNumber(summary?.sessions ?? 0)],
                    [t("overview.cost"), formatCost(summary?.totalCostUsd)],
                    [t("overview.input"), formatTokens(summary?.totalInput)],
                    [t("overview.output"), formatTokens(summary?.totalOutput)],
                    [
                      t("overview.cache"),
                      formatTokens(
                        (summary?.totalCacheRead ?? 0) +
                          (summary?.totalCacheCreation ?? 0)
                      ),
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <Card key={label} size="sm">
                    <CardContent className="pt-3">
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                      <p className="truncate text-lg font-semibold tabular-nums">
                        {value}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="flex h-[220px] shrink-0 flex-col sm:h-[260px]">
                <CardHeader className="shrink-0 py-2">
                  <CardTitle className="text-sm">{t("overview.dailyUsage")}</CardTitle>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 p-0 pb-2 pr-2">
                  {chartData.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      —
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={chartData}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis
                          dataKey="day"
                          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                          axisLine={{ stroke: "var(--border)" }}
                          tickLine={{ stroke: "var(--border)" }}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          yAxisId="left"
                          orientation="left"
                          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                          axisLine={{ stroke: "var(--border)" }}
                          tickLine={{ stroke: "var(--border)" }}
                          width={56}
                          tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                          axisLine={{ stroke: "var(--border)" }}
                          tickLine={{ stroke: "var(--border)" }}
                          width={48}
                          tickFormatter={(v) => formatTokens(Number(v))}
                        />
                        <Tooltip
                          formatter={(v, name) => {
                            const val = v == null ? 0 : Number(v);
                            const isCost =
                              name === t("overview.cost") || name === "Cost";
                            return [
                              isCost ? formatCost(val) : formatTokens(val),
                              name,
                            ];
                          }}
                          contentStyle={{
                            backgroundColor: "var(--popover)",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            color: "var(--popover-foreground)",
                            fontSize: 12,
                          }}
                          labelStyle={{ color: "var(--popover-foreground)" }}
                          itemStyle={{ color: "var(--popover-foreground)" }}
                          cursor={{ fill: "var(--muted)" }}
                        />
                        <Legend
                          wrapperStyle={{
                            color: "var(--muted-foreground)",
                            fontSize: 11,
                          }}
                        />
                        <Bar
                          yAxisId="left"
                          dataKey="totalCostUsd"
                          name={t("overview.cost")}
                          fill="var(--chart-1)"
                          radius={[3, 3, 0, 0]}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalInput"
                          name={t("overview.input")}
                          stroke="var(--chart-2)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalOutput"
                          name={t("overview.output")}
                          stroke="var(--chart-3)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalCacheRead"
                          name={t("overview.cacheHit")}
                          stroke="var(--chart-4)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalCacheCreation"
                          name={t("overview.cacheWrite")}
                          stroke="var(--chart-5)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalReasoning"
                          name={t("overview.reasoning")}
                          stroke="var(--chart-6)"
                          dot={false}
                          strokeWidth={2}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
                <Card className="flex min-h-0 flex-col overflow-hidden">
                  <CardHeader className="shrink-0 border-b py-2">
                    <CardTitle className="text-sm">{t("overview.byAgent")}</CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                    <Table>
                      <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                        <TableRow>
                          <TableHead>{t("overview.agent")}</TableHead>
                          <TableHead className="text-right">{t("overview.rec")}</TableHead>
                          <TableHead className="text-right">{t("overview.input")}</TableHead>
                          <TableHead className="text-right">{t("overview.output")}</TableHead>
                          <TableHead className="text-right">{t("overview.cache")}</TableHead>
                          <TableHead className="text-right">{t("overview.hitRate")}</TableHead>
                          <TableHead className="text-right">{t("overview.cost")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <VirtualTableBody
                        items={agentSummaries}
                        rowHeight={36}
                        renderRow={(a) => (
                          <TableRow key={a.agent}>
                            <TableCell className="font-medium">{a.agent}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatNumber(a.records)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(a.totalInput)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(a.totalOutput)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(a.totalCacheRead + a.totalCacheCreation)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPercent(cacheHitRate(a))}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCost(a.totalCostUsd)}
                            </TableCell>
                          </TableRow>
                        )}
                      />
                    </Table>
                  </CardContent>
                </Card>

                <Card className="flex min-h-0 flex-col overflow-hidden">
                  <CardHeader className="shrink-0 border-b py-2">
                    <CardTitle className="text-sm">{t("overview.byModel")}</CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                    <Table>
                      <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                        <TableRow>
                          <TableHead>{t("overview.model")}</TableHead>
                          <TableHead className="text-right">{t("overview.rec")}</TableHead>
                          <TableHead className="text-right">{t("overview.input")}</TableHead>
                          <TableHead className="text-right">{t("overview.output")}</TableHead>
                          <TableHead className="text-right">{t("overview.cache")}</TableHead>
                          <TableHead className="text-right">{t("overview.hitRate")}</TableHead>
                          <TableHead className="text-right">{t("overview.cost")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <VirtualTableBody
                        items={modelSummaries}
                        rowHeight={36}
                        renderRow={(m) => (
                          <TableRow key={m.model}>
                            <TableCell className="max-w-[140px] truncate font-medium" title={m.model}>
                              {m.model}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatNumber(m.records)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(m.totalInput)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(m.totalOutput)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatTokens(m.totalCacheRead + m.totalCacheCreation)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPercent(cacheHitRate(m))}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCost(m.totalCostUsd)}
                            </TableCell>
                          </TableRow>
                        )}
                      />
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

          <TabsContent
            value="records"
            className="mt-0 flex h-full min-h-0 flex-1 flex-col gap-2 data-[state=inactive]:hidden"
          >
            <FilterBar
              filter={filter}
              onChange={setFilter}
              agents={agents}
              models={filterModels}
              projects={filterProjects}
            />
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
              <span>
                {t("records.rangeOf", {
                  from: formatNumber(recordCount === 0 ? 0 : offset + 1),
                  to: formatNumber(Math.min(offset + PAGE_SIZE, recordCount)),
                  total: formatNumber(recordCount),
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                {t("actions.prev")}
              </Button>
              <span className="font-medium">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= recordCount}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                {t("actions.next")}
              </Button>
            </div>

            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardContent className="min-h-0 flex-1 p-0">
                <div className="h-full overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                      <TableRow>
                        <TableHead className="w-36">{t("records.time")}</TableHead>
                        <TableHead className="w-24">{t("overview.agent")}</TableHead>
                        <TableHead className="w-48">{t("overview.model")}</TableHead>
                        <TableHead className="text-right">{t("overview.input")}</TableHead>
                        <TableHead className="text-right">{t("overview.output")}</TableHead>
                        <TableHead className="text-right">{t("overview.cache")}</TableHead>
                        <TableHead className="text-right">{t("records.reason")}</TableHead>
                        <TableHead className="text-right">{t("overview.cost")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <VirtualTableBody
                      items={records}
                      rowHeight={40}
                      empty={
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="h-24 text-center text-muted-foreground"
                          >
                            {t("records.empty")}
                          </TableCell>
                        </TableRow>
                      }
                      renderRow={(r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap text-[10px] text-muted-foreground">
                            {new Date(r.timestamp).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px]">
                              {r.agent}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className="max-w-[200px] truncate"
                            title={r.model || t("records.unknown")}
                          >
                            {r.model?.trim() ? r.model : t("records.unknown")}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {formatTokens(r.inputTokens)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {formatTokens(r.outputTokens)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {formatTokens(
                              r.cacheReadTokens + r.cacheCreationTokens
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {formatTokens(r.reasoningTokens)}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {formatCost(r.costUsd)}
                          </TableCell>
                        </TableRow>
                      )}
                    />
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent
            value="balance"
            className="mt-0 flex h-full min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            {settings ? (
              <BalanceTab
                settings={settings}
                onSettingsChange={setSettings}
                autoRefreshToken={balanceAutoToken}
                active={activeTab === "balance"}
              />
            ) : (
              <Skeleton className="h-48 w-full" />
            )}
          </TabsContent>

          <TabsContent
            value="settings"
            className="mt-0 flex h-full min-h-0 flex-1 flex-col gap-3 data-[state=inactive]:hidden"
          >
            <div className="flex shrink-0 items-center justify-between gap-2">
              <span className="text-sm font-semibold">{t("settings.title")}</span>
              <div className="flex gap-2">
                {settingsEditing ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={cancelSettingsEdit}>
                      <X className="mr-1 h-3.5 w-3.5" />
                      {t("actions.cancel")}
                    </Button>
                    <Button size="sm" onClick={() => void saveSettingsEdit()}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      {t("actions.save")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={enterSettingsEdit}>
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    {t("actions.edit")}
                  </Button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-auto">
              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">{t("settings.agents")}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("overview.agent")}</TableHead>
                        <TableHead>{t("settings.status")}</TableHead>
                        <TableHead>{t("settings.enabled")}</TableHead>
                        <TableHead>{t("settings.path")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {agents.map((a) => {
                        const draftAgent = settingsDraft?.agents[a.id];
                        const enabled = settingsEditing
                          ? (draftAgent?.enabled ?? a.enabled)
                          : a.enabled;
                        const pathVal = settingsEditing
                          ? (draftAgent?.path ?? a.path ?? a.defaultPath ?? "")
                          : (a.path ?? a.defaultPath ?? "—");
                        return (
                          <TableRow key={a.id}>
                            <TableCell className="font-medium">{a.name}</TableCell>
                            <TableCell>
                              <Badge
                                variant={a.detected ? "default" : "secondary"}
                                className="text-[10px]"
                              >
                                {a.detected
                                  ? t("settings.detected")
                                  : t("settings.missing")}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {settingsEditing ? (
                                <Switch
                                  checked={enabled}
                                  onCheckedChange={(v) => {
                                    if (!settingsDraft) return;
                                    setSettingsDraft({
                                      ...settingsDraft,
                                      agents: {
                                        ...settingsDraft.agents,
                                        [a.id]: {
                                          ...settingsDraft.agents[a.id],
                                          enabled: v,
                                          path: settingsDraft.agents[a.id]?.path,
                                        },
                                      },
                                    });
                                  }}
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {enabled ? t("actions.on") : t("actions.off")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="max-w-[360px]">
                              {settingsEditing ? (
                                <Input
                                  className="h-8 font-mono text-xs"
                                  value={String(pathVal)}
                                  placeholder={a.defaultPath ?? ""}
                                  onChange={(e) => {
                                    if (!settingsDraft) return;
                                    setSettingsDraft({
                                      ...settingsDraft,
                                      agents: {
                                        ...settingsDraft.agents,
                                        [a.id]: {
                                          enabled:
                                            settingsDraft.agents[a.id]?.enabled ??
                                            a.enabled,
                                          path: e.target.value,
                                        },
                                      },
                                    });
                                  }}
                                />
                              ) : (
                                <span
                                  className="block truncate font-mono text-xs text-muted-foreground"
                                  title={String(pathVal)}
                                >
                                  {pathVal}
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">{t("settings.autoRefresh")}</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("settings.balanceInterval")}</Label>
                    {settingsEditing && settingsDraft ? (
                      <select
                        className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                        value={settingsDraft.balanceRefreshMinutes ?? 15}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            balanceRefreshMinutes: Number(e.target.value),
                          })
                        }
                      >
                        <option value={0}>{t("actions.off")}</option>
                        <option value={5}>{t("settings.min5")}</option>
                        <option value={15}>{t("settings.min15")}</option>
                        <option value={30}>{t("settings.min30")}</option>
                        <option value={60}>{t("settings.min60")}</option>
                      </select>
                    ) : (
                      <p className="text-sm tabular-nums">
                        {(settings?.balanceRefreshMinutes ?? 0) === 0
                          ? t("actions.off")
                          : locale === "zh-CN"
                            ? `${settings?.balanceRefreshMinutes ?? 15} 分钟`
                            : `${settings?.balanceRefreshMinutes ?? 15} min`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("settings.usageInterval")}</Label>
                    {settingsEditing && settingsDraft ? (
                      <select
                        className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                        value={settingsDraft.usageRefreshMinutes ?? 30}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            usageRefreshMinutes: Number(e.target.value),
                          })
                        }
                      >
                        <option value={0}>{t("actions.off")}</option>
                        <option value={15}>{t("settings.min15")}</option>
                        <option value={30}>{t("settings.min30")}</option>
                        <option value={60}>{t("settings.min60")}</option>
                        <option value={120}>
                          {locale === "zh-CN" ? "2 小时" : "2 hours"}
                        </option>
                      </select>
                    ) : (
                      <p className="text-sm tabular-nums">
                        {(settings?.usageRefreshMinutes ?? 0) === 0
                          ? t("actions.off")
                          : locale === "zh-CN"
                            ? `${settings?.usageRefreshMinutes ?? 30} 分钟`
                            : `${settings?.usageRefreshMinutes ?? 30} min`}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">{t("settings.language")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <select
                    className="h-8 w-full max-w-xs rounded-md border bg-background px-2 text-xs"
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as Locale)}
                  >
                    <option value="zh-CN">{t("settings.langZh")}</option>
                    <option value="en">{t("settings.langEn")}</option>
                  </select>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 py-2">
                  <CardTitle className="text-sm">{t("settings.about")}</CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={updateChecking}
                    onClick={() => void handleCheckUpdates()}
                  >
                    <RefreshCw
                      className={`mr-1 h-3.5 w-3.5 ${
                        updateChecking ? "animate-spin" : ""
                      }`}
                    />
                    {updateChecking
                      ? t("settings.checkingUpdate")
                      : t("settings.checkUpdate")}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">
                      {t("settings.version")}
                    </span>
                    <span className="font-mono tabular-nums">
                      {appVersion || "—"}
                    </span>
                    {updateResult?.latestVersion && (
                      <>
                        <span className="text-muted-foreground">
                          {t("settings.latestVersion")}
                        </span>
                        <span className="font-mono tabular-nums">
                          {updateResult.latestVersion}
                        </span>
                      </>
                    )}
                  </div>
                  {updateError && (
                    <p className="text-xs text-destructive">{updateError}</p>
                  )}
                  {updateResult && !updateError && (
                    <p
                      className={`text-xs ${
                        updateResult.updateAvailable
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {updateResult.updateAvailable
                        ? t("settings.updateAvailable", {
                            version:
                              updateResult.latestVersion ??
                              updateResult.message,
                          })
                        : updateResult.latestVersion
                          ? t("settings.upToDate")
                          : t("settings.noRelease")}
                    </p>
                  )}
                  {updateResult?.notes && (
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-[11px] text-muted-foreground">
                      {updateResult.notes.slice(0, 1200)}
                    </pre>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {updateResult?.releaseUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() =>
                          void openUrl(updateResult.releaseUrl as string)
                        }
                      >
                        <ExternalLink className="mr-1 h-3 w-3" />
                        {t("settings.openRelease")}
                      </Button>
                    )}
                    {updateResult?.downloadUrl && (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          void openUrl(updateResult.downloadUrl as string)
                        }
                      >
                        <ExternalLink className="mr-1 h-3 w-3" />
                        {t("settings.openDownload")}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">{t("settings.modelOverrides")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <ModelOverridesEditor
                    overrides={
                      settingsEditing
                        ? (settingsDraft?.modelOverrides ?? {})
                        : (settings?.modelOverrides ?? {})
                    }
                    onChange={(overrides) => {
                      if (!settingsEditing || !settingsDraft) return;
                      setSettingsDraft({
                        ...settingsDraft,
                        modelOverrides: overrides,
                      });
                    }}
                    readOnly={!settingsEditing}
                  />
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </div>
      )}
    </Tabs>
    </div>
  );
}
