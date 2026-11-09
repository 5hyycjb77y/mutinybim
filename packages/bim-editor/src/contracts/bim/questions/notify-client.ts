import type { AuthorRef, Question } from "@permitzip/bim-kernel"
import type { QuestionNoticeEvent } from "./contract"
import { noticeExcerpt, noticeRecipients, type QuestionsForMeResponse } from "./notices"
import type { EditorDataHost } from "@permitzip/bim-editor-host"
import { EditorServiceUnavailableError } from "@permitzip/bim-editor/host/unavailable"

type QuestionsPort = EditorDataHost["questions"]

function portOf(port: QuestionsPort): NonNullable<QuestionsPort> {
  if (!port) throw new EditorServiceUnavailableError("Question notices")
  return port
}

/**
 * Browser side of the bell's question notices. After the person's own act is
 * saved in the model, tell the asker (and the person asked) through the
 * host's `questions` port. A notice that
 * fails to send never undoes the act: it is logged and the caller shows it.
 */
export async function postQuestionNoticeFrom(port: QuestionsPort, input: {
  readonly projectId: string
  readonly modelId: string
  readonly question: Pick<Question, "id" | "number" | "askedByAuthor" | "askOfAuthor"> & Partial<Pick<Question, "ownerAuthor" | "formerAddressees">>
  readonly event: QuestionNoticeEvent
  readonly excerpt: string
  readonly actorUserId: string
  /** For a Take over: who carried it before (they hear that someone else carries it now). */
  readonly previousOwner?: AuthorRef
  /** The same recipient and key never write twice. */
  readonly dedupeKey?: string
  /** Every provider id the host's people carry on records (`hostProviderIds`). */
  readonly hostProviderIds?: readonly string[]
}): Promise<{ readonly written: number }> {
  const recipients = noticeRecipients(input.question, input.event, input.actorUserId, input.previousOwner, input.hostProviderIds)
  if (recipients.length === 0) return { written: 0 }
  const res = await portOf(port).notify({
    projectId: input.projectId,
    body: { modelId: input.modelId, questionId: input.question.id, questionNumber: input.question.number, event: input.event, excerpt: noticeExcerpt(input.excerpt), recipients, ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}) },
  })
  if (!res.ok) {
    const body: unknown = await res.json().catch((err: unknown) => {
      console.error("[questions] notice error body unreadable", err)
      return null
    })
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `The asker wasn't told (${res.status}).`
    throw new Error(message)
  }
  const body: unknown = await res.json()
  const written = typeof body === "object" && body !== null && "written" in body && typeof body.written === "number" ? body.written : 0
  return { written }
}

function isForMe(v: unknown): v is QuestionsForMeResponse {
  return typeof v === "object" && v !== null && "notices" in v && Array.isArray(v.notices)
}

/** The bell's "Questions for you". */
export async function fetchQuestionsForMeFrom(port: QuestionsPort): Promise<QuestionsForMeResponse> {
  const res = await portOf(port).forMe()
  const body: unknown = await res.json()
  if (!res.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `Questions for you didn't load (${res.status}).`
    throw new Error(message)
  }
  if (!isForMe(body)) throw new Error("Questions for you came back in a shape this page doesn't read. Refresh.")
  return body
}

export async function dismissQuestionNoticesFrom(port: QuestionsPort, ids: readonly string[]): Promise<void> {
  const res = await portOf(port).dismiss({ ids })
  if (!res.ok && res.status !== 404) throw new Error(`Couldn't dismiss that notice (${res.status}).`)
}

export { questionThreadHref } from "./thread-href"
