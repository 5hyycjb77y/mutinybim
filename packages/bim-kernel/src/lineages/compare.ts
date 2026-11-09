import { canonicalize, sha256HexOf } from "../authorship/canonical";
import { canonicalJson } from "../canonical";
import type { Changeset } from "../changeset";
import { partDeltaDigest } from "../branches/merge";
import { changedBetween, stateAt } from "../branches/state-at";
import type { BimElement, ElementId, ModelState } from "../types";
import { ancestorAnchor, commonAncestor, type LineageLookup } from "./chain";
import type { LineageAct, LineageAnchor, LineageDifference, LineageFieldDifference } from "./types";

/**
 * The overlay read (product owner answer 1): two lineages that share an ancestor,
 * record by record, against that ancestor. Incremental by the ids either
 * side changed since the ancestor (read from each side's changesets in the
 * range); never a model scan. Read only: the screen draws both models with
 * the differences highlighted (CP11).
 */

/** One side of a compare (or the child of an act): a lineage's head and the changesets on its line since the ancestor. */
export interface LineageSide {
  readonly lineageId: string;
  readonly head: ModelState;
  /** Changesets on this lineage's line with revision in (ancestor revision, head revision], any order (more is fine; only the range counts). */
  readonly changes: readonly Changeset[];
}

/** An act as the host stored it, with the reference a difference cites back (the sign-off record's id). */
export interface RecordedLineageAct {
  readonly ref: string;
  readonly act: LineageAct;
}

export interface CompareLineagesOptions {
  /** Acts recorded on the model (accept backs settle differences). */
  readonly acts?: readonly RecordedLineageAct[];
}

export interface LineageComparison {
  readonly ancestor: LineageAnchor;
  readonly differences: readonly LineageDifference[];
}

/** A record's content without the per-side bookkeeping (version counter, authored-revision stamps). */
function contentOf(el: BimElement | null): Readonly<Record<string, unknown>> | null {
  if (el === null) return null;
  const { version: _v, authoredRev: _a, ...rest } = el;
  return rest;
}

function fieldDifferences(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): LineageFieldDifference[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: LineageFieldDifference[] = [];
  for (const key of keys) {
    const before = a[key];
    const after = b[key];
    if (before === after) continue;
    if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) continue;
    out.push({ key, before, after });
  }
  return out;
}

/**
 * A difference's id: the ancestor, the record and side b's content. Stable
 * while the child's version of the record stays the same, whatever side a
 * does; a new child edit is a new difference.
 */
export function lineageDifferenceId(ancestor: LineageAnchor, recordId: string, bRecord: BimElement | null): string {
  return sha256HexOf(canonicalize({ v: 1, ancestor: { lineage: ancestor.lineageId, revision: ancestor.revision }, record: recordId, b: contentOf(bRecord) }));
}

/** The digest an act over a child's records names: the round 8b part digest over those ids at the anchor revision (one recipe for merge, review and accept back). */
export function lineageDeltaDigest(recordIds: readonly string[], anchorRevision: number, childRecord: (id: ElementId) => BimElement | null): string {
  return partDeltaDigest({ elementIds: recordIds as readonly ElementId[] }, anchorRevision, childRecord);
}

/** Difference ids a changeset cites (`cites`, written by a design edit that matches a copy). Absent on every changeset before round 11. */
export function changesetCitations(cs: Changeset): readonly string[] {
  const raw: unknown = Reflect.get(cs, "cites");
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function recordOf(state: ModelState): (id: ElementId) => BimElement | null {
  return (id) => state.elements[id] ?? null;
}

/** What a child changed since an ancestor: the ids, and the digest over all of them a review names. */
export interface LineageDelta {
  readonly anchor: LineageAnchor;
  readonly changedIds: readonly ElementId[];
  readonly deltaDigest: string;
}

/** The child's delta against `to` (absent: its parent), any depth. */
export function lineageDelta(lookup: LineageLookup, child: LineageSide, to?: string): LineageDelta {
  const anchor = ancestorAnchor(lookup, child.lineageId, to);
  const changedIds = changedBetween(child.changes, anchor.revision, child.head.revision);
  return { anchor, changedIds, deltaDigest: lineageDeltaDigest(changedIds, anchor.revision, recordOf(child.head)) };
}

/**
 * Compare lineages `a` and `b` against their nearest common ancestor. Each
 * difference says how b's record differs from a's (added: only b has it;
 * removed: only a has it; changed, with the fields) or that they now agree
 * (`unchanged`), which side changed it, and whether it was settled: accepted
 * back from b onto a with a digest over b's current record, or matched by an
 * edit on a whose changeset cites the difference.
 */
export function compareLineages(lookup: LineageLookup, a: LineageSide, b: LineageSide, options: CompareLineagesOptions = {}): LineageComparison {
  const ancestor = commonAncestor(lookup, a.lineageId, b.lineageId);
  const onA = changedBetween(a.changes, ancestor.revision, a.head.revision);
  const onB = changedBetween(b.changes, ancestor.revision, b.head.revision);
  const setA = new Set<string>(onA);
  const setB = new Set<string>(onB);
  const ids = [...new Set<ElementId>([...onA, ...onB])].sort();
  const base = stateAt(a.head, ancestor.revision, a.changes, ids);
  const bRecord = recordOf(b.head);

  const acceptedBack = new Map<string, string>();
  for (const { ref, act } of options.acts ?? []) {
    if (act.kind !== "accept_back" || act.to !== a.lineageId || act.from !== b.lineageId) continue;
    const anchor = ancestorAnchor(lookup, act.from, act.to);
    if (lineageDeltaDigest(act.recordIds, anchor.revision, bRecord) !== act.deltaDigest) continue;
    for (const id of act.recordIds) acceptedBack.set(id, ref);
  }
  const matched = new Map<string, string>();
  for (const cs of a.changes) {
    if (cs.revision <= ancestor.revision || cs.revision > a.head.revision) continue;
    for (const cited of changesetCitations(cs)) if (!matched.has(cited)) matched.set(cited, `revision:${cs.revision}`);
  }

  const differences: LineageDifference[] = [];
  for (const id of ids) {
    const ra = a.head.elements[id] ?? null;
    const rb = b.head.elements[id] ?? null;
    const ca = contentOf(ra);
    const cb = contentOf(rb);
    const kind = (rb ?? ra ?? base[id] ?? null)?.kind ?? "unknown";
    const changedOn = setA.has(id) && setB.has(id) ? "both" : setA.has(id) ? "a" : "b";
    const differenceId = lineageDifferenceId(ancestor, id, rb);
    const change: LineageDifference["change"] = ca === null && cb === null ? "unchanged" : ca === null ? "added" : cb === null ? "removed" : "changed";
    const fields = change === "changed" && ca && cb ? fieldDifferences(ca, cb) : [];
    const agreed = change === "unchanged" || (change === "changed" && fields.length === 0);
    const acceptRef = acceptedBack.get(id);
    const matchRef = matched.get(differenceId);
    const settled = acceptRef !== undefined ? { by: "accepted_back" as const, actRef: acceptRef } : matchRef !== undefined ? { by: "matched_in_design" as const, actRef: matchRef } : undefined;
    differences.push({
      id: differenceId,
      recordId: id,
      kind,
      change: agreed ? "unchanged" : change,
      ...(!agreed && change === "changed" ? { fields } : {}),
      changedOn,
      ancestor,
      ...(settled ? { settled } : {}),
    });
  }
  return { ancestor, differences };
}
