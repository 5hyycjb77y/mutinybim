import type { SharedQuestionThread } from "./shared-thread"

/**
 * What the question screens and the server agree on: link kinds, bell notice
 * events, reader reasons, and the people and readers the question routes
 * answer with. No database client here, so the editor can read these
 * anywhere; the server's typed client and row shapes live in `./db`, the
 * server reads in `./readers-server`.
 */

/** Link kinds this release can check and show (the column is open text). */
export const QUESTION_LINK_KINDS = ["client_submission", "client_rfi", "procore_item"] as const
export type QuestionLinkKind = (typeof QUESTION_LINK_KINDS)[number]

// db-shape: the columns of a `bim_question_links` row a link view reads; lib/bim/editor-shape-checks.ts holds them to the server's row
export type QuestionLinkRowForView = {
  readonly id: string
  readonly record_kind: "question" | "submittal"
  readonly record_id: string
  readonly link_kind: string
  readonly linked_id: string
  readonly created_at: string
}

export const QUESTION_NOTICE_EVENTS = ["asked", "answered", "declined", "not_in_scope", "replied", "asked_again", "withdrawn", "took_over", "forwarded", "kept_closed", "may_no_longer_hold", "forwarded_to_you", "shared_with_you"] as const
export type QuestionNoticeEvent = (typeof QUESTION_NOTICE_EVENTS)[number]

export const QUESTION_READER_REASONS = ["former_addressee", "forwarded_outside"] as const
export type QuestionReaderReason = (typeof QUESTION_READER_REASONS)[number]

/** One person a question can be forwarded to (the project's real access sources, IAM rule 41). */
export interface ForwardCandidate {
  readonly userId: string
  readonly name: string
  readonly email: string
  /** "Team", the client organization, or null when not known. */
  readonly company: string | null
  /** Where their access comes from, in words: "Project Lead", "All Employees", "Guest", "Client organization", "Administrator". */
  readonly access: string
}

/** Someone a thread is shared with, read-only. */
export interface ThreadReader {
  readonly id: string
  readonly name: string
  readonly kind: "person" | "contact"
  readonly reason: QuestionReaderReason
  readonly sharedBy: string
  readonly sharedAt: string
}

/** A thread shared with the signed-in person. */
export interface SharedWithMe {
  readonly readerId: string
  readonly projectId: string
  readonly projectLabel: string
  readonly modelId: string
  readonly questionId: string
  readonly questionNumber: string
  readonly sharedBy: string
  readonly sharedAt: string
  /** Null when the copy isn't there or this release can't read it. */
  readonly thread: SharedQuestionThread | null
  readonly updatedAt: string | null
}
