/**
 * Turn lazily-read rows into the columnar inputs `evaluateColumn` takes,
 * reading only the fields and relationships the formula uses.
 */

import { fillColumn, type Plan } from "./compile";
import type { CellValue, ColumnarInputs, FormulaType, RelationColumn, RowValues, ValueColumn } from "./types";

export function columnsFromRows(plan: Plan, rows: readonly RowValues[]): ColumnarInputs {
  const fields = new Map<string, ValueColumn>();
  for (const [path, type] of plan.fields) {
    const col = fillColumn(type, rows.length, (i) => checkedCell((rows[i] as RowValues).field(path), path, type));
    fields.set(path, type.type === "quantity" ? { type: "quantity", kind: type.kind, values: col as Float64Array } : type.type === "boolean" ? { type: "boolean", values: col as Int8Array } : { type: "text", values: col as (string | null)[] });
  }
  const relations = new Map<string, RelationColumn>();
  for (const [name, childPlan] of plan.relations) {
    const offsets = new Int32Array(rows.length + 1);
    const children: RowValues[] = [];
    for (let i = 0; i < rows.length; i++) {
      children.push(...(rows[i] as RowValues).related(name));
      offsets[i + 1] = children.length;
    }
    relations.set(name, { offsets, target: columnsFromRows(childPlan, children) });
  }
  return { rowCount: rows.length, fields, relations };
}

function checkedCell(value: CellValue, path: string, type: FormulaType): CellValue {
  if (value === null) return null;
  const ok = type.type === "quantity" ? typeof value === "number" : type.type === "boolean" ? typeof value === "boolean" : typeof value === "string";
  if (!ok) throw new TypeError(`Row value for {${path}} should be ${type.type === "quantity" ? `a ${type.kind} quantity` : type.type}, got ${typeof value}`);
  return value;
}

/** A row from a plain record, for library examples and tests: `{ "own.mbh": 58_322 }`. */
export function rowFromRecord(values: Readonly<Record<string, CellValue>>, related: Readonly<Record<string, readonly RowValues[]>> = {}): RowValues {
  return {
    field: (path) => (Object.prototype.hasOwnProperty.call(values, path) ? (values[path] ?? null) : null),
    related: (name) => related[name] ?? [],
  };
}
