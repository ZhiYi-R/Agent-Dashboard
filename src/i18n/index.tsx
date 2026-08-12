import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import zhCN, { type MessageTree } from "./locales/zh-CN";
import en from "./locales/en";

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "agent-stats.locale";

const catalogs: Record<Locale, MessageTree> = {
  "zh-CN": zhCN,
  en,
};

type Vars = Record<string, string | number>;

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Vars) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getByPath(tree: MessageTree, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = tree;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`
  );
}

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh-CN") return raw;
  } catch {
    /* ignore */
  }
  return "zh-CN";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  }, [locale]);

  const t = useCallback(
    (key: string, vars?: Vars) => {
      const primary = getByPath(catalogs[locale], key);
      const fallback = getByPath(catalogs["zh-CN"], key);
      const enFallback = getByPath(catalogs.en, key);
      return interpolate(primary ?? fallback ?? enFallback ?? key, vars);
    },
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}

export function useT() {
  return useI18n().t;
}
