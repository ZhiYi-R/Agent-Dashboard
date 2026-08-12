import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  countRecords,
  getAgents,
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
  UsageRecord,
  UsageSummary,
} from "@/types";

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
import { TitleBar } from "@/components/title-bar";
import { VirtualTableBody } from "@/components/virtual-table-body";
import { Pencil, Save, X } from "lucide-react";

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
  const scanPollRef = useRef<number | null>(null);
  const latestRefreshRef = useRef<() => void>(() => {});
  const handleScanRef = useRef<(full?: boolean) => void>(() => {});
  const scanningRef = useRef(false);

  const load = async () => {
    setLoading(true);
    try {
      const [a, s] = await Promise.all([getAgents(), getSettings()]);
      setAgents(a);
      setSettings({
        ...s,
        balanceProviders: s.balanceProviders ?? [],
        modelOverrides: s.modelOverrides ?? {},
        balanceRefreshMinutes: s.balanceRefreshMinutes ?? 15,
        usageRefreshMinutes: s.usageRefreshMinutes ?? 30,
      });
      await refreshData();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const refreshData = async (nextOffset = offset, nextFilter = filter) => {
    try {
      const [recs, total, sum] = await Promise.all([
        getRecords(nextFilter, PAGE_SIZE, nextOffset),
        countRecords(nextFilter),
        getSummary(nextFilter),
      ]);
      setRecords(recs);
      setRecordCount(total);
      setSummary(sum);
    } catch (e) {
      console.error("refresh failed:", e);
    }
  };

  useEffect(() => {
    latestRefreshRef.current = () => refreshData(offset, filter);
  }, [refreshData, offset, filter]);

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
          console.error("scan error:", agent, error);
        }
      })
    );
    unlisten.push(
      listen<{ total: number; errors: string[] }>("scan-finished", () => {
        setScanning(false);
        setScanProgress({});
        if (scanPollRef.current) {
          window.clearInterval(scanPollRef.current);
          scanPollRef.current = null;
        }
        load();
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
      if (scanPollRef.current) {
        window.clearInterval(scanPollRef.current);
        scanPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    setOffset(0);
    refreshData(0, filter);
    void Promise.all([
      listFilterModels(filter),
      listFilterProjects(filter),
    ])
      .then(([ms, ps]) => {
        setFilterModels(ms);
        setFilterProjects(ps);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, settings]);

  useEffect(() => {
    if (!settings) return;
    refreshData(offset, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const handleScan = async (full = false) => {
    setScanning(true);
    setScanProgress({});
    if (scanPollRef.current) {
      window.clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
    try {
      await startScan(full);
      scanPollRef.current = window.setInterval(() => {
        latestRefreshRef.current();
      }, 800);
    } catch (e) {
      console.error(e);
      setScanning(false);
      setScanProgress({});
      if (scanPollRef.current) {
        window.clearInterval(scanPollRef.current);
        scanPollRef.current = null;
      }
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
    return Object.values(summary.byDay).sort((a, b) => a.day.localeCompare(b.day));
  }, [summary]);

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
  const scanPct = Math.min(
    100,
    Math.round((Object.keys(scanProgress).length / enabledAgentCount) * 100)
  );
  const lastScan = Object.values(scanProgress).find((p) => p.count > 0);

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
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="records">Records</TabsTrigger>
            <TabsTrigger value="balance">Balance</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            {scanning && (
              <div className="flex w-44 flex-col gap-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span className="truncate">{lastScan?.agent ?? "Scanning"}</span>
                  <span>{scanPct}%</span>
                </div>
                <Progress value={scanPct} />
              </div>
            )}
            {priceProgress && (
              <div className="flex w-36 flex-col gap-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Prices</span>
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
              {syncing ? "Syncing…" : "Sync prices"}
            </Button>
            <Button
              onClick={() => handleScan(true)}
              disabled={scanning}
              variant="outline"
              size="sm"
            >
              Full scan
            </Button>
            <Button
              onClick={() => handleScan(false)}
              disabled={scanning}
              size="sm"
            >
              {scanning ? "Scanning…" : "Scan"}
            </Button>
          </div>
        </div>

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
              <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {(
                  [
                    ["Records", formatNumber(summary?.records ?? 0)],
                    ["Sessions", formatNumber(summary?.sessions ?? 0)],
                    ["Cost", formatCost(summary?.totalCostUsd)],
                    ["Input", formatTokens(summary?.totalInput)],
                    ["Output", formatTokens(summary?.totalOutput)],
                    [
                      "Cache",
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
                  <CardTitle className="text-sm">Daily usage</CardTitle>
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
                          tick={{ fontSize: 10 }}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          yAxisId="left"
                          orientation="left"
                          tick={{ fontSize: 10 }}
                          width={56}
                          tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          tick={{ fontSize: 10 }}
                          width={48}
                          tickFormatter={(v) => formatTokens(Number(v))}
                        />
                        <Tooltip
                          formatter={(v, name) => {
                            const val = v == null ? 0 : Number(v);
                            return [
                              name === "Cost" ? formatCost(val) : formatTokens(val),
                              name,
                            ];
                          }}
                          contentStyle={{ fontSize: 12 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar
                          yAxisId="left"
                          dataKey="totalCostUsd"
                          name="Cost"
                          fill="var(--primary)"
                          radius={[3, 3, 0, 0]}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalInput"
                          name="Input"
                          stroke="#3b82f6"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalOutput"
                          name="Output"
                          stroke="#10b981"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalCacheRead"
                          name="Cache Hit"
                          stroke="#f59e0b"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalCacheCreation"
                          name="Cache Write"
                          stroke="#8b5cf6"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="totalReasoning"
                          name="Reasoning"
                          stroke="#ec4899"
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
                    <CardTitle className="text-sm">By Agent</CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                    <Table>
                      <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                        <TableRow>
                          <TableHead>Agent</TableHead>
                          <TableHead className="text-right">Rec</TableHead>
                          <TableHead className="text-right">Input</TableHead>
                          <TableHead className="text-right">Output</TableHead>
                          <TableHead className="text-right">Cache</TableHead>
                          <TableHead className="text-right">Hit %</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
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
                    <CardTitle className="text-sm">By Model</CardTitle>
                  </CardHeader>
                  <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                    <Table>
                      <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                        <TableRow>
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Rec</TableHead>
                          <TableHead className="text-right">Input</TableHead>
                          <TableHead className="text-right">Output</TableHead>
                          <TableHead className="text-right">Cache</TableHead>
                          <TableHead className="text-right">Hit %</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
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
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <select
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
                value={filter.agents?.[0] ?? ""}
                onChange={(e) =>
                  setFilter((f) => ({
                    ...f,
                    agents: e.target.value ? [e.target.value] : undefined,
                  }))
                }
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>

              <select
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
                value={filter.models?.[0] ?? ""}
                onChange={(e) =>
                  setFilter((f) => ({
                    ...f,
                    models: e.target.value ? [e.target.value] : undefined,
                  }))
                }
              >
                <option value="">All models</option>
                {filterModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <Input
                type="date"
                className="h-8 w-36 text-xs"
                value={filter.from ? filter.from.slice(0, 10) : ""}
                onChange={(e) =>
                  setFilter((f) => ({
                    ...f,
                    from: e.target.value
                      ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString()
                      : undefined,
                  }))
                }
              />
              <Input
                type="date"
                className="h-8 w-36 text-xs"
                value={filter.to ? filter.to.slice(0, 10) : ""}
                onChange={(e) =>
                  setFilter((f) => ({
                    ...f,
                    to: e.target.value
                      ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString()
                      : undefined,
                  }))
                }
              />

              <select
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
                value={filter.project ?? ""}
                onChange={(e) =>
                  setFilter((f) => ({
                    ...f,
                    project: e.target.value ? e.target.value : undefined,
                  }))
                }
              >
                <option value="">All projects</option>
                {filterProjects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>

              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setFilter({
                    agents: undefined,
                    models: undefined,
                    from: undefined,
                    to: undefined,
                    project: undefined,
                  })
                }
              >
                Reset
              </Button>

              <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {formatNumber(offset + 1)}-{formatNumber(Math.min(offset + PAGE_SIZE, recordCount))} of {formatNumber(recordCount)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  Prev
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
                  Next
                </Button>
              </div>
            </div>

            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardContent className="min-h-0 flex-1 p-0">
                <div className="h-full overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-20 shadow-sm [&_th]:sticky [&_th]:top-0 [&_th]:z-20">
                      <TableRow>
                        <TableHead className="w-36">Time</TableHead>
                        <TableHead className="w-24">Agent</TableHead>
                        <TableHead className="w-48">Model</TableHead>
                        <TableHead className="text-right">Input</TableHead>
                        <TableHead className="text-right">Output</TableHead>
                        <TableHead className="text-right">Cache</TableHead>
                        <TableHead className="text-right">Reason</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
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
                            —
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
                            title={r.model || "<unknown>"}
                          >
                            {r.model?.trim() ? r.model : "<unknown>"}
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
              <span className="text-sm font-semibold">Settings</span>
              <div className="flex gap-2">
                {settingsEditing ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={cancelSettingsEdit}>
                      <X className="mr-1 h-3.5 w-3.5" />
                      Cancel
                    </Button>
                    <Button size="sm" onClick={() => void saveSettingsEdit()}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      Save
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={enterSettingsEdit}>
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    Edit
                  </Button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-auto">
              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">Agents</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Enabled</TableHead>
                        <TableHead>Path</TableHead>
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
                                {a.detected ? "Detected" : "Missing"}
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
                                  {enabled ? "On" : "Off"}
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
                  <CardTitle className="text-sm">Auto Refresh</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Balance interval</Label>
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
                        <option value={0}>Off</option>
                        <option value={5}>5 min</option>
                        <option value={15}>15 min</option>
                        <option value={30}>30 min</option>
                        <option value={60}>60 min</option>
                      </select>
                    ) : (
                      <p className="text-sm tabular-nums">
                        {(settings?.balanceRefreshMinutes ?? 0) === 0
                          ? "Off"
                          : `${settings?.balanceRefreshMinutes ?? 15} min`}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Usage scan interval</Label>
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
                        <option value={0}>Off</option>
                        <option value={15}>15 min</option>
                        <option value={30}>30 min</option>
                        <option value={60}>60 min</option>
                        <option value={120}>2 hours</option>
                      </select>
                    ) : (
                      <p className="text-sm tabular-nums">
                        {(settings?.usageRefreshMinutes ?? 0) === 0
                          ? "Off"
                          : `${settings?.usageRefreshMinutes ?? 30} min`}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2">
                  <CardTitle className="text-sm">Model Overrides</CardTitle>
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
