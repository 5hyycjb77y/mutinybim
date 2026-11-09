import {
  contextStanding,
  readCheckingContext,
  readFindingDisposition,
  type CheckingContext,
  type ContextStanding,
  type CurrentCodes,
  type CurrentRuleIndex,
  type FindingDisposition,
} from "@permitzip/bim-kernel"
import type { SheetApproval } from "@permitzip/bim-sheets"
import type { ModelSignoffsResponse, SignoffForCheckView } from "./api"

/**
 * Which sign-offs stand on a model now, as the record lines, the sheet banner
 * and the issue check read them (round 10, C10). Pure: the caller passes the
 * model's sign-off log and what the open model uses now.
 */

/** Record kinds where a person relied on the model being right; others (a removal, a decline, a merge applied) pin nothing. */
export const RELYING_SIGNOFF_KINDS: ReadonlySet<string> = new Set(["responsibility_accepted", "responsibility_taken", "responsibility_granted", "merge_approved", "change_significance_set"])

export interface StandingRecord {
  readonly view: SignoffForCheckView
  readonly context: CheckingContext | null
  readonly standing: ContextStanding
  /** Overrides of this record by its own signer. */
  readonly dispositions: readonly FindingDisposition[]
  /** The signer has left the project: someone else signs a new approval. */
  readonly departed: boolean
  /** Sheets the approval is scoped to; null: the whole set. */
  readonly sheetIds: readonly string[] | null
}

function scopedSheets(payload: SignoffForCheckView["payload"]): readonly string[] | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null
  const scope = payload.scope
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return null
  const sheets = scope.sheets
  return Array.isArray(sheets) && sheets.length > 0 ? sheets.filter((s): s is string => typeof s === "string") : null
}

/**
 * The standing of each relying sign-off, keeping only each signer's latest on
 * a subject: a re-check signs a new record, which replaces the older one.
 */
export function standingsFor(log: ModelSignoffsResponse, current: CurrentCodes | CurrentRuleIndex): StandingRecord[] {
  const overrides = new Map<string, FindingDisposition[]>()
  for (const d of log.dispositions) {
    const read = readFindingDisposition(d.payload)
    if (!read.ok) {
      console.error("[code-change] an override in the sign-off log can't be read; it is ignored", { id: d.id, seq: d.seq, reason: read.reason })
      continue
    }
    if (read.value.by.subject !== d.actorUserId) continue
    const list = overrides.get(d.subjectId)
    if (list) list.push(read.value)
    else overrides.set(d.subjectId, [read.value])
  }
  const latest = new Map<string, SignoffForCheckView>()
  for (const r of log.records) {
    if (!RELYING_SIGNOFF_KINDS.has(r.recordKind)) continue
    const key = `${r.subjectId}\u0000${r.actorUserId}`
    const prior = latest.get(key)
    if (!prior || prior.seq < r.seq) latest.set(key, r)
  }
  const departed = new Set(log.departed)
  return [...latest.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((view) => {
      const context = readCheckingContext(view.payload)
      return { view, context, standing: contextStanding(context, current), dispositions: overrides.get(view.id) ?? [], departed: departed.has(view.actorUserId), sheetIds: scopedSheets(view.payload) }
    })
}

/** The approvals each sheet of a set carries: one scoped to sheets covers those; one with no sheet scope covers every sheet. */
export function sheetApprovals(records: readonly StandingRecord[], sheetIds: readonly string[]): SheetApproval[] {
  const out: SheetApproval[] = []
  for (const r of records) {
    for (const sheetId of r.sheetIds ?? sheetIds) {
      if (!sheetIds.includes(sheetId)) continue
      out.push({ sheetId, recordId: r.view.id, signer: r.view.actorUserId, signerName: r.view.actorName, standing: r.standing, dispositions: r.dispositions, signerCanAct: !r.departed })
    }
  }
  return out
}
