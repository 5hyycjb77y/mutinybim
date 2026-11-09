'use client'

import { useCallback, useEffect, useState } from 'react'
import { Forward } from 'lucide-react'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchForwardCandidatesFrom } from '../../contracts/bim/questions/readers'
import type { ForwardCandidate } from '../../contracts/bim/questions/contract'
import { ProjectPersonPicker, type PeopleState } from './ProjectPersonPicker'

/** Where the question goes: a person picked from the project, or a company outside it (by name, with their person's email to share the thread). */
export type ForwardTarget = { readonly kind: 'person'; readonly person: ForwardCandidate } | { readonly kind: 'outside'; readonly company: string; readonly email: string | null }

export interface ForwardQuestionDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly number: string
  /** Who it is asked of now, in words: they keep the conversation. */
  readonly askOfLabel: string
  /** Where the project's people come from. Null: only "outside the project" by name (no roster). */
  readonly projectId: string | null
  /**
   * Forward it. Returns the model's refusal in words, or null when it saved.
   * `people`: the roster as loaded (null when it didn't load), so the caller
   * can tell who is outside the project.
   */
  readonly onForward: (target: ForwardTarget, people: readonly ForwardCandidate[] | null) => string | null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Forward a question (round 10): pick a person on the project, who hears it
 * in their bell, or name a company outside the project and give their
 * person's email so they can read this one conversation, read-only. Whoever
 * had it keeps the conversation. Cancel and Esc close it; forwarding back
 * undoes it (Nielsen 3). At most five controls in view (8): why it moved
 * goes in a reply, where everyone reads it.
 */
export function ForwardQuestionDialog({ open, onClose, number, askOfLabel, projectId, onForward }: ForwardQuestionDialogProps) {
  const questions = useEditorHost().data.questions
  const [where, setWhere] = useState<'person' | 'outside'>(projectId ? 'person' : 'outside')
  const [people, setPeople] = useState<PeopleState>({ kind: 'loading' })
  const [picked, setPicked] = useState<ForwardCandidate | null>(null)
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  const fetchPeople = useCallback(() => {
    if (!projectId) return
    fetchForwardCandidatesFrom(questions, projectId)
      .then((list) => setPeople({ kind: 'ready', people: list }))
      .catch((err: unknown) => {
        console.error('[ForwardQuestionDialog] loading the project people failed', err)
        setPeople({ kind: 'error', message: err instanceof Error ? err.message : "The project's people didn't load." })
      })
  }, [questions, projectId])

  useEffect(() => {
    if (open) fetchPeople()
  }, [open, fetchPeople])

  const retry = () => {
    setPeople({ kind: 'loading' })
    fetchPeople()
  }

  const reset = () => {
    setPicked(null)
    setCompany('')
    setEmail('')
    setRefusal(null)
  }
  const close = () => {
    reset()
    onClose()
  }

  const emailTyped = email.trim()
  const emailBad = emailTyped !== '' && !EMAIL.test(emailTyped)
  const why =
    where === 'person'
      ? picked
        ? null
        : 'Pick the person to ask first.'
      : company.trim() === ''
        ? 'Name the company first.'
        : emailBad
          ? 'That email doesn’t look right (name@company.com).'
          : null

  const send = () => {
    if (why) return
    const target: ForwardTarget = where === 'person' && picked ? { kind: 'person', person: picked } : { kind: 'outside', company: company.trim(), email: emailTyped === '' ? null : emailTyped }
    const refused = onForward(target, people.kind === 'ready' ? people.people : null)
    if (refused) {
      setRefusal(refused)
      return
    }
    close()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent data-testid="question-forward-dialog">
        <DialogHeader>
          <DialogTitle>Forward {number}</DialogTitle>
          <DialogDescription>{askOfLabel} keeps the conversation and still hears about it.</DialogDescription>
        </DialogHeader>
        {projectId ? (
          <ToggleGroup type="single" variant="outline" value={where} onValueChange={(v) => (v === 'person' || v === 'outside') && setWhere(v)} aria-label="Who to ask" data-testid="question-forward-where">
            <ToggleGroupItem value="person" data-testid="question-forward-person">
              Someone on the project
            </ToggleGroupItem>
            <ToggleGroupItem value="outside" data-testid="question-forward-outside">
              A company outside it
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
        {where === 'person' ? (
          <ProjectPersonPicker state={people} selected={picked?.userId ?? null} onSelect={setPicked} onRetry={retry} />
        ) : (
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="forward-company">Company</FieldLabel>
              <Input id="forward-company" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={60} placeholder="Acme Steel" data-testid="question-forward-to" />
            </Field>
            <Field>
              <FieldLabel htmlFor="forward-email">Their person&apos;s email (optional)</FieldLabel>
              <Input id="forward-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} placeholder="name@acme-steel.com" aria-invalid={emailBad} data-testid="question-forward-email" />
              <FieldDescription>They can read this one conversation, read-only, once they sign in as a guest. Nothing else in the model.</FieldDescription>
            </Field>
          </div>
        )}
        {refusal ? (
          <p role="alert" className="text-sm text-danger-600" data-testid="question-forward-refusal">
            {refusal}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={send} disabled={why !== null} title={why ?? undefined} data-testid="question-forward-save">
            <Forward data-icon="inline-start" />
            {where === 'person' && picked ? `Forward to ${picked.name}` : 'Forward'}
          </Button>
        </DialogFooter>
        {why ? (
          <p className="text-xs text-muted-foreground" data-testid="question-forward-why">
            {why}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
