import { z } from "zod"
import { QUESTION_LINK_KINDS, type QuestionLinkKind, type QuestionLinkRowForView } from "./contract"

/** What a link to the project's own records reads as on a question or submittal. Operator words, never a table name. */
export const QUESTION_LINK_LABELS: Readonly<Record<QuestionLinkKind, string>> = {
  client_submission: "Client submission",
  client_rfi: "Client RFI",
  procore_item: "Procore item",
}

export const createLinkSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    recordKind: z.enum(["question", "submittal"]),
    recordId: z.string().trim().min(1).max(200),
    linkKind: z.enum(QUESTION_LINK_KINDS),
    linkedId: z.string().uuid("Pick the submission or Procore item to link"),
  })
  .strict()

export type CreateLinkRequest = z.infer<typeof createLinkSchema>

export interface QuestionLinkView {
  readonly id: string
  readonly recordKind: "question" | "submittal"
  readonly recordId: string
  readonly linkKind: QuestionLinkKind
  readonly label: string
  readonly linkedId: string
  readonly createdAt: string
}

/** A stored link as the panel shows it, or null for a kind this release can't show. */
export function linkView(row: QuestionLinkRowForView): QuestionLinkView | null {
  const kind = QUESTION_LINK_KINDS.find((k) => k === row.link_kind)
  if (!kind) return null
  return { id: row.id, recordKind: row.record_kind, recordId: row.record_id, linkKind: kind, label: QUESTION_LINK_LABELS[kind], linkedId: row.linked_id, createdAt: row.created_at }
}

export interface QuestionLinksResponse {
  readonly links: readonly QuestionLinkView[]
}

/** Something on the project a question or submittal can be linked to (the Link picker). */
export interface LinkCandidate {
  readonly linkKind: QuestionLinkKind
  readonly id: string
  readonly label: string
  readonly kindLabel: string
}

export interface LinkCandidatesResponse {
  readonly candidates: readonly LinkCandidate[]
  /** Why Procore items aren't listed, in words, or null when they are. */
  readonly procoreNote: string | null
}
