'use client'

import { useState } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import { calloutHead, documentIndex, type CalloutSpec, type DrawingItem, type ModelState, type ViewElement } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

/** Views a callout can refer to: plans, sections and detail views, other than the one it is drawn in. */
export function calloutTargets(model: ModelState, ownerId: string): ViewElement[] {
  return documentIndex(model)
    .views.filter((v) => v.id !== ownerId && v.viewType !== 'schedule' && v.viewType !== 'three_d')
    .sort((a, b) => a.name.localeCompare(b.name))
}

function placedText(model: ModelState, view: ViewElement): string {
  const head = calloutHead(model, { viewId: view.id })
  return head.resolved ? `${view.name} (view ${head.top} on ${head.bottom})` : `${view.name} (not on a sheet yet)`
}

function ViewPicker({ model, ownerId, value, onChange, disabled }: { model: ModelState; ownerId: string; value: string; onChange: (viewId: string) => void; disabled?: boolean }) {
  const views = calloutTargets(model, ownerId)
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id="callout-view" size="sm" data-testid="callout-view-select">
        <SelectValue placeholder="Pick the enlarged view" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {views.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {placedText(model, v)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

interface DialogProps {
  readonly model: ModelState
  readonly ownerId: string
  readonly open: boolean
  readonly onCancel: () => void
  readonly onPlace: (spec: CalloutSpec) => void
}

/** After the box is dragged: which view the callout refers to, and an optional head label. Esc or Cancel saves nothing. */
export function CalloutViewDialog({ model, ownerId, open, onCancel, onPlace }: DialogProps) {
  const [viewId, setViewId] = useState('')
  const [label, setLabel] = useState('')
  const views = calloutTargets(model, ownerId)
  const picked = views.find((v) => v.id === viewId)
  const reason = views.length === 0 ? 'There is no other plan, section or detail view to refer to. Make the enlarged view first.' : !picked ? 'Pick the view this callout refers to.' : null
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent data-testid="callout-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Callout</DialogTitle>
          <DialogDescription>The head shows the view’s number and the sheet it is on, and updates when the view moves to another sheet.</DialogDescription>
        </DialogHeader>
        {views.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No view to refer to</EmptyTitle>
              <EmptyDescription>Make the enlarged plan or section first (Views → New view), then draw the callout again.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="callout-view">Refers to</FieldLabel>
              <ViewPicker model={model} ownerId={ownerId} value={viewId} onChange={setViewId} />
            </Field>
            <Field>
              <FieldLabel htmlFor="callout-label">Head label (optional)</FieldLabel>
              <Input id="callout-label" value={label} maxLength={12} placeholder="EEP" onChange={(e) => setLabel(e.target.value)} data-testid="callout-label" />
              <FieldDescription>Left empty, the head shows the view’s number on its sheet.</FieldDescription>
            </Field>
          </FieldGroup>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={reason !== null}
            title={reason ?? undefined}
            onClick={() => picked && onPlace({ viewId: picked.id, ...(label.trim() ? { label: label.trim() } : {}) })}
            data-testid="callout-place"
          >
            Place callout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface PropsPanel {
  readonly item: DrawingItem
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly onChange: (spec: CalloutSpec) => void
  readonly onOpenView: (viewId: string) => void
  readonly onDelete: () => void
}

/** A selected callout: what it refers to and what its head reads right now, with a way to go to that view. */
export function CalloutProperties({ item, model, canEdit, blockedReason, onChange, onOpenView, onDelete }: PropsPanel) {
  const spec = item.callout
  if (!spec) return null
  const head = calloutHead(model, spec)
  const target = model.elements[spec.viewId]
  return (
    <FieldGroup className="gap-3" data-testid="callout-properties">
      <Field>
        <FieldLabel>Head reads</FieldLabel>
        <p className="text-sm" data-testid="callout-head">
          {head.top} / {head.bottom}
        </p>
        <FieldDescription>{head.resolved ? `${head.viewName} is on sheet ${head.bottom}.` : head.viewName ? `${head.viewName} is on no sheet yet: the head shows — until it is placed.` : 'The view it referred to was deleted. Pick another.'}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="callout-view">Refers to</FieldLabel>
        <ViewPicker model={model} ownerId={item.ownerId} value={target?.kind === 'view' && !target.deleted ? spec.viewId : ''} onChange={(viewId) => onChange({ ...spec, viewId })} disabled={!canEdit} />
        {!canEdit && <FieldDescription>{blockedReason}</FieldDescription>}
      </Field>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={target?.kind !== 'view' || target.deleted === true} onClick={() => onOpenView(spec.viewId)} data-testid="callout-open-view">
          <ExternalLink data-icon="inline-start" />
          Open the view
        </Button>
        <Button variant="outline" size="sm" disabled={!canEdit} title={canEdit ? undefined : blockedReason} onClick={onDelete}>
          <Trash2 data-icon="inline-start" />
          Delete
        </Button>
      </div>
    </FieldGroup>
  )
}
