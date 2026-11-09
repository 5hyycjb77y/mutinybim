import type { BimElement, Changeset } from "@permitzip/bim-kernel";

/**
 * A changeset stored as patches (MIGRATION-PLAN §6, "Model server
 * changesets"; KERNEL-AUDIT §6.1): each changed element is the difference
 * from the record it replaced, not its whole body. Everything else in the
 * changeset (actor, read set, intents, removals, connections) is kept as is.
 *
 * Expand step: the model server writes this beside the full `body` and keeps
 * reading the body; `replayChangesetPatch` over the records before the change
 * gives the full changeset back exactly (r5w-changeset-patch.test.ts). The
 * contract step, a release later, stops writing the full body.
 */
export const CHANGESET_PATCH_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Set `path` to `value`, or remove `path`. Arrays are replaced whole. */
export type PatchOp = { readonly p: readonly string[]; readonly v: Json } | { readonly p: readonly string[]; readonly d: true };

export type ElementPatch =
  /** A new element (or one whose previous record was not available): its whole body. */
  | { readonly id: string; readonly put: Json }
  /** The changes from the record at `base` (its `version`). */
  | { readonly id: string; readonly base: number; readonly ops: readonly PatchOp[] };

/** One entry of the changeset's `before` (what undo restores): the base record itself, or kept as stored. */
export type BeforeEntry = { readonly id: string; readonly base: number } | { readonly id: string; readonly value: Json };

export interface ChangesetPatch {
  readonly v: typeof CHANGESET_PATCH_VERSION;
  /** The changeset without `elements` and `before`. */
  readonly rest: Json;
  readonly elements: readonly ElementPatch[];
  /** `before`, in order, where each record equal to the base is a reference. Absent when the changeset has none. */
  readonly before?: readonly BeforeEntry[];
}

function toJson(value: unknown): Json {
  // JSON boundary: our own plain data, round-tripped exactly as the database stores it.
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b) && sameKeys(a, b);
}

function sameKeys(a: Json, b: Json): boolean {
  if (!isObject(a) || !isObject(b)) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && same(a[k] ?? null, b[k] ?? null));
}

function diff(before: Json, after: Json, path: string[], ops: PatchOp[]): void {
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before)) if (!(key in after)) ops.push({ p: [...path, key], d: true });
    for (const key of Object.keys(after)) {
      const next = after[key] ?? null;
      if (!(key in before)) ops.push({ p: [...path, key], v: next });
      else if (!same(before[key] ?? null, next)) diff(before[key] ?? null, next, [...path, key], ops);
    }
    return;
  }
  ops.push({ p: path, v: after });
}

/** The difference from `before` to `after` (both as stored). Empty when nothing changed. */
export function diffRecord(before: unknown, after: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  const a = toJson(before);
  const b = toJson(after);
  if (!same(a, b)) diff(a, b, [], ops);
  return ops;
}

function applyOps(base: Json, ops: readonly PatchOp[]): Json {
  let root: Json = toJson(base);
  for (const op of ops) {
    if (op.p.length === 0) {
      if ("d" in op) throw new Error("[changeset-patch] a patch can't remove a whole record");
      root = toJson(op.v);
      continue;
    }
    let node: Json = root;
    for (const key of op.p.slice(0, -1)) {
      if (!isObject(node)) throw new Error(`[changeset-patch] path ${op.p.join(".")} runs through a value that is not an object`);
      const child: Json = node[key] ?? null;
      if (!isObject(child)) throw new Error(`[changeset-patch] path ${op.p.join(".")} is missing in the base record`);
      node = child;
    }
    if (!isObject(node)) throw new Error(`[changeset-patch] path ${op.p.join(".")} ends in a value that is not an object`);
    const last = op.p[op.p.length - 1] ?? "";
    if ("d" in op) delete node[last];
    else node[last] = toJson(op.v);
  }
  return root;
}

/**
 * Patch form of `cs`. `before` answers the record each changed element had
 * before this changeset (the head it was decided on); unknown ids are stored whole.
 */
export function changesetPatch(cs: Changeset, before: (id: string) => BimElement | undefined): ChangesetPatch {
  const { elements, before: undoRecords, ...rest } = cs;
  return {
    v: CHANGESET_PATCH_VERSION,
    rest: toJson(rest),
    elements: elements.map((el): ElementPatch => {
      const prior = before(el.id);
      return prior ? { id: el.id, base: prior.version, ops: diffRecord(prior, el) } : { id: el.id, put: toJson(el) };
    }),
    ...(undoRecords
      ? {
          before: Object.entries(undoRecords).map(([id, record]): BeforeEntry => {
            const prior = before(id);
            const value = toJson(record);
            return prior && record !== null && same(toJson(prior), value) ? { id, base: prior.version } : { id, value };
          }),
        }
      : {}),
  };
}

/** Rebuild the full changeset from its patch and the records before it. Throws when a base record is missing or at another version. */
export function replayChangesetPatch(patch: ChangesetPatch, before: (id: string) => BimElement | undefined): Changeset {
  if (patch.v !== CHANGESET_PATCH_VERSION) throw new Error(`[changeset-patch] unknown patch version ${String(patch.v)}`);
  const elements = patch.elements.map((ep) => {
    if ("put" in ep) return ep.put;
    const prior = before(ep.id);
    if (!prior) throw new Error(`[changeset-patch] ${ep.id}: the record this patch applies to is missing`);
    if (prior.version !== ep.base) throw new Error(`[changeset-patch] ${ep.id}: patch is from version ${ep.base}, the record is at ${prior.version}`);
    return applyOps(toJson(prior), ep.ops);
  });
  if (!isObject(patch.rest)) throw new Error("[changeset-patch] patch has no changeset fields");
  let undoRecords: Record<string, Json> | undefined;
  if (patch.before) {
    undoRecords = {};
    for (const entry of patch.before) {
      if ("value" in entry) {
        undoRecords[entry.id] = entry.value;
        continue;
      }
      const prior = before(entry.id);
      if (!prior) throw new Error(`[changeset-patch] ${entry.id}: the record undo restores is missing`);
      if (prior.version !== entry.base) throw new Error(`[changeset-patch] ${entry.id}: undo record is version ${entry.base}, the record is at ${prior.version}`);
      undoRecords[entry.id] = toJson(prior);
    }
  }
  // JSON boundary: the changeset this server stored, rebuilt field for field.
  return JSON.parse(JSON.stringify({ ...patch.rest, elements, ...(undoRecords ? { before: undoRecords } : {}) }));
}

/** Bytes of a value as the database receives it (JSON text). */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
