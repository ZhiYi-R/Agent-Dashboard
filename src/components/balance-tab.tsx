import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  checkBalanceProvider,
  checkBalances,
  getBalanceCheckedAt,
  getLatestBalances,
  saveSettings,
} from "@/lib/api";
import type {
  AppSettings,
  BalanceKey,
  BalanceProvider,
  BalanceProviderType,
  BalanceResult,
  BalanceWindow,
} from "@/types";
import { BALANCE_PROVIDER_META } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useT } from "@/i18n";

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function maskKey(key: string, head = 6, tail = 4) {
  const t = key.trim();
  if (!t) return "—";
  if (t.length <= head + tail + 2) {
    if (t.length <= 4) return "••••";
    return `${t.slice(0, 2)}…${t.slice(-2)}`;
  }
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function formatMoney(n?: number, currency?: string) {
  if (n === undefined || n === null || Number.isNaN(n)) return "--";
  if (!Number.isFinite(n)) return "∞";
  const c = currency ?? "USD";
  if (c === "USD" || c === "$") return `$${n.toFixed(4)}`;
  if (c === "CNY" || c === "¥") return `¥${n.toFixed(4)}`;
  return `${n.toFixed(4)} ${c}`;
}

function cloneProviders(list: BalanceProvider[]): BalanceProvider[] {
  return list.map((p) => ({
    ...p,
    keys: p.keys.map((k) => ({ ...k })),
  }));
}

const PROVIDER_TYPES = Object.keys(BALANCE_PROVIDER_META) as BalanceProviderType[];

interface Props {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  autoRefreshToken?: number;
  active?: boolean;
}

function WindowBar({ w }: { w: BalanceWindow }) {
  const t = useT();
  const used =
    w.usedPercent !== undefined
      ? Math.min(100, Math.max(0, w.usedPercent))
      : w.remaining !== undefined && w.total && w.total > 0
        ? Math.min(100, Math.max(0, ((w.total - w.remaining) / w.total) * 100))
        : undefined;
  const remainingPct = used !== undefined ? Math.max(0, 100 - used) : undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-foreground/90">{w.name}</span>
        <span className="tabular-nums text-muted-foreground">
          {used !== undefined
            ? t("balance.leftPct", {
                used: used.toFixed(0),
                left: remainingPct?.toFixed(0) ?? "0",
              })
            : w.remaining !== undefined
              ? t("balance.leftUnit", {
                  n: w.remaining,
                  unit: w.unit ? ` ${w.unit}` : "",
                })
              : "--"}
        </span>
      </div>
      {used !== undefined && <Progress value={used} className="h-1.5" />}
      {w.resetAt && (
        <p className="text-[10px] text-muted-foreground">
          {new Date(w.resetAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function KeyDashboardCard({
  provider,
  keyItem,
  result,
  onCheck,
  checking,
}: {
  provider: BalanceProvider;
  keyItem: BalanceKey;
  result?: BalanceResult;
  onCheck: () => void;
  checking: boolean;
}) {
  const t = useT();
  const meta = BALANCE_PROVIDER_META[provider.providerType];
  const ok = result?.success;
  const windows = result?.windows ?? [];

  return (
    <Card size="sm" className="h-full min-w-0">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <CardTitle className="truncate text-sm">{keyItem.name}</CardTitle>
            <Badge variant="outline" className="text-[10px]">
              {meta?.label ?? provider.providerType}
            </Badge>
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {maskKey(keyItem.key)}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {provider.name}
            {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 shrink-0 p-0"
          disabled={checking}
          onClick={onCheck}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : ok ? (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t("balance.available")}
                </p>
                <p className="truncate text-lg font-semibold tabular-nums">
                  {result.available !== undefined
                    ? formatMoney(result.available, result.currency)
                    : windows.length > 0
                      ? t("balance.quota")
                      : "--"}
                </p>
                {result.total !== undefined && Number.isFinite(result.total) && (
                  <p className="text-[11px] tabular-nums text-muted-foreground">
                    / {formatMoney(result.total, result.currency)}
                  </p>
                )}
              </div>
              <Badge className="gap-1 text-[10px]">
                <CheckCircle2 className="h-3 w-3" />
                {t("balance.statusOk")}
              </Badge>
            </div>
            {windows.length > 0 && (
              <div className="space-y-2.5 border-t pt-2">
                {windows.map((w) => (
                  <WindowBar key={w.name} w={w} />
                ))}
              </div>
            )}
            {result.message && (
              <p className="line-clamp-2 text-[11px] text-muted-foreground">
                {result.message}
              </p>
            )}
          </>
        ) : (
          <div className="space-y-1">
            <Badge variant="destructive" className="gap-1 text-[10px]">
              <AlertCircle className="h-3 w-3" />
              {t("balance.statusFailed")}
            </Badge>
            <p className="text-[11px] leading-snug text-destructive">
              {result.message}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BalanceTab({
  settings,
  onSettingsChange,
  autoRefreshToken = 0,
  active = false,
}: Props) {
  const t = useT();
  const savedProviders = settings.balanceProviders ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BalanceProvider[]>(() =>
    cloneProviders(savedProviders)
  );
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<BalanceResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (editing) return;
    setDraft(cloneProviders(savedProviders));
  }, [savedProviders, editing]);

  // Load latest snapshots from SQLite once.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void Promise.all([getLatestBalances(), getBalanceCheckedAt()])
      .then(([res, at]) => {
        if (res.length) setResults(res);
        if (at) setLastCheckedAt(new Date(at));
      })
      .catch(console.error);
  }, []);

  // Background refresh finished (startup worker).
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<BalanceResult[]>("balance-refreshed", (ev) => {
      setResults(ev.payload);
      setLastCheckedAt(new Date());
    }).then((f) => {
      un = f;
    });
    return () => {
      un?.();
    };
  }, []);

  const resultMap = useMemo(() => {
    const m = new Map<string, BalanceResult>();
    for (const r of results) {
      m.set(`${r.providerId}::${r.keyId}`, r);
    }
    return m;
  }, [results]);

  const dashboardCards = useMemo(() => {
    const cards: { provider: BalanceProvider; key: BalanceKey }[] = [];
    for (const p of savedProviders) {
      for (const k of p.keys) {
        cards.push({ provider: p, key: k });
      }
    }
    return cards;
  }, [savedProviders]);

  const summaryStats = useMemo(() => {
    const ok = results.filter((r) => r.success).length;
    const fail = results.filter((r) => !r.success).length;
    return {
      ok,
      fail,
      total: dashboardCards.length,
      providers: savedProviders.length,
    };
  }, [results, dashboardCards.length, savedProviders.length]);

  const runCheckAll = useCallback(async () => {
    if (savedProviders.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const res = await checkBalances();
      setResults(res);
      setLastCheckedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [savedProviders.length]);

  // When tab becomes active: if no rows yet, pull DB; if stale vs interval, recheck.
  useEffect(() => {
    if (!active || editing || savedProviders.length === 0) return;
    const mins = settings.balanceRefreshMinutes ?? 15;
    if (results.length === 0) {
      void getLatestBalances()
        .then((res) => {
          if (res.length) setResults(res);
          else void runCheckAll();
        })
        .catch(() => void runCheckAll());
      return;
    }
    if (mins === 0) return;
    const staleMs = mins * 60_000;
    if (
      !lastCheckedAt ||
      Date.now() - lastCheckedAt.getTime() > staleMs
    ) {
      void runCheckAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!autoRefreshToken || editing) return;
    void runCheckAll();
  }, [autoRefreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const enterEdit = () => {
    setDraft(cloneProviders(savedProviders));
    setEditing(true);
    setError(null);
  };

  const cancelEdit = () => {
    setDraft(cloneProviders(savedProviders));
    setEditing(false);
    setError(null);
  };

  const saveEdit = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const p of draft) {
        const meta = BALANCE_PROVIDER_META[p.providerType];
        if (meta.needsBaseUrl && !p.baseUrl?.trim()) {
          throw new Error(
            t("balance.baseUrlRequiredErr", { name: p.name || meta.label })
          );
        }
        for (const k of p.keys) {
          if (!k.key.trim()) {
            throw new Error(
              t("balance.emptyKey", { provider: p.name, key: k.name })
            );
          }
        }
      }
      const next: AppSettings = {
        ...settings,
        balanceProviders: cloneProviders(draft),
      };
      await saveSettings(next);
      onSettingsChange(next);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (id: string, patch: Partial<BalanceProvider>) => {
    setDraft((d) => d.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const removeProvider = (id: string) => {
    setDraft((d) => d.filter((p) => p.id !== id));
  };

  const addProvider = (type: BalanceProviderType) => {
    const meta = BALANCE_PROVIDER_META[type];
    setDraft((d) => [
      ...d,
      {
        id: uid("bp"),
        name: meta.label,
        providerType: type,
        baseUrl: meta.defaultBaseUrl,
        keys: [],
      },
    ]);
  };

  const addKey = (providerId: string) => {
    setDraft((d) =>
      d.map((p) =>
        p.id === providerId
          ? {
              ...p,
              keys: [...p.keys, { id: uid("bk"), name: "Key", key: "" }],
            }
          : p
      )
    );
  };

  const updateKey = (
    providerId: string,
    keyId: string,
    patch: Partial<BalanceKey>
  ) => {
    setDraft((d) =>
      d.map((p) =>
        p.id === providerId
          ? {
              ...p,
              keys: p.keys.map((k) => (k.id === keyId ? { ...k, ...patch } : k)),
            }
          : p
      )
    );
  };

  const removeKey = (providerId: string, keyId: string) => {
    setDraft((d) =>
      d.map((p) =>
        p.id === providerId
          ? { ...p, keys: p.keys.filter((k) => k.id !== keyId) }
          : p
      )
    );
  };

  const checkOneKey = async (providerId: string) => {
    setCheckingKey(providerId);
    setError(null);
    try {
      const res = await checkBalanceProvider(providerId);
      setResults((prev) => {
        const m = new Map(prev.map((r) => [`${r.providerId}::${r.keyId}`, r]));
        for (const r of res) {
          m.set(`${r.providerId}::${r.keyId}`, r);
        }
        return Array.from(m.values());
      });
      setLastCheckedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setCheckingKey(null);
    }
  };

  if (!editing) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="text-sm font-semibold text-foreground">
              {t("balance.title")}
            </span>
            <span>{t("balance.keys", { n: summaryStats.total })}</span>
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("balance.ok", { n: summaryStats.ok })}
            </span>
            {summaryStats.fail > 0 && (
              <span className="text-destructive">
                {t("balance.failed", { n: summaryStats.fail })}
              </span>
            )}
            {lastCheckedAt && (
              <span>{lastCheckedAt.toLocaleString()}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={enterEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              {t("actions.edit")}
            </Button>
            <Button
              size="sm"
              onClick={() => void runCheckAll()}
              disabled={checking || dashboardCards.length === 0}
            >
              <RefreshCw
                className={`mr-1 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
              />
              {checking ? "…" : t("actions.refresh")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {dashboardCards.length === 0 ? (
            <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-muted-foreground">
              <Button variant="link" className="px-1" onClick={enterEdit}>
                {t("actions.edit")}
              </Button>
              {t("balance.addProviders")}
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
              }}
            >
              {dashboardCards.map(({ provider, key }) => (
                <KeyDashboardCard
                  key={`${provider.id}::${key.id}`}
                  provider={provider}
                  keyItem={key}
                  result={resultMap.get(`${provider.id}::${key.id}`)}
                  checking={checking || checkingKey === provider.id}
                  onCheck={() => void checkOneKey(provider.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t("balance.editTitle")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value as BalanceProviderType;
              if (v) {
                addProvider(v);
                e.target.value = "";
              }
            }}
          >
            <option value="" disabled>
              {t("balance.providerOption")}
            </option>
            {PROVIDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {BALANCE_PROVIDER_META[type].label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
            <X className="mr-1 h-3.5 w-3.5" />
            {t("actions.cancel")}
          </Button>
          <Button size="sm" onClick={() => void saveEdit()} disabled={saving}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving ? "…" : t("actions.save")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto">
        {draft.length === 0 && (
          <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
            {t("balance.addProviderType")}
          </div>
        )}

        {draft.map((p) => {
          const meta = BALANCE_PROVIDER_META[p.providerType];
          return (
            <Card key={p.id}>
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-sm">{p.name || meta.label}</CardTitle>
                  <Badge variant="outline" className="text-[10px]">
                    {meta.label}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {p.keys.length}
                  </Badge>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeProvider(p.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("balance.name")}</Label>
                    <Input
                      className="h-8 text-xs"
                      value={p.name}
                      onChange={(e) =>
                        updateProvider(p.id, { name: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("balance.type")}</Label>
                    <select
                      className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                      value={p.providerType}
                      onChange={(e) => {
                        const type = e.target.value as BalanceProviderType;
                        const m = BALANCE_PROVIDER_META[type];
                        updateProvider(p.id, {
                          providerType: type,
                          baseUrl: m.needsBaseUrl
                            ? p.baseUrl
                            : m.defaultBaseUrl ?? p.baseUrl,
                        });
                      }}
                    >
                      {PROVIDER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {BALANCE_PROVIDER_META[type].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(meta.needsBaseUrl || p.baseUrl !== undefined) && (
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label className="text-xs">
                        {meta.needsBaseUrl
                          ? t("balance.baseUrlRequired")
                          : t("balance.baseUrl")}
                      </Label>
                      <Input
                        className="h-8 font-mono text-xs"
                        placeholder={
                          meta.defaultBaseUrl ?? "https://your-instance.example"
                        }
                        value={p.baseUrl ?? ""}
                        onChange={(e) =>
                          updateProvider(p.id, {
                            baseUrl: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{t("balance.keysLabel")}</p>
                  <Button size="sm" variant="outline" onClick={() => addKey(p.id)}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t("actions.add")}
                  </Button>
                </div>

                {p.keys.length === 0 ? (
                  <p className="text-xs text-muted-foreground">—</p>
                ) : (
                  <div className="space-y-2">
                    {p.keys.map((k) => (
                      <div
                        key={k.id}
                        className="grid gap-2 rounded-md border p-2 sm:grid-cols-[140px_1fr_auto] sm:items-center"
                      >
                        <Input
                          className="h-8 text-xs"
                          placeholder={t("balance.keyPlaceholder")}
                          value={k.name}
                          onChange={(e) =>
                            updateKey(p.id, k.id, { name: e.target.value })
                          }
                        />
                        <div className="min-w-0 space-y-1">
                          <Input
                            className="h-8 font-mono text-xs"
                            type="password"
                            autoComplete="off"
                            placeholder={meta.keyHint}
                            value={k.key}
                            onChange={(e) =>
                              updateKey(p.id, k.id, { key: e.target.value })
                            }
                          />
                          {k.key.trim() && (
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {maskKey(k.key)}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          onClick={() => removeKey(p.id, k.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
