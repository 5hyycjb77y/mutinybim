'use client'

import { useState } from 'react'
import type { ElementId } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Textarea } from '../../ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { NAMED_AUDIENCES, QUESTION_TYPES, type QuestionCommand, type KnownQuestionType as QuestionType } from '../../contracts/bim/questions/kernel'
import { newElementId } from '../placement'
import { AUDIENCE_LABEL, TYPE_LABEL } from './question-rows'

const TYPE_HINT: Readonly<Record<QuestionType, string>> = {
  question: 'Someone has to tell us. It stays open until answered.',
  assumption: 'We go ahead on it now and ask them to confirm.',
  field_verify: 'Someone checks it on site. It stays open until checked.',
}

function isQuestionType(v: string): v is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(v)
}

interface Props {
  readonly open: boolean
  /** What the question is about: the elements selected on the plan. */
  readonly elementIds: readonly ElementId[]
  /** "SD-1, SD-2": what the person sees selected. */
  readonly aboutLabel: string
  readonly submit: (command: QuestionCommand, undoLabel: string) => string | null
  readonly onClose: () => void
  /** Asking a closed question anew: the new question links back ("Asked before: Q-12, closed: not in scope"). */
  readonly askedBefore?: { readonly id: ElementId; readonly words: string } | null
}

/** Ask about what is selected: the question, who it is for, and whether it holds the issue. Esc or Cancel closes with nothing added. */
export function AskQuestionDialog({ open, elementIds, aboutLabel, submit, onClose, askedBefore }: Props) {
  const [text, setText] = useState('')
  const [type, setType] = useState<QuestionType>('question')
  const [askOf, setAskOf] = useState<string>('client')
  const [holds, setHolds] = useState(false)
  const [closeBy, setCloseBy] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  const missing = text.trim() === '' ? 'Type the question first.' : elementIds.length === 0 ? 'Select what it is about on the plan first.' : null

  const reset = () => {
    setText('')
    setType('question')
    setHolds(false)
    setCloseBy('')
    setRefusal(null)
  }

  const save = () => {
    if (missing) return
    const refused = submit(
      {
        type: 'add_question',
        questions: [
          {
            questionId: newElementId('question'),
            type,
            text: text.trim(),
            askOf,
            anchor: { elementIds: [...elementIds] },
            ...(holds && type !== 'assumption' ? { blocksIssue: true } : {}),
            ...(closeBy.trim() ? { closeBy: closeBy.trim() } : {}),
            ...(askedBefore ? { askedBefore: askedBefore.id } : {}),
          },
        ],
      },
      type === 'assumption' ? 'Add assumption' : 'Add question',
    )
    if (refused) {
      setRefusal(refused)
      return
    }
    reset()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent data-testid="questions-ask-dialog">
        <DialogHeader>
          <DialogTitle>Ask about {aboutLabel || 'the selection'}</DialogTitle>
          <DialogDescription>{askedBefore ? `A new question that links back to ${askedBefore.words}. It pins to the same things.` : 'It pins to what is selected and shows in Coordination › Questions.'}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="question-text">Question</FieldLabel>
            <Textarea id="question-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Is there a beam here? Please confirm." maxLength={1000} data-testid="questions-ask-text" />
          </Field>
          <Field>
            <FieldLabel>Kind</FieldLabel>
            <ToggleGroup type="single" variant="outline" value={type} onValueChange={(v) => isQuestionType(v) && setType(v)} aria-label="Kind">
              {QUESTION_TYPES.map((t) => (
                <ToggleGroupItem key={t} value={t} data-testid={`questions-ask-type-${t}`}>
                  {TYPE_LABEL[t]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{TYPE_HINT[type]}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="question-ask-of">For</FieldLabel>
            <Select value={askOf} onValueChange={setAskOf}>
              <SelectTrigger id="question-ask-of" data-testid="questions-ask-of">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {NAMED_AUDIENCES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {AUDIENCE_LABEL[a]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="question-holds" checked={holds} onCheckedChange={(v) => setHolds(v === true)} disabled={type === 'assumption'} aria-label="Holds the issue" data-testid="questions-ask-holds" />
            <FieldLabel htmlFor="question-holds">Holds the issue</FieldLabel>
            <FieldDescription>{type === 'assumption' ? 'An assumption never holds an issue: the design goes ahead on it.' : 'Sheets showing this can’t be issued while it is open.'}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="question-close-by">Needed by (optional)</FieldLabel>
            <Input id="question-close-by" value={closeBy} onChange={(e) => setCloseBy(e.target.value)} placeholder="DD" maxLength={40} />
          </Field>
        </FieldGroup>
        {refusal ? (
          <Alert variant="destructive" data-testid="questions-ask-refusal">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={missing !== null} title={missing ?? undefined} data-testid="questions-ask-save">
            {type === 'assumption' ? 'Add assumption' : 'Add question'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
