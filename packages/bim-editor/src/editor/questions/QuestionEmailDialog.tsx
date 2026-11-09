'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import type { ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Textarea } from '../../ui/textarea'
import { draftQuestionsEmail } from '../../contracts/bim/questions/draft-email'
import { audienceLabel, audiencesWithQuestions } from './question-rows'

interface Props {
  readonly open: boolean
  readonly model: ModelState
  readonly projectName: string
  readonly onClose: () => void
}

/**
 * The email listing what we still need from one party, drafted from the open
 * questions (answered, withdrawn and model-answered ones left out). Copy and
 * paste it; nothing is sent from here.
 */
export function QuestionEmailDialog({ open, model, projectName, onClose }: Props) {
  const parties = useMemo(() => audiencesWithQuestions(model), [model])
  const [picked, setPicked] = useState<string | null>(null)
  const [name, setName] = useState('')
  const askOf = picked !== null && parties.includes(picked) ? picked : (parties[0] ?? 'client')
  const draft = useMemo(() => draftQuestionsEmail(model, { askOf, projectName, ...(name.trim() ? { recipientName: name.trim() } : {}) }), [model, askOf, projectName, name])

  const copy = () => {
    if (draft.status !== 'draft') return
    navigator.clipboard
      .writeText(`Subject: ${draft.subject}\n\n${draft.body}`)
      .then(() => toast.success('Email copied. Paste it into a new message.'))
      .catch((err: unknown) => {
        console.error('[QuestionEmailDialog] copying the email failed', err)
        toast.error('Couldn’t copy: your browser blocked the clipboard. Select the text and copy it instead.')
      })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="questions-email-dialog">
        <DialogHeader>
          <DialogTitle>Email the open questions</DialogTitle>
          <DialogDescription>Only open questions and assumptions to confirm. Copy it into your email; nothing is sent from here.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-3">
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor="questions-email-to">To</FieldLabel>
            <Select value={askOf} onValueChange={setPicked} disabled={parties.length === 0}>
              <SelectTrigger id="questions-email-to" data-testid="questions-email-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(parties.length > 0 ? parties : ['client']).map((p) => (
                    <SelectItem key={p} value={p}>
                      {audienceLabel(p)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor="questions-email-name">Their name (optional)</FieldLabel>
            <Input id="questions-email-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana" maxLength={80} />
          </Field>
        </div>
        {draft.status === 'draft' ? (
          <Field>
            <FieldLabel htmlFor="questions-email-body">{draft.subject}</FieldLabel>
            <Textarea id="questions-email-body" readOnly value={draft.body} className="min-h-64 font-mono text-xs" data-testid="questions-email-body" />
            {draft.answeredByModel.length > 0 ? <FieldDescription>Left out because the model already answers them: {draft.answeredByModel.join('; ')}.</FieldDescription> : null}
          </Field>
        ) : (
          <Alert data-testid="questions-email-empty">
            <AlertDescription>{draft.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={copy} disabled={draft.status !== 'draft'} title={draft.status === 'draft' ? undefined : draft.message} data-testid="questions-email-copy">
            <Copy data-icon="inline-start" />
            Copy email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
