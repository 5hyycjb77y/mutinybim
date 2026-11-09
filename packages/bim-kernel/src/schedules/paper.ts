import { pushTo } from "../collections";
import { formatter, type DisplayOverride, type DisplayProfile, type Measure } from "@permitzip/bim-units";
import type { Primitive } from "../drawing/sheet";
import type { Vec2 } from "../types";
import type { ScheduleColumnDef, ScheduleDefinitionV2 } from "./definition";
import { fieldProviderRegistry } from "../fields/providers";
import { buildRowSet, ScheduleDefinitionError, scheduleProfile, type ScheduleEngineContext, type ScheduleModel } from "./engine/session";
import { V1_SCHEDULE_PROFILE_ID } from "./engine/v1";
import type { CellValue, ColumnValues, RowGroup, RowSet, RowSetColumn } from "./engine/types";
import { drawFormTable, formTable, type FormTable } from "./forms/layout";
import { builtinFormTemplate, formScheduleRow } from "./forms/evaluate";
import type { FormScheduleDefinition } from "./forms/types";
import { drawScheduleTable, layoutScheduleTable, type EvaluatedSchedule, type ScheduleRowStyle, type ScheduleTable } from "./schedule";

/**
 * v2 schedules on paper (SCHEDULES-PLAN §5a, §5b). A list prints the engine's
 * rows through the same table layout as v1; an `expand` column prints as
 * indented child rows (`nested`), its count (`summary`) or not at all
 * (`hidden`); groups print a heading and a footer, the definition's grand
 * totals a last row. A form presentation prints through the form layout, so a
 * panel schedule read as v2 is the same drawing as the v1 form.
 */

export type ScheduleV2Paper = { readonly kind: "list"; readonly table: ScheduleTable; readonly columnIds?: readonly (string | null)[] } | { readonly kind: "form"; readonly table: FormTable };

const PAPER_CONTEXT: ScheduleEngineContext = { viewId: "paper", revision: 0 };

function hasBuiltinTemplate(kind: string): boolean {
  return formScheduleRow(kind)?.template !== undefined;
}

/** The form a form presentation prints: the model's copy, else the built-in template it names. Null: neither. */
export function scheduleV2Form(def: ScheduleDefinitionV2): FormScheduleDefinition | null {
  const p = def.presentation;
  if (p.kind !== "form") return null;
  if (p.form) return p.form;
  if (!hasBuiltinTemplate(p.template)) return null;
  return {
    kind: p.template,
    template: builtinFormTemplate(p.template),
    ...(def.source.kind === "related" ? { elementId: def.source.from } : {}),
    textSizeMm: def.display.textSizeMm,
    emptyText: def.display.emptyText,
  };
}

interface PaperColumn {
  readonly heading: string;
  /** The definition column it prints (absent: one of an expand column's nested columns, sized by its text). */
  readonly columnId?: string;
  readonly widthMm?: number;
  readonly hideWhenEmpty: boolean;
  /** The text of this column on an element row. */
  readonly item: (row: number) => string;
  /** For a nested sub-table column: which expand column and child column it prints. */
  readonly child?: { readonly expandId: string; readonly column: RowSetColumn };
  /** Footer / grand total text from a totals record. */
  readonly total?: (totals: ReadonlyMap<string, Measure | null>) => string;
}

function cellAt(col: ColumnValues | undefined, i: number): CellValue {
  if (!col) return null;
  if (col.type === "quantity") {
    const v = col.values[i] ?? Number.NaN;
    return Number.isNaN(v) ? null : v;
  }
  if (col.type === "boolean") {
    const v = col.values[i] ?? -1;
    return v === -1 ? null : v === 1;
  }
  return col.values[i] ?? null;
}

/** A column's printed text: its own unit and precision when the definition sets them, else the profile's, else the field's unit. */
function textOf(column: RowSetColumn, def: ScheduleColumnDef | undefined, profile: DisplayProfile): (v: CellValue) => string {
  const kind = column.quantityKind;
  let format: ((si: number) => string) | null = null;
  if (kind) {
    const unit = def?.unit ?? (profile.kinds[kind] ? undefined : column.unit);
    const precision = def?.precision ?? column.precision;
    const override: DisplayOverride | undefined = unit || precision ? { ...(unit ? { unit } : {}), ...(precision ? { precision } : {}) } : undefined;
    format = formatter(kind, profile, override);
  }
  return (v) => {
    if (v === null || v === "") return "";
    if (typeof v === "number") return format ? format(v) : String(v);
    if (typeof v === "boolean") return v ? "YES" : "NO";
    return v;
  };
}

function paperColumns(rows: RowSet, def: ScheduleDefinitionV2, profile: DisplayProfile): PaperColumn[] {
  const out: PaperColumn[] = [];
  for (const column of rows.columns) {
    const d = def.columns.find((c) => c.id === column.id);
    const base = { columnId: column.id, hideWhenEmpty: d?.hideWhenEmpty === true, ...(d?.widthMm === undefined ? {} : { widthMm: d.widthMm }) };
    if (column.kind === "expand") {
      const paper = d?.kind === "expand" ? d.paper : "nested";
      if (paper === "hidden") continue;
      const sets = rows.children.get(column.id);
      if (paper === "summary") {
        out.push({ ...base, heading: column.heading, item: (i) => String(sets?.get(rows.rowKeys[i] ?? "")?.rowCount ?? 0) });
        continue;
      }
      for (const child of column.childColumns ?? []) {
        out.push({ hideWhenEmpty: base.hideWhenEmpty, heading: `${column.heading} ${child.heading}`, item: () => "", child: { expandId: column.id, column: child } });
      }
      continue;
    }
    const text = textOf(column, d, profile);
    const values = rows.values.get(column.id);
    const kind = column.quantityKind;
    out.push({
      ...base,
      heading: column.heading,
      item: (i) => text(cellAt(values, i)),
      ...(d?.total && kind
        ? {
            total: (totals: ReadonlyMap<string, Measure | null>) => {
              const m = totals.get(column.id);
              return m ? text(m.value) : "";
            },
          }
        : {}),
    });
  }
  return out;
}

export interface EvaluatedScheduleV2 extends EvaluatedSchedule {
  /** Fixed paper widths by printed column (the definition's `widthMm`). */
  readonly widthsMm: readonly (number | undefined)[];
  /** The definition column each printed column comes from; null for an expand column's nested columns. */
  readonly columnIds: readonly (string | null)[];
}

/** Engine rows as printed rows: element rows, nested sub-rows, group headings and footers, the grand total. */
export function evaluateScheduleV2(rows: RowSet, def: ScheduleDefinitionV2): EvaluatedScheduleV2 {
  const profile = scheduleProfile(def);
  const all = paperColumns(rows, def, profile);
  // Hide-when-empty looks at element rows only (a total alone doesn't keep a column).
  const columns = all.filter((c) => {
    if (!c.hideWhenEmpty) return true;
    if (c.child) return rowsHaveChildren(rows, c.child.expandId);
    for (let i = 0; i < rows.rowCount; i++) if (c.item(i) !== "") return true;
    return false;
  });
  const nestedIds = [...new Set(columns.flatMap((c) => (c.child ? [c.child.expandId] : [])))];

  const printed: string[][] = [];
  const ids: (readonly string[])[] = [];
  const styles: ScheduleRowStyle[] = [];
  const push = (cells: string[], style: ScheduleRowStyle, elementIds: readonly string[]): void => {
    printed.push(cells);
    styles.push(style);
    ids.push(elementIds);
  };
  const totalRow = (label: string, totals: ReadonlyMap<string, Measure | null>, style: ScheduleRowStyle): void => {
    const cells = columns.map((c) => (c.total ? c.total(totals) : ""));
    const labelAt = columns.findIndex((c) => !c.total);
    if (labelAt >= 0) cells[labelAt] = label;
    push(cells, style, []);
  };

  const starts = new Map<number, RowGroup[]>();
  const ends = new Map<number, RowGroup[]>();
  for (const g of rows.groups ?? []) {
    pushTo(starts, g.start, g);
    const last = g.start + g.count - 1;
    pushTo(ends, last, g);
  }

  for (let i = 0; i < rows.rowCount; i++) {
    for (const g of [...(starts.get(i) ?? [])].sort((a, b) => a.depth - b.depth)) {
      if (def.groups[g.depth]?.header) push([g.label.toUpperCase()], "group", []);
    }
    const key = rows.rowKeys[i] ?? "";
    push(
      columns.map((c) => c.item(i)),
      "item",
      rows.rowElementIds?.[i] ?? [rows.elementIds[i] ?? key],
    );
    for (const expandId of nestedIds) {
      const set = rows.children.get(expandId)?.get(key);
      if (!set) continue;
      const childText = new Map(columns.flatMap((c) => (c.child?.expandId === expandId ? [[c, textOf(c.child.column, undefined, profile)] as const] : [])));
      for (let k = 0; k < set.rowCount; k++) {
        const cells = columns.map((c) => {
          const text = childText.get(c);
          if (!text || !c.child) return "";
          return text(cellAt(set.values.get(c.child.column.id), k));
        });
        const first = cells.findIndex((t) => t !== "");
        if (first >= 0) cells[first] = `› ${cells[first]}`;
        push(cells, "child", [set.elementIds[k] ?? set.rowKeys[k] ?? ""]);
      }
    }
    for (const g of [...(ends.get(i) ?? [])].sort((a, b) => b.depth - a.depth)) {
      if (!def.groups[g.depth]?.footer) continue;
      if (g.totals) totalRow("TOTAL", new Map(Object.entries(g.totals)), "footer");
      else totalRow(`${g.count} ${g.count === 1 ? "ITEM" : "ITEMS"}`, new Map(), "footer");
    }
  }
  if (rows.totals && rows.rowCount > 0) totalRow("GRAND TOTAL", rows.totals, "total");

  return { title: def.name.toUpperCase(), headings: columns.map((c) => c.heading.trim()), rows: printed, elementIds: ids, rowStyles: styles, widthsMm: columns.map((c) => c.widthMm), columnIds: columns.map((c) => (c.child ? null : (c.columnId ?? null))) };
}

function rowsHaveChildren(rows: RowSet, expandId: string): boolean {
  for (const set of rows.children.get(expandId)?.values() ?? []) if (set.rowCount > 0) return true;
  return false;
}

/** A definition that can't build prints its problems instead of rows, so a broken schedule is never a blank box. */
function problemTable(def: ScheduleDefinitionV2, messages: readonly string[]): ScheduleTable {
  return layoutScheduleTable(
    { title: def.name.toUpperCase(), headings: ["THIS SCHEDULE CAN'T PRINT"], rows: messages.map((m) => [m]), elementIds: messages.map(() => []) },
    { textSizeMm: def.display.textSizeMm },
  );
}

/**
 * Rows to print. Anything that builds over the given registry prints exactly
 * as before. A native v2 schedule refused only because it names trade
 * provider fields (the Loads list, Not placed yet) builds over the registry
 * with every field provider, as the model server's grid opens it. Never a v1
 * schedule: its bare column names keep their v1 reading.
 */
function buildPaperRows(model: ScheduleModel, def: ScheduleDefinitionV2, ctx: ScheduleEngineContext): RowSet {
  try {
    return buildRowSet(model, def, ctx);
  } catch (err) {
    const providerFields = !ctx.registry && def.display.profile !== V1_SCHEDULE_PROFILE_ID && err instanceof ScheduleDefinitionError && err.problems.some((p) => p.code === "unknown_field");
    if (!providerFields) throw err;
    return buildRowSet(model, def, { ...ctx, registry: fieldProviderRegistry() });
  }
}

/** The schedule as it prints, at this model state. */
export function scheduleV2Paper(model: ScheduleModel, def: ScheduleDefinitionV2, ctx: ScheduleEngineContext = PAPER_CONTEXT): ScheduleV2Paper {
  if (def.presentation.kind === "form") {
    const form = scheduleV2Form(def);
    if (!form) return { kind: "list", table: problemTable(def, [`There is no form template called "${def.presentation.template}".`]) };
    return { kind: "form", table: formTable(model, form) };
  }
  let rows: RowSet;
  try {
    rows = buildPaperRows(model, def, ctx);
  } catch (err) {
    if (err instanceof ScheduleDefinitionError) {
      console.error("[scheduleV2Paper] definition refused; printing its problems", { name: def.name, problems: err.problems });
      return { kind: "list", table: problemTable(def, err.problems.map((p) => p.message)) };
    }
    throw err;
  }
  const evaluated = evaluateScheduleV2(rows, def);
  return { kind: "list", table: layoutScheduleTable(evaluated, { textSizeMm: def.display.textSizeMm, emptyText: def.display.emptyText, widthsMm: evaluated.widthsMm }), columnIds: evaluated.columnIds };
}

export function scheduleV2Size(paper: ScheduleV2Paper): Vec2 {
  return paper.table.size;
}

/** Draw with the top-left corner at `topLeft` (paper mm). */
export function drawScheduleV2(prims: Primitive[], paper: ScheduleV2Paper, topLeft: Vec2): void {
  if (paper.kind === "form") drawFormTable(prims, paper.table, topLeft);
  else drawScheduleTable(prims, paper.table, topLeft);
}
