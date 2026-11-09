import { compileFormula, evaluateRow, formulaDependencies, type CellValue, type CompiledFormula, type FormulaSchema, type FormulaType, type FormulaValue, type LookupTableSignature } from "@permitzip/bim-formula";
import { fromCanonical, fromSI, isUnitCode, kindsOfUnit, toSI, unitAllowed, type Kind, type UnitCode } from "@permitzip/bim-units";
import type { RuleRecord, RuleTable } from "./types";

/**
 * Rule logic through bim-formula (REQUIREMENTS-GRAPH §4.3): a rule's
 * `applies.when`, each template's `value` and each effect's `value` are
 * formulas over the rule's declared inputs (`{space.area}`), its parameters
 * (`{param.<name>}`), the target's value in an effect (`{value}`) and its
 * tables (`lookup(<table>, key)`, or `lookup(<table>.<column>, key)` for a
 * table with more than one value column).
 *
 * Inputs are typed by what they hold on the anchor being evaluated (a
 * determination may be a number with a unit, a label or yes/no), so a
 * formula compiles once per rule and input signature, and the compiled
 * handle is reused for every anchor with the same signature.
 *
 * A table column whose header ends in a unit code (`area_per_occupant ft2/occ`)
 * holds that unit; other number columns are plain numbers.
 */

/** One input value as the engine read it. */
export type InputValue =
  | { readonly type: "quantity"; readonly kind: Kind; readonly unit: UnitCode; /** coherent SI */ readonly si: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean };

/** A number in `unit` as an input value; null when the unit isn't a bim-units code. */
export function quantityInput(value: number, unit: string): InputValue | null {
  if (!isUnitCode(unit)) return null;
  const kind = kindsOfUnit(unit)[0];
  if (!kind) return null;
  return { type: "quantity", kind, unit, si: toSI(value, unit) };
}

/** A stored scalar with an optional unit as an input value (a number with no unit is a plain number). */
export function scalarInput(value: number | string | boolean, unit?: string): InputValue | null {
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  return quantityInput(value, unit && unit.length > 0 ? unit : "1");
}

export type FormulaOutcome =
  | { readonly ok: true; readonly value: FormulaValue; readonly type: FormulaType }
  /** An input the formula reads isn't there on this anchor. */
  | { readonly ok: false; readonly missing: readonly string[] }
  /** The formula is wrong for these inputs, in plain words. */
  | { readonly ok: false; readonly problem: string };

/** The field paths a formula reads, from its text alone; null when it doesn't parse. */
export function formulaFields(source: string): readonly string[] | null {
  const deps = formulaDependencies(source);
  return deps.ok ? deps.fields : null;
}

function typeOf(v: InputValue): FormulaType {
  return v.type === "quantity" ? { type: "quantity", kind: v.kind, unit: v.unit } : { type: v.type };
}

function signatureOf(v: InputValue): string {
  return v.type === "quantity" ? `q:${v.kind}:${v.unit}` : v.type;
}

function cellOf(v: InputValue): CellValue {
  if (v.type === "quantity") return fromCanonical(v.kind, v.si);
  return v.value;
}

interface TableColumns {
  readonly key: FormulaType;
  readonly columns: ReadonlyMap<string, LookupTableSignature>;
}

function columnType(header: string, cells: readonly (number | string)[]): { readonly type: FormulaType; readonly unit: UnitCode | null; readonly name: string } {
  const parts = header.trim().split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const name = (last !== undefined && isUnitCode(last) ? parts.slice(0, -1) : parts).join("_");
  if (last !== undefined && isUnitCode(last)) {
    const kind = kindsOfUnit(last)[0];
    if (kind) return { type: { type: "quantity", kind, unit: last }, unit: last, name };
  }
  if (cells.every((c) => typeof c === "number")) return { type: { type: "quantity", kind: "dimensionless", unit: "1" }, unit: "1", name };
  return { type: { type: "text" }, unit: null, name };
}

function cellIn(value: number | string | undefined, unit: UnitCode | null): CellValue {
  if (value === undefined) return null;
  if (typeof value === "number") {
    const kind = unit ? kindsOfUnit(unit)[0] : undefined;
    return unit && kind ? fromCanonical(kind, toSI(value, unit)) : fromCanonical("dimensionless", value);
  }
  return value;
}

const tablesByRule = new WeakMap<RuleRecord, ReadonlyMap<string, LookupTableSignature>>();

/** A rule's tables as lookup tables: `<id>` is its first value column, `<id>.<column>` each value column by name. */
export function ruleTables(rule: RuleRecord): ReadonlyMap<string, LookupTableSignature> {
  const hit = tablesByRule.get(rule);
  if (hit) return hit;
  const out = new Map<string, LookupTableSignature>();
  for (const t of rule.tables ?? []) for (const [name, sig] of tableSignatures(t).columns) out.set(name, sig);
  tablesByRule.set(rule, out);
  return out;
}

function tableSignatures(t: RuleTable): TableColumns {
  const columns = new Map<string, LookupTableSignature>();
  const keyHeader = t.columns[0] ?? "key";
  const key = columnType(keyHeader, t.rows.map((r) => r[0] ?? ""));
  for (let c = 1; c < t.columns.length; c++) {
    const col = columnType(t.columns[c] ?? `column_${c}`, t.rows.map((r) => r[c] ?? ""));
    const sig: LookupTableSignature = {
      key: key.type,
      value: col.type,
      match: key.type.type === "quantity" ? "floor" : "exact",
      rows: t.rows.map((r) => ({ key: cellIn(r[0], key.unit), value: cellIn(r[c], col.unit) })),
    };
    if (c === 1) columns.set(t.id, sig);
    columns.set(`${t.id}.${col.name}`, sig);
  }
  return { key: key.type, columns };
}

/** The rule's parameters as input values (`param.<name>`). */
export function parameterInputs(rule: RuleRecord): ReadonlyMap<string, InputValue> {
  const out = new Map<string, InputValue>();
  for (const [name, p] of Object.entries(rule.parameters ?? {})) {
    const v = typeof p === "object" ? quantityInput(p.value, p.unit) : scalarInput(p);
    if (v) out.set(`param.${name}`, v);
    else console.error(`[bim-kernel/graph] rule ${rule.ruleId}'s parameter ${name} has a unit bim-units doesn't know; it reads as missing`, { unit: typeof p === "object" ? p.unit : null });
  }
  return out;
}

/** The type a template's unit asks a formula to produce, so an ambiguous quotient (a count or an occupant load) resolves. */
export function expectedType(unit: string): FormulaType | undefined {
  if (!isUnitCode(unit)) return undefined;
  const kind = kindsOfUnit(unit)[0];
  return kind ? { type: "quantity", kind, unit } : undefined;
}

type Handle = { readonly ok: true; readonly formula: CompiledFormula } | { readonly ok: false; readonly problem: string };
/** Per rule object (an edited rule is a new object, so its tables and formulas never read a stale handle). */
const compiledByRule = new WeakMap<RuleRecord, Map<string, Handle>>();
/** Distinct (formula, input signature) handles kept per rule; past this the rule's cache starts over (a pathological model). */
const MAX_COMPILED = 2_000;

/**
 * Evaluate one formula of `rule` with the inputs read on an anchor. `inputs`
 * maps each field path to its value, or to null when the anchor lacks it.
 */
export function evaluateRuleFormula(rule: RuleRecord, source: string, fields: readonly string[], inputs: ReadonlyMap<string, InputValue | null>, expect?: FormulaType): FormulaOutcome {
  const missing: string[] = [];
  const sig: string[] = [];
  for (const f of fields) {
    const v = inputs.get(f);
    if (v === undefined || v === null) missing.push(f);
    else sig.push(`${f}=${signatureOf(v)}`);
  }
  if (missing.length > 0) return { ok: false, missing };
  const key = `${source}\u0000${sig.join(",")}\u0000${expect ? JSON.stringify(expect) : ""}`;
  let compiled = compiledByRule.get(rule);
  if (!compiled) {
    compiled = new Map();
    compiledByRule.set(rule, compiled);
  }
  let handle = compiled.get(key);
  if (!handle) {
    const tables = ruleTables(rule);
    const schema: FormulaSchema = {
      field: (path) => {
        const v = inputs.get(path);
        return v ? { type: typeOf(v), label: path } : undefined;
      },
      relationship: () => undefined,
      table: (name) => tables.get(name),
    };
    const r = compileFormula(source, schema, expect ? { expect } : undefined);
    handle = r.ok ? { ok: true, formula: r.formula } : { ok: false, problem: r.errors.map((e) => e.message).join("; ") };
    if (compiled.size >= MAX_COMPILED) compiled.clear();
    compiled.set(key, handle);
  }
  if (!handle.ok) return { ok: false, problem: handle.problem };
  const formula = handle.formula;
  const value = evaluateRow(formula, {
    field: (path) => {
      const v = inputs.get(path);
      return v ? cellOf(v) : null;
    },
    related: () => [],
  });
  return { ok: true, value, type: formula.type };
}

/** A formula's result in a template's unit: a number in that unit, a label or yes/no; or why it can't be. */
export function valueInUnit(value: FormulaValue, unit: string): { readonly ok: true; readonly value: number | string | boolean | null } | { readonly ok: false; readonly problem: string } {
  switch (value.type) {
    case "empty":
      return { ok: true, value: null };
    case "text":
    case "boolean":
      return { ok: true, value: value.value };
    case "quantity": {
      if (isUnitCode(unit) && unitAllowed(value.kind, unit)) return { ok: true, value: tidy(fromSI(value.value, unit)) };
      const plain = value.kind === "dimensionless";
      const wanted = isUnitCode(unit) ? kindsOfUnit(unit)[0] : undefined;
      if (plain && (wanted === "count" || wanted === "dimensionless" || wanted === "ratio" || wanted === undefined)) return { ok: true, value: tidy(value.value) };
      return { ok: false, problem: `it gives a ${value.kind.replace(/_/g, " ")}, but the requirement is in ${unit}` };
    }
  }
}

/** A number without float noise (12 significant digits). */
export function tidy(n: number): number {
  return Number(n.toPrecision(12));
}
