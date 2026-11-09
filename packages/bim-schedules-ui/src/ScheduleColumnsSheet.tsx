"use client";

import { Button } from "@permitzip/bim-ui";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Checkbox, Input, NativeSelect, NativeSelectOption } from "./components/ui/fields";
import type { ScheduleColumnDef, ScheduleColumnStep, ScheduleDefinitionV2 } from "./contracts";
import type { CatalogField } from "./ports";
import { Sheet } from "./ui/overlays";

export interface ScheduleColumnsSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly definition: ScheduleDefinitionV2;
  /** The fields the schedule's rows have (the host's catalog for its classes). */
  readonly fields: readonly CatalogField[];
  /** Sends one change as one undo step; returns why it was refused, or null. */
  readonly onStep: (step: ScheduleColumnStep, label: string) => string | null;
  /** What it lists, formulas and paper: the full builder. */
  readonly onMore?: () => void;
  /** Why changes are off (read only), or null. */
  readonly blocked?: string | null;
}

type Feedback = { readonly kind: "done" | "refused"; readonly text: string } | null;

function pathOf(c: ScheduleColumnDef): string | null {
  return c.kind === "field" || c.kind === "parameter" ? c.path : null;
}

function columnId(path: string, taken: readonly ScheduleColumnDef[]): string {
  const base = path.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70) || "column";
  const ids = new Set(taken.map((c) => c.id));
  if (!ids.has(base)) return base;
  for (let n = 2; n < 100; n++) if (!ids.has(`${base}_${n}`)) return `${base}_${n}`;
  return `${base}_${Date.now()}`;
}

/**
 * Change a schedule one column at a time: add, remove, move, rename, sort,
 * group, total and show only some rows. Every control sends one step, saved
 * at once as its own undo step (Ctrl+Z puts it back), the same step an agent
 * or a script sends. List schedules of every kind, old and new, open here.
 */
export function ScheduleColumnsSheet({ open, onOpenChange, definition, fields, onStep, onMore, blocked = null }: ScheduleColumnsSheetProps) {
  const ids = useId();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [adding, setAdding] = useState("");
  const [filterPath, setFilterPath] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const columns = definition.columns;
  const fieldLabel = (path: string | null) => (path ? (fields.find((f) => f.path === path)?.label ?? path) : null);
  const label = (c: ScheduleColumnDef) => c.heading ?? fieldLabel(pathOf(c)) ?? c.id;
  const shown = new Set(columns.map(pathOf).filter((p): p is string => p !== null));
  const addable = fields.filter((f) => !shown.has(f.path));
  const sortPath = definition.sort[0]?.path ?? null;
  const groupPath = definition.groups[0]?.path ?? null;

  const send = (step: ScheduleColumnStep, words: string) => {
    if (blocked) {
      setFeedback({ kind: "refused", text: blocked });
      return false;
    }
    const refused = onStep(step, words);
    setFeedback(refused ? { kind: "refused", text: `Not changed: ${refused}` } : { kind: "done", text: `${words}. Undo (Ctrl+Z) puts it back.` });
    return refused === null;
  };

  const totalWhy = (c: ScheduleColumnDef): string | null => {
    if (c.kind === "expand" || (c.kind === "aggregate" && c.fn === "list")) return "This column lists items, so it has no total.";
    const field = fields.find((f) => f.path === pathOf(c));
    if (field?.totalRefusedReason) return field.totalRefusedReason;
    if (field && (field.valueType !== "quantity" || field.aggregation === "none")) return "Only numbers add up.";
    return null;
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Columns · ${definition.name}`}
      description="Each change is saved as you make it, and Undo puts it back."
      footer={
        onMore ? (
          <Button variant="outline" size="sm" onClick={onMore}>
            What it lists, formulas and paper…
          </Button>
        ) : undefined
      }
    >
      <div className="mutiny-sched-columns" data-testid="schedule-columns-panel">
        {blocked && (
          <p className="mutiny-sched-muted" role="note">
            Read only: {blocked}
          </p>
        )}
        <ol className="mutiny-sched-columns-list" aria-label="Columns, left to right">
          {columns.map((c, i) => {
            const path = pathOf(c);
            const why = totalWhy(c);
            return (
              <li key={c.id} className="mutiny-sched-columns-row" data-testid={`schedule-column-${c.id}`}>
                <Input
                  key={c.heading ?? ""}
                  aria-label={`Heading of column ${i + 1}`}
                  defaultValue={c.heading ?? ""}
                  placeholder={fieldLabel(path) ?? c.id}
                  maxLength={60}
                  disabled={blocked !== null}
                  onBlur={(e) => {
                    const heading = e.currentTarget.value.trim();
                    if (heading === (c.heading ?? "")) return;
                    send({ op: "rename_column", columnId: c.id, heading: heading === "" ? null : heading }, heading === "" ? `${label(c)} uses its field name again` : `Renamed to ${heading}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${label(c)} left`} disabled={i === 0 || blocked !== null} onClick={() => send({ op: "move_column", columnId: c.id, to: i - 1 }, `Moved ${label(c)} left`)}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${label(c)} right`} disabled={i === columns.length - 1 || blocked !== null} onClick={() => send({ op: "move_column", columnId: c.id, to: i + 1 }, `Moved ${label(c)} right`)}>
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  variant={sortPath === path && path ? "outline" : "ghost"}
                  aria-pressed={Boolean(path) && sortPath === path}
                  size="sm"
                  disabled={!path || blocked !== null}
                  title={path ? "Sort the rows by this column; again to reverse" : "Sort by a formula from What it lists, formulas and paper"}
                  onClick={() => {
                    if (!path) return;
                    const desc = sortPath === path && definition.sort[0]?.direction === "asc";
                    send({ op: "sort", sort: [{ path, direction: desc ? "desc" : "asc" }] }, `Sorted by ${label(c)}${desc ? ", Z to A" : ", A to Z"}`);
                  }}
                >
                  Sort
                </Button>
                <Button
                  variant={groupPath === path && path ? "outline" : "ghost"}
                  aria-pressed={Boolean(path) && groupPath === path}
                  size="sm"
                  disabled={!path || blocked !== null}
                  title={path ? "Group the rows by this column; again to stop grouping" : "Only a field column groups rows"}
                  onClick={() => {
                    if (!path) return;
                    const off = groupPath === path;
                    send({ op: "group", groups: off ? [] : [{ path, header: true, footer: true, totals: true }] }, off ? "Not grouped" : `Grouped by ${label(c)}`);
                  }}
                >
                  Group
                </Button>
                <label className="mutiny-sched-columns-check" title={why ?? "Add this column up in each group and at the bottom"}>
                  <Checkbox checked={Boolean(c.total)} disabled={(why !== null && !c.total) || blocked !== null} onChange={(e) => send({ op: "totals", columnId: c.id, show: e.target.checked }, e.target.checked ? `${label(c)} totalled` : `${label(c)} not totalled`)} /> Total
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${label(c)}`}
                  disabled={columns.length === 1 || blocked !== null}
                  title={columns.length === 1 ? "A schedule keeps at least one column" : "Remove this column (Undo puts it back)"}
                  onClick={() => send({ op: "remove_column", columnId: c.id }, `Removed ${label(c)}`)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            );
          })}
        </ol>
        <div className="mutiny-sched-columns-add">
          <label htmlFor={`${ids}-add`}>Add a column</label>
          <NativeSelect id={`${ids}-add`} value={adding} onChange={(e) => setAdding(e.target.value)} disabled={blocked !== null || addable.length === 0}>
            <NativeSelectOption value="">{addable.length === 0 ? "Every field is shown" : "Pick a field…"}</NativeSelectOption>
            {addable.map((f) => (
              <NativeSelectOption key={f.path} value={f.path}>
                {f.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            disabled={!adding || blocked !== null}
            title={adding ? undefined : "Pick a field first"}
            onClick={() => {
              const field = fields.find((f) => f.path === adding);
              if (!field) return;
              if (send({ op: "add_column", column: { id: columnId(field.path, columns), kind: "field", path: field.path } }, `Added ${field.label}`)) setAdding("");
            }}
          >
            Add
          </Button>
        </div>
        <div className="mutiny-sched-columns-filter">
          <label htmlFor={`${ids}-filter`}>Show only rows where</label>
          <NativeSelect id={`${ids}-filter`} value={filterPath} onChange={(e) => setFilterPath(e.target.value)} disabled={blocked !== null}>
            <NativeSelectOption value="">Pick a field…</NativeSelectOption>
            {fields.map((f) => (
              <NativeSelectOption key={f.path} value={f.path}>
                {f.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input aria-label="is" placeholder="is…" value={filterValue} maxLength={120} onChange={(e) => setFilterValue(e.target.value)} disabled={blocked !== null} />
          <Button
            size="sm"
            disabled={!filterPath || !filterValue.trim() || blocked !== null}
            title={filterPath && filterValue.trim() ? undefined : "Pick a field and type a value"}
            onClick={() => {
              const words = `Showing only ${fieldLabel(filterPath)} is ${filterValue.trim()}`;
              if (send({ op: "filter", filters: [...definition.filters, { path: filterPath, op: "equals", value: filterValue.trim() }] }, words)) setFilterValue("");
            }}
          >
            Apply
          </Button>
          {definition.filters.length > 0 && (
            <ul aria-label="Rows shown only where">
              {definition.filters.map((f, i) => (
                <li key={`${f.path}-${i}`}>
                  {fieldLabel(f.path)} {f.op === "equals" ? "is" : f.op.replace(/_/g, " ")} {f.value ?? ""}
                  <Button variant="ghost" size="icon-sm" aria-label={`Stop showing only ${fieldLabel(f.path)} ${f.value ?? ""}`} disabled={blocked !== null} onClick={() => send({ op: "filter", filters: definition.filters.filter((_, k) => k !== i) }, `Showing every ${fieldLabel(f.path)} again`)}>
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="mutiny-sched-columns-check">
          <Checkbox checked={definition.grandTotals} disabled={blocked !== null} onChange={(e) => send({ op: "totals", show: e.target.checked }, e.target.checked ? "Grand totals shown" : "Grand totals hidden")} /> Grand totals at the bottom
        </label>
        {feedback && (
          <p className={feedback.kind === "refused" ? "mutiny-sched-error" : "mutiny-sched-muted"} role={feedback.kind === "refused" ? "alert" : "status"} data-testid="schedule-columns-feedback">
            {feedback.text}
          </p>
        )}
      </div>
    </Sheet>
  );
}
