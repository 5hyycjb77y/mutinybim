'use client'

import { useMemo, useState } from 'react'
import { Pencil, Plus, Trash2, Zap } from 'lucide-react'
import type { Command, ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../../ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { newElementId } from '../placement'
import { EstimateCountingField } from '../loads-policy/EstimateCountingField'
import { SpaceLoadsSections } from '../contributions/space-loads-sections'
import {
  addLoadCommand,
  editLoadCommand,
  figuresLine,
  libraryDensity,
  LOAD_QUANTITIES,
  loadQuantity,
  policyWords,
  removeLoadCommand,
  scopeFigures,
  scopeLoads,
  type LoadBasisChoice,
  type LoadDraft,
  type LoadQuantityId,
  type LoadScope,
  type ScopeLoadRow,
} from './space-loads'

interface Props {
  /** The space or zone whose loads are open; null when closed. */
  readonly scope: LoadScope | null
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly onClose: () => void
  /** The project the model belongs to (add-ons' Loads sections read its tables); null or absent: none. */
  readonly projectId?: string | null
}

const BLANK: LoadDraft = { name: 'Lighting', quantityId: 'power', basis: 'lump', amount: '' }
const trimNumber = (v: number) => String(Math.round(v * 1000) / 1000)

/**
 * Loads on a space or zone (the product owner's decision 4): add a total ("Lighting 5 kW")
 * or a density ("1.5 W/ft²", from the space-use library), see the estimate
 * against the devices placed so far, change or remove each one. Every edit
 * goes through the one edit path with Undo; Esc closes with nothing changed.
 */
export function SpaceLoadsDialog({ scope, model, canEdit, blockedReason, submit, onClose, projectId }: Props) {
  const [draft, setDraft] = useState<LoadDraft>(BLANK)
  const [editing, setEditing] = useState<ScopeLoadRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ScopeLoadRow | null>(null)

  const rows = useMemo(() => (scope ? scopeLoads(model, scope) : []), [model, scope])
  const figures = useMemo(() => (scope ? scopeFigures(model, scope) : null), [model, scope])
  const q = loadQuantity(draft.quantityId)
  const library = scope && draft.basis === 'density' ? libraryDensity(model, scope, q, draft.name) : null
  const editReason = canEdit ? null : blockedReason
  const densityReason = q.density ? null : `${q.label} loads are typed as a total, not per square foot.`

  const reset = () => {
    setDraft(BLANK)
    setEditing(null)
    setNotice(null)
  }
  const close = () => {
    reset()
    setRemoving(null)
    onClose()
  }

  const setBasis = (basis: LoadBasisChoice) => {
    if (basis === 'density' && scope) {
      const lib = libraryDensity(model, scope, q, draft.name)
      setDraft((d) => ({ ...d, basis, amount: typeof lib === 'string' ? '' : trimNumber(lib.typed) }))
    } else setDraft((d) => ({ ...d, basis, amount: '' }))
  }
  const setQuantity = (quantityId: LoadQuantityId) => {
    const next = loadQuantity(quantityId)
    setDraft((d) => ({ ...d, quantityId, basis: next.density ? d.basis : 'lump', amount: '' }))
  }

  const save = () => {
    if (!scope) return
    if (editing) {
      const command = editLoadCommand(editing, draft)
      if (command === null) {
        reset()
        return
      }
      if (typeof command === 'string') {
        setNotice(command)
        return
      }
      const refused = submit(command, `Change ${editing.name}`)
      if (refused) setNotice(refused)
      else reset()
      return
    }
    const command = addLoadCommand(scope, draft, newElementId('load'))
    if (typeof command === 'string') {
      setNotice(command)
      return
    }
    const refused = submit(command, `Add ${draft.name.trim()} to ${scope.label}`)
    if (refused) setNotice(refused)
    else reset()
  }

  const startEdit = (row: ScopeLoadRow) => {
    setEditing(row)
    setNotice(null)
    setDraft({ name: row.name, quantityId: row.quantity.id, basis: row.basis, amount: trimNumber(row.typed) })
  }

  const unit = draft.basis === 'density' ? q.density?.label ?? q.lump.label : q.lump.label

  return (
    <>
      <Dialog open={scope !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-xl" data-testid="space-loads-dialog">
          <DialogHeader>
            <DialogTitle>Loads on {scope?.label}</DialogTitle>
            <DialogDescription>{policyWords(model)}</DialogDescription>
          </DialogHeader>
          {scope?.kind === 'space' && (
            <EstimateCountingField model={model} spaceId={scope.id} canEdit={canEdit} blockedReason={blockedReason} submit={submit} />
          )}

          <p className="text-sm" data-testid="space-loads-figures">
            {figures ? figuresLine(figures) : 'No estimate yet. Add the loads you know now; devices placed inside later count against them.'}
            {figures && scope?.kind === 'zone' ? <span className="block text-xs text-muted-foreground">Includes the loads on the zone’s spaces; the list below is the zone’s own.</span> : null}
          </p>
          {scope?.kind === 'space' ? <SpaceLoadsSections model={model} spaceId={scope.id} projectId={projectId ?? null} /> : null}

          {rows.length === 0 ? (
            <Empty className="border py-4" data-testid="space-loads-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Zap />
                </EmptyMedia>
                <EmptyTitle>No loads on {scope?.label} yet</EmptyTitle>
                <EmptyDescription>Type a total such as lighting 5 kW, or a density per square foot from the space’s use.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table data-testid="space-loads-table">
              <TableCaption className="sr-only">Loads spread over {scope?.label}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Load</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} data-testid="space-load-row" data-load={r.id} data-selected={editing?.id === r.id}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{r.text}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button variant="ghost" size="icon-sm" aria-label={`Change ${r.name}`} title={editReason ?? undefined} disabled={editReason !== null} onClick={() => startEdit(r)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${r.name}`} title={editReason ?? undefined} disabled={editReason !== null} onClick={() => setRemoving(r)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <FieldGroup className="gap-3 border-t pt-3">
            <h3 className="text-sm font-medium">{editing ? `Change ${editing.name}` : 'Add a load'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="space-load-name">Name</FieldLabel>
                <Input id="space-load-name" value={draft.name} maxLength={40} disabled={editReason !== null} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} data-testid="space-load-name" />
              </Field>
              <Field>
                <FieldLabel htmlFor="space-load-quantity">Kind</FieldLabel>
                <Select value={draft.quantityId} disabled={editReason !== null || editing !== null} onValueChange={(v) => setQuantity(LOAD_QUANTITIES.find((x) => x.id === v)?.id ?? 'power')}>
                  <SelectTrigger id="space-load-quantity" aria-label="Kind of load" title={editing ? 'To change the kind, remove this load and add another.' : editReason ?? undefined} data-testid="space-load-quantity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {LOAD_QUANTITIES.map((x) => (
                        <SelectItem key={x.id} value={x.id}>
                          {x.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>Typed as</FieldLabel>
              <ToggleGroup type="single" size="sm" variant="outline" value={draft.basis} disabled={editReason !== null} onValueChange={(v) => (v === 'lump' || v === 'density') && setBasis(v)} aria-label="Typed as a total or per square foot" data-testid="space-load-basis">
                <ToggleGroupItem value="lump">Total</ToggleGroupItem>
                <ToggleGroupItem value="density" disabled={densityReason !== null} title={densityReason ?? `Per square foot of the ${scope?.kind ?? 'space'}’s drawn area`}>
                  Per sq ft
                </ToggleGroupItem>
              </ToggleGroup>
              {densityReason ? <FieldDescription>{densityReason}</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="space-load-amount">Amount</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="space-load-amount"
                  inputMode="decimal"
                  value={draft.amount}
                  disabled={editReason !== null}
                  onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                  data-testid="space-load-amount"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{unit}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              {draft.basis === 'density' && library ? (
                <FieldDescription data-testid="space-load-library">{typeof library === 'string' ? library : `From the space-use library: ${trimNumber(library.typed)} ${unit} (${library.source}).`}</FieldDescription>
              ) : draft.quantityId === 'power' && draft.basis === 'lump' ? (
                <FieldDescription>Counted as volt-amperes at unity power factor: 1 kW = 1,000 VA.</FieldDescription>
              ) : null}
            </Field>
            {notice ? (
              <Alert variant="destructive" data-testid="space-loads-notice">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}
            {editReason ? <p className="text-xs text-muted-foreground" data-testid="space-loads-edit-reason">{editReason}</p> : null}
          </FieldGroup>

          <DialogFooter>
            {editing ? (
              <Button variant="outline" onClick={reset}>
                Cancel change
              </Button>
            ) : (
              <Button variant="outline" onClick={close}>
                Close
              </Button>
            )}
            <Button onClick={save} disabled={editReason !== null} title={editReason ?? undefined} data-testid="space-load-save">
              {editing ? null : <Plus data-icon="inline-start" />}
              {editing ? 'Save change' : 'Add load'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name} from {scope?.label}?</AlertDialogTitle>
            <AlertDialogDescription>The estimate comes off the {scope?.kind ?? 'space'} and out of every total. Devices already placed stay. Undo puts it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing && scope) {
                  const refused = submit(removeLoadCommand(removing), `Remove ${removing.name} from ${scope.label}`)
                  setNotice(refused)
                  if (!refused && editing?.id === removing.id) reset()
                }
                setRemoving(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
