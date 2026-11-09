import { z } from "zod"
import {
  approvalEvaluator,
  asElementId,
  type ApprovalRule,
  type ElementId,
  type MergeApprovalRecord,
  type MergeConflict,
  type MergePart,
  type PartApprover,
  type ProjectLead,
  type Responsibility,
} from "@permitzip/bim-kernel"
import type { BimJson } from "../json"
import { MERGE_POLICY, NO_LEAD_WORDS } from "../responsibilities/policy"

const NO_ONE_NAMED = "No one is named for this part."

/**
 * The editor's view of a merge proposal: the stored preview read back, approvals
 * mapped to the kernel's records, and each part's approvers worked out with
 * the kernel's evaluator. Display only: the model server recomputes coverage
 * from the model and re-reads approvals when it applies.
 */

// db-shape: the columns of a `bim_merge_proposals` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type MergeProposalRowForView = {
  readonly id: string
  readonly branch_id: string
  readonly branch_name: string
  readonly base_revision: number
  readonly branch_head: number
  readonly main_head: number
  readonly parts: BimJson
  readonly conflicts: BimJson
  readonly status: string
  readonly proposed_by: string
  readonly created_at: string
}

// db-shape: the columns of a `bim_merge_approvals` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type MergeApprovalRowForView = {
  readonly proposal_id: string
  readonly responsibility_id: string | null
  readonly approver_id: string
  readonly decision: string
  readonly note: string | null
  readonly branch_head: number
  readonly delta_digest: string
  readonly signoff_seq: number
  readonly decided_at: string
}

const idList = z.array(z.string().min(1).max(200)).max(250_000)

/**
 * A part as the preview stored it: `deltaDigest`, what approvals name (the
 * model server recomputes it at apply); `lastChangedRevision`, the newest
 * branch revision touching it.
 */
export const storedPartSchema = z.object({
  discipline: z.string().min(1).max(96),
  responsibilityIds: z.array(z.string().uuid()).max(200),
  elementIds: idList,
  deltaDigest: z.string().regex(/^[0-9a-f]{64}$/),
  lastChangedRevision: z.number().int().min(0).optional(),
  suggestedScope: z.object({ levels: z.array(z.string().min(1).max(200)).max(50).optional(), systems: z.array(z.string().min(1).max(200)).max(50).optional() }).optional(),
  suggestedScopeWords: z.string().min(1).max(300).optional(),
})
export type StoredMergePart = MergePart & {
  readonly deltaDigest: string
  readonly lastChangedRevision?: number
  /** Round 9: what "Take responsibility for this" starts from (the part's levels and systems). */
  readonly suggestedScope?: { readonly levels?: readonly string[]; readonly systems?: readonly string[] }
  readonly suggestedScopeWords?: string
}

const conflictSchema = z.object({ elementId: z.string().min(1).max(200), words: z.string().min(1).max(1000) })

export const storedPartsSchema = z.array(storedPartSchema).max(2000)
export const storedConflictsSchema = z.array(conflictSchema).max(5000)

export function readParts(raw: BimJson, proposalId: string): StoredMergePart[] {
  const parsed = storedPartsSchema.safeParse(raw)
  if (!parsed.success) {
    console.error("[bim/merge] stored parts are malformed; showing none", { proposalId, issue: parsed.error.issues[0]?.message })
    return []
  }
  return parsed.data.map((p) => ({ ...p, elementIds: p.elementIds.map(asElementId) }))
}

export function readConflicts(raw: BimJson, proposalId: string): MergeConflict[] {
  const parsed = storedConflictsSchema.safeParse(raw)
  if (!parsed.success) {
    console.error("[bim/merge] stored conflicts are malformed; showing none", { proposalId, issue: parsed.error.issues[0]?.message })
    return []
  }
  return parsed.data.map((c) => ({ elementId: asElementId(c.elementId), words: c.words }))
}

export function toApprovalRecord(row: MergeApprovalRowForView, labelOf: (userId: string) => string): MergeApprovalRecord {
  return {
    responsibilityId: row.responsibility_id,
    approverRef: row.approver_id,
    approverLabel: labelOf(row.approver_id),
    decision: row.decision === "approved" ? "approved" : "declined",
    seenBranchHead: row.branch_head,
    deltaDigest: row.delta_digest,
    signoffSeq: row.signoff_seq,
    decidedAt: row.decided_at,
    ...(row.note ? { note: row.note } : {}),
  }
}

/** Each stored part's digest (the parts are the stored objects, so identity finds them). */
function digestReader(parts: readonly StoredMergePart[]): (part: MergePart) => string {
  const byPart = new Map<MergePart, string>(parts.map((p) => [p, p.deltaDigest]))
  return (part) => byPart.get(part) ?? ""
}

export interface PartView {
  readonly discipline: string
  /** What an approval of this part names. */
  readonly deltaDigest: string
  /** No one is named for it: the project lead approves, or with no lead it waits for someone to take it. */
  readonly uncovered: boolean
  readonly elementCount: number
  readonly approvers: readonly PartApprover[]
  /** Whose word this part still needs, in words ("Waiting for approval from J. Rao"). Null: approved. */
  readonly waiting: string | null
  /** The responsibility the viewer approves this part under; `null` with `asLead`. Absent: not theirs. */
  readonly mine?: { readonly responsibilityId: string | null; readonly asLead: boolean }
  readonly lastChangedRevision?: number
  /** No one covers it: the levels and systems its changes sit on, prefilled in "Take responsibility for this". */
  readonly suggested?: { readonly scope: { readonly levels?: readonly string[]; readonly systems?: readonly string[] }; readonly words: string }
}

export interface ProposalView {
  readonly id: string
  readonly branchId: string
  readonly branchName: string
  readonly status: string
  readonly baseRevision: number
  readonly branchHead: number
  readonly mainHead: number
  readonly proposedBy: string
  readonly proposedByLabel: string
  readonly createdAt: string
  readonly conflicts: readonly MergeConflict[]
  /** The viewer's parts first, then the rest (Nielsen 8: your scope first). */
  readonly parts: readonly PartView[]
}

export interface ProposalViewInput {
  readonly proposal: MergeProposalRowForView
  readonly approvals: readonly MergeApprovalRowForView[]
  readonly responsibilities: readonly Responsibility[]
  readonly leads: readonly ProjectLead[]
  readonly viewerId: string
  readonly labelOf: (userId: string) => string
  readonly ruleFor?: (discipline: string) => ApprovalRule
}

export function proposalView(input: ProposalViewInput): ProposalView {
  const { proposal } = input
  const parts = readParts(proposal.parts, proposal.id)
  const evaluator = approvalEvaluator(parts, {
    responsibilities: input.responsibilities,
    approvals: input.approvals.filter((a) => a.proposal_id === proposal.id).map((a) => toApprovalRecord(a, input.labelOf)),
    leads: input.leads,
    ruleFor: input.ruleFor ?? (() => "each"),
    changedSince: () => new Set<ElementId>(),
    digestOf: digestReader(parts),
    reapproval: MERGE_POLICY.reapproval,
  })
  const myRows = new Map(
    input.responsibilities.filter((r) => r.party.kind === "person" && r.party.ref === input.viewerId && r.acceptedAt !== undefined).map((r) => [r.id, r]),
  )
  const isLead = input.leads.some((l) => l.ref === input.viewerId)
  const views: PartView[] = parts.map((p) => {
    const gate = evaluator.gate(p)
    const first = gate[0]
    const waiting = !first
      ? null
      : first.kind === "approval"
        ? `Waiting for approval from ${first.waitingFor.join(", ")}`
        : first.kind === "no_lead"
          ? `${NO_ONE_NAMED} ${NO_LEAD_WORDS}`
          : "Waiting"
    const mineId = p.responsibilityIds.find((id) => myRows.has(id))
    const mine = mineId ? { responsibilityId: mineId, asLead: false } : isLead && p.responsibilityIds.length === 0 ? { responsibilityId: null, asLead: true } : undefined
    return {
      discipline: p.discipline,
      deltaDigest: p.deltaDigest,
      uncovered: p.responsibilityIds.length === 0,
      elementCount: p.elementIds.length,
      approvers: evaluator.approversOf(p),
      waiting,
      ...(mine ? { mine } : {}),
      ...(p.lastChangedRevision !== undefined ? { lastChangedRevision: p.lastChangedRevision } : {}),
      ...(p.suggestedScope && p.suggestedScopeWords && p.responsibilityIds.length === 0 ? { suggested: { scope: p.suggestedScope, words: p.suggestedScopeWords } } : {}),
    }
  })
  views.sort((a, b) => Number(b.mine !== undefined) - Number(a.mine !== undefined))
  return {
    id: proposal.id,
    branchId: proposal.branch_id,
    branchName: proposal.branch_name,
    status: proposal.status,
    baseRevision: proposal.base_revision,
    branchHead: proposal.branch_head,
    mainHead: proposal.main_head,
    proposedBy: proposal.proposed_by,
    proposedByLabel: input.labelOf(proposal.proposed_by),
    createdAt: proposal.created_at,
    conflicts: readConflicts(proposal.conflicts, proposal.id),
    parts: views,
  }
}
