'use client'

import { useMemo, useState } from 'react'
import type { BranchRef, ChangeTarget, ModelState } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Textarea } from '../../ui/textarea'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { openChangeOrderFrom, setChangeOrderStatusFrom } from '../../contracts/bim/change-orders/client'
import type { AddresseeOption } from '../../contracts/bim/change-orders/model'
import type { VersionEntry } from '../../contracts/building-model/branch-versions'
import type { BranchChannel } from '../branches/useBranches'
import { AddresseePicker } from './AddresseePicker'
import { QuantityDeltaList } from './QuantityDeltaList'
import { useQuantityDelta } from './useQuantityDelta'

const THIS_BRANCH = '__branch__'

export interface NewChangeOrderDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly projectId: string
  readonly modelId: string
  readonly model: ModelState | null
  readonly channel: BranchChannel | null
  /** Versions to start from (saved and issued); null while they load. */
  readonly versions: readonly VersionEntry[] | null
  /** Called with the new order's id once it is saved (and sent, if asked); `notice` says what didn't happen. */
  readonly onOpened: (id: string, notice?: string) => void
}

/**
 * New change order: everything changed since a version (or this branch
 * against Main), addressed to a contact or a company from the contact list.
 * Opening one is the only way a change order exists. "Save as draft" keeps
 * it on the project; "Send" also shows it to the party it is for. Esc and
 * Cancel close it without saving anything.
 */
export function NewChangeOrderDialog({ open, onOpenChange, projectId, modelId, model, channel, versions, onOpened }: NewChangeOrderDialogProps) {
  const changeOrders = useEditorHost().data.changeOrders
  const branch: BranchRef | null = channel?.branch() ?? null
  const head = model?.revision ?? null
  const choices = useMemo(() => (versions ?? []).filter((v) => v.kind !== 'now' && head !== null && v.revision < head), [versions, head])
  const [since, setSince] = useState<string>(branch ? THIS_BRANCH : '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [addressee, setAddressee] = useState<AddresseeOption | null>(null)
  const [saving, setSaving] = useState<'draft' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const target: ChangeTarget | null = useMemo(() => {
    if (since === THIS_BRANCH && branch && head !== null) return { kind: 'branch', modelId, branchId: branch.branchId, branchHead: head }
    const from = choices.find((v) => v.key === since)
    return from && head !== null ? { kind: 'version_range', modelId, fromRevision: from.revision, toRevision: head } : null
  }, [since, branch, head, choices, modelId])
  const { state: delta, retry } = useQuantityDelta(channel, model, open ? target : null)

  const blocked = !target ? 'Pick what the change order covers.' : !addressee ? 'Pick whom it is for.' : title.trim().length === 0 ? 'Give it a title.' : null

  async function save(send: boolean) {
    if (blocked || !target || !addressee) return
    setSaving(send ? 'send' : 'draft')
    setError(null)
    try {
      const digest = delta.status === 'ready' ? delta.read.digest : undefined
      const { id } = await openChangeOrderFrom(changeOrders, projectId, { target, title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), addressee: { kind: addressee.kind, id: addressee.id }, ...(digest ? { deltaDigest: digest } : {}) })
      if (send) {
        try {
          await setChangeOrderStatusFrom(changeOrders, projectId, id, { status: 'sent', ...(digest ? { deltaDigest: digest } : {}) })
        } catch (err) {
          console.error('[NewChangeOrderDialog] saved, but sending failed', err)
          onOpened(id, `Saved as a draft, but it wasn't sent: ${err instanceof Error ? err.message : 'press Send on the change order to try again.'}`)
          onOpenChange(false)
          return
        }
      }
      onOpened(id)
      onOpenChange(false)
    } catch (err) {
      console.error('[NewChangeOrderDialog] opening the change order failed', err)
      setError(err instanceof Error ? err.message : "Couldn't open the change order. Try again.")
    } finally {
      setSaving(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New change order</DialogTitle>
          <DialogDescription>A change order is separate from the design change. It has no price here; whoever it is for prices it with their own book.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="co-since">Covers</FieldLabel>
            <Select value={since} onValueChange={setSince}>
              <SelectTrigger id="co-since" aria-label="Covers">
                <SelectValue placeholder={versions === null ? 'Loading versions…' : 'Since version…'} />
              </SelectTrigger>
              <SelectContent>
                {branch ? <SelectItem value={THIS_BRANCH}>This branch ({branch.name}) against Main</SelectItem> : null}
                {choices.map((v) => (
                  <SelectItem key={v.key} value={v.key}>
                    Since {v.label} (version {v.revision})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {versions !== null && choices.length === 0 && !branch ? <FieldDescription>No saved version to start from yet. Save one in Manage › Versions, or open a branch.</FieldDescription> : null}
          </Field>
          {target ? <QuantityDeltaList state={delta} onRetry={retry} /> : null}
          <Field>
            <FieldLabel>Address to</FieldLabel>
            <AddresseePicker projectId={projectId} value={addressee} onChange={setAddressee} />
            <FieldDescription>Only they can accept it, refuse it or mark it no cost.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="co-title">Title</FieldLabel>
            <Input id="co-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Lobby ceiling raised to 12 ft" />
          </Field>
          <Field>
            <FieldLabel htmlFor="co-description">Description (optional)</FieldLabel>
            <Textarea id="co-description" value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="outline" disabled={blocked !== null || saving !== null} title={blocked ?? undefined} onClick={() => void save(false)}>
            {saving === 'draft' ? <Spinner aria-hidden /> : null}
            Save as draft
          </Button>
          <Button disabled={blocked !== null || saving !== null} title={blocked ?? undefined} onClick={() => void save(true)}>
            {saving === 'send' ? <Spinner aria-hidden /> : null}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
