import type { BimJson } from "../json"

/** One notice in the bell's "Code changes". */
export interface CodeChangeNoticeView {
  readonly id: string
  readonly projectId: string
  readonly projectLabel: string
  readonly modelId: string
  readonly discipline: string
  /** "The project now uses IBC 2024. 3 of your approvals were checked against IBC 2021." */
  readonly words: string
  readonly rules: readonly string[]
  readonly recordIds: readonly string[]
  readonly createdAt: string
  readonly readAt: string | null
}

export interface CodeChangeNoticesResponse {
  readonly notices: readonly CodeChangeNoticeView[]
}

/** One sign-off record on a model, as the banner, the record line and the issue check read it. */
export interface SignoffForCheckView {
  readonly id: string
  readonly seq: number
  readonly recordKind: string
  readonly subjectId: string
  readonly actorUserId: string
  readonly actorName: string
  readonly payload: BimJson
  readonly createdAt: string
}

export interface ModelSignoffsResponse {
  readonly modelId: string
  readonly records: readonly SignoffForCheckView[]
  /** `finding_disposition` records (overrides), read with the kernel's `readFindingDisposition`. */
  readonly dispositions: readonly SignoffForCheckView[]
  /** People who can no longer act on the project (left it): their records need someone else's new approval. */
  readonly departed: readonly string[]
}

export interface CodeChangeRecordedResponse {
  readonly written: number
}

export interface OverrideRecordedResponse {
  readonly id: string
  readonly seq: number
}
