import { askerWords, authorWords, isAsker, isOwner, mayAskAgain, ownerWords, questionAt, questionOutcomeLabel, questionThread, recordValidity, type AuthorRef, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { eventWords, STATUS_ACT } from '../../contracts/bim/questions/thread-words'

/** One line of a question's thread, in operator words. */
export interface ThreadLine {
  readonly id: ElementId
  readonly who: string
  /** "2 Nov, 09:00" (local), or "" when the record has no readable time. */
  readonly when: string
  /** "Declined", "Answered: Clarification", "Asked again", or "" for a plain reply. */
  readonly act: string
  readonly text: string
  /** An answer that may no longer hold: "May no longer hold — Room 104 changed in Rev 52". */
  readonly stale?: string
}

/** What the five answer choices record. Decline isn't an answer: it writes its own status (see `decline_question`). */
export type AnswerChoice = 'clarification' | 'judgment_recorded' | 'design_revision' | 'not_in_scope' | 'decline'

export const ANSWER_CHOICES: readonly { readonly id: AnswerChoice; readonly label: string; readonly hint: string }[] = [
  { id: 'clarification', label: 'Clarify', hint: 'Explain; nothing in the design changes.' },
  { id: 'judgment_recorded', label: 'Record a decision', hint: 'A judgment call the model can cite later.' },
  { id: 'design_revision', label: 'Revise the design (opens a branch)', hint: 'Record that the design will change, then open a branch to change it. Main is not changed.' },
  { id: 'not_in_scope', label: 'Not in scope', hint: "It isn't yours to answer. The pin leaves the plan; the asker can ask again." },
  { id: 'decline', label: 'Decline', hint: 'You choose not to answer. The pin leaves the plan; the asker can ask again.' },
]

export function whenWords(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function personWords(a: AuthorRef | undefined, fallback: string): string {
  return a ? authorWords(a) : fallback
}

/** The thread of one question, oldest first, as lines a person reads. */
export function threadLines(model: ModelState, questionId: string): ThreadLine[] {
  const thread = questionThread(model.elements, questionId)
  if (!thread) return []
  return thread.entries.map((e) => {
    if (e.kind === 'answer') {
      const a = e.record.answer
      const v = recordValidity(model.elements, e.id)
      return { id: e.id, who: personWords(a.author, a.by), when: whenWords(a.at), act: `Answered: ${questionOutcomeLabel(a.outcome)}`, text: a.text, ...(v.state === 'may_not_hold' ? { stale: v.words } : {}) }
    }
    const r = e.record.reply
    const to = r.statusChange?.to
    const acts = [to ? (STATUS_ACT[to] ?? 'Changed it') : '', r.event ? eventWords(r.event) : ''].filter(Boolean)
    return { id: e.id, who: authorWords(r.author), when: whenWords(r.at), act: acts.join(' · '), text: r.text }
  })
}

/** Who asked, who carries it now, whom it is asked of, and the closed question it asks anew, in words, for the thread's header. */
export function askedByLine(model: ModelState, questionId: string): string | null {
  const q = questionThread(model.elements, questionId)?.question
  if (!q) return null
  const who = askerWords(q)
  const owner = q.ownerAuthor ? ownerWords(q) : null
  const before = q.formerAddressees?.length ? ` (before: ${q.formerAddressees.map((p) => p.label).join(', ')})` : ''
  const prior = q.askedBefore ? questionAt(model.elements, q.askedBefore) : undefined
  const parts = [
    who ? `Asked by ${who}` : null,
    owner ? `Carried by ${owner}` : null,
    q.formerAddressees?.length ? `Asked of ${q.askOf}${before}` : null,
    prior ? `Asked before: ${prior.number}, closed: ${prior.status.replace(/_/g, ' ')}` : null,
  ].filter((x): x is string => x !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** "Q-12 'Is there a beam?', closed: not in scope": the words a new question links back with. */
export function askedBeforeWords(model: ModelState, questionId: string): string | null {
  const q = questionAt(model.elements, questionId)
  if (!q) return null
  const t = q.text.length > 50 ? `${q.text.slice(0, 47)}...` : q.text
  return `${q.number} '${t}', closed: ${q.status.replace(/_/g, ' ')}`
}

/** Whether the question is closed and kept closed (Ask again is refused; ask a new question instead). */
export function keptClosed(model: ModelState, questionId: string): boolean {
  return Boolean(questionAt(model.elements, questionId)?.keptClosed)
}

/** Whether the signed-in person carries the question now (Take over is then nothing to do). */
export function iCarry(model: ModelState, questionId: string, me: AuthorRef | null): boolean {
  const q = questionAt(model.elements, questionId)
  return Boolean(q && me && isOwner(q, me))
}

/**
 * Why Ask again is off for this person, or null when they may press it.
 * The kernel refuses the same command in the same words; this only lets the
 * button say why before anyone presses it (Nielsen 5).
 */
export function askAgainBlocked(model: ModelState, questionId: string, me: AuthorRef | null): string | null {
  const q = questionThread(model.elements, questionId)?.question
  if (!q) return null
  const may = mayAskAgain(q, me)
  return may.ok ? null : q.keptClosed ? `${may.reason}.` : `${may.reason}. You can reply instead.`
}

/** Whether the signed-in person asked this question (the bell and the thread say "you"). */
export function iAsked(model: ModelState, questionId: string, me: AuthorRef | null): boolean {
  const q = questionThread(model.elements, questionId)?.question
  return Boolean(q && me && isAsker(q, me))
}
