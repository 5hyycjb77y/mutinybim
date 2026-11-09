import { fieldText, type FieldOptions } from "../../fields/resolver";
import { fillTemplate, parseFieldTemplate } from "../../fields/template";
import type { BimElement, ModelState, PartInstance, PartTypeElement } from "../../types";
import type { FormColumn, FormScheduleDefinition } from "./types";

/**
 * What every form schedule shares: the evaluated shape, the header and title
 * from the template, list grids, and the empty form that says why. A trade's
 * form kinds (rows of `FORM_SCHEDULE_POINT`) build on these.
 */

type Elements = Readonly<Record<string, BimElement>>;
export type FormAlign = "left" | "center" | "right";

export interface FormGrid {
  readonly headings: readonly string[];
  readonly aligns: readonly FormAlign[];
  readonly widths: readonly (number | undefined)[];
  readonly rows: readonly (readonly string[])[];
  /** The circuits or parts behind each row (selection and click-through). */
  readonly rowIds: readonly (readonly string[])[];
  /** Slot grids: the column where the even (right) half starts, drawn with a heavier rule. */
  readonly splitAt: number | null;
}

export interface EvaluatedForm {
  readonly title: string;
  readonly header: readonly { readonly label: string; readonly value: string }[];
  readonly headerColumns: number;
  readonly grid: FormGrid;
  readonly summary: { readonly headings: readonly string[]; readonly rows: readonly (readonly string[])[] } | null;
  readonly totals: readonly { readonly label: string; readonly value: string }[];
  readonly notes: readonly string[];
  /** What the demand figures rest on ("Demand: NEC 2023 Article 220"), or that they are connected loads only. */
  readonly footer: string;
  /** Why the schedule can't show its element (deleted, no longer a panel), in plain words. */
  readonly problem: string | null;
}

export const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function cell(template: string, value: (path: string) => string): string {
  const parsed = parseFieldTemplate(template);
  if (!parsed.ok) return template;
  return fillTemplate(parsed.parts, value).text.trim();
}

export function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

export function typeOf(elements: Elements, part: PartInstance): PartTypeElement | null {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? t : null;
}

export function options(def: FormScheduleDefinition): FieldOptions {
  return { rules: def.rules ?? null, ...(def.template.supplyFrom ? { supplyFrom: def.template.supplyFrom } : {}) };
}

export function headerOf(model: Pick<ModelState, "elements">, def: FormScheduleDefinition, subjectId: string | null, opts: FieldOptions) {
  return def.template.header.fields.map((f) => ({ label: f.label, value: subjectId ? cell(f.value, (p) => fieldText(model.elements, subjectId, p, opts)) : cell(f.value, () => "") }));
}

export function titleOf(model: Pick<ModelState, "elements">, def: FormScheduleDefinition, subjectId: string | null, opts: FieldOptions): string {
  const t = subjectId ? cell(def.template.title, (p) => fieldText(model.elements, subjectId, p, opts)) : cell(def.template.title, () => "");
  return (t || def.template.name).toUpperCase();
}

const EMPTY_GRID: FormGrid = { headings: [], aligns: [], widths: [], rows: [], rowIds: [], splitAt: null };

export function empty(def: FormScheduleDefinition, title: string, problem: string): EvaluatedForm {
  return { title, header: [], headerColumns: def.template.header.columns, grid: EMPTY_GRID, summary: null, totals: [], notes: [], footer: "", problem };
}


export function listGrid(cols: readonly FormColumn[], rows: Array<{ ids: readonly string[]; value: (path: string) => string }>): FormGrid {
  return {
    headings: cols.map((c) => c.heading),
    aligns: cols.map((c) => c.align ?? "center"),
    widths: cols.map((c) => c.widthMm),
    rows: rows.map((r) => cols.map((c) => cell(c.value, r.value))),
    rowIds: rows.map((r) => r.ids),
    splitAt: null,
  };
}

export function listForm(model: Pick<ModelState, "elements">, def: FormScheduleDefinition, rows: Array<{ ids: readonly string[]; value: (path: string) => string }>): EvaluatedForm {
  const opts = options(def);
  return {
    title: titleOf(model, def, null, opts),
    header: headerOf(model, def, null, opts),
    headerColumns: def.template.header.columns,
    grid: listGrid(def.template.body.columns, rows),
    summary: null,
    totals: [],
    notes: def.template.notes.map((n) => `[${n.mark}] ${n.text}`),
    footer: "",
    problem: null,
  };
}

/** Part-type facts the connection-type and equipment schedules print that no single field path names. */
