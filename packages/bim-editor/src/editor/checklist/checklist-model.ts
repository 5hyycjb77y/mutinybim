import { GRAPH_ANSWER_LIMIT, type Requirement } from '@permitzip/bim-kernel'
import { SHOW_AGENT_FOUND } from './decisions'

/**
 * The checklist's list, from the requirements graph: one group per cause
 * ("Room 104 is Assembly A-3", "fully sprinklered: allowable floor area
 * tripled"), most open items first, five per group then "and N more"
 * (product owner decision 6). A requirement from a second source for the same thing
 * in the same place sits beside the one that governs (decision 11).
 */

export interface ChecklistRow {
  /** The governing requirement. */
  readonly requirement: Requirement
  /** Requirements from other sources for the same key and place, shown side by side. */
  readonly conflicts: readonly Requirement[]
}

export interface ChecklistGroup {
  readonly cause: string
  readonly rows: readonly ChecklistRow[]
  /** Rows that still need something (not met, open, or unverified and unchecked). */
  readonly open: number
}

const FULFILMENT_ORDER: Readonly<Record<string, number>> = { not_met: 0, open: 1, unchecked: 2, met: 3 }

/** Whether a requirement still needs someone's attention. */
export function needsAttention(r: Requirement): boolean {
  if (r.status === 'withdrawn') return false
  if (r.fulfilment.state !== 'met') return true
  return r.status === 'proposed' && r.ruleVerification !== 'verified'
}

function rowRank(r: Requirement): number {
  const f = FULFILMENT_ORDER[r.fulfilment.state] ?? 2
  return r.status === 'withdrawn' ? 10 + f : f
}

/** Group, rank and pair conflicts. Withdrawn requirements sort last in their group. */
export function checklistGroups(requirements: readonly Requirement[]): ChecklistGroup[] {
  const byId = new Map(requirements.map((r) => [r.id, r]))
  const groups = new Map<string, ChecklistRow[]>()
  for (const r of requirements) {
    if (r.standing === 'conflicting') continue
    const conflicts = (r.conflictsWith ?? []).map((id) => byId.get(id)).filter((c): c is Requirement => c !== undefined)
    const cause = r.causeGroup ?? r.cause
    const list = groups.get(cause)
    const row = { requirement: r, conflicts }
    if (list) list.push(row)
    else groups.set(cause, [row])
  }
  const out: ChecklistGroup[] = []
  for (const [cause, rows] of groups) {
    rows.sort((a, b) => rowRank(a.requirement) - rowRank(b.requirement) || a.requirement.title.localeCompare(b.requirement.title))
    out.push({ cause, rows, open: rows.filter((row) => needsAttention(row.requirement)).length })
  }
  out.sort((a, b) => b.open - a.open || b.rows.length - a.rows.length || a.cause.localeCompare(b.cause))
  return out
}

/** The rows a group shows before "and N more". */
export function visibleRows(group: ChecklistGroup, expanded: boolean): { readonly rows: readonly ChecklistRow[]; readonly more: number } {
  if (expanded || group.rows.length <= GRAPH_ANSWER_LIMIT) return { rows: group.rows, more: 0 }
  return { rows: group.rows.slice(0, GRAPH_ANSWER_LIMIT), more: group.rows.length - GRAPH_ANSWER_LIMIT }
}

/** How many requirements still need attention (the rail badge and the Needs chip). */
export function needsCount(requirements: readonly Requirement[]): number {
  return requirements.filter((r) => r.standing !== 'conflicting' && needsAttention(r)).length
}

const MODEL_STATUS_LABEL: Readonly<Record<string, string>> = {
  verified: 'Verified',
  overridden: 'Overridden',
  withdrawn: 'Withdrawn',
}

/**
 * The status chip: the model's own state when a person set one, else the
 * rule's standing in its source ("Found by an agent" only with
 * `SHOW_AGENT_FOUND`).
 */
export function statusLabel(r: Requirement): string {
  const own = MODEL_STATUS_LABEL[r.status]
  if (own) return own
  if (r.ruleVerification === 'verified') return 'Verified in its code study'
  if (r.ruleVerification === 'invalidated') return 'Ruled out in its code study'
  if (r.ruleVerification === 'agent_found' && SHOW_AGENT_FOUND) return 'Found by an agent'
  return 'Proposed'
}

export function fulfilmentLabel(r: Requirement): string {
  if (r.fulfilment.summary) return r.fulfilment.summary
  switch (r.fulfilment.state) {
    case 'met':
      return 'Met'
    case 'not_met':
      return 'Not met'
    case 'open':
      return 'Not drawn yet'
    default:
      return 'No model check; a person confirms it'
  }
}

/** "138" with its unit, "2 ea", "A"; null for a manual rule. */
export function valueLabel(r: Pick<Requirement, 'value' | 'unit' | 'compare'>): string | null {
  if (r.value === null) return null
  const unit = r.unit && r.unit !== '1' ? ` ${r.unit}` : ''
  const prefix = r.compare === 'at_least' ? 'at least ' : r.compare === 'at_most' ? 'at most ' : ''
  return `${prefix}${String(r.value)}${typeof r.value === 'number' ? unit : ''}`
}
