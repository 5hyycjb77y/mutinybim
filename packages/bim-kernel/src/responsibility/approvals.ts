/**
 * Merge approvals by responsible professionals (round 8 step 8b, lane M).
 *
 * A part of a merge needs each covering accepted responsibility's person to
 * approve it. Rows in one approver set (a firm entry's people for one
 * discipline and scope) approve under that set's rule: `each` (all of them)
 * or `any_one`; a discipline's `any_one` rule makes all its covering rows
 * one set. A part no accepted row covers needs the project lead; with no
 * lead named it waits. An approval counts only when:
 * - its responsibility covers the part and its approver is that row's person
 *   (a firm row never approves, and a row that was never accepted covers
 *   nothing, so its person can't approve);
 * - it is the person's latest word on that part and says approve;
 * - it names the part as it is now: its `deltaDigest` equals the part's
 *   current digest (the product owner's answer 2). A change inside the part changes the
 *   digest and asks that approver again; a change elsewhere doesn't. Hosts
 *   without digests may pass `changedSince` instead.
 *
 * The host stores the rows; this file only decides.
 */
import type { ElementId } from "../types";
import type { MergePart, PartWait } from "../branches/merge-types";
import type { ApprovalRule, Responsibility } from "./types";

export type MergeDecision = "approved" | "declined";

export interface MergeApprovalRecord {
  /** The responsibility approved under; `null`: approved as the project lead. */
  readonly responsibilityId: string | null;
  /** The host's id for the person who decided. */
  readonly approverRef: string;
  readonly approverLabel: string;
  readonly decision: MergeDecision;
  /** The branch head the approver saw when deciding. */
  readonly seenBranchHead: number;
  /** The digest of the part the approver saw (`partDeltaDigest`). */
  readonly deltaDigest?: string;
  readonly decidedAt: string;
  readonly note?: string;
  /** Where the decision sits in the model's sign-off log. */
  readonly signoffSeq?: number;
}

export interface ProjectLead {
  readonly ref: string;
  readonly label: string;
}

export interface ApprovalInputs {
  readonly responsibilities: readonly Responsibility[];
  readonly approvals: readonly MergeApprovalRecord[];
  readonly leads: readonly ProjectLead[];
  readonly ruleFor: (discipline: string) => ApprovalRule;
  /** Elements the branch changed after a revision, up to its head (`changed_between`); used when there is no digest. */
  readonly changedSince: (revision: number) => ReadonlySet<ElementId>;
  /** The part's digest as it is now; when given, approvals count only for the digest they name. */
  readonly digestOf?: (part: MergePart) => string;
  /**
   * Without digests, what a later branch change re-asks: only approvers whose
   * part it touched (`inside_part`, the default), or every approver (`any_change`).
   */
  readonly reapproval?: "inside_part" | "any_change";
}

export type ApprovalState = "approved" | "declined" | "waiting" | "stale";

/** One approver's standing on a part, for screens and the landing gate. */
export interface PartApprover {
  readonly responsibilityId: string | null;
  readonly label: string;
  readonly state: ApprovalState;
  readonly note?: string;
  readonly decidedAt?: string;
  readonly signoffSeq?: number;
  /** The approver set it belongs to and that set's rule. */
  readonly group: string;
  readonly rule: ApprovalRule;
}

export interface ApprovalEvaluator {
  /** Who approves each part and where each stands. */
  approversOf(part: MergePart): readonly PartApprover[];
  /** The gate `planLanding` takes: approval waits for a part (empty: approved). */
  gate(part: MergePart): readonly PartWait[];
}

/** Elements each responsibility approves across all parts (its whole share of the merge). */
function elementsByResponsibility(parts: readonly MergePart[]): Map<string, ElementId[]> {
  const out = new Map<string, ElementId[]>();
  for (const p of parts) {
    for (const r of p.responsibilityIds) {
      const list = out.get(r) ?? [];
      list.push(...p.elementIds);
      out.set(r, list);
    }
  }
  return out;
}

export function approvalEvaluator(parts: readonly MergePart[], inputs: ApprovalInputs): ApprovalEvaluator {
  const rows = new Map(inputs.responsibilities.map((r) => [r.id, r]));
  const share = elementsByResponsibility(parts);
  const changedCache = new Map<number, ReadonlySet<ElementId>>();
  const changedAfter = (rev: number) => {
    const hit = changedCache.get(rev);
    if (hit) return hit;
    const set = inputs.changedSince(rev);
    changedCache.set(rev, set);
    return set;
  };

  // The person's records under one responsibility (or as lead), newest last.
  const byWho = new Map<string, MergeApprovalRecord[]>();
  for (const r of inputs.approvals) {
    const key = `${r.responsibilityId ?? "lead"}|${r.approverRef}`;
    const list = byWho.get(key) ?? [];
    list.push(r);
    byWho.set(key, list);
  }
  for (const list of byWho.values()) list.sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0));

  const standing = (key: string, part: MergePart, elementIds: readonly ElementId[]): { state: ApprovalState; record?: MergeApprovalRecord } => {
    const list = byWho.get(key) ?? [];
    if (list.length === 0) return { state: "waiting" };
    if (inputs.digestOf) {
      const digest = inputs.digestOf(part);
      const forThis = list.filter((r) => r.deltaDigest === digest);
      const latest = forThis[forThis.length - 1];
      if (!latest) return { state: "stale", record: list[list.length - 1] };
      return { state: latest.decision === "declined" ? "declined" : "approved", record: latest };
    }
    const latest = list[list.length - 1];
    if (!latest) return { state: "waiting" };
    if (latest.decision === "declined") return { state: "declined", record: latest };
    const after = changedAfter(latest.seenBranchHead);
    if (inputs.reapproval === "any_change") return { state: after.size > 0 ? "stale" : "approved", record: latest };
    return { state: elementIds.some((id) => after.has(id)) ? "stale" : "approved", record: latest };
  };

  const extra = (record: MergeApprovalRecord | undefined) => ({
    ...(record?.note ? { note: record.note } : {}),
    ...(record ? { decidedAt: record.decidedAt } : {}),
    ...(record?.signoffSeq !== undefined ? { signoffSeq: record.signoffSeq } : {}),
  });

  const approversOf = (part: MergePart): PartApprover[] => {
    if (part.responsibilityIds.length === 0) {
      return inputs.leads.map((lead) => {
        const s = standing(`lead|${lead.ref}`, part, part.elementIds);
        return { responsibilityId: null, label: `${lead.label} (project lead)`, state: s.state, group: "lead", rule: "any_one" as const, ...extra(s.record) };
      });
    }
    const disciplineRule = inputs.ruleFor(part.discipline);
    return part.responsibilityIds.map((id) => {
      const row = rows.get(id);
      const label = row?.party.label ?? "Someone no longer named";
      const group = disciplineRule === "any_one" ? `discipline|${part.discipline}` : (row?.approval?.group ?? id);
      const rule: ApprovalRule = disciplineRule === "any_one" ? "any_one" : (row?.approval?.rule ?? "each");
      if (!row || row.party.kind !== "person" || row.acceptedAt === undefined) return { responsibilityId: id, label, state: "waiting" as const, group, rule };
      const s = standing(`${id}|${row.party.ref}`, part, share.get(id) ?? part.elementIds);
      return { responsibilityId: id, label, state: s.state, group, rule, ...extra(s.record) };
    });
  };

  const gate = (part: MergePart): PartWait[] => {
    const approvers = approversOf(part);
    if (part.responsibilityIds.length === 0) {
      if (inputs.leads.length === 0) return [{ kind: "no_lead" }];
      return approvers.some((a) => a.state === "approved") ? [] : [{ kind: "approval", waitingFor: approvers.map((a) => a.label) }];
    }
    const groups = new Map<string, PartApprover[]>();
    for (const a of approvers) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
    const waitingFor: string[] = [];
    for (const members of groups.values()) {
      const rule = members[0]?.rule ?? "each";
      if (rule === "any_one") {
        if (!members.some((m) => m.state === "approved")) waitingFor.push(members.length === 1 ? (members[0]?.label ?? "") : `any one of ${members.map((m) => m.label).join(", ")}`);
      } else for (const m of members) if (m.state !== "approved") waitingFor.push(m.label);
    }
    return waitingFor.length === 0 ? [] : [{ kind: "approval", waitingFor }];
  };

  return { approversOf, gate };
}

/** Parts that need this person's word, theirs first (for "Merges waiting for you"). */
export function partsForApprover(parts: readonly MergePart[], responsibilities: readonly Responsibility[], personRef: string, isLead: boolean): { readonly mine: MergePart[]; readonly rest: MergePart[] } {
  const myRows = new Set(responsibilities.filter((r) => r.party.kind === "person" && r.party.ref === personRef && r.acceptedAt !== undefined).map((r) => r.id));
  const mine: MergePart[] = [];
  const rest: MergePart[] = [];
  for (const p of parts) {
    const ours = p.responsibilityIds.some((id) => myRows.has(id)) || (isLead && p.responsibilityIds.length === 0);
    (ours ? mine : rest).push(p);
  }
  return { mine, rest };
}
