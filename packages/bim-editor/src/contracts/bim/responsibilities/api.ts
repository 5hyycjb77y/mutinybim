import type { BimJson } from "../json"
import type { ProposalView } from "../merge/model"
import type { ResponsibilityPowers } from "./server-types"

/** What lane M's routes answer, shared by the routes and the screens. */

export interface ResponsibilityItem {
  readonly id: string
  readonly partyKind: "person" | "firm"
  readonly personId: string | null
  readonly organizationId: string | null
  /** A person named from a firm entry. */
  readonly firmEntryId: string | null
  readonly label: string
  readonly discipline: string
  readonly scope: BimJson
  readonly wholeDiscipline: boolean
  readonly scopeWords: string
  /** On a firm entry (and its people): each of them approves, or any one of them. */
  readonly approvalRule: "each" | "any_one"
  readonly namedAt: string
  readonly acceptedAt: string | null
  /** The acceptance (or take / request) entry in this model's sign-off log. */
  readonly acceptedSignoffSeq: number | null
  /** A "Take responsibility" request still waiting to be granted. */
  readonly pendingRequest: boolean
  /** Accepted, and granted if it was a request: this row approves merges. */
  readonly counts: boolean
  readonly isMine: boolean
}

export interface FirmCandidate {
  readonly organizationId: string
  readonly name: string
  readonly people: readonly { readonly id: string; readonly label: string }[]
}

export interface ResponsibilitiesResponse {
  readonly modelId: string
  readonly viewerId: string
  readonly powers: ResponsibilityPowers
  readonly leads: readonly { readonly ref: string; readonly label: string }[]
  /** Who decides a request to take responsibility (the lead, or with no lead whoever names people). */
  readonly deciders: readonly { readonly id: string; readonly label: string }[]
  /** The viewer decides requests. */
  readonly canDecideRequests: boolean
  readonly candidates: readonly { readonly id: string; readonly label: string; readonly email: string | null }[]
  readonly firms: readonly FirmCandidate[]
  readonly responsibilities: readonly ResponsibilityItem[]
}

export interface TakeResult {
  readonly id: string
  readonly outcome: "taken" | "requested"
  readonly signoffSeq: number | null
  readonly already: boolean
  /** Who the request went to, when it is one. */
  readonly sentTo: readonly string[]
}

export interface MergesResponse {
  readonly modelId: string
  readonly viewerId: string
  readonly powers: ResponsibilityPowers
  readonly proposals: readonly ProposalView[]
}
