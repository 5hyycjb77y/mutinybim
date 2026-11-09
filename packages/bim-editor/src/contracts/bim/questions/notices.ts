import { z } from "zod"
import { personOf, type AuthorRef, type Command, type Question } from "@permitzip/bim-kernel"
import { hostProviderIds as defaultHostProviderIds } from "../identity/host-provider"
import { QUESTION_NOTICE_EVENTS, type QuestionNoticeEvent } from "./contract"

/**
 * Who hears about an act on a question (round 9, the bell). The asker hears
 * about answers, declines, replies and the rest; the one person a question
 * was asked of hears about replies, Ask again and the question itself. Never
 * the person who acted. Only people this app knows (the host provider's
 * user ids) can be told; a party named in words is told through its own
 * channel.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The host app's user id for an author (the person an agent acted for), or
 * null when the author isn't one. `hostProviderIds`: every id the host's
 * people carry on records (its current id and earlier ones).
 */
export function hostUserOf(author: AuthorRef | undefined, hostProviderIds: readonly string[] = defaultHostProviderIds()): string | null {
  if (!author) return null
  const person = personOf(author)
  if (!person || !UUID.test(person.subject)) return null
  return hostProviderIds.includes(person.provider) || person.provider === "unsigned" ? person.subject : null
}

type NoticeQuestion = Pick<Question, "askedByAuthor" | "askOfAuthor"> & Partial<Pick<Question, "ownerAuthor" | "formerAddressees">>

/**
 * The notices to write for one act on a question, as recipient user ids:
 * the owner (whoever carries it now) and the original asker hear what came
 * back; the person asked hears what is asked of them; people it was
 * forwarded away from keep hearing about the conversation. Never the actor.
 * `previousOwner`: for a Take over, the one who carried it before.
 */
export function noticeRecipients(question: NoticeQuestion, event: QuestionNoticeEvent, actorUserId: string, previousOwner?: AuthorRef, hostProviderIds: readonly string[] = defaultHostProviderIds()): string[] {
  const userOf = (author: AuthorRef | undefined) => hostUserOf(author, hostProviderIds)
  const owner = userOf(question.ownerAuthor ?? question.askedByAuthor)
  const asker = userOf(question.askedByAuthor)
  const asked = userOf(question.askOfAuthor)
  const formers = (question.formerAddressees ?? []).map((p) => userOf(p.author)).filter((u): u is string => u !== null)
  const out = new Set<string>()
  const add = (...ids: readonly (string | null)[]) => ids.forEach((u) => u && out.add(u))
  switch (event) {
    case "answered":
    case "declined":
    case "not_in_scope":
    case "kept_closed":
    case "may_no_longer_hold":
      add(owner, asker)
      break
    case "replied":
      add(owner, asker, asked, ...formers)
      break
    case "asked":
    case "asked_again":
    case "withdrawn":
      add(asked)
      break
    case "took_over":
      add(userOf(previousOwner), asked)
      break
    // The question as it reads after the forward: the new addressee hears "forwarded to you", the
    // owner and everyone it was asked of before hear "forwarded" (round 10).
    case "forwarded":
      add(owner, ...formers)
      break
    case "forwarded_to_you":
      add(asked)
      break
    case "shared_with_you":
      break
  }
  out.delete(actorUserId)
  return [...out]
}

export interface NoticeEvent {
  readonly questionIds: readonly string[]
  readonly event: QuestionNoticeEvent
  readonly excerpt: string
}

/**
 * Every bell event a saved question command makes. A forward is two: the new
 * addressee is told it is theirs now, everyone else that it moved (round 10).
 */
export function noticeEventsFor(command: Command): NoticeEvent[] {
  if (command.type === "forward_question") {
    const excerpt = command.note ?? `Now asked of ${command.askOf}`
    return [
      { questionIds: [command.questionId], event: "forwarded_to_you", excerpt: command.note ?? "" },
      { questionIds: [command.questionId], event: "forwarded", excerpt },
    ]
  }
  const one = noticeEventFor(command)
  return one ? [one] : []
}

/** Which bell event a saved question command is, and its words; null for commands nobody needs to hear about. A forward's second event is in `noticeEventsFor`. */
export function noticeEventFor(command: Command): NoticeEvent | null {
  switch (command.type) {
    case "reply_question":
      return { questionIds: [command.questionId], event: "replied", excerpt: command.text }
    case "decline_question":
      return { questionIds: [command.questionId], event: command.keep_closed ? "kept_closed" : command.not_in_scope ? "not_in_scope" : "declined", excerpt: command.keep_closed ?? command.note ?? "" }
    case "answer_question":
      return command.status === "assumed" ? null : { questionIds: [command.questionId], event: command.outcome === "not_in_scope" ? "not_in_scope" : "answered", excerpt: command.answer }
    case "set_question_status":
      return { questionIds: command.questionIds, event: command.status === "open" ? "asked_again" : "withdrawn", excerpt: "" }
    case "take_over_question":
      return { questionIds: [command.questionId], event: "took_over", excerpt: command.note ?? "" }
    case "forward_question":
      return { questionIds: [command.questionId], event: "forwarded", excerpt: command.note ?? `Now asked of ${command.askOf}` }
    case "add_question":
      return { questionIds: command.questions.filter((q) => q.askOfAuthor).map((q) => q.questionId), event: "asked", excerpt: command.questions[0]?.text ?? "" }
    default:
      return null
  }
}

/** A notice's words in the bell: "J. Rao declined Q-3: 'not ours, ask the architect'. Reply or ask again." Never "overdue". */
export function noticeWords(n: { readonly actorLabel: string; readonly event: QuestionNoticeEvent; readonly questionNumber: string; readonly excerpt: string }): string {
  const said = n.excerpt.trim() ? `: '${n.excerpt.trim()}'` : ""
  switch (n.event) {
    case "asked":
      return `${n.actorLabel} asked you ${n.questionNumber}${said}. Answer, decline or reply when you can.`
    case "answered":
      return `${n.actorLabel} answered ${n.questionNumber}${said}.`
    case "declined":
      return `${n.actorLabel} declined ${n.questionNumber}${said}. Reply or ask again.`
    case "not_in_scope":
      return `${n.actorLabel} marked ${n.questionNumber} not in scope${said}. Reply or ask again.`
    case "replied":
      return `${n.actorLabel} replied on ${n.questionNumber}${said}.`
    case "asked_again":
      return `${n.actorLabel} asked ${n.questionNumber} again${said}.`
    case "withdrawn":
      return `${n.actorLabel} withdrew ${n.questionNumber}.`
    case "took_over":
      return `${n.actorLabel} took over ${n.questionNumber}${said}. They carry it now.`
    case "forwarded":
      return `${n.actorLabel} forwarded ${n.questionNumber}${said}.`
    case "kept_closed":
      return `${n.actorLabel} closed ${n.questionNumber} and kept it closed${said}. Ask a new question if it still matters.`
    case "forwarded_to_you":
      return `${n.actorLabel} forwarded ${n.questionNumber} to you${said}. Answer, decline or reply when you can.`
    case "shared_with_you":
      return `${n.actorLabel} shared ${n.questionNumber} with you, read-only.`
    case "may_no_longer_hold":
      return `The answer to ${n.questionNumber} may no longer hold${n.excerpt.trim() ? ` — ${n.excerpt.trim().replace(/^May no longer hold — /, "")}` : ""}. Nothing was reopened.`
  }
}

/** The notice key a stale answer is told under: the open page and the agent apply path use the same one, so whichever notices first tells once. */
export function staleAnswerDedupeKey(modelId: string, answerId: string, relianceDigest: string): string {
  return `stale:${modelId}:${answerId}:${relianceDigest}`
}

/** The bell's request to write notices after an act the person just saved in the model. */
export const writeNoticesSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    questionId: z.string().trim().min(1).max(200),
    questionNumber: z.string().trim().min(1).max(20),
    event: z.enum(QUESTION_NOTICE_EVENTS),
    excerpt: z.string().max(2000).optional(),
    recipients: z.array(z.string().regex(UUID, "A recipient must be a person on this project")).min(1).max(10),
    /** The same recipient and key never write twice (a stale answer, noticed by whichever client sees it first). */
    dedupeKey: z.string().trim().min(1).max(300).optional(),
  })
  .strict()

export type WriteNoticesRequest = z.infer<typeof writeNoticesSchema>

export const dismissNoticesSchema = z.object({ ids: z.array(z.string().regex(UUID)).min(1).max(200) }).strict()

/** The excerpt kept on a notice: the actor's words, one line, at most 280 characters. */
export function noticeExcerpt(text: string | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim()
  return one.length > 280 ? `${one.slice(0, 277)}...` : one
}

/** What the bell's section reads (`GET /api/questions/for-me`). */
export interface QuestionNoticeForMe {
  readonly id: string
  readonly projectId: string
  readonly projectLabel: string
  readonly modelId: string
  readonly questionId: string
  readonly questionNumber: string
  readonly event: QuestionNoticeEvent
  readonly words: string
  readonly createdAt: string
  /** They read only this thread (not on the project): it opens read-only, not in the Building Model. */
  readonly sharedOnly?: boolean
}

export interface QuestionsForMeResponse {
  readonly notices: readonly QuestionNoticeForMe[]
}
