import type { CellValue, ColumnValues, RowPatch, RowSet } from "./contracts";

/**
 * Applies a `RowPatch` to the client's copy of a `RowSet`. Value-only patches
 * (the common case: one edit) copy only the touched columns' arrays and keep
 * row order; inserts, removes and re-sorts rebuild the arrays in the new
 * order. Either way the result equals what a fresh `schedule_rows` would hold.
 */

const INDEX = new WeakMap<RowSet, Map<string, number>>();

export function rowIndexOf(rows: RowSet): Map<string, number> {
  let idx = INDEX.get(rows);
  if (!idx) {
    idx = new Map();
    for (let i = 0; i < rows.rowKeys.length; i++) {
      const k = rows.rowKeys[i];
      if (k !== undefined) idx.set(k, i);
    }
    INDEX.set(rows, idx);
  }
  return idx;
}

function setCell(col: ColumnValues, i: number, value: CellValue): void {
  if (col.type === "quantity") (col.values as Float64Array)[i] = typeof value === "number" ? value : NaN;
  else if (col.type === "boolean") (col.values as Int8Array)[i] = value === true ? 1 : value === false ? 0 : -1;
  else (col.values as (string | null)[])[i] = value === null ? null : String(value);
}

function cloneColumn(col: ColumnValues, length: number): ColumnValues {
  if (col.type === "quantity") {
    const v = new Float64Array(length).fill(NaN);
    v.set(col.values.subarray(0, Math.min(length, col.values.length)));
    return { type: "quantity", kind: col.kind, values: v };
  }
  if (col.type === "boolean") {
    const v = new Int8Array(length).fill(-1);
    v.set(col.values.subarray(0, Math.min(length, col.values.length)));
    return { type: "boolean", values: v };
  }
  const v: (string | null)[] = col.values.slice(0, length);
  while (v.length < length) v.push(null);
  return { type: "text", values: v };
}

function pick(col: ColumnValues, order: readonly number[]): ColumnValues {
  const n = order.length;
  if (col.type === "quantity") {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = order[i]! < 0 ? NaN : (col.values[order[i]!] ?? NaN);
    return { type: "quantity", kind: col.kind, values: v };
  }
  if (col.type === "boolean") {
    const v = new Int8Array(n);
    for (let i = 0; i < n; i++) v[i] = order[i]! < 0 ? -1 : (col.values[order[i]!] ?? -1);
    return { type: "boolean", values: v };
  }
  const v: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) v[i] = order[i]! < 0 ? null : (col.values[order[i]!] ?? null);
  return { type: "text", values: v };
}

export function applyRowPatch(rows: RowSet, patch: RowPatch): RowSet {
  if (patch.viewId !== rows.viewId) return rows;
  const index = rowIndexOf(rows);
  const removes = new Set(patch.removes);
  const inserts = patch.upserts.filter((u) => !index.has(u.rowKey));
  const structural = removes.size > 0 || inserts.length > 0 || patch.order !== undefined;

  let rowKeys = rows.rowKeys;
  let elementIds = rows.elementIds;
  const values = new Map<string, ColumnValues>();

  if (!structural) {
    const touched = new Set<string>();
    for (const u of patch.upserts) for (const c of Object.keys(u.values)) touched.add(c);
    for (const [id, col] of rows.values) values.set(id, touched.has(id) ? cloneColumn(col, rows.rowCount) : col);
  } else {
    const extendedKeys = [...rows.rowKeys, ...inserts.map((u) => u.rowKey)];
    const extendedEls = [...rows.elementIds, ...inserts.map((u) => u.elementId)];
    const extIndex = new Map(extendedKeys.map((k, i) => [k, i] as const));
    const keys = patch.order ? patch.order.filter((k) => extIndex.has(k) && !removes.has(k)) : extendedKeys.filter((k) => !removes.has(k));
    const order = keys.map((k) => extIndex.get(k) ?? -1);
    rowKeys = keys;
    elementIds = order.map((i) => extendedEls[i] ?? "");
    for (const [id, col] of rows.values) {
      const extended = cloneColumn(col, extendedKeys.length);
      values.set(id, pick(extended, order));
    }
  }

  const finalIndex = new Map(rowKeys.map((k, i) => [k, i] as const));
  const children = new Map(rows.children);
  for (const u of patch.upserts) {
    const i = finalIndex.get(u.rowKey);
    if (i === undefined) continue;
    for (const [c, v] of Object.entries(u.values)) {
      const col = values.get(c);
      if (col) setCell(col, i, v);
    }
    if (u.children) {
      for (const [c, sub] of Object.entries(u.children)) {
        const byParent = new Map(children.get(c) ?? []);
        byParent.set(u.rowKey, sub);
        children.set(c, byParent);
      }
    }
  }
  for (const k of removes) {
    for (const [c, byParent] of children) {
      if (byParent.has(k)) {
        const next = new Map(byParent);
        next.delete(k);
        children.set(c, next);
      }
    }
  }

  const totals = patch.totals ? new Map([...(rows.totals ?? new Map()), ...Object.entries(patch.totals)]) : rows.totals;
  return { ...rows, revision: patch.toRevision, rowCount: rowKeys.length, rowKeys, elementIds, values, children, ...(totals ? { totals } : {}) };
}
