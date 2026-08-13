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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useT } from "@/i18n";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

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

function cloneProvider(p: BalanceProvider): BalanceProvider {
  return {
    ...p,
    keys: p.keys.map((k) => ({ ...k })),
  };
}

function newProvider(type: BalanceProviderType): BalanceProvider {
  const meta = BALANCE_PROVIDER_META[type];
  return {
    id: uid("bp"),
    name: meta.label,
    providerType: type,
    baseUrl: meta.defaultBaseUrl,
    keys: [],
  };
}

function validateProvider(p: BalanceProvider, t: TFunc): string | null {
  const meta = BALANCE_PROVIDER_META[p.providerType];
  if (meta.needsBaseUrl && !p.baseUrl?.trim()) {
    return t("balance.baseUrlRequiredErr", { name: p.name || meta.label });
  }
  for (const k of p.keys) {
    if (!k.key.trim()) {
      return t("balance.emptyKey", { provider: p.name, key: k.name });
    }
    if (meta.needsUserId && !k.userId?.trim()) {
      return t("balance.userIdRequiredErr", { provider: p.name, key: k.name });
    }
  }
  return null;
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

function ProviderForm({
  provider,
  onDone,
  onCancel,
}: {
  provider: BalanceProvider | null;
  onDone: (p: BalanceProvider) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [p, setP] = useState<BalanceProvider>(() =>
    provider ? cloneProvider(provider) : newProvider(PROVIDER_TYPES[0])
  );
  const [error, setError] = useState<string | null>(null);

  const meta = BALANCE_PROVIDER_META[p.providerType];

  const update = (patch: Partial<BalanceProvider>) =>
    setP((d) => ({ ...d, ...patch }));

  const changeType = (type: BalanceProviderType) => {
    const m = BALANCE_PROVIDER_META[type];
    setP((d) => ({
      ...d,
      providerType: type,
      baseUrl: m.needsBaseUrl ? d.baseUrl : m.defaultBaseUrl ?? d.baseUrl,
    }));
  };

  const addKey = () =>
    setP((d) => ({
      ...d,
      keys: [...d.keys, { id: uid("bk"), name: "Key", key: "", userId: "" }],
    }));

  const updateKey = (keyId: string, patch: Partial<BalanceKey>) =>
    setP((d) => ({
      ...d,
      keys: d.keys.map((k) => (k.id === keyId ? { ...k, ...patch } : k)),
    }));

  const removeKey = (keyId: string) =>
    setP((d) => ({ ...d, keys: d.keys.filter((k) => k.id !== keyId) }));

  const submit = () => {
    const err = validateProvider(p, t);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    onDone(p);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {provider ? t("balance.editProvider") : t("balance.addProvider")}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("balance.type")}</Label>
            <Select
              value={p.providerType}
              onValueChange={(v) => changeType(v as BalanceProviderType)}
            >
              <SelectTrigger size="sm" className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {BALANCE_PROVIDER_META[type].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("balance.name")}</Label>
            <Input
              className="h-8 text-xs"
              value={p.name}
              onChange={(e) => update({ name: e.target.value })}
            />
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
                  update({ baseUrl: e.target.value || undefined })
                }
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs font-medium">{t("balance.keysLabel")}</p>
          <Button size="sm" variant="outline" onClick={addKey}>
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
                  onChange={(e) => updateKey(k.id, { name: e.target.value })}
                />
                <div className="min-w-0 space-y-1">
                  <Input
                    className="h-8 font-mono text-xs"
                    type="password"
                    autoComplete="off"
                    placeholder={meta.keyHint}
                    value={k.key}
                    onChange={(e) => updateKey(k.id, { key: e.target.value })}
                  />
                  {k.key.trim() && (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {maskKey(k.key)}
                    </p>
                  )}
                  {meta.needsUserId && (
                    <Input
                      className="h-8 font-mono text-xs"
                      placeholder={t("balance.userIdPlaceholder")}
                      value={k.userId ?? ""}
                      onChange={(e) =>
                        updateKey(k.id, { userId: e.target.value || undefined })
                      }
                    />
                  )}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => removeKey(k.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("actions.cancel")}
        </Button>
        <Button onClick={submit}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {t("actions.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

type DialogView = { kind: "list" } | { kind: "add" } | { kind: "edit"; id: string };

function ProvidersDialog({
  open,
  onOpenChange,
  providers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: BalanceProvider[];
  onSave: (list: BalanceProvider[]) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<BalanceProvider[]>([]);
  const [view, setView] = useState<DialogView>({ kind: "list" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(cloneProviders(providers));
      setView({ kind: "list" });
      setError(null);
    }
  }, [open, providers]);

  const close = () => {
    if (!saving) onOpenChange(false);
  };

  const saveAll = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const p of draft) {
        const err = validateProvider(p, t);
        if (err) throw new Error(err);
      }
      await onSave(cloneProviders(draft));
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const formProvider =
    view.kind === "edit" ? draft.find((p) => p.id === view.id) ?? null : null;

  if (view.kind !== "list") {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <ProviderForm
            key={view.kind === "add" ? "add" : `edit:${view.id}`}
            provider={formProvider}
            onCancel={() => {
              setError(null);
              setView({ kind: "list" });
            }}
            onDone={(p) => {
              setDraft((d) =>
                view.kind === "add"
                  ? [...d, p]
                  : d.map((x) => (x.id === view.id ? p : x))
              );
              setView({ kind: "list" });
            }}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("balance.manageProviders")}</DialogTitle>
          <DialogDescription>
            {t("balance.manageProvidersHint")}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {draft.length === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              {t("balance.addProviderType")}
            </div>
          ) : (
            draft.map((p) => {
              const meta = BALANCE_PROVIDER_META[p.providerType];
              return (
                <Card key={p.id} size="sm">
                  <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <CardTitle className="truncate text-sm">
                        {p.name || meta.label}
                      </CardTitle>
                      <Badge variant="outline" className="text-[10px]">
                        {meta.label}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {p.keys.length}
                      </Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setView({ kind: "edit", id: p.id });
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() =>
                          setDraft((d) => d.filter((x) => x.id !== p.id))
                        }
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  </CardHeader>
                  {p.baseUrl && (
                    <CardContent className="pt-0">
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {p.baseUrl}
                      </p>
                    </CardContent>
                  )}
                </Card>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setView({ kind: "add" });
            }}
            disabled={saving}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t("balance.addProvider")}
          </Button>
          <Button onClick={() => void saveAll()} disabled={saving}>
            <Save className="mr-1 h-3.5 w-3.5" />
            {saving ? "…" : t("actions.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [manageOpen, setManageOpen] = useState(false);
  const [results, setResults] = useState<BalanceResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkingKey, setCheckingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const loadedRef = useRef(false);

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
    if (!active || savedProviders.length === 0) return;
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
    if (!autoRefreshToken) return;
    void runCheckAll();
  }, [autoRefreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveProviders = async (list: BalanceProvider[]) => {
    const next: AppSettings = {
      ...settings,
      balanceProviders: cloneProviders(list),
    };
    await saveSettings(next);
    onSettingsChange(next);
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => setManageOpen(true)}
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            {t("balance.manageProviders")}
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
            <Button
              variant="link"
              className="px-1"
              onClick={() => setManageOpen(true)}
            >
              {t("balance.manageProviders")}
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

      <ProvidersDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        providers={savedProviders}
        onSave={handleSaveProviders}
      />
    </div>
  );
}
