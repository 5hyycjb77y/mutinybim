import { CHANGE_WORDS, changeTargetKey, readChangeOrderStatus, type ChangeOrderStatus, type ChangeTarget, type Responsibility } from "@permitzip/bim-kernel"

/** What lane O's routes answer, shared by the routes and the screens. No prices anywhere. */

export interface SignificanceView {
  readonly targetKey: string
  readonly kind: string
  readonly reason: string
  readonly citation: string | null
  readonly discipline: string
  readonly classifiedByLabel: string
  readonly classifiedAt: string
  /** How many classifications this target has had (1 = never changed). */
  readonly historyCount: number
}

export interface ChangeOrderView {
  readonly id: string
  readonly target: ChangeTarget
  readonly targetWords: string
  readonly title: string
  readonly description: string | null
  readonly addressee: { readonly kind: "contact" | "organization"; readonly id: string; readonly label: string }
  /** As stored; `statusKnown` false when this release doesn't know it (nothing can be done to it here). */
  readonly status: string
  readonly statusKnown: ChangeOrderStatus | null
  readonly statusWords: string
  readonly reason: string | null
  readonly citation: string | null
  readonly deltaDigest: string | null
  readonly openedByLabel: string
  readonly openedAt: string
  readonly sentAt: string | null
  readonly decidedAt: string | null
  readonly iAmAddressee: boolean
  readonly iOpenedIt: boolean
  readonly addresseeHasLogin: boolean
  readonly invitePending: boolean
  /** Only for people who may open change orders here (for an invite). */
  readonly addresseeEmail: string | null
  /** Plain words on who acts next (Nielsen 1). */
  readonly waitingWords: string | null
}

export interface ChangeOrderEventView {
  readonly from: string | null
  readonly to: string
  readonly reason: string | null
  readonly citation: string | null
  readonly at: string
}

export interface ChangeOrdersPowers {
  /** May open and send change orders on this project. */
  readonly canOpen: boolean
  /** May send a portal invite (an addressee with no login). */
  readonly canInvite: boolean
  /** On the project (false: an addressee seeing only what's addressed to them). */
  readonly onProject: boolean
}

export interface ChangeOrdersResponse {
  readonly modelId: string | null
  readonly powers: ChangeOrdersPowers
  readonly orders: readonly ChangeOrderView[]
}

/** A sent change order waiting on the signed-in person (bell, Change order page). */
export interface ChangeOrderForMe {
  readonly id: string
  readonly projectId: string
  readonly projectLabel: string
  readonly title: string
  readonly openedBy: string | null
  readonly sentAt: string | null
  /** The page that shows it, with Accept / Refuse / No cost. */
  readonly href: string
}

export interface ChangeOrdersForMeResponse {
  readonly orders: readonly ChangeOrderForMe[]
}

export interface ChangeOrderDetailResponse {
  readonly order: ChangeOrderView
  readonly events: readonly ChangeOrderEventView[]
}

export interface ClassifierOption {
  /** The kernel's record (person ref = the viewer), so the screen runs coverage on each change. */
  readonly responsibility: Responsibility
  readonly scopeWords: string
}

export interface ChangeSignificanceResponse {
  readonly modelId: string
  readonly viewerId: string
  readonly current: readonly SignificanceView[]
  /** The viewer's own accepted responsibilities on this model, which the screen tests against each change with the kernel. */
  readonly mine: readonly ClassifierOption[]
}

export interface AddresseeOption {
  readonly kind: "contact" | "organization"
  readonly id: string
  readonly label: string
  readonly detail: string | null
}

export interface AddresseeSearchResponse {
  readonly options: readonly AddresseeOption[]
  /** Why the list is empty or short, in words (no access to the contact list, nothing matched). */
  readonly note: string | null
}

// db-shape: the columns of a `bim_model_change_orders` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type ChangeOrderListRowForView = {
  readonly id: string
  readonly model_id: string
  readonly target_kind: string
  readonly from_revision: number | null
  readonly to_revision: number | null
  readonly branch_id: string | null
  readonly branch_head: number | null
  readonly title: string
  readonly description: string | null
  readonly addressee_kind: string
  readonly addressee_id: string
  readonly addressee_label: string
  readonly status: string
  readonly reason: string | null
  readonly citation: string | null
  readonly delta_digest: string | null
  readonly opened_by: string
  readonly opened_by_label: string
  readonly opened_at: string
  readonly sent_at: string | null
  readonly decided_at: string | null
  readonly i_am_addressee: boolean
  readonly addressee_has_login: boolean
  readonly addressee_invite_pending: boolean
  readonly addressee_email: string | null
}

// db-shape: the columns of a `bim_change_order_events` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type ChangeOrderEventRowForView = {
  readonly from_status: string | null
  readonly to_status: string
  readonly reason: string | null
  readonly citation: string | null
  readonly created_at: string
}

// db-shape: the columns of a `bim_model_change_significance` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type SignificanceRowForView = {
  readonly target_key: string
  readonly kind: string
  readonly reason: string
  readonly citation: string | null
  readonly discipline: string
  readonly classified_by_label: string
  readonly classified_at: string
  readonly history_count: number
}

// db-shape: the columns of a `bim_change_orders_for_me` row this view reads; lib/bim/editor-shape-checks.ts holds them to the database row
export type ChangeOrderForMeRowForView = {
  readonly id: string
  readonly project_id: string
  readonly project_number: string | null
  readonly project_name: string
  readonly title: string
  readonly opened_by_name: string | null
  readonly sent_at: string | null
}

const STATUS_WORDS: Readonly<Record<ChangeOrderStatus, string>> = {
  draft: "Draft, not sent",
  sent: "Sent, waiting for an answer",
  accepted: "Accepted",
  refused: "Refused",
  no_cost: "No cost",
}

export function statusWords(status: string): string {
  const known = readChangeOrderStatus(status)
  return known ? STATUS_WORDS[known] : `“${status}” (a state this release doesn't know)`
}

export function targetOf(row: Pick<ChangeOrderListRowForView, "model_id" | "target_kind" | "from_revision" | "to_revision" | "branch_id" | "branch_head">): ChangeTarget | null {
  if (row.target_kind === "version_range" && row.from_revision !== null && row.to_revision !== null) {
    return { kind: "version_range", modelId: row.model_id, fromRevision: row.from_revision, toRevision: row.to_revision }
  }
  if (row.target_kind === "branch" && row.branch_id !== null && row.branch_head !== null) {
    return { kind: "branch", modelId: row.model_id, branchId: row.branch_id, branchHead: row.branch_head }
  }
  return null
}

export function targetWords(target: ChangeTarget, branchName?: string): string {
  return target.kind === "version_range" ? `Changes since version ${target.fromRevision}, up to version ${target.toRevision}` : `Branch ${branchName ?? target.branchId} (as of version ${target.branchHead}) against Main`
}

function waitingWords(row: ChangeOrderListRowForView): string | null {
  if (row.status === "draft") return "Not sent yet. The party it is addressed to sees it once it is sent."
  if (row.status !== "sent") return null
  if (!row.addressee_has_login) return CHANGE_WORDS.needsLogin(row.addressee_label)
  return CHANGE_WORDS.waitingFor(row.addressee_label)
}

export function changeOrderView(row: ChangeOrderListRowForView, viewerId: string): ChangeOrderView | null {
  const target = targetOf(row)
  if (!target) {
    console.error("[bim/change-orders] a change order has a target this release can't read; it is left out", { id: row.id, kind: row.target_kind })
    return null
  }
  return {
    id: row.id,
    target,
    targetWords: targetWords(target),
    title: row.title,
    description: row.description,
    addressee: { kind: row.addressee_kind === "organization" ? "organization" : "contact", id: row.addressee_id, label: row.addressee_label },
    status: row.status,
    statusKnown: readChangeOrderStatus(row.status),
    statusWords: statusWords(row.status),
    reason: row.reason,
    citation: row.citation,
    deltaDigest: row.delta_digest,
    openedByLabel: row.opened_by_label,
    openedAt: row.opened_at,
    sentAt: row.sent_at,
    decidedAt: row.decided_at,
    iAmAddressee: row.i_am_addressee,
    iOpenedIt: row.opened_by === viewerId,
    addresseeHasLogin: row.addressee_has_login,
    invitePending: row.addressee_invite_pending,
    addresseeEmail: row.addressee_email,
    waitingWords: waitingWords(row),
  }
}

export function eventView(row: ChangeOrderEventRowForView): ChangeOrderEventView {
  return { from: row.from_status, to: row.to_status, reason: row.reason, citation: row.citation, at: row.created_at }
}

export function significanceView(row: SignificanceRowForView): SignificanceView {
  return {
    targetKey: row.target_key,
    kind: row.kind,
    reason: row.reason,
    citation: row.citation,
    discipline: row.discipline,
    classifiedByLabel: row.classified_by_label,
    classifiedAt: row.classified_at,
    historyCount: Number(row.history_count),
  }
}

/** The key a Versions row classifies: the range from the version listed before it up to this one. */
export function versionRangeTarget(modelId: string, fromRevision: number, toRevision: number): ChangeTarget | null {
  return toRevision > fromRevision ? { kind: "version_range", modelId, fromRevision, toRevision } : null
}

export { changeTargetKey }

/** The page that shows one change order waiting on you (Accept / Refuse / No cost). */
export function changeOrderForYouHref(id: string): string {
  return `/change-orders/${encodeURIComponent(id)}`
}

export function changeOrderForMe(row: ChangeOrderForMeRowForView): ChangeOrderForMe {
  const number = row.project_number?.trim()
  return {
    id: row.id,
    projectId: row.project_id,
    projectLabel: number ? `${number} ${row.project_name}` : row.project_name,
    title: row.title,
    openedBy: row.opened_by_name,
    sentAt: row.sent_at,
    href: changeOrderForYouHref(row.id),
  }
}
