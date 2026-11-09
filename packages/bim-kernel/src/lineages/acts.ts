import { readAuthorRef, writeAuthorRef, type AuthorRefJson } from "../authorship/author";
import type { AuthorRef } from "../authorship/types";
import type { Changeset } from "../changeset";
import type { ExecuteResult } from "../command-core";
import { landMergePart, threeWayMerge } from "../branches/merge";
import type { ConnectionChanges, ElementAt, MergeConflict } from "../branches/merge-types";
import { changesetTouchedIds, stateAt } from "../branches/state-at";
import type { SignoffKind } from "../responsibility/signoff-chain";
import { asElementId, type Connection, type ElementId } from "../types";
import { ancestorAnchor, assertActAllowed, lineageChain, type LineageLookup } from "./chain";
import { lineageDelta, lineageDeltaDigest, type LineageSide } from "./compare";
import { LINEAGE_WORDS, LineageError, type LineageAct, type LineageAnchor, type ReviewOutcomeId } from "./types";

/**
 * Review and accept back (D1), as signed sign-off chain events. Both target
 * the child's parent or any ancestor in its chain; the delta is computed
 * against that ancestor at the revision the chain pins (same code at every
 * depth). A review lands nothing: the parent is untouched. An accept back
 * lands the chosen records on the ancestor as one ordinary revision through
 * `landMergePart` and cites the child's delta digest over those records.
 *
 * The chain event kinds (`LINEAGE_SIGNOFF_KINDS`) join `SIGNOFF_KINDS`
 * through the coordinator; `SignoffKind` is open, so a host may write them
 * today. Payload keys are snake_case, as the host writes them; numbers are
 * whole (the chain's rule).
 */

/** The sign-off record kind each act is written as. A merge stays round 8b's `merge_applied`. */
export const LINEAGE_SIGNOFF_KINDS = {
  merge: "merge_applied",
  review: "lineage_reviewed",
  accept_back: "lineage_accepted_back",
} as const satisfies Readonly<Record<LineageAct["kind"], SignoffKind>>;

/** The two kinds new in round 11, for `SIGNOFF_KINDS`. */
export const LINEAGE_ACT_RECORD_KINDS = [LINEAGE_SIGNOFF_KINDS.review, LINEAGE_SIGNOFF_KINDS.accept_back] as const;

type PayloadValue = string | readonly string[] | AuthorRefJson | { readonly [key: string]: string | number };

/** A review or accept back as a chain payload: who, when, the act and the anchor it was computed against. */
export interface LineageActPayload {
  readonly [key: string]: PayloadValue;
}

/** The chain payload of an act (review or accept back). Throws for a merge: that is `merge_applied`'s own payload. */
export function writeLineageActPayload(act: LineageAct, input: { readonly by: AuthorRef; readonly at: string; readonly anchor: LineageAnchor }): LineageActPayload {
  const common = { by: writeAuthorRef(input.by), at: input.at, anchor: { lineage_id: input.anchor.lineageId, revision: input.anchor.revision }, delta_digest: act.deltaDigest };
  switch (act.kind) {
    case "review":
      return { ...common, lineage_id: act.lineageId, to: act.to ?? input.anchor.lineageId, outcome: act.outcome, ...(act.reason ? { reason: act.reason } : {}) };
    case "accept_back":
      return { ...common, from: act.from, to: act.to, record_ids: [...act.recordIds].sort() };
    case "merge":
      throw new LineageError("A merge is recorded as merge_applied with its own payload.");
  }
}

export type LineageActRead = { readonly ok: true; readonly act: LineageAct; readonly by: AuthorRef; readonly at: string; readonly anchor: LineageAnchor } | { readonly ok: false; readonly reason: string };

type Raw = Readonly<Record<string, unknown>>;

function isRecord(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** A stored review or accept back, from its record kind and payload. Unknown outcomes are kept as written. */
export function readLineageActPayload(recordKind: string, raw: unknown): LineageActRead {
  if (!isRecord(raw)) return { ok: false, reason: "a copy act's payload must be an object" };
  const by = readAuthorRef(raw.by);
  if (!by.ok) return { ok: false, reason: `who acted can't be read: ${by.reason}` };
  const at = text(raw.at);
  const deltaDigest = text(raw.delta_digest ?? raw.deltaDigest);
  const anchorRaw = raw.anchor;
  const anchorLineage = isRecord(anchorRaw) ? text(anchorRaw.lineage_id ?? anchorRaw.lineageId) : null;
  const anchorRevision = isRecord(anchorRaw) ? anchorRaw.revision : undefined;
  if (!at || !deltaDigest || !anchorLineage || typeof anchorRevision !== "number" || !Number.isInteger(anchorRevision)) return { ok: false, reason: "a copy act names when, the delta digest and the version it was computed against" };
  const anchor = { lineageId: anchorLineage, revision: anchorRevision };
  if (recordKind === LINEAGE_SIGNOFF_KINDS.review) {
    const lineageId = text(raw.lineage_id ?? raw.lineageId);
    const outcome = text(raw.outcome);
    if (!lineageId || !outcome) return { ok: false, reason: "a review names the copy and its outcome" };
    const to = text(raw.to);
    const reason = text(raw.reason);
    return { ok: true, by: by.value, at, anchor, act: { kind: "review", lineageId, deltaDigest, outcome, ...(to ? { to } : {}), ...(reason ? { reason } : {}) } };
  }
  if (recordKind === LINEAGE_SIGNOFF_KINDS.accept_back) {
    const from = text(raw.from);
    const to = text(raw.to);
    const ids = raw.record_ids ?? raw.recordIds;
    if (!from || !to || !Array.isArray(ids) || !ids.every((v) => typeof v === "string" && v.length > 0)) return { ok: false, reason: "an accept back names the copy, where it went and the records" };
    return { ok: true, by: by.value, at, anchor, act: { kind: "accept_back", from, to, deltaDigest, recordIds: ids as string[] } };
  }
  return { ok: false, reason: `${recordKind} isn't a copy act this release reads` };
}

function childLineage(lookup: LineageLookup, id: string) {
  const link = lineageChain(lookup, id)[0];
  if (!link) throw new LineageError(LINEAGE_WORDS.unknownLineage(id));
  return link.lineage;
}

export interface ReviewInput {
  readonly lookup: LineageLookup;
  readonly child: LineageSide;
  /** The ancestor reviewed against; absent: the parent. */
  readonly to?: string;
  readonly outcome: ReviewOutcomeId;
  readonly reason?: string;
  /** The digest of the delta the reviewer was shown: a review of anything else is refused. */
  readonly deltaDigest: string;
}

/** A review act over the child's whole delta against `to`. Lands nothing; no model is changed. */
export function reviewLineage(input: ReviewInput): { readonly act: LineageAct; readonly anchor: LineageAnchor } {
  assertActAllowed(childLineage(input.lookup, input.child.lineageId), "review");
  const delta = lineageDelta(input.lookup, input.child, input.to);
  if (delta.deltaDigest !== input.deltaDigest) throw new LineageError(LINEAGE_WORDS.staleReview);
  const reason = input.reason?.trim();
  return {
    anchor: delta.anchor,
    act: { kind: "review", lineageId: input.child.lineageId, to: delta.anchor.lineageId, deltaDigest: delta.deltaDigest, outcome: input.outcome, ...(reason ? { reason } : {}) },
  };
}

/**
 * Where a merge from `from` lands and what it is computed against: `to` (absent:
 * the parent) at the revision the chain pins. Round 8b's three-way merge and
 * landing run unchanged with that anchor as the base, at any depth.
 */
export function mergeAnchor(lookup: LineageLookup, from: string, to?: string): LineageAnchor {
  assertActAllowed(childLineage(lookup, from), "merge");
  return ancestorAnchor(lookup, from, to);
}

/** Connections made and cut over a run of changesets, net (a connection made then cut is neither). */
export function netConnectionChanges(changes: readonly Changeset[], from: number, to: number): ConnectionChanges {
  const added = new Map<string, Connection>();
  const removed = new Map<string, Connection>();
  for (const cs of [...changes].filter((c) => c.revision > from && c.revision <= to).sort((x, y) => x.revision - y.revision)) {
    for (const c of cs.removedConnections ?? []) {
      if (added.has(c.id)) added.delete(c.id);
      else removed.set(c.id, c);
    }
    for (const c of cs.addedConnections ?? []) {
      if (removed.has(c.id)) removed.delete(c.id);
      else added.set(c.id, c);
    }
  }
  return { added: [...added.values()], removed: [...removed.values()] };
}

/** Ids touched in (from, to], unsorted: a membership test needs no order. */
function touchedIn(changes: readonly Changeset[], from: number, to: number): Set<ElementId> {
  const out = new Set<ElementId>();
  for (const cs of changes) {
    if (cs.revision <= from || cs.revision > to) continue;
    for (const id of changesetTouchedIds(cs)) out.add(asElementId(id));
  }
  return out;
}

function touching(changes: ConnectionChanges, ids: ReadonlySet<string>): ConnectionChanges {
  const hit = (c: Connection) => ids.has(c.a.elementId) || ids.has(c.b.elementId);
  return { added: changes.added.filter(hit), removed: changes.removed.filter(hit) };
}

export interface AcceptBackInput {
  readonly lookup: LineageLookup;
  readonly child: LineageSide;
  /** The ancestor the records land on: its head and the changesets on its line since the anchor revision. */
  readonly target: LineageSide;
  readonly recordIds: readonly string[];
  /** The digest over the chosen records the person saw; absent: computed now. */
  readonly deltaDigest?: string;
}

export type AcceptBackResult =
  | { readonly ok: true; readonly act: LineageAct; readonly anchor: LineageAnchor; readonly landing: ExecuteResult }
  | { readonly ok: false; readonly conflicts: readonly MergeConflict[]; readonly anchor: LineageAnchor };

/**
 * Accept chosen records from a child back onto an ancestor (`target`), as
 * one revision on it: the three-way merge over those records (base: the
 * anchor; the ancestor's changes since then; the child's records), landed by
 * `landMergePart`. Connections the child made or cut on those records come
 * along. A record both sides changed differently is a conflict, in words,
 * and nothing lands.
 */
export function acceptBack(input: AcceptBackInput): AcceptBackResult {
  const { lookup, child, target } = input;
  assertActAllowed(childLineage(lookup, child.lineageId), "accept_back");
  const anchor = ancestorAnchor(lookup, child.lineageId, target.lineageId);
  if (input.recordIds.length === 0) throw new LineageError(LINEAGE_WORDS.noRecords);
  const ids = [...new Set(input.recordIds)].sort() as ElementId[];
  const onChild = touchedIn(child.changes, anchor.revision, child.head.revision);
  for (const id of ids) if (!onChild.has(id)) throw new LineageError(LINEAGE_WORDS.notInDelta(id));
  const childRecord: ElementAt = (id) => child.head.elements[id] ?? null;
  const deltaDigest = lineageDeltaDigest(ids, anchor.revision, childRecord);
  if (input.deltaDigest !== undefined && input.deltaDigest !== deltaDigest) throw new LineageError(LINEAGE_WORDS.staleDigest);
  const base = stateAt(child.head, anchor.revision, child.changes, ids);
  const baseAt: ElementAt = (id) => base[id] ?? null;
  const targetAt: ElementAt = (id) => target.head.elements[id] ?? null;
  const onTarget = touchedIn(target.changes, anchor.revision, target.head.revision);
  const chosen = new Set<string>(ids);
  const merge = threeWayMerge(baseAt, targetAt, childRecord, ids, onTarget, {
    branch: touching(netConnectionChanges(child.changes, anchor.revision, child.head.revision), chosen),
    main: netConnectionChanges(target.changes, anchor.revision, target.head.revision),
  });
  if (merge.conflicts.length > 0) return { ok: false, conflicts: merge.conflicts, anchor };
  const landing = landMergePart(target.head, merge.writes, { add: merge.addConnections, remove: merge.removeConnections });
  return { ok: true, anchor, landing, act: { kind: "accept_back", from: child.lineageId, to: target.lineageId, deltaDigest, recordIds: ids } };
}
