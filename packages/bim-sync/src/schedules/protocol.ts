import { z } from "zod";
import type { Measure } from "@permitzip/bim-units";
import type { CellValue, ColumnId, ColumnValues, RowGroup, RowHighlight, RowKey, RowPatch, RowSet, RowSetColumn, RowUpsert } from "./rows";

/**
 * Schedule subscriptions and cell presence on the live-sync socket
 * (SCHEDULES-PLAN §6). A client opens a schedule by view id or ad hoc
 * definition with a row window; the server evaluates it over the WHOLE model
 * it holds (not the client's loaded areas), sends that window, then sends
 * incremental patches as commits land. `editing_cell` is a short soft hold:
 * others see who is typing in a cell and their client waits (at most the TTL)
 * before sending its own edit to it.
 */

/** Cell hold TTL ceiling: a second person's edit waits at most this long. */
export const EDITING_CELL_MAX_TTL_MS = 8_000;
/** Rows one window may ask for (the grid mounts ~40; scroll prefetch asks a few hundred). */
export const MAX_WINDOW_ROWS = 2_000;
/** Schedules one connection may hold open at once. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 16;
/** An ad hoc definition is a small JSON document; anything larger is refused. */
export const MAX_DEFINITION_BYTES = 64 * 1024;

const idSchema = z.string().min(1).max(200);

export const scheduleWindowSchema = z.object({
  offset: z.number().int().min(0).max(10_000_000),
  limit: z.number().int().min(1).max(MAX_WINDOW_ROWS),
});
export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;

export const scheduleTargetSchema = z.union([
  z.object({ viewId: idSchema }).strict(),
  z
    .object({ definition: z.record(z.string(), z.unknown()) })
    .strict()
    .refine((t) => JSON.stringify(t.definition).length <= MAX_DEFINITION_BYTES, { message: "Schedule definition is too large" }),
]);
/** `definition` is Stream E's ScheduleDefinitionV2; the evaluator validates it. */
export type ScheduleTarget = { readonly viewId: string } | { readonly definition: Readonly<Record<string, unknown>> };

const cellSchema = { viewId: idSchema, rowKey: z.string().min(1).max(400), columnId: idSchema };

/** The schedule members of the client message union (protocol.ts adds them to `clientMessageSchema`). */
export const scheduleClientMessageSchemas = [
  z.object({ type: z.literal("schedule_open"), subscriptionId: idSchema, target: scheduleTargetSchema, window: scheduleWindowSchema }),
  z.object({ type: z.literal("schedule_window"), subscriptionId: idSchema, window: scheduleWindowSchema }),
  z.object({ type: z.literal("schedule_close"), subscriptionId: idSchema }),
  z.object({ type: z.literal("editing_cell"), ...cellSchema, ttlMs: z.number().int().min(500).max(EDITING_CELL_MAX_TTL_MS) }),
  z.object({ type: z.literal("editing_cell_release"), ...cellSchema }),
] as const;

export type ScheduleClientMessage =
  | { readonly type: "schedule_open"; readonly subscriptionId: string; readonly target: ScheduleTarget; readonly window: ScheduleWindow }
  | { readonly type: "schedule_window"; readonly subscriptionId: string; readonly window: ScheduleWindow }
  | { readonly type: "schedule_close"; readonly subscriptionId: string }
  | { readonly type: "editing_cell"; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId; readonly ttlMs: number }
  | { readonly type: "editing_cell_release"; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId };

export type ScheduleClosedReason = "denied" | "deleted" | "closed";

export interface ActorRef {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

// ---------------------------------------------------------------- wire encoding

/** JSON-safe column: typed arrays become arrays (quantity NaN → null). */
export type WireColumnValues =
  | { readonly type: "quantity"; readonly kind: Extract<ColumnValues, { type: "quantity" }>["kind"]; readonly values: readonly (number | null)[] }
  | { readonly type: "boolean"; readonly values: readonly number[] }
  | { readonly type: "text"; readonly values: readonly (string | null)[] };

export interface WireRowSet {
  readonly viewId: string;
  readonly revision: number;
  readonly columns: readonly RowSetColumn[];
  readonly rowCount: number;
  readonly rowKeys: readonly RowKey[];
  readonly elementIds: readonly string[];
  readonly values: Readonly<Record<ColumnId, WireColumnValues>>;
  readonly children: Readonly<Record<ColumnId, Readonly<Record<RowKey, WireRowSet>>>>;
  readonly highlights?: Readonly<Record<ColumnId, Readonly<Record<RowKey, RowHighlight>>>>;
  readonly totals?: Readonly<Record<ColumnId, Measure | null>>;
  readonly groups?: readonly RowGroup[];
  readonly rowElementIds?: readonly (readonly string[])[];
}

export interface WireRowUpsert {
  readonly rowKey: RowKey;
  readonly elementId: string;
  readonly values: Readonly<Record<ColumnId, CellValue>>;
  readonly children?: Readonly<Record<ColumnId, WireRowSet>>;
  readonly highlights?: Readonly<Record<ColumnId, RowHighlight | null>>;
  readonly elementIds?: readonly string[];
}

export interface WireRowPatch {
  readonly viewId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly upserts: readonly WireRowUpsert[];
  readonly removes: readonly RowKey[];
  readonly order?: readonly RowKey[];
  readonly totals?: Readonly<Record<ColumnId, Measure | null>>;
  readonly groups?: readonly RowGroup[];
}

export type ScheduleServerMessage =
  /** The rows of the subscriber's window; `total` is the whole schedule's row count. Also sent again when the definition changes. */
  | { readonly type: "schedule_rows"; readonly subscriptionId: string; readonly window: ScheduleWindow; readonly total: number; readonly rows: WireRowSet }
  /** Applying `patch` to the window the client holds equals a fresh `schedule_rows`. `total` is present when the row count changed. */
  | { readonly type: "schedule_patch"; readonly subscriptionId: string; readonly patch: WireRowPatch; readonly total?: number }
  | { readonly type: "schedule_closed"; readonly subscriptionId: string; readonly reason: ScheduleClosedReason; readonly message: string }
  /** `expiresAt` is the server clock; receivers time the hold with `ttlMs` on their own clock. */
  | {
      readonly type: "editing_cell";
      readonly connectionId: string;
      readonly actor: ActorRef;
      readonly viewId: string;
      readonly rowKey: RowKey;
      readonly columnId: ColumnId;
      readonly ttlMs: number;
      readonly expiresAt: number;
    }
  | { readonly type: "editing_cell_release"; readonly connectionId: string; readonly actor: ActorRef; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId };

export const SCHEDULE_SERVER_TYPES = ["schedule_rows", "schedule_patch", "schedule_closed", "editing_cell", "editing_cell_release"] as const;

function encodeColumn(col: ColumnValues): WireColumnValues {
  if (col.type === "quantity") {
    const values: (number | null)[] = new Array(col.values.length);
    for (let i = 0; i < col.values.length; i++) {
      const v = col.values[i] ?? NaN;
      values[i] = Number.isFinite(v) ? v : null;
    }
    return { type: "quantity", kind: col.kind, values };
  }
  if (col.type === "boolean") return { type: "boolean", values: Array.from(col.values) };
  return { type: "text", values: col.values };
}

function decodeColumn(col: WireColumnValues): ColumnValues {
  if (col.type === "quantity") {
    const values = new Float64Array(col.values.length);
    for (let i = 0; i < col.values.length; i++) values[i] = col.values[i] ?? NaN;
    return { type: "quantity", kind: col.kind, values };
  }
  if (col.type === "boolean") return { type: "boolean", values: Int8Array.from(col.values) };
  return { type: "text", values: col.values };
}

function mapRecord<A, B>(map: ReadonlyMap<string, A>, f: (a: A) => B): Record<string, B> {
  const out: Record<string, B> = {};
  for (const [k, v] of map) out[k] = f(v);
  return out;
}

function recordMap<A, B>(rec: Readonly<Record<string, A>>, f: (a: A) => B): Map<string, B> {
  const out = new Map<string, B>();
  for (const [k, v] of Object.entries(rec)) out.set(k, f(v));
  return out;
}

export function encodeRowSet(rows: RowSet): WireRowSet {
  return {
    viewId: rows.viewId,
    revision: rows.revision,
    columns: rows.columns,
    rowCount: rows.rowCount,
    rowKeys: rows.rowKeys,
    elementIds: rows.elementIds,
    values: mapRecord(rows.values, encodeColumn),
    children: mapRecord(rows.children, (byParent) => mapRecord(byParent, encodeRowSet)),
    ...(rows.highlights ? { highlights: mapRecord(rows.highlights, (byRow) => mapRecord(byRow, (h) => h)) } : {}),
    ...(rows.totals ? { totals: mapRecord(rows.totals, (t) => t) } : {}),
    ...(rows.groups ? { groups: rows.groups } : {}),
    ...(rows.rowElementIds ? { rowElementIds: rows.rowElementIds } : {}),
  };
}

export function decodeRowSet(rows: WireRowSet): RowSet {
  return {
    viewId: rows.viewId,
    revision: rows.revision,
    columns: rows.columns,
    rowCount: rows.rowCount,
    rowKeys: rows.rowKeys,
    elementIds: rows.elementIds,
    values: recordMap(rows.values, decodeColumn),
    children: recordMap(rows.children, (byParent) => recordMap(byParent, decodeRowSet)),
    ...(rows.highlights ? { highlights: recordMap(rows.highlights, (byRow) => recordMap(byRow, (h) => h)) } : {}),
    ...(rows.totals ? { totals: recordMap(rows.totals, (t) => t) } : {}),
    ...(rows.groups ? { groups: rows.groups } : {}),
    ...(rows.rowElementIds ? { rowElementIds: rows.rowElementIds } : {}),
  };
}

function encodeUpsert(u: RowUpsert): WireRowUpsert {
  const { children: _children, ...rest } = u;
  return {
    ...rest,
    ...(u.children ? { children: Object.fromEntries(Object.entries(u.children).map(([c, sub]) => [c, encodeRowSet(sub)])) } : {}),
  };
}

function decodeUpsert(u: WireRowUpsert): RowUpsert {
  const { children: _children, ...rest } = u;
  return {
    ...rest,
    ...(u.children ? { children: Object.fromEntries(Object.entries(u.children).map(([c, sub]) => [c, decodeRowSet(sub)])) } : {}),
  };
}

export function encodeRowPatch(patch: RowPatch): WireRowPatch {
  return { ...patch, upserts: patch.upserts.map(encodeUpsert) };
}

export function decodeRowPatch(patch: WireRowPatch): RowPatch {
  return { ...patch, upserts: patch.upserts.map(decodeUpsert) };
}

const PALETTE = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f"] as const;

/** A stable presence colour per actor, so everyone sees the same person in the same colour. */
export function actorColor(actorId: string): string {
  let h = 2166136261;
  for (let i = 0; i < actorId.length; i++) h = Math.imul(h ^ actorId.charCodeAt(i), 16777619);
  return PALETTE[(h >>> 0) % PALETTE.length] ?? PALETTE[0];
}
