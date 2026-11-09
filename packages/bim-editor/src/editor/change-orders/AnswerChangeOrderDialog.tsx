'use client'

import { useState } from 'react'
import { CHANGE_WORDS } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Spinner } from '../../ui/spinner'
import { Textarea } from '../../ui/textarea'
import { AssuranceButton } from '../signing/AssuranceButton'
import type { AssuranceOffer } from '../signing/useAssuranceOffer'
import type { Assurance } from '../../contracts/bim/signing/client'

export type Answer = 'accepted' | 'refused' | 'no_cost'

const WORDS: Readonly<Record<Answer, { readonly title: string; readonly action: string; readonly reasonLabel: string }>> = {
  accepted: { title: 'Accept this change order?', action: 'Accept', reasonLabel: 'Why you accept it' },
  refused: { title: 'Refuse this change order?', action: 'Refuse', reasonLabel: 'Why you refuse it' },
  no_cost: { title: 'Mark this change order no cost?', action: 'Mark no cost', reasonLabel: 'Why it costs nothing' },
}

/**
 * The addressed party's answer: accept, refuse or no cost, each with a
 * reason, and optionally the requirement it cites. The answer is final and
 * is recorded in the model's sign-off log. Esc and Cancel close it without
 * answering. With `signing`, the answer can also be signed with Touch ID or
 * verified with a one-time code (offered, never required: the plain button
 * records it).
 */
export function AnswerChangeOrderDialog({
  answer,
  title,
  onClose,
  onAnswer,
  signing,
}: {
  readonly answer: Answer | null
  readonly title: string
  readonly onClose: () => void
  readonly onAnswer: (input: { status: Answer; reason: string; citation?: string; assurance: Assurance | null }) => Promise<void>
  readonly signing?: AssuranceOffer
}) {
  const [reason, setReason] = useState('')
  const [citation, setCitation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const words = answer ? WORDS[answer] : null
  const blocked = reason.trim().length === 0 ? CHANGE_WORDS.reasonRequired : null

  async function confirm(assurance: Assurance | null) {
    if (!answer || blocked) return
    setSaving(true)
    setError(null)
    try {
      await onAnswer({ status: answer, reason: reason.trim(), ...(citation.trim() ? { citation: citation.trim() } : {}), assurance })
      setReason('')
      setCitation('')
      onClose()
    } catch (err) {
      console.error('[AnswerChangeOrderDialog] answering failed', err)
      setError(err instanceof Error ? err.message : "Couldn't record your answer. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={answer !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{words?.title}</DialogTitle>
          <DialogDescription>
            “{title}”. Your answer is final and is recorded in this model’s sign-off log with your name.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="co-answer-reason">{words?.reasonLabel}</FieldLabel>
            <Textarea id="co-answer-reason" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="co-answer-citation">Coordination requirement or specification section (optional)</FieldLabel>
            <Input id="co-answer-citation" value={citation} maxLength={500} onChange={(e) => setCitation(e.target.value)} placeholder="e.g. Spec 01 31 00, 1.4.B" />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          {signing && words ? <AssuranceButton offer={signing} busy={saving} blockedReason={blocked} onSecure={(a) => void confirm(a)} action={words.action} testId="change-order-answer-signed" /> : null}
          <Button variant={answer === 'refused' ? 'destructive' : 'default'} disabled={blocked !== null || saving} title={blocked ?? undefined} onClick={() => void confirm(null)}>
            {saving ? <Spinner aria-hidden /> : null}
            {words?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
