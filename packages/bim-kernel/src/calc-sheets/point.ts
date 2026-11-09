import { defineExtensionPoint } from "../packs/contract";
import type { PackRefusal } from "../packs/points";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { ElementId, ModelState } from "../types";
import type { DesignLimitSources } from "../policy/design-limits";
import { evaluateSheet } from "./evaluate";
import type { CalcSheetEvaluation, CalcSheetSpec, CalcTableSource } from "./types";

/**
 * Calculation sheet templates (contract 1.10.0, `kernel.calc_sheet` v1).
 * An add-on registers a template that builds a sheet spec for a subject (a
 * system, a beam, a tank); Insert › Calculation lists them.
 */

export interface CalcSheetBuildRequest {
  /** What the sheet is about (a system, an element); absent for a project-wide sheet. */
  readonly subjectId?: ElementId;
  /** The template's own options (an edition label, a table slot). */
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface CalcSheetTemplateRow {
  /** `<pack>.<name>`; a first-party row keeps its bare id. Stored on placed sheets, so frozen. */
  readonly id: string;
  /** What a person picks ("Beam check"). */
  readonly label: string;
  /** The discipline it belongs to (`DISCIPLINE_POINT` id), for grouping in the Insert menu. */
  readonly discipline?: string;
  /** The subject kinds it can be placed for; absent: project-wide. */
  readonly subjectKinds?: readonly string[];
  build(model: ModelState, request: CalcSheetBuildRequest): CalcSheetSpec | PackRefusal;
}

export const CALC_SHEET_POINT = defineExtensionPoint<CalcSheetTemplateRow>({
  id: "kernel.calc_sheet",
  version: 1,
  label: "Calculation sheets",
  idOf: (row) => row.id,
});

/** Problems with calculation sheet template rows (pack conformance), in words. */
export function calcSheetRowProblems(rows: readonly CalcSheetTemplateRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`calculation sheet ${row.id} has no label`);
    if (typeof row.build !== "function") out.push(`calculation sheet ${row.id}: build must be a function`);
  }
  return out;
}

/** Problems with one built spec (keys unique, every reference names a key defined before it), in words. */
export function calcSheetSpecProblems(spec: CalcSheetSpec): string[] {
  const out: string[] = [];
  const known = new Set<string>();
  const define = (key: string, what: string) => {
    if (known.has(key)) out.push(`${spec.title}: ${what} ${key} is defined twice`);
    known.add(key);
  };
  for (const i of spec.inputs) define(i.key, "input");
  for (const l of spec.lookups) {
    for (const ref of [l.row.input, l.column.input]) if (!known.has(ref)) out.push(`${spec.title}: lookup ${l.key} reads ${ref}, which isn't an input`);
    define(l.key, "lookup");
  }
  for (const s of spec.steps) define(s.key, "step");
  for (const c of spec.checks) if (!known.has(c.value)) out.push(`${spec.title}: check ${c.key} compares ${c.value}, which isn't defined`);
  if (!known.has(spec.result.key)) out.push(`${spec.title}: the result ${spec.result.key} isn't defined`);
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, CalcSheetTemplateRow> => new Map(set.items(CALC_SHEET_POINT).map((r) => [r.id, r] as const));

export function calcSheetTemplate(id: string): CalcSheetTemplateRow | null {
  return activePackSet().memo("kernel.calc_sheet#table", tableOf).get(id) ?? null;
}

export function calcSheetTemplates(): readonly CalcSheetTemplateRow[] {
  return activePackSet().items(CALC_SHEET_POINT);
}

export interface CalcSheetContext {
  readonly tables: CalcTableSource;
  readonly limits: DesignLimitSources;
  /** The stage the project is at (`LIFECYCLE_STAGE_POINT` id), for stage-bound limits. */
  readonly stage?: string;
  /** Other sheets' results, for an input bound `from: "sheet"` (S12, additive). Absent: those inputs read as missing. */
  readonly sheets?: { result(sheetId: string, key: string): number | null };
}

/**
 * Work a sheet out against the model (S12). Refuses only a spec that is wrong
 * in itself (`calcSheetSpecProblems`); a missing input, table or limit is an
 * evaluation that says what to add.
 */
export function evaluateCalcSheet(model: Pick<ModelState, "elements">, spec: CalcSheetSpec, ctx: CalcSheetContext): CalcSheetEvaluation | PackRefusal {
  const problems = calcSheetSpecProblems(spec);
  if (problems.length > 0) return { refused: problems.join("; ") };
  return evaluateSheet(model, spec, ctx);
}

/** Build a template's sheet for a subject and work it out; refuses when the template isn't in this model's add-ons or can't build. */
export function placeCalcSheet(model: ModelState, templateId: string, request: CalcSheetBuildRequest, ctx: CalcSheetContext): { readonly spec: CalcSheetSpec; readonly evaluation: CalcSheetEvaluation } | PackRefusal {
  const row = calcSheetTemplate(templateId);
  if (!row) return { refused: `No add-on in this model has the ${templateId} calculation` };
  const spec = row.build(model, request);
  if ("refused" in spec) return spec;
  const evaluation = evaluateCalcSheet(model, spec, ctx);
  if ("refused" in evaluation) return evaluation;
  return { spec, evaluation };
}
