import type { CellValue, ColumnValues, RowGroup, RowHighlight, RowKey, RowPatch, RowSet, RowUpsert } from "./rows";
import type { ScheduleWindow } from "./protocol";

/**
 * Windowing: a subscriber holds only the rows of its window. The evaluator
 * produces whole-schedule rows and patches; these turn them into exactly
 * what one subscriber needs, so applying the windowed patch to the window it
 * holds equals a fresh window of the new rows.
 */

function sliceColumn(col: ColumnValues, start: number, end: number): ColumnValues {
  if (col.type === "quantity") return { type: "quantity", kind: col.kind, values: col.values.slice(start, end) };
  if (col.type === "boolean") return { type: "boolean", values: col.values.slice(start, end) };
  return { type: "text", values: col.values.slice(start, end) };
}

/** Groups overlapping rows [start, end), re-based to the window. */
function sliceGroups(groups: readonly RowGroup[], start: number, end: number): RowGroup[] {
  const out: RowGroup[] = [];
  for (const g of groups) {
    const from = Math.max(g.start, start);
    const to = Math.min(g.start + g.count, end);
    if (to > from || (g.count === 0 && g.start >= start && g.start < end)) out.push({ ...g, start: from - start, count: Math.max(0, to - from) });
  }
  return out;
}

export function windowKeys(rows: RowSet, window: ScheduleWindow): RowKey[] {
  return rows.rowKeys.slice(window.offset, window.offset + window.limit);
}

/** The rows of one window (children and highlights for those rows only; grand totals kept). */
export function sliceRows(rows: RowSet, window: ScheduleWindow): RowSet {
  const start = Math.min(window.offset, rows.rowCount);
  const end = Math.min(window.offset + window.limit, rows.rowCount);
  const keys = rows.rowKeys.slice(start, end);
  const inWindow = new Set(keys);
  const values = new Map<string, ColumnValues>();
  for (const [id, col] of rows.values) values.set(id, sliceColumn(col, start, end));
  const children = new Map<string, Map<RowKey, RowSet>>();
  for (const [id, byParent] of rows.children) {
    const kept = new Map<RowKey, RowSet>();
    for (const [parent, sub] of byParent) if (inWindow.has(parent)) kept.set(parent, sub);
    children.set(id, kept);
  }
  let highlights: Map<string, Map<RowKey, RowHighlight>> | undefined;
  if (rows.highlights) {
    highlights = new Map();
    for (const [id, byRow] of rows.highlights) {
      const kept = new Map<RowKey, RowHighlight>();
      for (const [key, h] of byRow) if (inWindow.has(key)) kept.set(key, h);
      highlights.set(id, kept);
    }
  }
  return {
    viewId: rows.viewId,
    revision: rows.revision,
    columns: rows.columns,
    rowCount: keys.length,
    rowKeys: keys,
    elementIds: rows.elementIds.slice(start, end),
    values,
    children,
    ...(highlights ? { highlights } : {}),
    ...(rows.totals ? { totals: rows.totals } : {}),
    ...(rows.groups ? { groups: sliceGroups(rows.groups, start, end) } : {}),
    ...(rows.rowElementIds ? { rowElementIds: rows.rowElementIds.slice(start, end) } : {}),
  };
}

function cellAt(col: ColumnValues, i: number): CellValue {
  if (col.type === "quantity") {
    const v = col.values[i] ?? NaN;
    return Number.isFinite(v) ? v : null;
  }
  if (col.type === "boolean") {
    const v = col.values[i] ?? -1;
    return v === 1 ? true : v === 0 ? false : null;
  }
  return col.values[i] ?? null;
}

/** Every value of row `i` as an upsert (a row entering someone's window). */
export function rowUpsertAt(rows: RowSet, i: number): RowUpsert {
  const key = rows.rowKeys[i] ?? "";
  const values: Record<string, CellValue> = {};
  for (const [id, col] of rows.values) values[id] = cellAt(col, i);
  const children: Record<string, RowSet> = {};
  for (const [id, byParent] of rows.children) {
    const sub = byParent.get(key);
    if (sub) children[id] = sub;
  }
  const highlights: Record<string, RowHighlight> = {};
  for (const [id, byRow] of rows.highlights ?? []) {
    const h = byRow.get(key);
    if (h) highlights[id] = h;
  }
  const elementIds = rows.rowElementIds?.[i];
  return {
    rowKey: key,
    elementId: rows.elementIds[i] ?? "",
    values,
    ...(Object.keys(children).length ? { children } : {}),
    ...(Object.keys(highlights).length ? { highlights } : {}),
    ...(elementIds ? { elementIds } : {}),
  };
}

export interface WindowedPatch {
  readonly patch: RowPatch | null;
  /** The keys this subscriber holds after applying it. */
  readonly keys: RowKey[];
  /** Present when the whole schedule's row count changed. */
  readonly total?: number;
}

/**
 * Narrow a whole-schedule patch to one subscriber. `held` is the window the
 * subscriber holds now; `rows` is the whole schedule after the patch.
 */
export function projectPatch(rows: RowSet, patch: RowPatch, held: readonly RowKey[], window: ScheduleWindow, previousTotal: number): WindowedPatch {
  const keys = windowKeys(rows, window);
  const next = new Set(keys);
  const before = new Set(held);
  const removes = held.filter((k) => !next.has(k));
  const entering = new Set(keys.filter((k) => !before.has(k)));
  const sameOrder = removes.length === 0 && entering.size === 0 && keys.length === held.length && keys.every((k, i) => k === held[i]);

  const upserts: RowUpsert[] = [];
  for (const u of patch.upserts) if (next.has(u.rowKey) && before.has(u.rowKey)) upserts.push(u);
  if (entering.size > 0) {
    const first = Math.min(window.offset, rows.rowCount);
    for (let i = first; i < first + keys.length; i++) {
      const key = rows.rowKeys[i];
      if (key !== undefined && entering.has(key)) upserts.push(rowUpsertAt(rows, i));
    }
  }
  const total = rows.rowCount !== previousTotal ? rows.rowCount : undefined;
  // Group spans are row indices: any move inside the window, or a changed group, re-sends the window's groups.
  const start = Math.min(window.offset, rows.rowCount);
  const groups = rows.groups && (patch.groups || !sameOrder || total !== undefined) ? sliceGroups(rows.groups, start, start + keys.length) : undefined;
  if (upserts.length === 0 && removes.length === 0 && sameOrder && !patch.totals && total === undefined && !groups) return { patch: null, keys };
  return {
    patch: {
      viewId: patch.viewId,
      fromRevision: patch.fromRevision,
      toRevision: patch.toRevision,
      upserts,
      removes,
      ...(sameOrder ? {} : { order: keys }),
      ...(patch.totals ? { totals: patch.totals } : {}),
      ...(groups ? { groups } : {}),
    },
    keys,
    ...(total !== undefined ? { total } : {}),
  };
}

/** A patch that moved no rows: keep the upserts inside the window (and totals). */
export function projectValuePatch(patch: RowPatch, held: RowKey[], heldSet: ReadonlySet<RowKey>): WindowedPatch {
  const upserts = patch.upserts.filter((u) => heldSet.has(u.rowKey));
  if (upserts.length === 0 && !patch.totals) return { patch: null, keys: held };
  return {
    patch: { viewId: patch.viewId, fromRevision: patch.fromRevision, toRevision: patch.toRevision, upserts, removes: [], ...(patch.totals ? { totals: patch.totals } : {}) },
    keys: held,
  };
}
