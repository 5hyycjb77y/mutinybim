'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { DISPOSITION_REASON_MIN } from '@permitzip/bim-kernel'
import type { BlockedApproval } from '@permitzip/bim-sheets'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Spinner } from '../../ui/spinner'
import { Textarea } from '../../ui/textarea'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { postOverrideFrom } from '../../contracts/bim/code-change/client'

type Step = { readonly step: 'write' } | { readonly step: 'confirm' } | { readonly step: 'saving' } | { readonly step: 'error'; readonly message: string }

/**
 * "Override with a reason" (round 10, C10): the signer says why their
 * approval still holds under the code the project uses now. Two steps: write
 * the reason, then confirm it goes into the sign-off log where reviewers read
 * it. Esc and Cancel close it at any step; nothing is recorded until the
 * second step. The server allows only the approval's own signer.
 */
export function OverrideDialog({
  projectId,
  approval,
  open,
  onOpenChange,
  onRecorded,
}: {
  readonly projectId: string
  readonly approval: BlockedApproval | null
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onRecorded: (seq: number) => void
}) {
  const codeChange = useEditorHost().data.codeChange
  const [reason, setReason] = useState('')
  const [step, setStep] = useState<Step>({ step: 'write' })

  const close = () => {
    setReason('')
    setStep({ step: 'write' })
    onOpenChange(false)
  }

  const tooShort = reason.trim().length < DISPOSITION_REASON_MIN
  const save = async () => {
    if (!approval) return
    setStep({ step: 'saving' })
    try {
      const out = await postOverrideFrom(codeChange, projectId, { recordId: approval.recordId, sourceVersion: approval.sourceVersion, reason: reason.trim() })
      toast.success('Override recorded. You can sign it from the sign-off log.')
      onRecorded(out.seq)
      close()
    } catch (err) {
      console.error('[OverrideDialog] recording the override failed', { recordId: approval.recordId, err })
      setStep({ step: 'error', message: err instanceof Error ? err.message : 'The override wasn’t recorded.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : step.step !== 'saving' && close())}>
      <DialogContent data-testid="override-dialog">
        <DialogHeader>
          <DialogTitle>Override with a reason</DialogTitle>
          <DialogDescription>
            {approval ? `${approval.sheetNumber}: ${approval.words}` : null}
          </DialogDescription>
        </DialogHeader>
        {step.step === 'confirm' || step.step === 'saving' ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="override-confirm">
            <p>Record this override in the sign-off log? Reviewers will read your reason, and the sheet can be issued again.</p>
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{reason.trim()}</blockquote>
          </div>
        ) : (
          <Field>
            <FieldLabel htmlFor="override-reason">Why does your approval still hold?</FieldLabel>
            <Textarea id="override-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} placeholder="The requirement reads the same in the new edition; I checked the threshold by hand." />
            <FieldDescription>{tooShort ? 'Say why in a sentence; reviewers will read it.' : 'Reviewers will see this beside your approval.'}</FieldDescription>
          </Field>
        )}
        {step.step === 'error' ? (
          <Alert variant="destructive" data-testid="override-error">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {step.message}
              <Button size="xs" variant="outline" onClick={() => void save()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => (step.step === 'confirm' ? setStep({ step: 'write' }) : close())} disabled={step.step === 'saving'}>
            {step.step === 'confirm' ? 'Back' : 'Cancel'}
          </Button>
          {step.step === 'write' || step.step === 'error' ? (
            <Button onClick={() => setStep({ step: 'confirm' })} disabled={tooShort} title={tooShort ? 'Say why in a sentence first.' : undefined} data-testid="override-next">
              Continue
            </Button>
          ) : (
            <Button onClick={() => void save()} disabled={step.step === 'saving'} data-testid="override-record">
              {step.step === 'saving' ? <Spinner data-icon="inline-start" /> : null}
              Record override
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
