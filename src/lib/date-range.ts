export type DatePreset = "today" | "7d" | "30d" | "month" | "all" | "custom";

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

/** Local calendar day as YYYY-MM-DD. */
export function formatLocalDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function addLocalDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

export function isoFromLocalDayStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return startOfLocalDay(new Date(y, m - 1, d)).toISOString();
}

export function isoFromLocalDayEnd(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return endOfLocalDay(new Date(y, m - 1, d)).toISOString();
}

export function dayFromIso(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return formatLocalDay(d);
}

export function rangeForPreset(
  preset: Exclude<DatePreset, "custom" | "all">,
  now = new Date()
): { from: string; to: string } {
  const to = endOfLocalDay(now).toISOString();
  switch (preset) {
    case "today":
      return { from: startOfLocalDay(now).toISOString(), to };
    case "7d":
      return {
        from: startOfLocalDay(addLocalDays(now, -6)).toISOString(),
        to,
      };
    case "30d":
      return {
        from: startOfLocalDay(addLocalDays(now, -29)).toISOString(),
        to,
      };
    case "month":
      return { from: startOfLocalMonth(now).toISOString(), to };
  }
}

export function detectPreset(from?: string, to?: string): DatePreset {
  if (!from && !to) return "all";
  if (!from || !to) return "custom";

  const now = new Date();
  const candidates: Exclude<DatePreset, "custom" | "all">[] = [
    "today",
    "7d",
    "30d",
    "month",
  ];
  for (const p of candidates) {
    const r = rangeForPreset(p, now);
    // Allow small clock skew while comparing ISO strings from the same helpers.
    if (r.from === from && r.to === to) return p;
    const fromDiff = Math.abs(new Date(r.from).getTime() - new Date(from).getTime());
    const toDiff = Math.abs(new Date(r.to).getTime() - new Date(to).getTime());
    if (fromDiff < 2000 && toDiff < 2000) return p;
  }
  return "custom";
}

export interface DayBucket {
  day: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalReasoning: number;
  totalCostUsd: number;
  records: number;
}

/** Fill missing calendar days between from/to (or data min/max) with zeros. */
export function fillDayGaps(
  byDay: Record<string, DayBucket>,
  fromIso?: string,
  toIso?: string
): DayBucket[] {
  const existing = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  if (existing.length === 0 && !fromIso && !toIso) return [];

  let startDay = fromIso ? dayFromIso(fromIso) : existing[0]?.day;
  let endDay = toIso ? dayFromIso(toIso) : existing[existing.length - 1]?.day;
  if (!startDay || !endDay) return existing;
  if (startDay > endDay) [startDay, endDay] = [endDay, startDay];

  const map = new Map(existing.map((d) => [d.day, d]));
  const out: DayBucket[] = [];
  let cur = startOfLocalDay(
    new Date(
      Number(startDay.slice(0, 4)),
      Number(startDay.slice(5, 7)) - 1,
      Number(startDay.slice(8, 10))
    )
  );
  const end = startOfLocalDay(
    new Date(
      Number(endDay.slice(0, 4)),
      Number(endDay.slice(5, 7)) - 1,
      Number(endDay.slice(8, 10))
    )
  );

  // Cap to ~400 days to avoid pathological ranges.
  let guard = 0;
  while (cur <= end && guard < 400) {
    const key = formatLocalDay(cur);
    out.push(
      map.get(key) ?? {
        day: key,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheCreation: 0,
        totalReasoning: 0,
        totalCostUsd: 0,
        records: 0,
      }
    );
    cur = addLocalDays(cur, 1);
    guard += 1;
  }
  return out;
}
