import { MAIN_LINEAGE, RETRACTED_ACTION, type FindingDisposition } from "./disposition";
import { UNVERSIONED, type DispositionIndex, type HeldDisposition } from "./record";
import type { FindingRef } from "./ref";

/**
 * Where a finding stands on one copy of the model (round 11, D2).
 *
 * Dispositions are per copy (`scope.lineageId`). A copy inherits its
 * parents' dispositions as of the fork; its own stay on it until accepted
 * back. That is a read over the copy's id and its ancestor list, passed in
 * by the caller (the lineage module's `lineageChain` when it lands), never
 * an import of it: own decisions first, then decisions accepted back into
 * this copy, then each ancestor nearest first, cut at the fork revision.
 * Within one copy the latest decision wins; a retraction on a nearer copy
 * re-opens the finding there even when an ancestor accepted it.
 *
 * A source version bump re-opens a decision the way C10 marks "checked
 * against an older rule": the decision stays and reads "accepted against an
 * earlier version of this check", and the gate asks again.
 */

export interface LineageAncestor {
  readonly lineageId: string;
  /** The ancestor's revision the copy (or the copy between) forked from: its decisions recorded after it don't reach the copy. */
  readonly forkRevision: number;
}

export interface LineageView {
  readonly lineageId: string;
  /** Nearest first, ending at Main. Absent: none (Main itself). */
  readonly ancestors?: readonly LineageAncestor[];
  /** Copies whose decisions were accepted back into this one: they count as this copy's own. */
  readonly acceptedFrom?: readonly string[];
}

export const MAIN_VIEW: LineageView = { lineageId: MAIN_LINEAGE };

export type DispositionStanding =
  | { readonly state: "open" }
  | { readonly state: "disposed"; readonly disposition: FindingDisposition; readonly inherited: boolean }
  | { readonly state: "earlier_version"; readonly disposition: FindingDisposition; readonly words: string }
  | { readonly state: "lapsed"; readonly disposition: FindingDisposition; readonly words: string };

export interface StandingOptions {
  /** True once the project has reached this stage (a deferral to it lapses). Absent: no stage has been reached. */
  stageReached?(stageId: string): boolean;
  /** True once this gate is frozen (a decision held until it lapses). Absent: none is. */
  gateFrozen?(gateId: string): boolean;
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  accepted_known: "Accepted",
  waived: "Waived",
  deferred_to_stage: "Deferred",
  override: "Overridden",
};

/** "Accepted", "Waived": how a decision reads at the start of a sentence. */
export function dispositionActionWords(action: string): string {
  return ACTION_WORDS[action] ?? action.replace(/[_.]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function latest(list: readonly HeldDisposition[]): HeldDisposition | null {
  let best: HeldDisposition | null = null;
  for (const h of list) {
    if (!best || h.disposition.at > best.disposition.at || (h.disposition.at === best.disposition.at && (h.recordedRevision ?? -1) > (best.recordedRevision ?? -1))) best = h;
  }
  return best;
}

function decide(found: HeldDisposition, finding: Pick<FindingRef, "source">, inherited: boolean, options: StandingOptions): DispositionStanding {
  const d = found.disposition;
  if (d.action === RETRACTED_ACTION) return { state: "open" };
  if (d.sourceVersion !== UNVERSIONED && d.sourceVersion !== finding.source.version) return { state: "earlier_version", disposition: d, words: `${dispositionActionWords(d.action)} against an earlier version of this check` };
  if (d.scope.untilStage && options.stageReached?.(d.scope.untilStage)) return { state: "lapsed", disposition: d, words: `${dispositionActionWords(d.action)} until ${d.scope.untilStage}; that stage is here` };
  if (d.scope.untilGate && options.gateFrozen?.(d.scope.untilGate)) return { state: "lapsed", disposition: d, words: `${dispositionActionWords(d.action)} until ${d.scope.untilGate}, which has been issued` };
  return { state: "disposed", disposition: d, inherited };
}

/** Where one finding stands on the copy `view` names. Agents' decisions never count (they propose; a person records). */
export function dispositionStanding(finding: Pick<FindingRef, "id" | "source">, index: DispositionIndex, view: LineageView = MAIN_VIEW, options: StandingOptions = {}): DispositionStanding {
  const all = index.byFinding.get(finding.id);
  if (!all || all.length === 0) return { state: "open" };
  const people = all.filter((h) => h.disposition.by.kind === "person");
  const own = new Set([view.lineageId, ...(view.acceptedFrom ?? [])]);
  const mine = latest(people.filter((h) => own.has(h.disposition.scope.lineageId)));
  if (mine) return decide(mine, finding, false, options);
  for (const a of view.ancestors ?? []) {
    const theirs = latest(people.filter((h) => h.disposition.scope.lineageId === a.lineageId && (h.recordedRevision === null || h.recordedRevision <= a.forkRevision)));
    if (theirs) return decide(theirs, finding, true, options);
  }
  return { state: "open" };
}

/** Whether a standing still needs someone: open, re-opened by a version change, or a deferral that has run out. */
export function standingIsOpen(s: DispositionStanding): boolean {
  return s.state !== "disposed";
}
