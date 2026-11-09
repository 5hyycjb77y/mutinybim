/**
 * Which parts of a merge hang on which (round 8 step 8b, lane M), and the
 * landing plan: a part lands only when it is approved, has no conflict and
 * depends on no part that waits.
 *
 * Dependencies are read from the kernel's generic shapes only, never a
 * trade's fields: an element's host (`hostId`, `host.segmentId`,
 * `host.elementId`), a service link's source, members and the runs that
 * realise it, a placed point's anchor, and connections through the caller's
 * topology index (`connectionsOf`). Cost: the changed set and their
 * connections; never a model scan.
 */
import { networkOf } from "../network";
import type { BimElement, Connection, ElementId, ModelState } from "../types";
import { asElementId } from "../types";
import type { LandingPlan, MergeConflict, MergePart, PartVerdict, PartWait } from "./merge-types";

export interface DependencyContext {
  /** Connections of an element on the branch head (the topology index). */
  connectionsOf(id: ElementId): readonly Connection[];
  /** A pack's own references, beyond the generic ones. */
  extraRefsOf?(el: BimElement): readonly ElementId[];
}

/** `connectionsOf` from a model's topology index (built once per head and shared). */
export function topologyConnections(model: Pick<ModelState, "elements" | "connections">): (id: ElementId) => readonly Connection[] {
  const index = networkOf(model);
  return (id) => index.connectionsOf(id);
}

function idAt(value: unknown, key: string): ElementId | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const v: unknown = Reflect.get(value, key);
  return typeof v === "string" && v !== "" ? asElementId(v) : null;
}

function idsAt(value: unknown, key: string): ElementId[] {
  if (typeof value !== "object" || value === null || !(key in value)) return [];
  const v: unknown = Reflect.get(value, key);
  if (!Array.isArray(v)) return [];
  const out: ElementId[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(asElementId(item));
    else {
      const id = idAt(item, "elementId");
      if (id) out.push(id);
    }
  }
  return out;
}

/** The elements a record stands on or serves through: hosts, a link's ends, an anchor. */
export function recordRefs(el: BimElement): ElementId[] {
  const out: ElementId[] = [];
  const hostId = idAt(el, "hostId");
  if (hostId) out.push(hostId);
  const host: unknown = "host" in el ? Reflect.get(el, "host") : undefined;
  for (const key of ["segmentId", "elementId"]) {
    const id = idAt(host, key);
    if (id) out.push(id);
  }
  const source: unknown = "source" in el ? Reflect.get(el, "source") : undefined;
  const sourceId = idAt(source, "elementId");
  if (sourceId) out.push(sourceId);
  out.push(...idsAt(el, "members"), ...idsAt(el, "realizedBy"));
  const at: unknown = "at" in el ? Reflect.get(el, "at") : undefined;
  const anchor = idAt(at, "elementId");
  if (anchor) out.push(anchor);
  return out.filter((id) => id !== el.id);
}

/**
 * For each changed element, the other changed elements it depends on.
 * `records`: each changed element's branch record (null when the branch
 * removed it). A removed element depends on nothing; what depended on it
 * does. Connections between two changed elements bind both ways.
 */
export function mergeDependencies(records: ReadonlyMap<ElementId, BimElement | null>, ctx: DependencyContext): Map<ElementId, ElementId[]> {
  const deps = new Map<ElementId, ElementId[]>();
  const add = (from: ElementId, to: ElementId) => {
    if (from === to || !records.has(to)) return;
    const list = deps.get(from);
    if (!list) deps.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const [id, record] of records) {
    if (record) {
      for (const ref of recordRefs(record)) add(id, ref);
      for (const ref of ctx.extraRefsOf?.(record) ?? []) add(id, ref);
    }
    for (const c of ctx.connectionsOf(id)) {
      const other = c.a.elementId === id ? c.b.elementId : c.a.elementId;
      add(id, other);
      add(other, id);
    }
  }
  return deps;
}

/** The waits a part has before dependencies: conflicts and approvals (from `partApprovalWaits`). */
export type PartGate = (part: MergePart) => readonly PartWait[];

function waitWords(part: MergePart, waits: readonly PartWait[], label: (discipline: string) => string, name: (id: ElementId) => string): string | null {
  const first = waits[0];
  if (!first) return null;
  const what = label(part.discipline);
  switch (first.kind) {
    case "conflict":
      return `${what} has ${first.elementIds.length === 1 ? "a conflict" : `${first.elementIds.length} conflicts`} with Main to resolve on the branch first.`;
    case "approval":
      return `${what} is waiting for approval from ${first.waitingFor.join(", ")}.`;
    case "no_lead":
      return `${what} waits: no one is named for it and no project lead is named. Name one in Manage › Responsibilities.`;
    case "depends_on":
      return `${what} can't land alone: ${name(first.elementId)} depends on ${name(first.on)} in ${label(first.discipline)}, which is still waiting.`;
  }
}

/**
 * The landing plan: every part's verdict. A part lands when its gate has no
 * waits and none of its elements depends on an element of a part that
 * doesn't land; that repeats until nothing changes, so a chain of waits is
 * followed to its end.
 */
export function planLanding(
  parts: readonly MergePart[],
  gate: PartGate,
  deps: ReadonlyMap<ElementId, readonly ElementId[]>,
  conflicts: readonly MergeConflict[],
  words: { readonly label: (discipline: string) => string; readonly name: (id: ElementId) => string },
): LandingPlan {
  const conflicted = new Set(conflicts.map((c) => c.elementId));
  const partOf = new Map<ElementId, number>();
  parts.forEach((p, i) => p.elementIds.forEach((id) => partOf.set(id, i)));
  const waits: PartWait[][] = parts.map((p) => {
    const own: PartWait[] = [];
    const clash = p.elementIds.filter((id) => conflicted.has(id));
    if (clash.length > 0) own.push({ kind: "conflict", elementIds: clash });
    own.push(...gate(p));
    return own;
  });
  let moved = true;
  while (moved) {
    moved = false;
    parts.forEach((p, i) => {
      if ((waits[i] ?? []).length > 0) return;
      for (const id of p.elementIds) {
        const blocker = (deps.get(id) ?? []).find((on) => {
          const j = partOf.get(on);
          return j !== undefined && j !== i && (waits[j] ?? []).length > 0;
        });
        if (blocker === undefined) continue;
        const j = partOf.get(blocker);
        const discipline = j === undefined ? p.discipline : (parts[j]?.discipline ?? p.discipline);
        waits[i] = [{ kind: "depends_on", discipline, elementId: id, on: blocker }];
        moved = true;
        return;
      }
    });
  }
  const verdicts: PartVerdict[] = parts.map((part, i) => {
    const w = waits[i] ?? [];
    return { part, lands: w.length === 0, waits: w, words: waitWords(part, w, words.label, words.name) };
  });
  return { verdicts, landingElementIds: verdicts.filter((v) => v.lands).flatMap((v) => v.part.elementIds) };
}
