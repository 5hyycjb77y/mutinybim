import { askerWords, authorWords, ownerWords, questionOutcomeLabel, questionThread, recordValidity, type ModelState } from "@permitzip/bim-kernel"
import { eventWords, STATUS_ACT } from "./thread-words"

/**
 * The read-only copy of one question's thread for someone outside the
 * project (round 10, lane Q10). The model server admits only people on the
 * project, so a former addressee or an outside company's person reads this
 * copy, written by people on the project when they share or act on the
 * question. Words only: no element ids, no model data beyond the thread.
 */

export const SHARED_THREAD_VERSION = 1

export interface SharedThreadEntry {
  /** ISO 8601. */
  readonly at: string
  readonly who: string
  /** "Declined", "Answered: Clarification", "Forwarded it from Structural to A. Arch", or "" for a plain reply. */
  readonly act: string
  readonly text: string
  /** "May no longer hold — Room 104 changed in Rev 52". */
  readonly stale?: string
}

export interface SharedQuestionThread {
  readonly v: typeof SHARED_THREAD_VERSION
  readonly number: string
  readonly text: string
  readonly askOf: string
  /** "Open", "Answered", "Declined", … */
  readonly status: string
  readonly askedBy: string | null
  readonly carriedBy: string | null
  readonly entries: readonly SharedThreadEntry[]
}

const STATUS_WORDS: Readonly<Record<string, string>> = { open: "Open", answered: "Answered", assumed: "Going ahead on an assumption", withdrawn: "Withdrawn", declined: "Declined", not_in_scope: "Not in scope" }

/** The copy of one question's thread as it reads in `model` now; null when it isn't a question. */
export function sharedThreadOf(model: ModelState, questionId: string): SharedQuestionThread | null {
  const thread = questionThread(model.elements, questionId)
  if (!thread) return null
  const q = thread.question
  const entries: SharedThreadEntry[] = thread.entries.map((e) => {
    if (e.kind === "answer") {
      const a = e.record.answer
      const v = recordValidity(model.elements, e.id)
      return { at: a.at, who: a.author ? authorWords(a.author) : a.by, act: `Answered: ${questionOutcomeLabel(a.outcome)}`, text: a.text, ...(v.state === "may_not_hold" ? { stale: v.words } : {}) }
    }
    const r = e.record.reply
    const to = r.statusChange?.to
    const act = [to ? (STATUS_ACT[to] ?? "Changed it") : "", r.event ? eventWords(r.event) : ""].filter(Boolean).join(" · ")
    return { at: r.at, who: authorWords(r.author), act, text: r.text }
  })
  return { v: SHARED_THREAD_VERSION, number: q.number, text: q.text, askOf: q.askOf, status: STATUS_WORDS[q.status] ?? q.status.replace(/_/g, " "), askedBy: askerWords(q), carriedBy: q.ownerAuthor ? ownerWords(q) : null, entries }
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isEntry(v: unknown): v is SharedThreadEntry {
  return isRecord(v) && typeof v.at === "string" && typeof v.who === "string" && typeof v.act === "string" && typeof v.text === "string" && (v.stale === undefined || typeof v.stale === "string")
}

/** A stored copy, checked; null when it isn't one this release reads (the reader sees "not available yet"). */
export function readSharedThread(raw: unknown): SharedQuestionThread | null {
  if (!isRecord(raw) || raw.v !== SHARED_THREAD_VERSION) return null
  if (typeof raw.number !== "string" || typeof raw.text !== "string" || typeof raw.askOf !== "string" || typeof raw.status !== "string") return null
  if (!Array.isArray(raw.entries) || !raw.entries.every(isEntry)) return null
  const askedBy = typeof raw.askedBy === "string" ? raw.askedBy : null
  const carriedBy = typeof raw.carriedBy === "string" ? raw.carriedBy : null
  return { v: SHARED_THREAD_VERSION, number: raw.number, text: raw.text, askOf: raw.askOf, status: raw.status, askedBy, carriedBy, entries: raw.entries }
}
