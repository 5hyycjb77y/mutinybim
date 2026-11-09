'use client'

import { useState } from 'react'
import { Checkbox } from '../../ui/checkbox'
import { Input } from '../../ui/input'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldSet, FieldLegend } from '../../ui/field'
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group'
import { Textarea } from '../../ui/textarea'
import type { QuestionCommand } from '../../contracts/bim/questions/kernel'
import type { QuestionRow } from './question-rows'
import { ANSWER_CHOICES, type AnswerChoice } from './thread-rows'

interface Props {
  /** The question being answered; null keeps the dialog closed. */
  readonly row: QuestionRow | null
  readonly submit: (command: QuestionCommand, undoLabel: string) => string | null
  readonly onClose: () => void
  /** Saved: tell the asker (the bell) what happened. */
  readonly onSaved?: (choice: AnswerChoice | 'assumed' | 'kept_closed', text: string) => void
  /** "Revise the design": open a branch to change it (Main is not changed). Absent: the answer records the outcome without a branch. */
  readonly revise?: { readonly create: (name: string) => Promise<string>; readonly open: (branchId: string) => void } | null
}

const LABEL: Readonly<Record<AnswerChoice, string>> = { clarification: 'Answer question', judgment_recorded: 'Record a decision', design_revision: 'Revise the design', not_in_scope: 'Not in scope', decline: 'Decline question' }

function commandFor(row: QuestionRow, choice: AnswerChoice, text: string, keep: string | null, branchId: string | null): QuestionCommand {
  const kept = keep ? { keep_closed: keep } : {}
  if (choice === 'decline') return { type: 'decline_question', questionId: row.id, ...(text ? { note: text } : {}), ...kept }
  if (choice === 'not_in_scope') return { type: 'decline_question', questionId: row.id, not_in_scope: true, ...(text ? { note: text } : {}), ...kept }
  // A clarification sends the round 8 shape, so a model server that doesn't store outcomes still saves it.
  if (choice === 'clarification') return { type: 'answer_question', questionId: row.id, answer: text, status: 'answered' }
  return { type: 'answer_question', questionId: row.id, answer: text, outcome: choice, ...(branchId ? { links: [{ kind: 'branch', ref: branchId }] } : {}) }
}

/**
 * The person asked answers (Clarify, Record a decision, Revise the design),
 * says it is not in scope, or declines; or the design goes ahead on a stated
 * assumption. Nobody has to answer: there is no date and nothing is late.
 * Esc or Cancel closes with nothing changed.
 */
export function AnswerQuestionDialog({ row, submit, onClose, onSaved, revise }: Props) {
  const [answer, setAnswer] = useState('')
  const [keepClosed, setKeepClosed] = useState(false)
  const [keepReason, setKeepReason] = useState('')
  const [branchName, setBranchName] = useState('')
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<AnswerChoice>('clarification')
  const [refusal, setRefusal] = useState<string | null>(null)
  const close = () => {
    setAnswer('')
    setChoice('clarification')
    setKeepClosed(false)
    setKeepReason('')
    setBranchName('')
    setRefusal(null)
    onClose()
  }
  const noteOnly = choice === 'decline' || choice === 'not_in_scope'
  const branching = choice === 'design_revision' && revise
  const missing = !noteOnly && answer.trim() === ''
    ? 'Type what they said first.'
    : noteOnly && keepClosed && keepReason.trim() === ''
      ? 'Say why it stays closed.'
      : branching && branchName.trim() === ''
        ? 'Name the branch the revision is worked on.'
        : null

  const save = async (as: AnswerChoice | 'assumed') => {
    if (!row || saving || (as !== 'decline' && as !== 'not_in_scope' && answer.trim() === '')) return
    const text = answer.trim()
    let branchId: string | null = null
    if (as === 'design_revision' && revise) {
      setSaving(true)
      try {
        branchId = await revise.create(branchName.trim())
      } catch (err) {
        console.error('[AnswerQuestionDialog] opening the revision branch failed', err)
        setRefusal(err instanceof Error ? err.message : "The branch couldn't be opened.")
        setSaving(false)
        return
      }
      setSaving(false)
    }
    const keep = noteOnly && keepClosed ? keepReason.trim() : null
    const command: QuestionCommand = as === 'assumed' ? { type: 'answer_question', questionId: row.id, answer: text, status: 'assumed' } : commandFor(row, as, text, keep, branchId)
    const refused = submit(command, as === 'assumed' ? 'Go ahead on assumption' : LABEL[as])
    if (refused) {
      setRefusal(branchId ? `${refused} The branch was opened; it stays open.` : refused)
      return
    }
    onSaved?.(keep ? 'kept_closed' : as, keep ?? text)
    close()
    if (branchId && revise) revise.open(branchId)
  }

  const picked = ANSWER_CHOICES.find((c) => c.id === choice)
  return (
    <Dialog open={row !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="questions-answer-dialog">
        <DialogHeader>
          <DialogTitle>Answer {row?.number}</DialogTitle>
          <DialogDescription>{row?.text}</DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend variant="label">What you do with it</FieldLegend>
          <RadioGroup value={choice} onValueChange={(v) => { const c = ANSWER_CHOICES.find((x) => x.id === v); if (c) setChoice(c.id) }} data-testid="questions-answer-choice">
            {ANSWER_CHOICES.map((c) => (
              <Field key={c.id} orientation="horizontal">
                <RadioGroupItem value={c.id} id={`answer-choice-${c.id}`} data-testid={`questions-answer-choice-${c.id}`} />
                <FieldContent>
                  <FieldLabel htmlFor={`answer-choice-${c.id}`}>{c.label}</FieldLabel>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
          {picked ? <FieldDescription>{picked.hint}</FieldDescription> : null}
        </FieldSet>
        <Field>
          <FieldLabel htmlFor="question-answer">{noteOnly ? 'Note for the asker (optional)' : 'What they said'}</FieldLabel>
          <Textarea id="question-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={noteOnly ? 'Not ours; ask the architect.' : 'No beam; joists at 16 in. on centre.'} maxLength={2000} data-testid="questions-answer-text" />
          <FieldDescription>{noteOnly ? 'The question stays in the list. Only the person who carries it can ask it again.' : 'Answered questions drop off the next issue and out of the client email. The answer remembers what it relied on and says so if that changes.'}</FieldDescription>
        </Field>
        {noteOnly ? (
          <Field orientation="horizontal">
            <Checkbox id="question-keep-closed" checked={keepClosed} onCheckedChange={(v) => setKeepClosed(v === true)} data-testid="questions-keep-closed" />
            <FieldLabel htmlFor="question-keep-closed">Keep it closed (Ask again is refused; a new question can link back)</FieldLabel>
          </Field>
        ) : null}
        {noteOnly && keepClosed ? (
          <Field>
            <FieldLabel htmlFor="question-keep-reason">Why it stays closed</FieldLabel>
            <Input id="question-keep-reason" value={keepReason} onChange={(e) => setKeepReason(e.target.value)} maxLength={500} placeholder="Settled in the 10/12 coordination meeting" data-testid="questions-keep-reason" />
          </Field>
        ) : null}
        {branching ? (
          <Field>
            <FieldLabel htmlFor="question-branch-name">Branch to work the revision on</FieldLabel>
            <Input id="question-branch-name" value={branchName} onChange={(e) => setBranchName(e.target.value)} maxLength={80} placeholder={`Revise for ${row?.number ?? 'the question'}`} data-testid="questions-branch-name" />
            <FieldDescription>Opened from Main now and linked to this answer. Main is not changed until the branch is merged.</FieldDescription>
          </Field>
        ) : null}
        {refusal ? (
          <Alert variant="destructive" data-testid="questions-answer-refusal">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {!noteOnly ? (
            <Button variant="secondary" onClick={() => void save('assumed')} disabled={missing !== null} title={missing ?? 'No answer yet: the design goes ahead on what you typed, and the client is asked to confirm it'} data-testid="questions-answer-assume">
              Go ahead on this
            </Button>
          ) : null}
          <Button onClick={() => void save(choice)} disabled={missing !== null || saving} title={missing ?? undefined} data-testid="questions-answer-save">
            {noteOnly ? picked?.label : 'Save answer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
