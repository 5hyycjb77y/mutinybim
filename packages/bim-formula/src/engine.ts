import { compileSource, isBuiltinFunction, toValueColumn, type CNode, type Col, type Compiled, type Plan } from "./compile";
import { findCycles } from "./cycles";
import { renderExplanation } from "./explain";
import { parseFormula, type Node } from "./parse";
import { columnsFromRows } from "./rows";
import type { ColumnarInputs, CompiledFormula, FormulaDependencies, FormulaEngine, FormulaValue, RowValues, ValueColumn } from "./types";
import type { Kind, Quantity } from "./units";

const internals = new WeakMap<CompiledFormula, Compiled>();

function internalsOf(formula: CompiledFormula): Compiled {
  const c = internals.get(formula);
  if (!c) throw new Error("This formula was not compiled by this formula engine; call compile() first");
  return c;
}

function dependenciesFromPlan(plan: Plan, tables: readonly string[], calculations: readonly string[]): FormulaDependencies {
  return {
    fields: [...plan.fields.keys()].sort(),
    relationships: [...plan.relations.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, child]) => ({ name, dependencies: dependenciesFromPlan(child, [], []) })),
    tables,
    calculations,
  };
}

function run(c: Compiled, inputs: ColumnarInputs, trace: Map<CNode, Col> | null): Col {
  return c.root.run({ n: inputs.rowCount, inputs, params: [], trace });
}

function evaluateColumn(formula: CompiledFormula, inputs: ColumnarInputs): ValueColumn {
  const c = internalsOf(formula);
  let col = run(c, inputs, null);
  if (c.root.node.k === "field") col = col instanceof Float64Array || col instanceof Int8Array ? col.slice() : [...col];
  return toValueColumn(col, c.type);
}

function valueAt(col: ValueColumn, i: number): FormulaValue {
  if (col.type === "quantity") {
    const v = col.values[i] as number;
    return v === v ? { type: "quantity", kind: col.kind, value: v as Quantity<Kind> } : { type: "empty" };
  }
  if (col.type === "boolean") {
    const v = col.values[i] as number;
    return v < 0 ? { type: "empty" } : { type: "boolean", value: v === 1 };
  }
  const v = col.values[i] ?? null;
  return v === null ? { type: "empty" } : { type: "text", value: v };
}

function evaluateRow(formula: CompiledFormula, row: RowValues): FormulaValue {
  return valueAt(evaluateColumn(formula, columnsFromRows(internalsOf(formula).plan, [row])), 0);
}

function explain(formula: CompiledFormula, row: RowValues) {
  const c = internalsOf(formula);
  const trace = new Map<CNode, Col>();
  const col = run(c, columnsFromRows(c.plan, [row]), trace);
  const value = valueAt(toValueColumn(col, c.type), 0);
  return { text: renderExplanation(c, trace, value), value };
}

/** Columnar inputs for `formula` built from lazily-read rows (reads only what the formula uses). */
export function inputsFromRows(formula: CompiledFormula, rows: readonly RowValues[]): ColumnarInputs {
  return columnsFromRows(internalsOf(formula).plan, rows);
}

const AGGREGATE_NAMES: ReadonlySet<string> = new Set(["sum", "avg", "count", "list", "min", "max"]);

function dependenciesOf(source: string): ReturnType<FormulaEngine["dependenciesOf"]> {
  const parsed = parseFormula(source);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const fields = new Set<string>();
  const calculations = new Set<string>();
  const tables = new Set<string>();
  const relationships = new Set<string>();
  const walk = (node: Node, insideRelationship: boolean): void => {
    switch (node.k) {
      case "field":
        if (!insideRelationship) fields.add(node.path);
        return;
      case "unary":
        walk(node.arg, insideRelationship);
        return;
      case "binary":
        walk(node.left, insideRelationship);
        walk(node.right, insideRelationship);
        return;
      case "call": {
        const [first, ...rest] = node.args;
        const aggregate = AGGREGATE_NAMES.has(node.name) && first?.k === "ident" && (node.name !== "min" && node.name !== "max" ? true : node.args.length === 2);
        if (aggregate && first?.k === "ident") {
          if (!insideRelationship) relationships.add(first.name);
          for (const a of rest) walk(a, true);
          return;
        }
        if (node.name === "lookup" && first?.k === "ident") {
          tables.add(first.name);
          for (const a of rest) walk(a, insideRelationship);
          return;
        }
        if (!isBuiltinFunction(node.name)) calculations.add(node.name);
        for (const a of node.args) walk(a, insideRelationship);
        return;
      }
      default:
        return;
    }
  };
  walk(parsed.node, false);
  return { ok: true, fields: [...fields].sort(), calculations: [...calculations].sort(), tables: [...tables].sort(), relationships: [...relationships].sort() };
}

export const formulaEngine: FormulaEngine = {
  compile(source, schema, options) {
    const result = compileSource(source, schema, options);
    if (!result.ok) return { ok: false, errors: result.errors };
    const c = result.compiled;
    const formula: CompiledFormula = Object.freeze({ source, type: c.type, dependencies: dependenciesFromPlan(c.plan, c.tables, c.calculations) });
    internals.set(formula, c);
    return { ok: true, formula };
  },
  evaluateColumn,
  evaluateRow,
  explain,
  dependenciesOf,
  findCycles,
};
