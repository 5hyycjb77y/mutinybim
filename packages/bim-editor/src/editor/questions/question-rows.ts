import { answerValidity, type BimElement, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { allQuestions, modelAnswerFor, NAMED_AUDIENCES, type Question, type QuestionStatus, type QuestionType } from '../../contracts/bim/questions/kernel'

/** What the Questions list shows per question, in operator words. */
export interface QuestionRow {
  readonly id: ElementId
  readonly number: string
  readonly text: string
  readonly type: QuestionType
  readonly typeLabel: string
  readonly status: QuestionStatus
  readonly statusLabel: string
  readonly askOf: string
  readonly askOfLabel: string
  /** "SD-1, SD-2" or "a spot on the plan"; "deleted" ones say so. */
  readonly about: string
  readonly elementIds: readonly ElementId[]
  readonly blocksIssue: boolean
  readonly closeBy: string | null
  readonly answer: string | null
  /** The model already holds the value that answers it ("SD-1 mark is SD-1"); null when it can't tell. */
  readonly modelAnswer: string | null
  readonly anchorGone: boolean
  /** Answered, but what the answer relied on changed: "May no longer hold — Room 104 changed in Rev 52". */
  readonly staleWords: string | null
}

export type QuestionFilter = 'open' | 'all'

export const STATUS_LABEL: Readonly<Record<QuestionStatus, string>> = { open: 'Open', answered: 'Answered', assumed: 'Assumed', withdrawn: 'Withdrawn', declined: 'Declined', not_in_scope: 'Not in scope' }
export const TYPE_LABEL: Readonly<Record<QuestionType, string>> = { question: 'Question', assumption: 'Assumption', field_verify: 'Verify on site' }
export const AUDIENCE_LABEL: Readonly<Record<(typeof NAMED_AUDIENCES)[number], string>> = { client: 'Client', architect: 'Architect', structural: 'Structural', contractor: 'Contractor', internal: 'Our team' }

export function audienceLabel(askOf: string): string {
  const key = askOf.trim().toLowerCase()
  const named = NAMED_AUDIENCES.find((a) => a === key)
  return named ? AUDIENCE_LABEL[named] : askOf.trim()
}

function elementWords(el: BimElement): string {
  if ('mark' in el && typeof el.mark === 'string' && el.mark.trim() !== '') return el.mark.trim()
  if ((el.kind === 'space' || el.kind === 'room') && `${el.number} ${el.name}`.trim() !== '') return `${el.number} ${el.name}`.trim()
  if ('name' in el && typeof el.name === 'string' && el.name.trim() !== '') return el.name.trim()
  return el.kind.replace(/_/g, ' ')
}

function about(model: ModelState, q: Question): { readonly text: string; readonly gone: boolean } {
  const names: string[] = []
  let gone = 0
  for (const id of q.anchor.elementIds) {
    const el = model.elements[id]
    if (el) names.push(elementWords(el))
    else gone += 1
  }
  const parts = [...new Set(names)]
  const shown = parts.slice(0, 3).join(', ') + (parts.length > 3 ? ` and ${parts.length - 3} more` : '')
  const pieces = [shown, q.anchor.point ? 'a spot on the plan' : '', gone > 0 ? `${gone} deleted` : ''].filter((s) => s !== '')
  return { text: pieces.join('; '), gone: gone > 0 && parts.length === 0 && !q.anchor.point }
}

/** The selection as the person sees it ("SD-1, SD-2 and 3 more"), for Ask about selection. */
export function selectionLabel(model: ModelState | null, ids: readonly string[]): string {
  if (!model || ids.length === 0) return ''
  const names = ids.flatMap((id) => {
    const el = model.elements[id]
    return el ? [elementWords(el)] : []
  })
  const unique = [...new Set(names)]
  return unique.slice(0, 3).join(', ') + (unique.length > 3 ? ` and ${unique.length - 3} more` : '')
}

/** Open first (holding ones first), then by number. Assumed ones count as still in play for "open". */
export function questionRows(model: ModelState, filter: QuestionFilter): QuestionRow[] {
  const rows: QuestionRow[] = []
  for (const q of allQuestions(model.elements)) {
    if (filter === 'open' && q.status !== 'open' && q.status !== 'assumed') continue
    const a = about(model, q)
    const m = q.status === 'open' || q.status === 'assumed' ? modelAnswerFor(model, q) : null
    rows.push({
      id: q.id,
      number: q.number,
      text: q.text,
      type: q.type,
      typeLabel: TYPE_LABEL[q.type] ?? q.type.replace(/_/g, ' '),
      status: q.status,
      statusLabel: STATUS_LABEL[q.status],
      askOf: q.askOf,
      askOfLabel: audienceLabel(q.askOf),
      about: a.text,
      elementIds: q.anchor.elementIds,
      blocksIssue: q.blocksIssue === true,
      closeBy: q.closeBy ?? null,
      answer: q.answer ?? null,
      modelAnswer: m?.answered ? `${m.from} is ${m.value}` : null,
      anchorGone: a.gone,
      staleWords: q.status === 'answered' ? (() => { const v = answerValidity(model.elements, q.id); return v.state === 'may_not_hold' ? v.words : null })() : null,
    })
  }
  const rank = (r: QuestionRow) => (r.status === 'open' ? (r.blocksIssue ? 0 : 1) : r.status === 'assumed' ? 2 : 3)
  return rows.sort((x, y) => rank(x) - rank(y) || x.number.localeCompare(y.number, 'en', { numeric: true }))
}

/** Who has something open or assumed, for the email picker: named parties first, then firm-typed ones. */
export function audiencesWithQuestions(model: ModelState): string[] {
  const keys = new Map<string, string>()
  for (const q of allQuestions(model.elements)) if (q.status === 'open' || q.status === 'assumed') keys.set(q.askOf.trim().toLowerCase(), q.askOf.trim())
  const named = NAMED_AUDIENCES.filter((a) => keys.has(a))
  const others = [...keys.entries()].filter(([k]) => !NAMED_AUDIENCES.some((a) => a === k)).map(([, v]) => v).sort()
  return [...named, ...others]
}
