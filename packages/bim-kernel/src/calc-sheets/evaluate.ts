import { compileFormula, evaluateRow, formulaDependencies, type CompileResult, type FormulaSchema } from "@permitzip/bim-formula";
import { fromCanonical } from "@permitzip/bim-units";
import { BLOCK_DEPENDENCY_POINT } from "../blocks/dependency-point";
import { resolveField } from "../fields/resolver";
import { activePackSet } from "../packs/scope";
import { checkDesignLimit } from "../policy/check";
import type { BimElement, ElementId, ModelState } from "../types";
import type { CalcSheetContext } from "./point";
import type { CalcCheckResult, CalcLookupMatch, CalcSheetEvaluation, CalcSheetLookup, CalcSheetSpec, CalcTable, GoverningCell } from "./types";

/**
 * The calculation sheet evaluator (lane S12). Deterministic: the same model,
 * tables and limits give the same values, governing cells, checks and words.
 *
 * Order: inputs (a bound model field, a typed number, another sheet's
 * result), lookups (the governing cell of a firm or project table), steps
 * (formulas through `@permitzip/bim-formula`, in the units each line is
 * written in), checks (against the most specific design limit). Nothing is
 * guessed: a missing input, table or limit leaves its line empty and says
 * what to add.
 *
 * `dependsOn` is the elements the bound inputs read, widened through
 * `BLOCK_DEPENDENCY_POINT` exactly as a field block's (a board's loads read
 * every link it feeds), so a session re-runs a sheet only when one of them
 * changed.
 */

type Elements = Readonly<Record<string, BimElement>>;

const PLAIN = { type: "quantity", kind: "dimensionless", unit: "1" } as const;

/** A heading as a number: "1-1/4" → 1.25, "3/4" → 0.75, "2" → 2; null for words. */
export function headingNumber(heading: number | string): number | null {
  if (typeof heading === "number") return Number.isFinite(heading) ? heading : null;
  const t = heading.trim().replace(/["″]|\s*in(ch(es)?)?$/i, "");
  const mixed = /^(\d+)[-\s]+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/** The index a value picks from headings (in table order), or -1. */
function pick(headings: readonly (number | null)[], value: number, match: CalcLookupMatch): number {
  const EPS = 1e-9;
  let best = -1;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h === null || h === undefined) continue;
    const b = best < 0 ? null : (headings[best] as number);
    switch (match) {
      case "exact":
        if (Math.abs(h - value) <= EPS) return i;
        break;
      case "next_up":
        if (h >= value - EPS && (b === null || h < b)) best = i;
        break;
      case "next_down":
        if (h <= value + EPS && (b === null || h > b)) best = i;
        break;
      case "nearest": {
        const d = Math.abs(h - value);
        const bd = b === null ? Infinity : Math.abs(b - value);
        if (d < bd - EPS || (Math.abs(d - bd) <= EPS && b !== null && h > b)) best = i;
        break;
      }
    }
  }
  return best;
}

function headingLabel(h: number | string, unit: string): string {
  return typeof h === "number" ? `${h.toLocaleString("en-US", { maximumFractionDigits: 3 })}${unit && unit !== "1" ? ` ${unit}` : ""}` : h;
}

interface LookupAnswer {
  readonly cell: GoverningCell | null;
  readonly row: number | null;
  readonly column: number | null;
  readonly missing: string | null;
}

function lookup(l: CalcSheetLookup, table: CalcTable | null, values: ReadonlyMap<string, number | null>): LookupAnswer {
  if (!table) return { cell: null, row: null, column: null, missing: `${l.label}: add the table this sheet reads (${l.table.slot}) to the project or firm library` };
  const rv = values.get(l.row.input);
  const cv = values.get(l.column.input);
  if (rv === null || rv === undefined || cv === null || cv === undefined) return { cell: null, row: null, column: null, missing: null };
  const rowIndex = pick(table.rows, rv, l.row.match);
  if (rowIndex < 0) return { cell: null, row: null, column: null, missing: `${l.label}: ${table.label} has no row for ${headingLabel(rv, table.rowHeading.unit)}` };
  const cells = table.values[rowIndex] ?? [];
  let columnIndex: number;
  if ((l.column.by ?? "heading") === "value") columnIndex = pick(cells.map((c) => (c === null || c === undefined ? null : c)), cv, l.column.match);
  else columnIndex = pick(table.columns.map(headingNumber), cv, l.column.match);
  if (columnIndex < 0) return { cell: null, row: null, column: null, missing: `${l.label}: ${table.label} has no column for ${headingLabel(cv, table.columnHeading.unit)} in the ${headingLabel(table.rows[rowIndex] as number, table.rowHeading.unit)} row` };
  const value = cells[columnIndex];
  const column = table.columns[columnIndex] as number | string;
  if (value === null || value === undefined) return { cell: null, row: null, column: null, missing: `${l.label}: ${table.label} has no value at ${headingLabel(table.rows[rowIndex] as number, table.rowHeading.unit)}, ${headingLabel(column, table.columnHeading.unit)}` };
  return {
    cell: { lookup: l.key, rowIndex, columnIndex, rowLabel: headingLabel(table.rows[rowIndex] as number, table.rowHeading.unit), columnLabel: headingLabel(column, table.columnHeading.unit), value, unit: l.unit },
    row: table.rows[rowIndex] ?? null,
    column: headingNumber(column),
    missing: null,
  };
}

const compiledBySpec = new WeakMap<CalcSheetSpec, Map<string, CompileResult>>();

function compiled(spec: CalcSheetSpec, key: string, formula: string, known: ReadonlySet<string>): CompileResult {
  let cache = compiledBySpec.get(spec);
  if (!cache) {
    cache = new Map();
    compiledBySpec.set(spec, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const schema: FormulaSchema = { field: (path) => (known.has(path) ? { type: PLAIN, label: path } : undefined), relationship: () => undefined };
  const r = compileFormula(formula, schema);
  cache.set(key, r);
  return r;
}

function addDependencies(elements: Elements, id: ElementId, out: Set<ElementId>): void {
  out.add(id);
  const rows = activePackSet().items(BLOCK_DEPENDENCY_POINT);
  if (rows.some((d) => d.collect(elements, id, out))) return;
  const el = elements[id];
  if (el?.kind === "part") out.add(el.typeId);
}

function readNumber(elements: Elements, subjectId: ElementId, path: string): number | null {
  if (!elements[subjectId]) return null;
  const r = resolveField(elements, subjectId, path);
  if (typeof r.value === "number" && Number.isFinite(r.value)) return r.value;
  if (typeof r.value === "string") {
    const n = Number(r.value.replace(/,/g, ""));
    return Number.isFinite(n) && r.value.trim() !== "" ? n : null;
  }
  return null;
}

/** Work a sheet out against the model. */
export function evaluateSheet(model: Pick<ModelState, "elements">, spec: CalcSheetSpec, ctx: CalcSheetContext): CalcSheetEvaluation {
  const elements = model.elements;
  const values = new Map<string, number | null>();
  const units = new Map<string, string>();
  const labels = new Map<string, string>();
  const missing: string[] = [];
  const deps = new Set<ElementId>();
  const governing: GoverningCell[] = [];

  for (const input of spec.inputs) {
    units.set(input.key, input.unit);
    labels.set(input.key, input.label);
    const b = input.bind;
    let v: number | null = null;
    if (b.from === "typed") v = Number.isFinite(b.value) ? b.value : null;
    else if (b.from === "field") {
      if (b.subjectId === undefined) missing.push(`${input.label}: pick what this sheet is about`);
      else {
        addDependencies(elements, b.subjectId, deps);
        v = readNumber(elements, b.subjectId, b.path);
        if (v === null) missing.push(`${input.label}: ${elements[b.subjectId] ? `the model has no value for ${b.path}` : "the element it reads no longer exists"}`);
      }
    } else {
      v = ctx.sheets?.result(b.sheetId, b.key) ?? null;
      if (v === null) missing.push(`${input.label}: the sheet it reads (${b.sheetId}) has no result yet`);
    }
    values.set(input.key, v);
  }

  for (const l of spec.lookups) {
    units.set(l.key, l.unit);
    labels.set(l.key, l.label);
    const a = lookup(l, ctx.tables.table(l.table.slot), values);
    if (a.missing) missing.push(a.missing);
    if (a.cell) governing.push(a.cell);
    values.set(l.key, a.cell ? a.cell.value : null);
    values.set(`${l.key}_row`, a.row);
    values.set(`${l.key}_column`, a.column);
  }

  for (const step of spec.steps) {
    units.set(step.key, step.unit);
    labels.set(step.key, step.label);
    const reads = formulaDependencies(step.formula);
    if (!reads.ok) {
      missing.push(`${step.label}: ${reads.errors.map((e) => e.message).join("; ")}`);
      values.set(step.key, null);
      continue;
    }
    const unknown = reads.fields.filter((f) => !values.has(f));
    if (unknown.length > 0) {
      missing.push(`${step.label}: it reads ${unknown.join(", ")}, which the sheet doesn't define before it`);
      values.set(step.key, null);
      continue;
    }
    if (reads.fields.some((f) => values.get(f) === null)) {
      values.set(step.key, null);
      continue;
    }
    const c = compiled(spec, step.key, step.formula, new Set(values.keys()));
    if (!c.ok) {
      missing.push(`${step.label}: ${c.errors.map((e) => e.message).join("; ")}`);
      values.set(step.key, null);
      continue;
    }
    const out = evaluateRow(c.formula, { field: (p) => fromCanonical("dimensionless", values.get(p) as number), related: () => [] });
    const n = out.type === "quantity" ? (out.value as number) : out.type === "boolean" ? (out.value ? 1 : 0) : null;
    if (out.type === "text") missing.push(`${step.label}: it gives words, not a number`);
    values.set(step.key, n !== null && Number.isFinite(n) ? Number(n.toPrecision(12)) : null);
  }

  const checks: CalcCheckResult[] = spec.checks.map((c) => {
    const v = values.get(c.value);
    const label = labels.get(c.value) ?? c.label;
    if (v === null || v === undefined) return { key: c.key, pass: null, message: `${c.label}: can't check until ${label.toLowerCase()} is worked out` };
    const r = checkDesignLimit(label, v, units.get(c.value) ?? "1", c.limit, ctx.stage, ctx.limits);
    return { key: c.key, pass: r.pass, ...(r.limit ? { limitId: r.limit.limit.id } : {}), message: r.words };
  });

  const out: Record<string, number | null> = {};
  for (const [k, v] of values) out[k] = v;
  return { values: out, governing, checks, missing, dependsOn: [...deps].sort() };
}
