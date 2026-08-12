import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import type { ModelOverride } from "@/types";

interface ModelOverridesProps {
  overrides: Record<string, ModelOverride>;
  onChange: (overrides: Record<string, ModelOverride>) => void;
  readOnly?: boolean;
}

export function ModelOverridesEditor({
  overrides,
  onChange,
  readOnly = false,
}: ModelOverridesProps) {
  const [draft, setDraft] = useState<Record<string, ModelOverride>>(overrides);

  useEffect(() => {
    setDraft(overrides);
  }, [overrides]);

  const commit = (next: Record<string, ModelOverride>) => {
    const cleaned: Record<string, ModelOverride> = {};
    for (const [k, v] of Object.entries(next)) {
      const key = k.trim();
      if (!key) continue;
      cleaned[key] = { ...v, input: v.input, output: v.output };
    }
    setDraft(cleaned);
    onChange(cleaned);
  };

  const addOverride = () => {
    const next = { ...draft };
    let i = 1;
    while (`new-model-${i}` in next) i++;
    next[`new-model-${i}`] = { aliases: [], input: 0, output: 0 };
    commit(next);
  };

  const updateKey = (oldKey: string, newKey: string) => {
    if (!newKey.trim() || oldKey === newKey.trim()) return;
    const next: Record<string, ModelOverride> = {};
    for (const [k, v] of Object.entries(draft)) {
      next[k === oldKey ? newKey.trim() : k] = v;
    }
    commit(next);
  };

  const updateValue = (key: string, patch: Partial<ModelOverride>) => {
    commit({ ...draft, [key]: { ...draft[key], ...patch } });
  };

  const updateNumber = (key: string, field: keyof ModelOverride, value: string) => {
    const num = value === "" ? 0 : parseFloat(value);
    updateValue(key, { [field]: isNaN(num) ? 0 : num } as Partial<ModelOverride>);
  };

  const remove = (key: string) => {
    const next = { ...draft };
    delete next[key];
    commit(next);
  };

  const entries = Object.entries(draft);

  return (
    <div className="space-y-2">
      {!readOnly && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={addOverride}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">—</p>
      ) : (
        <div className="max-h-[340px] overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead className="w-40 text-xs">Model</TableHead>
                <TableHead className="w-40 text-xs">Aliases</TableHead>
                <TableHead className="w-20 text-right text-xs">In</TableHead>
                <TableHead className="w-20 text-right text-xs">Out</TableHead>
                <TableHead className="w-20 text-right text-xs">C.R</TableHead>
                <TableHead className="w-20 text-right text-xs">C.W</TableHead>
                <TableHead className="w-20 text-right text-xs">Rsn</TableHead>
                {!readOnly && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([key, o]) => (
                <TableRow key={key}>
                  <TableCell className="p-1">
                    {readOnly ? (
                      <span className="text-xs font-medium">{key}</span>
                    ) : (
                      <Input
                        defaultValue={key}
                        className="h-7 text-xs"
                        onBlur={(e) => updateKey(key, e.target.value)}
                      />
                    )}
                  </TableCell>
                  <TableCell className="p-1">
                    {readOnly ? (
                      <span className="text-xs text-muted-foreground">
                        {o.aliases.join(", ") || "—"}
                      </span>
                    ) : (
                      <Input
                        value={o.aliases.join(", ")}
                        className="h-7 text-xs"
                        onChange={(e) =>
                          updateValue(key, {
                            aliases: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    )}
                  </TableCell>
                  {(
                    [
                      ["input", o.input],
                      ["output", o.output],
                      ["cacheRead", o.cacheRead],
                      ["cacheWrite", o.cacheWrite],
                      ["reasoning", o.reasoning],
                    ] as const
                  ).map(([field, val]) => (
                    <TableCell key={field} className="p-1">
                      {readOnly ? (
                        <span className="block text-right text-xs tabular-nums">
                          {val ?? "—"}
                        </span>
                      ) : (
                        <Input
                          type="number"
                          step="0.01"
                          value={val ?? ""}
                          className="h-7 text-right text-xs"
                          onChange={(e) =>
                            updateNumber(key, field, e.target.value)
                          }
                          placeholder="0"
                        />
                      )}
                    </TableCell>
                  ))}
                  {!readOnly && (
                    <TableCell className="p-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => remove(key)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
