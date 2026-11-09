import type { Measure } from "@permitzip/bim-units";
import type { Changeset } from "../../changeset";
import type { ModelState } from "../../types";
import type { CellValue, ColumnId, ColumnValues, RowHighlight, RowKey, RowPatch, RowSet, ScheduleChange } from "./types";

/**
 * Client side of the row engine: fold a `RowPatch` into the `RowSet` it was
 * made against. `applyRowPatch(before, session.apply(change))` equals
 * `buildRowSet(after)`; the engine's property test holds it to that.
 */

function cellAt(col: ColumnValues, i: number): CellValue {
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

function rebuildColumn(col: ColumnValues, cells: readonly CellValue[]): ColumnValues {
  if (col.type === "quantity") return { type: "quantity", kind: col.kind, values: Float64Array.from(cells, (c) => (typeof c === "number" ? c : Number.NaN)) };
  if (col.type === "boolean") return { type: "boolean", values: Int8Array.from(cells, (c) => (c === true ? 1 : c === false ? 0 : -1)) };
  return { type: "text", values: cells.map((c) => (c === null ? null : String(c))) };
}

/** Rows stay where they are (no order, no removes, every upsert already present): copy each column and write the upserted cells. */
function patchInPlace(rows: RowSet, patch: RowPatch): RowSet | null {
  if (patch.order || patch.removes.length > 0) return null;
  const at: number[] = [];
  const index = patch.upserts.length > 32 ? new Map(rows.rowKeys.map((k, i) => [k, i])) : null;
  for (const u of patch.upserts) {
    const i = index ? (index.get(u.rowKey) ?? -1) : rows.rowKeys.indexOf(u.rowKey);
    if (i < 0) return null;
    at.push(i);
  }
  const values = new Map<ColumnId, ColumnValues>();
  for (const [id, col] of rows.values) {
    if (col.type === "quantity") {
      const v = col.values.slice();
      patch.upserts.forEach((u, k) => {
        if (Object.prototype.hasOwnProperty.call(u.values, id)) {
          const c = u.values[id];
          v[at[k] ?? 0] = typeof c === "number" ? c : Number.NaN;
        }
      });
      values.set(id, { type: "quantity", kind: col.kind, values: v });
    } else if (col.type === "boolean") {
      const v = col.values.slice();
      patch.upserts.forEach((u, k) => {
        if (Object.prototype.hasOwnProperty.call(u.values, id)) {
          const c = u.values[id];
          v[at[k] ?? 0] = c === true ? 1 : c === false ? 0 : -1;
        }
      });
      values.set(id, { type: "boolean", values: v });
    } else {
      const v = col.values.slice();
      patch.upserts.forEach((u, k) => {
        if (Object.prototype.hasOwnProperty.call(u.values, id)) {
          const c = u.values[id];
          v[at[k] ?? 0] = c === null || c === undefined ? null : String(c);
        }
      });
      values.set(id, { type: "text", values: v });
    }
  }
  let children = rows.children;
  const expandIds = rows.columns.filter((c) => c.kind === "expand").map((c) => c.id);
  if (expandIds.length > 0) {
    const next = new Map<ColumnId, Map<RowKey, RowSet>>();
    for (const col of expandIds) {
      const m = new Map(rows.children.get(col) ?? []);
      for (const u of patch.upserts) {
        const set = u.children?.[col];
        if (set && !m.has(u.rowKey)) return null;
        if (set) m.set(u.rowKey, set);
        else m.delete(u.rowKey);
      }
      next.set(col, m);
    }
    children = next;
  }
  let highlights = rows.highlights;
  const touched = new Set<ColumnId>(patch.upserts.flatMap((u) => Object.keys(u.highlights ?? {})));
  if (touched.size > 0) {
    const next = new Map<ColumnId, Map<RowKey, RowHighlight>>();
    for (const [col, m] of rows.highlights ?? []) next.set(col, new Map(m));
    for (const u of patch.upserts) {
      for (const [col, h] of Object.entries(u.highlights ?? {})) {
        let m = next.get(col);
        if (!m) next.set(col, (m = new Map()));
        if (h && !m.has(u.rowKey)) return null;
        if (h) m.set(u.rowKey, h);
        else m.delete(u.rowKey);
      }
    }
    for (const [col, m] of next) if (m.size === 0) next.delete(col);
    highlights = next.size > 0 ? next : undefined;
  }
  const elementIds = rows.elementIds.slice();
  const rowElementIds = rows.rowElementIds ? rows.rowElementIds.slice() : undefined;
  patch.upserts.forEach((u, k) => {
    const i = at[k] ?? 0;
    elementIds[i] = u.elementId;
    if (rowElementIds) rowElementIds[i] = u.elementIds ?? [u.rowKey];
  });
  const totals = patch.totals ? new Map<ColumnId, Measure | null>(Object.entries(patch.totals)) : rows.totals;
  const groups = patch.groups ?? rows.groups;
  return {
    viewId: rows.viewId,
    revision: patch.toRevision,
    columns: rows.columns,
    rowCount: rows.rowCount,
    rowKeys: rows.rowKeys,
    elementIds,
    values,
    children,
    ...(highlights ? { highlights } : {}),
    ...(totals ? { totals } : {}),
    ...(groups ? { groups } : {}),
    ...(rowElementIds ? { rowElementIds } : {}),
  };
}

function writeCell(col: ColumnValues, i: number, v: CellValue): void {
  if (col.type === "quantity") col.values[i] = typeof v === "number" ? v : Number.NaN;
  else if (col.type === "boolean") col.values[i] = v === true ? 1 : v === false ? 0 : -1;
  else (col.values as (string | null)[])[i] = v === null ? null : String(v);
}

function copyColumn(col: ColumnValues): ColumnValues {
  if (col.type === "quantity") return { type: "quantity", kind: col.kind, values: col.values.slice() };
  if (col.type === "boolean") return { type: "boolean", values: col.values.slice() };
  return { type: "text", values: col.values.slice() };
}

/** Same rows in the same order (an edit that moved nothing): copy each column and overwrite the upserted rows. */
function applyInPlace(rows: RowSet, patch: RowPatch): RowSet | null {
  const at: number[] = [];
  const many = patch.upserts.length > 32 ? new Map(rows.rowKeys.map((k, i) => [k, i])) : null;
  for (const u of patch.upserts) {
    const i = many ? (many.get(u.rowKey) ?? -1) : rows.rowKeys.indexOf(u.rowKey);
    if (i < 0) return null;
    at.push(i);
  }
  const values = new Map<ColumnId, ColumnValues>();
  for (const [id, col] of rows.values) {
    const next = copyColumn(col);
    patch.upserts.forEach((u, k) => {
      if (Object.prototype.hasOwnProperty.call(u.values, id)) writeCell(next, at[k] as number, u.values[id] ?? null);
    });
    values.set(id, next);
  }
  const children = new Map<ColumnId, Map<RowKey, RowSet>>();
  for (const c of rows.columns) {
    if (c.kind !== "expand") continue;
    const m = new Map(rows.children.get(c.id) ?? []);
    for (const u of patch.upserts) {
      const set = u.children?.[c.id];
      if (set) m.set(u.rowKey, set);
      else m.delete(u.rowKey);
    }
    children.set(c.id, m);
  }
  let highlights: Map<ColumnId, Map<RowKey, RowHighlight>> | undefined = rows.highlights ? new Map([...rows.highlights].map(([k, m]) => [k, new Map(m)])) : undefined;
  for (const u of patch.upserts) {
    if (highlights) for (const [col, m] of highlights) if (!u.highlights || !Object.prototype.hasOwnProperty.call(u.highlights, col)) m.delete(u.rowKey);
    for (const [col, h] of Object.entries(u.highlights ?? {})) {
      highlights ??= new Map();
      let m = highlights.get(col);
      if (!m) highlights.set(col, (m = new Map()));
      if (h) m.set(u.rowKey, h);
      else m.delete(u.rowKey);
    }
  }
  if (highlights) for (const [k, m] of highlights) if (m.size === 0) highlights.delete(k);
  if (highlights?.size === 0) highlights = undefined;
  const elementIds = [...rows.elementIds];
  const rowElementIds = rows.rowElementIds ? [...rows.rowElementIds] : undefined;
  patch.upserts.forEach((u, k) => {
    const i = at[k] as number;
    elementIds[i] = u.elementId;
    if (rowElementIds) rowElementIds[i] = u.elementIds ?? [u.rowKey];
  });
  const totals = patch.totals ? new Map<ColumnId, Measure | null>(Object.entries(patch.totals)) : rows.totals;
  const groups = patch.groups ?? rows.groups;
  return {
    viewId: rows.viewId,
    revision: patch.toRevision,
    columns: rows.columns,
    rowCount: rows.rowCount,
    rowKeys: rows.rowKeys,
    elementIds,
    values,
    children,
    ...(highlights ? { highlights } : {}),
    ...(totals ? { totals } : {}),
    ...(groups ? { groups } : {}),
    ...(rowElementIds ? { rowElementIds } : {}),
  };
}

export function applyRowPatch(rows: RowSet, patch: RowPatch): RowSet {
  if (patch.fromRevision !== rows.revision) throw new Error(`This patch is for revision ${patch.fromRevision}, but the rows are at ${rows.revision}.`);
  if (!patch.order && patch.removes.length === 0) {
    const same = applyInPlace(rows, patch);
    if (same) return same;
  }
  const fast = patchInPlace(rows, patch);
  if (fast) return fast;
  const indexOf = new Map<RowKey, number>();
  rows.rowKeys.forEach((k, i) => indexOf.set(k, i));
  const upserts = new Map(patch.upserts.map((u) => [u.rowKey, u]));
  const removed = new Set(patch.removes);
  const order = patch.order ?? [...rows.rowKeys.filter((k) => !removed.has(k)), ...patch.upserts.map((u) => u.rowKey).filter((k) => !indexOf.has(k))];

  const values = new Map<ColumnId, ColumnValues>();
  for (const [id, col] of rows.values) {
    values.set(
      id,
      rebuildColumn(
        col,
        order.map((k) => {
          const u = upserts.get(k);
          if (u && Object.prototype.hasOwnProperty.call(u.values, id)) return u.values[id] ?? null;
          const i = indexOf.get(k);
          return i === undefined ? null : cellAt(col, i);
        }),
      ),
    );
  }

  const children = new Map<ColumnId, Map<RowKey, RowSet>>();
  const childColumns = rows.columns.filter((c) => c.kind === "expand").map((c) => c.id);
  for (const col of childColumns) {
    const before = rows.children.get(col);
    const m = new Map<RowKey, RowSet>();
    for (const k of order) {
      const u = upserts.get(k);
      const set = u ? u.children?.[col] : before?.get(k);
      if (set) m.set(k, set);
    }
    children.set(col, m);
  }

  let highlights: Map<ColumnId, Map<RowKey, RowHighlight>> | undefined;
  const highlightCols = new Set<ColumnId>([...(rows.highlights?.keys() ?? []), ...patch.upserts.flatMap((u) => Object.keys(u.highlights ?? {}))]);
  if (highlightCols.size > 0) {
    highlights = new Map();
    for (const col of highlightCols) {
      const before = rows.highlights?.get(col);
      const m = new Map<RowKey, RowHighlight>();
      for (const k of order) {
        const u = upserts.get(k);
        const h = u?.highlights && Object.prototype.hasOwnProperty.call(u.highlights, col) ? u.highlights[col] : u ? null : before?.get(k);
        if (h) m.set(k, h);
      }
      if (m.size > 0) highlights.set(col, m);
    }
    if (highlights.size === 0) highlights = undefined;
  }

  const elementIds = order.map((k) => upserts.get(k)?.elementId ?? rows.elementIds[indexOf.get(k) ?? -1] ?? k);
  const rowElementIds = rows.rowElementIds ? order.map((k) => upserts.get(k)?.elementIds ?? rows.rowElementIds?.[indexOf.get(k) ?? -1] ?? [k]) : undefined;
  const totals = patch.totals ? new Map<ColumnId, Measure | null>(Object.entries(patch.totals)) : rows.totals;
  const groups = patch.groups ?? rows.groups;
  return {
    viewId: rows.viewId,
    revision: patch.toRevision,
    columns: rows.columns,
    rowCount: order.length,
    rowKeys: order,
    elementIds,
    values,
    children,
    ...(highlights ? { highlights } : {}),
    ...(totals ? { totals } : {}),
    ...(groups ? { groups } : {}),
    ...(rowElementIds ? { rowElementIds } : {}),
  };
}

/** What a committed changeset touched, in the shape `ScheduleSession.apply` takes. */
export function scheduleChangeFromChangeset(changeset: Changeset, model: Pick<ModelState, "elements" | "connections">): ScheduleChange {
  const endpoints = new Set<string>();
  for (const c of [...(changeset.addedConnections ?? []), ...(changeset.removedConnections ?? [])]) {
    endpoints.add(c.a.elementId);
    endpoints.add(c.b.elementId);
  }
  return {
    model,
    revision: changeset.revision,
    changedIds: changeset.elements.map((e) => e.id),
    ...(changeset.removedIds ? { removedIds: changeset.removedIds } : {}),
    ...(endpoints.size > 0 ? { connectionEndpoints: [...endpoints] } : {}),
  };
}
