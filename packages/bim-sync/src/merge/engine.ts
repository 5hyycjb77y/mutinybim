import {
  approvalEvaluator,
  coveringResponsibilities,
  disciplineLabel,
  mergeDependencies,
  mergeElementName,
  mergeParts,
  partDeltaDigest,
  modelCoverageContext,
  sheetMembership,
  suggestedScopeFor,
  planLanding,
  threeWayMerge,
  topologyConnections,
  type ApprovalRule,
  type BimElement,
  type BranchRef,
  type Changeset,
  type Connection,
  type ElementId,
  type MergeApprovalRecord,
  type MergePart,
  type MergeWrite,
  type ModelState,
  type ProjectLead,
  type Responsibility,
} from "@permitzip/bim-kernel";
import {
  netConnectionChanges,
} from "@permitzip/bim-kernel/lineages";
import type { HistoryReader } from "../branches/history";
import { MERGE_WORDS, type LandedPart, type MergePreview, type PreviewPart, type WaitingPart } from "./messages";

/**
 * The merge engine (round 8 step 8b, lane M), host-neutral: it reads both
 * histories, runs the kernel's three-way merge over the changed sets only,
 * groups the branch's changes into parts by who must approve them, and at
 * apply time lands only the approved parts that hang on no waiting part.
 *
 * The host supplies who is responsible and who approved, read as the person
 * (`MergeApprovalSource`); the engine recomputes coverage from the model it
 * holds, so a forged or stale proposal row can't widen what lands.
 */

export interface MergeSides {
  readonly branch: Pick<BranchRef, "branchId" | "name" | "baseRevision" | "baseModelId" | "state">;
  readonly mainHistory: HistoryReader;
  readonly branchHistory: HistoryReader;
  /** The branch head, for coverage (classes, systems) and its topology. */
  readonly branchHead: ModelState;
}

export interface ApprovalSnapshot {
  readonly responsibilities: readonly Responsibility[];
  readonly approvals: readonly MergeApprovalRecord[];
  readonly leads: readonly ProjectLead[];
  readonly rules: Readonly<Record<string, ApprovalRule>>;
}

/** What the host knows about one proposal, read as the person. */
export interface ProposalSnapshot extends ApprovalSnapshot {
  readonly proposal: { readonly id: string; readonly baseModelId: string; readonly branchId: string; readonly status: string; readonly proposedBy: string };
}

/** The host side, read as the person (their own token), never with a service key. */
export interface MergeApprovalSource {
  responsibilitiesFor(input: { readonly userId: string; readonly token: string; readonly baseModelId: string }): Promise<ApprovalSnapshot | { readonly error: string }>;
  proposalFor(input: { readonly userId: string; readonly token: string; readonly proposalId: string }): Promise<ProposalSnapshot | { readonly error: string } | null>;
}

/** Lands one part on Main as one ordinary revision attributed to the person (the store's commit path). */
export interface MainLander {
  land(input: {
    readonly writes: readonly MergeWrite[];
    readonly add: readonly Connection[];
    readonly remove: readonly Connection[];
    readonly label: string;
    readonly discipline?: string;
    /** Main's head the merge was computed on: a later change on Main to what this part writes refuses it. */
    readonly mainHead?: number;
  }): Promise<{ readonly ok: true; readonly revision: number } | { readonly ok: false; readonly message: string }>;
}

function lastTouched(changesets: readonly Changeset[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const cs of changesets) {
    for (const el of cs.elements) out.set(el.id, Math.max(out.get(el.id) ?? 0, cs.revision));
    for (const id of cs.removedIds ?? []) out.set(id, Math.max(out.get(id) ?? 0, cs.revision));
  }
  return out;
}

function touchedIds(changesets: readonly Changeset[]): ElementId[] {
  const ids = new Set<ElementId>();
  for (const cs of changesets) {
    for (const el of cs.elements) ids.add(el.id);
    for (const id of cs.removedIds ?? []) ids.add(id);
  }
  return [...ids];
}

function ruleReader(rules: Readonly<Record<string, ApprovalRule>>): (discipline: string) => ApprovalRule {
  return (d) => (rules[d] === "any_one" ? "any_one" : "each");
}

export interface ComputedMerge {
  readonly preview: MergePreview;
  /** Each part's digest now, from the held model. */
  readonly digestOf: (part: MergePart) => string;
  readonly parts: readonly MergePart[];
  readonly writes: ReadonlyMap<ElementId, MergeWrite>;
  readonly connections: { readonly add: readonly Connection[]; readonly remove: readonly Connection[] };
  readonly branchChanges: readonly Changeset[];
  readonly deps: ReadonlyMap<ElementId, readonly ElementId[]>;
  readonly conflicts: MergePreview["conflicts"];
}

/** The merge as it stands now: both histories read, merged, split into parts. */
export async function computeMerge(sides: MergeSides, snapshot: ApprovalSnapshot): Promise<ComputedMerge> {
  const base = sides.branch.baseRevision;
  const [mainHead, branchHead] = await Promise.all([sides.mainHistory.headRevision(), sides.branchHistory.headRevision()]);
  const [mainChanges, branchChanges] = await Promise.all([sides.mainHistory.changesBetween(base, mainHead), sides.branchHistory.changesBetween(base, branchHead)]);
  const onBranch = touchedIds(branchChanges);
  const onMain = new Set(touchedIds(mainChanges));
  const both = [...new Set<ElementId>([...onBranch, ...onMain])];
  const [atBase, atMain, atBranch] = await Promise.all([
    sides.mainHistory.elementsAt(base, both),
    sides.mainHistory.elementsAt(mainHead, both),
    sides.branchHistory.elementsAt(branchHead, onBranch),
  ]);
  const read = (rec: Record<string, BimElement | null>) => (id: ElementId) => rec[id] ?? null;
  const merged = threeWayMerge(read(atBase), read(atMain), read(atBranch), onBranch, onMain, { branch: netConnectionChanges(branchChanges, base, branchHead), main: netConnectionChanges(mainChanges, base, mainHead) });

  // Parts over what the branch brings (writes) and what it can't yet (conflicts): the branch's record, or the base's when it removed it.
  const conflictIds = merged.conflicts.map((c) => c.elementId);
  const recordOf = (id: ElementId) => atBranch[id] ?? atBase[id] ?? atMain[id] ?? null;
  const subjects = [...merged.writes.map((w) => w.elementId), ...conflictIds].flatMap((id) => {
    const r = recordOf(id);
    return r ? [r] : [];
  });
  // A responsibility scoped to sheets covers what the branch's sheets show (built once from the sheets' view lists).
  const ctx = modelCoverageContext(sides.branchHead, { sheetsOf: sheetMembership(sides.branchHead) });
  const coverage = coveringResponsibilities(subjects, snapshot.responsibilities, ctx);
  const parts = mergeParts(coverage);
  const subjectById = new Map(subjects.map((el) => [el.id, el]));
  const digests = new Map<MergePart, string>(parts.map((p) => [p, partDeltaDigest(p, base, (id) => atBranch[id] ?? null)]));
  const digestOf = (p: MergePart) => digests.get(p) ?? partDeltaDigest(p, base, (id) => atBranch[id] ?? null);
  const evaluator = approvalEvaluator(parts, { ...snapshot, ruleFor: ruleReader(snapshot.rules), changedSince: () => new Set(), digestOf });
  const touched = lastTouched(branchChanges);
  const previewParts: PreviewPart[] = parts.map((p) => {
    const approvers = evaluator.approversOf(p).map((a) => a.label);
    // No one covers it: "Take responsibility for this" starts from the part's own levels and systems.
    const suggested = p.responsibilityIds.length === 0 ? suggestedScopeFor(p.elementIds.flatMap((id) => subjectById.get(id) ?? []), ctx, sides.branchHead) : null;
    return {
      ...p,
      lastChangedRevision: Math.max(base, ...p.elementIds.map((id) => touched.get(id) ?? base)),
      deltaDigest: digestOf(p),
      approvers,
      ...(suggested ? { suggestedScope: suggested.scope, suggestedScopeWords: suggested.words } : {}),
    };
  });
  const records = new Map<ElementId, BimElement | null>(merged.writes.map((w) => [w.elementId, w.record]));
  const deps = mergeDependencies(records, { connectionsOf: topologyConnections(sides.branchHead) });
  return {
    preview: {
      branchId: sides.branch.branchId,
      branchName: sides.branch.name,
      baseRevision: base,
      branchHead,
      mainHead,
      parts: previewParts,
      conflicts: merged.conflicts,
      alreadyOnMain: merged.alreadyOnMain.length,
    },
    digestOf,
    parts,
    writes: new Map(merged.writes.map((w) => [w.elementId, w])),
    connections: { add: merged.addConnections, remove: merged.removeConnections },
    branchChanges,
    deps,
    conflicts: merged.conflicts,
  };
}

export async function previewMerge(sides: MergeSides, source: MergeApprovalSource, who: { readonly userId: string; readonly token: string }): Promise<{ readonly ok: true; readonly preview: MergePreview } | { readonly ok: false; readonly message: string }> {
  const snapshot = await source.responsibilitiesFor({ ...who, baseModelId: sides.branch.baseModelId });
  if ("error" in snapshot) return { ok: false, message: snapshot.error };
  const computed = await computeMerge(sides, snapshot);
  return { ok: true, preview: computed.preview };
}

/** Parts in an order where each lands after the parts it depends on (a cycle lands in list order). */
function landingOrder(parts: readonly MergePart[], deps: ReadonlyMap<ElementId, readonly ElementId[]>): MergePart[] {
  const partOf = new Map<ElementId, number>();
  parts.forEach((p, i) => p.elementIds.forEach((id) => partOf.set(id, i)));
  const done = new Set<number>();
  const visiting = new Set<number>();
  const out: MergePart[] = [];
  const visit = (i: number) => {
    if (done.has(i) || visiting.has(i)) return;
    visiting.add(i);
    for (const id of parts[i]?.elementIds ?? []) for (const on of deps.get(id) ?? []) {
      const j = partOf.get(on);
      if (j !== undefined && j !== i) visit(j);
    }
    visiting.delete(i);
    done.add(i);
    const p = parts[i];
    if (p) out.push(p);
  };
  parts.forEach((_, i) => visit(i));
  return out;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly landed: readonly LandedPart[]; readonly waiting: readonly WaitingPart[]; readonly allLanded: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Apply: recompute the merge and coverage from the model, read the
 * proposal's approvals as the person, land only what may land. Each landing
 * part is one revision on Main; parts that depend on each other land in
 * dependency order. Never a change order, never a cost.
 */
export async function applyMerge(
  sides: MergeSides,
  source: MergeApprovalSource,
  lander: MainLander,
  who: { readonly userId: string; readonly token: string; readonly canEdit: boolean },
  proposalId: string,
): Promise<ApplyOutcome> {
  if (sides.branch.state === "merged" || sides.branch.state === "closed") return { ok: false, message: MERGE_WORDS.branchClosed };
  if (!who.canEdit) return { ok: false, message: MERGE_WORDS.noEdit };
  const snapshot = await source.proposalFor({ userId: who.userId, token: who.token, proposalId });
  if (snapshot === null) return { ok: false, message: MERGE_WORDS.wrongProposal };
  if ("error" in snapshot) return { ok: false, message: snapshot.error };
  if (snapshot.proposal.branchId !== sides.branch.branchId || snapshot.proposal.baseModelId !== sides.branch.baseModelId) return { ok: false, message: MERGE_WORDS.wrongProposal };
  if (snapshot.proposal.status !== "open" && snapshot.proposal.status !== "partly_merged") return { ok: false, message: MERGE_WORDS.proposalClosed };
  if (snapshot.proposal.proposedBy !== who.userId) return { ok: false, message: MERGE_WORDS.notProposer };

  const computed = await computeMerge(sides, snapshot);
  // An approval counts only for the digest of the part as the model holds it now (product decision, answer 2).
  const evaluator = approvalEvaluator(computed.parts, { ...snapshot, ruleFor: ruleReader(snapshot.rules), changedSince: () => new Set(), digestOf: computed.digestOf });
  const labels = (d: string) => disciplineLabel(d);
  const name = (id: ElementId) => mergeElementName(computed.writes.get(id)?.record ?? null, id);
  const plan = planLanding(computed.parts, evaluator.gate, computed.deps, computed.conflicts, { label: labels, name });
  const landingParts = new Set(plan.verdicts.filter((v) => v.lands).map((v) => v.part));
  const waiting: WaitingPart[] = plan.verdicts.filter((v) => !v.lands).map((v) => ({ discipline: v.part.discipline, words: v.words ?? "Waiting" }));
  if (landingParts.size === 0) return { ok: true, landed: [], waiting: waiting.length > 0 ? waiting : [{ discipline: "", words: MERGE_WORDS.nothingToLand }], allLanded: false };

  const landed: LandedPart[] = [];
  const failed = new Set<ElementId>();
  const connectionEnds = (c: Connection) => [c.a.elementId, c.b.elementId];
  for (const part of landingOrder([...landingParts], computed.deps)) {
    const ids = new Set(part.elementIds);
    const hangsOnFailed = part.elementIds.find((id) => (computed.deps.get(id) ?? []).some((on) => failed.has(on)));
    if (hangsOnFailed !== undefined) {
      part.elementIds.forEach((id) => failed.add(id));
      waiting.push({ discipline: part.discipline, words: `${labels(part.discipline)} waits: what it depends on couldn't land just now. Try Merge approved parts again.` });
      continue;
    }
    const writes = part.elementIds.flatMap((id) => {
      const w = computed.writes.get(id);
      return w ? [w] : [];
    });
    // A connection lands with the first part that holds one of its ends.
    const mine = (c: Connection) => connectionEnds(c).some((id) => ids.has(id)) && !landed.some((l) => connectionEnds(c).some((id) => l.elementIds.includes(id)));
    const result = await lander.land({ writes, add: computed.connections.add.filter(mine), remove: computed.connections.remove.filter(mine), label: `Merge ${sides.branch.name}: ${labels(part.discipline)}`, discipline: part.discipline, mainHead: computed.preview.mainHead });
    if (!result.ok) {
      part.elementIds.forEach((id) => failed.add(id));
      waiting.push({ discipline: part.discipline, words: result.message });
      continue;
    }
    landed.push({ discipline: part.discipline, elementIds: part.elementIds, revision: result.revision, deltaDigest: computed.digestOf(part) });
  }
  return { ok: true, landed, waiting, allLanded: waiting.length === 0 && landed.length === computed.parts.length };
}
