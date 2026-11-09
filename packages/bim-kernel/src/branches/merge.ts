/**
 * Three-way merge of a branch into Main (round 8 step 8b, lane M).
 *
 * Inputs are the element records at the branch's base revision, on Main's
 * head and on the branch's head, for the ids each side changed since the base
 * (the model server reads them with `state_at` / `changed_between`). Only the
 * changed set is touched: never a model scan.
 *
 * - Changed on the branch only: the branch's record is written to Main.
 * - Changed on both the same way: already on Main, nothing to do.
 * - Changed on both differently: a conflict, listed in words, resolved on the
 *   branch before merging.
 *
 * A landed part is an ordinary revision on Main: never a change order, never
 * a cost.
 */
import { canonicalJson } from "../canonical";
import { canonicalize, sha256HexOf } from "../authorship/canonical";
import { finish, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { draftElements } from "../store";
import type { BimElement, Connection, ConnectorRef, ElementId, ModelState } from "../types";
import type { ElementCoverage } from "../responsibility/types";
import type { ConnectionChanges, ElementAt, MergeConflict, MergePart, MergeWrite, ThreeWayMerge } from "./merge-types";

/** A record's content without the per-side bookkeeping (version counters, authored-revision stamps). */
function content(el: BimElement | null): string {
  if (el === null) return "null";
  const { version: _v, authoredRev: _a, ...rest } = el;
  return canonicalJson(rest);
}

function textField(el: BimElement | null, key: "mark" | "name" | "label"): string | null {
  if (el === null || !(key in el)) return null;
  const value: unknown = Reflect.get(el, key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** What people call an element in a conflict: its mark, name or label, else its kind and id. */
export function mergeElementName(el: BimElement | null, id: ElementId): string {
  const named = textField(el, "mark") ?? textField(el, "name") ?? textField(el, "label");
  if (named) return named;
  return el ? `${el.kind.replace(/_/g, " ")} ${id}` : id;
}

function conflictWords(id: ElementId, base: BimElement | null, main: BimElement | null, branch: BimElement | null): string {
  const name = mergeElementName(branch ?? main ?? base, id);
  if (main === null && base !== null) return `${name} was removed on Main after this branch started, but this branch changed it. Remove it on the branch too, or put it back on Main, then propose again.`;
  if (branch === null && base !== null) return `This branch removes ${name}, but Main changed it since the branch started. Keep it on the branch, or remove it on Main, then propose again.`;
  if (base === null) return `Main and this branch both added ${name}, differently. Make them match on the branch, then propose again.`;
  return `Main and this branch both changed ${name}, differently. Make the branch match Main or redo the change on the branch, then propose again.`;
}

function endKey(ref: ConnectorRef): string {
  return `${ref.elementId}|${ref.end}`;
}

function sameEnds(x: Connection, y: Connection): boolean {
  const a = [endKey(x.a), endKey(x.b)].sort().join("~");
  const b = [endKey(y.a), endKey(y.b)].sort().join("~");
  return a === b;
}

function mergeConnections(
  base: ElementAt,
  main: ElementAt,
  onBranch: ConnectionChanges,
  onMain: ConnectionChanges,
  conflicts: MergeConflict[],
): { add: Connection[]; remove: Connection[] } {
  const mainAddedByEnd = new Map<string, Connection>();
  for (const c of onMain.added) {
    mainAddedByEnd.set(endKey(c.a), c);
    mainAddedByEnd.set(endKey(c.b), c);
  }
  const mainRemoved = new Set(onMain.removed.map((c) => c.id));
  const add: Connection[] = [];
  for (const c of onBranch.added) {
    if (onMain.added.some((m) => m.id === c.id || sameEnds(m, c))) continue;
    const gone = [c.a.elementId, c.b.elementId].find((id) => main(id) === null && base(id) !== null);
    if (gone) {
      conflicts.push({ elementId: gone, words: `This branch connects to ${mergeElementName(base(gone), gone)}, which was removed on Main since. Reconnect on the branch, then propose again.` });
      continue;
    }
    const clash = [c.a, c.b].map((end) => mainAddedByEnd.get(endKey(end))).find((m) => m !== undefined && !sameEnds(m, c));
    if (clash) {
      const id = c.a.elementId;
      conflicts.push({ elementId: id, words: `Main and this branch both connected ${mergeElementName(main(id), id)} at the same place, to different things. Make the branch match Main, then propose again.` });
      continue;
    }
    add.push(c);
  }
  const remove = onBranch.removed.filter((c) => !mainRemoved.has(c.id));
  return { add, remove };
}

/**
 * The three-way merge for the changed sets. `connections`: what each side
 * made and cut since the base (from the changesets); absent, connections are
 * not merged.
 */
export function threeWayMerge(
  base: ElementAt,
  main: ElementAt,
  branch: ElementAt,
  changedOnBranch: readonly ElementId[],
  changedOnMain: ReadonlySet<ElementId> | readonly ElementId[],
  connections?: { readonly branch: ConnectionChanges; readonly main: ConnectionChanges },
): ThreeWayMerge {
  const mainSet: ReadonlySet<ElementId> = changedOnMain instanceof Set ? changedOnMain : new Set(changedOnMain);
  const writes: MergeWrite[] = [];
  const alreadyOnMain: ElementId[] = [];
  const conflicts: MergeConflict[] = [];
  const seen = new Set<ElementId>();
  for (const id of changedOnBranch) {
    if (seen.has(id)) continue;
    seen.add(id);
    const theirs = branch(id);
    if (!mainSet.has(id)) {
      writes.push({ elementId: id, record: theirs });
      continue;
    }
    const ours = main(id);
    if (content(ours) === content(theirs)) {
      alreadyOnMain.push(id);
      continue;
    }
    conflicts.push({ elementId: id, words: conflictWords(id, base(id), ours, theirs) });
  }
  const merged = connections ? mergeConnections(base, main, connections.branch, connections.main, conflicts) : { add: [], remove: [] };
  return { writes, addConnections: merged.add, removeConnections: merged.remove, alreadyOnMain, conflicts };
}

/**
 * Split the branch's changes into parts: elements of one discipline that need
 * the same approvals. `coverage` comes from `coveringResponsibilities` over
 * the changed records (each element's branch record, or its base record when
 * the branch removed it). Conflicting elements stay in their part so it waits.
 */
export function mergeParts(coverage: readonly ElementCoverage[]): MergePart[] {
  const byKey = new Map<string, { discipline: string; responsibilityIds: string[]; elementIds: ElementId[] }>();
  for (const c of coverage) {
    const ids = c.covering.map((r) => r.id).sort();
    const key = `${c.discipline}|${c.fallback ?? "covered"}|${ids.join(",")}`;
    const hit = byKey.get(key);
    if (hit) hit.elementIds.push(c.elementId);
    else byKey.set(key, { discipline: c.discipline, responsibilityIds: ids, elementIds: [c.elementId] });
  }
  return [...byKey.values()];
}

/**
 * A part's delta digest (the product owner's answer 2): SHA-256 over the branch's base
 * revision and the part's sorted element ids, each with the hash of its
 * branch-side canonical record (null when the branch removed it). An
 * approval names it; any change inside the part changes it, a change
 * elsewhere doesn't. It is what a round 9 signature on an approval covers.
 */
export function partDeltaDigest(part: Pick<MergePart, "elementIds">, baseRevision: number, branchRecord: (id: ElementId) => BimElement | null): string {
  const ids = [...part.elementIds].sort();
  const elements = ids.map((id) => {
    const record = branchRecord(id);
    return [id, record === null ? null : sha256HexOf(canonicalize(record))];
  });
  return sha256HexOf(canonicalize({ baseRevision, elements, v: 1 }));
}

/**
 * Land merged writes on Main as one ordinary revision: the branch's records
 * replace Main's (or remove them), and the branch's connections are made and
 * cut. Every element written is read from Main first, so the commit's read
 * set refuses it when Main moved on underneath.
 */
export function landMergePart(main: ModelState, writes: readonly MergeWrite[], connections: { readonly add: readonly Connection[]; readonly remove: readonly Connection[] } = { add: [], remove: [] }): ExecuteResult {
  const reader = new TrackedReader(main);
  const working = draftElements(main.elements);
  const touched: ElementId[] = [];
  const removed: ElementId[] = [];
  for (const w of writes) {
    const current = reader.find(w.elementId);
    if (w.record === null) {
      if (current) {
        delete working[w.elementId];
        removed.push(w.elementId);
      }
      continue;
    }
    working[w.elementId] = w.record;
    touched.push(w.elementId);
  }
  const live = new Set(main.connections.map((c) => c.id));
  return finish(reader, working, touched, [], () => [], {
    removedIds: removed,
    removedConnections: connections.remove.filter((c) => live.has(c.id)),
    addedConnections: connections.add.filter((c) => !live.has(c.id)),
  });
}
