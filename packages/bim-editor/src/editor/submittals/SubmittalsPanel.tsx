'use client'

import { useMemo, useState } from 'react'
import { FilePlus2, FileStack, RefreshCw } from 'lucide-react'
import { isSubmittalRecord, SUBMITTAL_REVIEW_LABELS, SUBMITTAL_REVIEW_STATES, type ElementId, type ModelState, type SubmittalCommand } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Skeleton } from '../../ui/skeleton'
import { Textarea } from '../../ui/textarea'
import { submittalRows, type SubmittalItemRow, type SubmittalRow } from './submittal-rows'

export interface SubmittalsPanelProps {
  readonly model: ModelState | null
  readonly error?: string | null
  readonly onRetry?: () => void
  readonly canEdit: boolean
  readonly blockedReason: string
  /** The session's one edit path: the model's refusal in words, or null. */
  readonly submit: (command: SubmittalCommand, undoLabel: string) => string | null
  readonly selection: readonly ElementId[]
  readonly selectionLabel: string
}

type Reviewable = (typeof SUBMITTAL_REVIEW_STATES)[number]

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Building Model › rail › Submittals: product data and shop drawings offered
 * for elements or a type, reviewed item by item, beside the design. An
 * approved substitution is recorded as a difference from the design; the
 * design itself changes only through a branch (the element's Inspector badge
 * offers "Update design to match"). No dates, no prices.
 */
export function SubmittalsPanel({ model, error, onRetry, canEdit, blockedReason, submit, selection, selectionLabel }: SubmittalsPanelProps) {
  const rows = useMemo(() => (model ? submittalRows(model) : []), [model])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState('')
  const [substituting, setSubstituting] = useState<{ readonly row: SubmittalRow; readonly item: SubmittalItemRow } | null>(null)
  const [product, setProduct] = useState('')
  const [notes, setNotes] = useState('')
  const [responsible, setResponsible] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  const editReason = canEdit ? null : blockedReason
  const newReason = editReason ?? (selection.length === 0 ? 'Select the elements (or one of the type) the submittal is for first.' : null)

  const send = (command: SubmittalCommand, label: string): boolean => {
    const refused = submit(command, label)
    setRefusal(refused)
    return refused === null
  }

  const closeNew = () => {
    setCreating(false)
    setTitle('')
    setItems('')
    setRefusal(null)
  }
  const closeSub = () => {
    setSubstituting(null)
    setProduct('')
    setNotes('')
    setResponsible('')
    setRefusal(null)
  }

  const saveNew = () => {
    const lines = items.split('\n').map((l) => l.trim()).filter(Boolean)
    const list = (lines.length > 0 ? lines : ['Product data']).map((label, i) => ({ id: String(i + 1), label }))
    if (send({ type: 'add_submittal', submittalId: newId('sub'), title: title.trim(), offeredFor: { elementIds: [...selection] }, items: list }, 'New submittal')) closeNew()
  }

  const saveSub = () => {
    if (!substituting || !model) return
    const s: { readonly kind: string } | undefined = model.elements[substituting.row.id]
    const basis = isSubmittalRecord(s) ? s.submittal.offeredFor : null
    const ok = send(
      {
        type: 'record_divergence',
        divergenceId: newId('div'),
        designBasis: { ...(basis?.elementIds?.length ? { elementIds: [...basis.elementIds] } : {}), ...(basis?.typeIds?.length ? { typeIds: [...basis.typeIds] } : {}) },
        approvedProduct: { label: product.trim(), submittalId: substituting.row.id, itemId: substituting.item.id },
        notes: notes.trim(),
        ...(responsible.trim() ? { responsibleParty: { label: responsible.trim() } } : {}),
      },
      'Record approved substitution',
    )
    if (ok) closeSub()
  }

  if (error)
    return (
      <Alert variant="destructive" data-testid="submittals-error">
        <AlertTitle>The submittals didn’t load</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{error}</span>
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw data-icon="inline-start" />
              Try again
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    )
  if (!model)
    return (
      <section aria-label="Submittals" aria-busy="true" className="flex flex-col gap-2" data-testid="submittals-panel">
        <span className="sr-only">Loading the submittals</span>
        <Skeleton className="h-8" />
      </section>
    )

  return (
    <section aria-label="Submittals" className="flex min-w-0 flex-col gap-2" data-testid="submittals-panel">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <FileStack className="size-4" /> Submittals
      </h3>
      <Button size="sm" className="self-start" onClick={() => setCreating(true)} disabled={newReason !== null} title={newReason ?? `New submittal for ${selectionLabel}`} data-testid="submittals-new">
        <FilePlus2 data-icon="inline-start" />
        New submittal
      </Button>
      {editReason ? <p className="text-xs text-muted-foreground">{editReason}</p> : null}
      {refusal && !creating && !substituting ? (
        <Alert variant="destructive" data-testid="submittals-refusal">
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      ) : null}
      {rows.length === 0 ? (
        <Empty className="border" data-testid="submittals-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileStack />
            </EmptyMedia>
            <EmptyTitle>No submittals yet</EmptyTitle>
            <EmptyDescription>Select what a submittal is for on the plan, then New submittal. Each item is reviewed on its own; the design stays as it is.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {rows.map((r) => (
            <Item key={r.id} variant="outline" size="sm" data-testid="submittals-row" data-submittal={r.id}>
              <ItemContent className="min-w-0">
                <ItemTitle className="flex flex-wrap items-center gap-2">
                  {r.title}
                  <Badge variant="outline">Rev {r.revision}</Badge>
                </ItemTitle>
                <ItemDescription>
                  {r.about ? `For ${r.about}` : 'For a type or requirement'}
                  {r.submittedBy ? ` · from ${r.submittedBy}` : ''}
                </ItemDescription>
                <ul className="mt-1 flex flex-col gap-1">
                  {r.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="submittals-item" data-item={i.id}>
                      <span className="min-w-0 flex-1">{i.label}</span>
                      <Select
                        value={i.state === 'pending' || SUBMITTAL_REVIEW_STATES.some((s) => s === i.state) ? i.state : undefined}
                        onValueChange={(v) => {
                          const state = SUBMITTAL_REVIEW_STATES.find((s) => s === v)
                          if (state) send({ type: 'review_submittal', submittalId: r.id, itemId: i.id, state }, `Review: ${SUBMITTAL_REVIEW_LABELS[state]}`)
                        }}
                        disabled={editReason !== null}
                      >
                        <SelectTrigger size="sm" className="w-44" aria-label={`Review of ${i.label}`} title={editReason ?? undefined} data-testid="submittals-item-review">
                          <SelectValue placeholder={i.stateLabel} />
                        </SelectTrigger>
                        <SelectContent>
                          {SUBMITTAL_REVIEW_STATES.map((s: Reviewable) => (
                            <SelectItem key={s} value={s}>
                              {SUBMITTAL_REVIEW_LABELS[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {i.substituted ? (
                        <Badge variant="secondary">Approved substitution</Badge>
                      ) : i.state === 'approved' || i.state === 'approved_as_noted' ? (
                        <Button size="sm" variant="ghost" onClick={() => setSubstituting({ row: r, item: i })} disabled={editReason !== null} title={editReason ?? 'Record that the approved product differs from the design. The design is not changed.'} data-testid="submittals-substitution">
                          It differs from the design
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}

      <Dialog open={creating} onOpenChange={(next) => !next && closeNew()}>
        <DialogContent data-testid="submittals-new-dialog">
          <DialogHeader>
            <DialogTitle>New submittal</DialogTitle>
            <DialogDescription>For {selectionLabel || 'the selection'}. Files stay in the project&apos;s files; this records what was offered and how each item is reviewed.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="submittal-title">Title</FieldLabel>
            <Input id="submittal-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Rooftop unit product data" data-testid="submittals-new-title" />
          </Field>
          <Field>
            <FieldLabel htmlFor="submittal-items">Items, one per line</FieldLabel>
            <Textarea id="submittal-items" value={items} onChange={(e) => setItems(e.target.value)} placeholder={'Product data\nWiring diagram'} data-testid="submittals-new-items" />
            <FieldDescription>Each item is reviewed on its own. Empty: one item, product data.</FieldDescription>
          </Field>
          {refusal ? (
            <Alert variant="destructive">
              <AlertDescription>{refusal}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeNew}>
              Cancel
            </Button>
            <Button onClick={saveNew} disabled={title.trim() === ''} title={title.trim() === '' ? 'Give it a title first.' : undefined} data-testid="submittals-new-save">
              Save submittal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={substituting !== null} onOpenChange={(next) => !next && closeSub()}>
        <DialogContent data-testid="submittals-substitution-dialog">
          <DialogHeader>
            <DialogTitle>Approved substitution</DialogTitle>
            <DialogDescription>Records that the approved product differs from the design. The design is not changed; update it on purpose from the element&apos;s Inspector (it opens a branch).</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="substitution-product">Approved product</FieldLabel>
            <Input id="substitution-product" value={product} onChange={(e) => setProduct(e.target.value)} maxLength={200} placeholder="Alternate unit, maker B" data-testid="submittals-substitution-product" />
          </Field>
          <Field>
            <FieldLabel htmlFor="substitution-notes">Notes</FieldLabel>
            <Textarea id="substitution-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          <Field>
            <FieldLabel htmlFor="substitution-responsible">Who is responsible for this difference? (optional)</FieldLabel>
            <Input id="substitution-responsible" value={responsible} onChange={(e) => setResponsible(e.target.value)} maxLength={120} placeholder="Contractor" />
          </Field>
          {refusal ? (
            <Alert variant="destructive">
              <AlertDescription>{refusal}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeSub}>
              Cancel
            </Button>
            <Button onClick={saveSub} disabled={product.trim() === ''} title={product.trim() === '' ? 'Name the approved product first.' : undefined} data-testid="submittals-substitution-save">
              Record substitution
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
