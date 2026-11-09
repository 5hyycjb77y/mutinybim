import type { ScheduleColumnDef, ScheduleDefinition, ScheduleDefinitionV2, ScheduleFilter, ScheduleGroup, ScheduleSort } from "../definition";
import type { FormScheduleDefinition } from "../forms/types";
import { scheduleV1ToV2 } from "./v1";

/**
 * Column-by-column schedule edits (`edit_schedule` steps): the one way the
 * grid's column menu, the agent's schedule tool and a script's
 * `documents.editSchedule` change what a schedule shows. Each step names one
 * change; a command carrying several is one undo step. Pure: the command
 * writes the result as the view's v2 schedule.
 */
export type ScheduleStep =
  /** Insert a column at `at` (0 is first); absent: last. */
  | { readonly op: "add_column"; readonly column: ScheduleColumnDef; readonly at?: number }
  | { readonly op: "move_column"; readonly columnId: string; readonly to: number }
  | { readonly op: "remove_column"; readonly columnId: string }
  /** The heading people read; null: the field's own label again. */
  | { readonly op: "rename_column"; readonly columnId: string; readonly heading: string | null }
  | { readonly op: "filter"; readonly filters: readonly ScheduleFilter[] }
  | { readonly op: "sort"; readonly sort: readonly ScheduleSort[] }
  | { readonly op: "group"; readonly groups: readonly ScheduleGroup[] }
  /** A column's total; without `columnId`, the grand totals row. */
  | { readonly op: "totals"; readonly columnId?: string; readonly show: boolean }
  /** Its width on paper, mm (dragged where the schedule sits on a sheet); null: sized to its text again. */
  | { readonly op: "resize_column"; readonly columnId: string; readonly widthMm: number | null };

export type ScheduleStepsResult = { readonly ok: true; readonly definition: ScheduleDefinitionV2 } | { readonly ok: false; readonly reason: string; readonly step: number };

/** What a schedule view stores, as the step engine reads it. */
export interface StoredSchedule {
  readonly schedule?: ScheduleDefinition;
  readonly formSchedule?: FormScheduleDefinition;
  readonly scheduleV2?: ScheduleDefinitionV2;
}

/**
 * The v2 schedule a view's steps apply to: its own v2 schedule, or an old
 * list schedule read as v2 (the first edit stores it as v2, one undo puts the
 * old one back). Null with a reason when it has none or is a form.
 */
export function editableScheduleOf(name: string, props: StoredSchedule | undefined): { readonly ok: true; readonly definition: ScheduleDefinitionV2 } | { readonly ok: false; readonly reason: string } {
  if (props?.scheduleV2) return props.scheduleV2.presentation.kind === "form" ? { ok: false, reason: formReason(name) } : { ok: true, definition: props.scheduleV2 };
  if (props?.schedule) return { ok: true, definition: { ...scheduleV1ToV2(props.schedule), ...(props.schedule.title ? {} : { name }) } };
  if (props?.formSchedule) return { ok: false, reason: formReason(name) };
  return { ok: false, reason: `"${name}" isn't a schedule.` };
}

function formReason(name: string): string {
  return `"${name}" is laid out by its form, so it has no columns to change one by one. Change its template in its properties.`;
}

function columnLabel(c: ScheduleColumnDef): string {
  return c.heading ?? c.id;
}

function indexOf(columns: readonly ScheduleColumnDef[], id: string): number {
  return columns.findIndex((c) => c.id === id);
}

function clamp(n: number, max: number): number {
  return Math.max(0, Math.min(n, max));
}

function withoutTotal(c: ScheduleColumnDef): ScheduleColumnDef {
  const { total: _total, ...rest } = c;
  return rest;
}

function withoutWidth(c: ScheduleColumnDef): ScheduleColumnDef {
  const { widthMm: _widthMm, ...rest } = c;
  return rest;
}

function withoutHeading(c: ScheduleColumnDef): ScheduleColumnDef {
  const { heading: _heading, ...rest } = c;
  return rest;
}

/** One step on a definition, or the reason it can't be done, in the operator's words. */
function applyStep(def: ScheduleDefinitionV2, step: ScheduleStep): ScheduleDefinitionV2 | string {
  const columns = def.columns;
  switch (step.op) {
    case "add_column": {
      if (indexOf(columns, step.column.id) >= 0) return `This schedule already has a column "${step.column.id}". Give the new one another id.`;
      const at = step.at === undefined ? columns.length : clamp(step.at, columns.length);
      return { ...def, columns: [...columns.slice(0, at), step.column, ...columns.slice(at)] };
    }
    case "move_column": {
      const from = indexOf(columns, step.columnId);
      if (from < 0) return `There is no column "${step.columnId}" to move.`;
      const moving = columns[from];
      if (!moving) return `There is no column "${step.columnId}" to move.`;
      const rest = columns.filter((_, i) => i !== from);
      const to = clamp(step.to, rest.length);
      return { ...def, columns: [...rest.slice(0, to), moving, ...rest.slice(to)] };
    }
    case "remove_column": {
      const at = indexOf(columns, step.columnId);
      if (at < 0) return `There is no column "${step.columnId}" to remove.`;
      if (columns.length === 1) return "A schedule keeps at least one column. Add another before removing this one.";
      return { ...def, columns: columns.filter((_, i) => i !== at) };
    }
    case "rename_column": {
      const at = indexOf(columns, step.columnId);
      if (at < 0) return `There is no column "${step.columnId}" to rename.`;
      const heading = step.heading?.trim() ?? "";
      return { ...def, columns: columns.map((c, i) => (i !== at ? c : heading === "" ? withoutHeading(c) : { ...c, heading })) };
    }
    case "filter":
      return { ...def, filters: step.filters };
    case "sort":
      return { ...def, sort: step.sort };
    case "group":
      return { ...def, groups: step.groups };
    case "totals": {
      if (step.columnId === undefined) return { ...def, grandTotals: step.show };
      const at = indexOf(columns, step.columnId);
      if (at < 0) return `There is no column "${step.columnId}" to total.`;
      const column = columns[at];
      if (column && step.show && (column.kind === "expand" || (column.kind === "aggregate" && column.fn === "list"))) return `"${columnLabel(column)}" lists items, so it has no total.`;
      return { ...def, columns: columns.map((c, i) => (i !== at ? c : step.show ? { ...c, total: true } : withoutTotal(c))) };
    }
    case "resize_column": {
      const at = indexOf(columns, step.columnId);
      if (at < 0) return `There is no column "${step.columnId}" to resize.`;
      const w = step.widthMm;
      return { ...def, columns: columns.map((c, i) => (i !== at ? c : w === null ? withoutWidth(c) : { ...c, widthMm: w })) };
    }
  }
}

/** Every step in order; the first that can't be done stops the edit, and nothing changes. */
export function applyScheduleSteps(def: ScheduleDefinitionV2, steps: readonly ScheduleStep[]): ScheduleStepsResult {
  let next = def;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const out = applyStep(next, step);
    if (typeof out === "string") return { ok: false, reason: steps.length > 1 ? `Step ${i + 1}: ${out}` : out, step: i };
    next = out;
  }
  return { ok: true, definition: next };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameExcept(a: ScheduleColumnDef, b: ScheduleColumnDef, keys: readonly ("heading" | "total" | "widthMm")[]): boolean {
  const strip = (c: ScheduleColumnDef) => Object.fromEntries(Object.entries(c).filter(([k]) => !(keys as readonly string[]).includes(k)));
  return same(strip(a), strip(b));
}

/**
 * The steps that turn `before` into `after`, or null when the change is more
 * than columns, filters, sort, groups and totals (a new source, name or
 * form): that is a whole new definition, saved as one. The builder's Save
 * sends these, so it and the column menu make the same edit.
 */
export function scheduleStepsBetween(before: ScheduleDefinitionV2, after: ScheduleDefinitionV2): readonly ScheduleStep[] | null {
  const { columns: bc, filters: bf, sort: bs, groups: bg, grandTotals: bt, ...bRest } = before;
  const { columns: ac, filters: af, sort: as, groups: ag, grandTotals: at, ...aRest } = after;
  if (!same(bRest, aRest)) return null;
  const steps: ScheduleStep[] = [];
  const afterIds = new Set(ac.map((c) => c.id));
  const beforeById = new Map(bc.map((c) => [c.id, c]));
  // Remove, then add, then put every column where it ends up, then headings and totals.
  let current: ScheduleColumnDef[] = [];
  for (const c of bc) {
    if (afterIds.has(c.id)) current.push(c);
    else steps.push({ op: "remove_column", columnId: c.id });
  }
  for (let i = 0; i < ac.length; i++) {
    const c = ac[i];
    if (!c) continue;
    const was = beforeById.get(c.id);
    if (!was) {
      const at = Math.min(i, current.length);
      steps.push({ op: "add_column", column: c, at });
      current = [...current.slice(0, at), c, ...current.slice(at)];
      continue;
    }
    if (!sameExcept(was, c, ["heading", "total", "widthMm"])) return null;
  }
  for (let i = 0; i < ac.length; i++) {
    const c = ac[i];
    if (!c) continue;
    if (current[i]?.id === c.id) continue;
    const from = current.findIndex((x) => x.id === c.id);
    const moving = current[from];
    if (from < 0 || !moving) return null;
    steps.push({ op: "move_column", columnId: c.id, to: i });
    const rest = current.filter((_, k) => k !== from);
    current = [...rest.slice(0, i), moving, ...rest.slice(i)];
  }
  for (const c of ac) {
    const was = beforeById.get(c.id);
    if (!was) continue;
    if (was.heading !== c.heading) steps.push({ op: "rename_column", columnId: c.id, heading: c.heading ?? null });
    if (Boolean(was.total) !== Boolean(c.total)) steps.push({ op: "totals", columnId: c.id, show: Boolean(c.total) });
    if (was.widthMm !== c.widthMm) steps.push({ op: "resize_column", columnId: c.id, widthMm: c.widthMm ?? null });
  }
  if (!same(bf, af)) steps.push({ op: "filter", filters: af });
  if (!same(bs, as)) steps.push({ op: "sort", sort: as });
  if (!same(bg, ag)) steps.push({ op: "group", groups: ag });
  if (bt !== at) steps.push({ op: "totals", show: at });
  return steps;
}
