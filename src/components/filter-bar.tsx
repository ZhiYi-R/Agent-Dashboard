import { memo } from "react";
import type { AgentDef, RecordFilter } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DatePreset,
  dayFromIso,
  detectPreset,
  isoFromLocalDayEnd,
  isoFromLocalDayStart,
  rangeForPreset,
} from "@/lib/date-range";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

const PRESETS: { id: DatePreset; labelKey: string }[] = [
  { id: "today", labelKey: "filter.today" },
  { id: "7d", labelKey: "filter.last7d" },
  { id: "30d", labelKey: "filter.last30d" },
  { id: "month", labelKey: "filter.thisMonth" },
  { id: "all", labelKey: "filter.allTime" },
];

export const FilterBar = memo(function FilterBar({
  filter,
  onChange,
  agents,
  models,
  projects,
  className,
}: {
  filter: RecordFilter;
  onChange: (next: RecordFilter) => void;
  agents: AgentDef[];
  models: string[];
  projects: string[];
  className?: string;
}) {
  const t = useT();
  const preset = detectPreset(filter.from, filter.to);
  const selectedAgents = new Set(filter.agents ?? []);

  const patch = (partial: Partial<RecordFilter>) => {
    onChange({ ...filter, ...partial });
  };

  const applyPreset = (p: DatePreset) => {
    if (p === "all") {
      patch({ from: undefined, to: undefined });
      return;
    }
    if (p === "custom") return;
    const r = rangeForPreset(p);
    patch({ from: r.from, to: r.to });
  };

  const toggleAgent = (id: string) => {
    const next = new Set(selectedAgents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const arr = Array.from(next);
    patch({ agents: arr.length ? arr : undefined });
  };

  const summaryParts: string[] = [];
  if (preset !== "all" && preset !== "custom") {
    summaryParts.push(t(`filter.${preset === "7d" ? "last7d" : preset === "30d" ? "last30d" : preset === "month" ? "thisMonth" : "today"}`));
  } else if (preset === "custom") {
    summaryParts.push(t("filter.custom"));
  }
  if (selectedAgents.size > 0) {
    summaryParts.push(
      t("filter.agentsSelected", { n: selectedAgents.size })
    );
  }
  if (filter.models?.length) {
    summaryParts.push(filter.models[0]);
  }
  if (filter.project) {
    summaryParts.push(filter.project);
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 rounded-lg border bg-card/40 px-2.5 py-2",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant={preset === p.id ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => applyPreset(p.id)}
          >
            {t(p.labelKey as "filter.today")}
          </Button>
        ))}
        <div className="flex items-center gap-1">
          <Input
            type="date"
            className="h-7 w-[132px] text-xs"
            value={dayFromIso(filter.from)}
            onChange={(e) => {
              const v = e.target.value;
              patch({
                from: v ? isoFromLocalDayStart(v) : undefined,
              });
            }}
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type="date"
            className="h-7 w-[132px] text-xs"
            value={dayFromIso(filter.to)}
            onChange={(e) => {
              const v = e.target.value;
              patch({
                to: v ? isoFromLocalDayEnd(v) : undefined,
              });
            }}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            onChange({
              agents: undefined,
              models: undefined,
              from: undefined,
              to: undefined,
              project: undefined,
            })
          }
        >
          {t("actions.reset")}
        </Button>
        {summaryParts.length > 0 && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t("filter.active", { detail: summaryParts.join(" · ") })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">{t("overview.agent")}</span>
        <Button
          type="button"
          size="sm"
          variant={selectedAgents.size === 0 ? "default" : "outline"}
          className="h-7 px-2 text-xs"
          onClick={() => patch({ agents: undefined })}
        >
          {t("records.allAgents")}
        </Button>
        {agents.map((a) => (
          <Button
            key={a.id}
            type="button"
            size="sm"
            variant={selectedAgents.has(a.id) ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => toggleAgent(a.id)}
            disabled={!a.enabled && !selectedAgents.has(a.id)}
            title={a.name}
          >
            {a.name}
          </Button>
        ))}

        <select
          className="ml-1 h-7 rounded-md border bg-background px-2 text-xs"
          value={filter.models?.[0] ?? ""}
          onChange={(e) =>
            patch({
              models: e.target.value ? [e.target.value] : undefined,
            })
          }
        >
          <option value="">{t("records.allModels")}</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <select
          className="h-7 rounded-md border bg-background px-2 text-xs"
          value={filter.project ?? ""}
          onChange={(e) =>
            patch({
              project: e.target.value ? e.target.value : undefined,
            })
          }
        >
          <option value="">{t("records.allProjects")}</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
});
