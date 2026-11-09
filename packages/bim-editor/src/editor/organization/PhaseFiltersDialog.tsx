'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { PHASE_DISPLAYS, PHASE_STATUSES, organizationOf, type ModelState, type PhaseStatus } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { newId, type SubmitCommand } from '../views-sheets/types'
import { PHASE_DISPLAY_LABEL, PHASE_STATUS_LABEL } from './labels'

interface Props {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
  readonly onClose: () => void
}

/** Phase filters: for each, how new, existing, demolished and temporary elements draw. */
export function PhaseFiltersDialog({ model, canEdit, blockedReason, submit, onClose }: Props) {
  const org = organizationOf(model)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const run = (refusal: string | null) => {
    setError(refusal)
    return refusal
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="phase-filters-dialog">
        <DialogHeader>
          <DialogTitle>Phase filters</DialogTitle>
          <DialogDescription>A view picks one filter. It decides how each element draws, by where it stands in the view&apos;s phase.</DialogDescription>
        </DialogHeader>
        {!canEdit && (
          <Alert>
            <AlertDescription>{blockedReason}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableCaption className="sr-only">How each phase filter draws new, existing, demolished and temporary elements</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Filter</TableHead>
              {PHASE_STATUSES.map((s) => (
                <TableHead key={s}>
                  <Tooltip>
                    <TooltipTrigger className="underline decoration-dotted underline-offset-2">{PHASE_STATUS_LABEL[s].label}</TooltipTrigger>
                    <TooltipContent>{PHASE_STATUS_LABEL[s].hint}</TooltipContent>
                  </Tooltip>
                </TableHead>
              ))}
              <TableHead className="w-10">
                <span className="sr-only">Delete</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {org.filters.map((f) => (
              <TableRow key={f.id} data-testid={`phase-filter-${f.id}`}>
                <TableCell>
                  <Input
                    key={`${f.id}:${f.entry.name}`}
                    aria-label="Filter name"
                    defaultValue={f.entry.name}
                    disabled={!canEdit}
                    className="h-8 min-w-36"
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const name = e.target.value.trim()
                      if (name && name !== f.entry.name) run(submit({ type: 'update_phase_filter', filterId: f.id, name }, `rename ${f.entry.name} to ${name}`))
                    }}
                  />
                </TableCell>
                {PHASE_STATUSES.map((s: PhaseStatus) => (
                  <TableCell key={s}>
                    <Select
                      value={f.entry.statuses[s]}
                      disabled={!canEdit}
                      onValueChange={(v) => {
                        const next = PHASE_DISPLAYS.find((x) => x === v)
                        if (next) run(submit({ type: 'update_phase_filter', filterId: f.id, statuses: { [s]: next } }, `${f.entry.name}: ${PHASE_STATUS_LABEL[s].label.toLowerCase()} as ${PHASE_DISPLAY_LABEL[next].toLowerCase()}`))
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={`${f.entry.name}: ${PHASE_STATUS_LABEL[s].label} elements`} data-testid={`phase-filter-${f.id}-${s}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {PHASE_DISPLAYS.map((d) => (
                            <SelectItem key={d} value={d}>
                              {PHASE_DISPLAY_LABEL[d]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                ))}
                <TableCell>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${f.entry.name}`} disabled={!canEdit || org.filters.length <= 1} onClick={() => run(submit({ type: 'delete_phase_filter', filterId: f.id }, `delete filter ${f.entry.name}`))}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const name = draft.trim()
            if (!name) return
            const refusal = run(submit({ type: 'create_phase_filter', filterId: newId('pf'), name, statuses: { new: 'show', existing: 'halftone', demolished: 'dashed', temporary: 'show' } }, `add filter ${name}`))
            if (!refusal) setDraft('')
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor="new-filter-name">New filter (starts like Show all)</FieldLabel>
            <Input id="new-filter-name" value={draft} placeholder="e.g. Demolition plan" disabled={!canEdit} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          <Button type="submit" disabled={!canEdit || draft.trim() === ''}>
            <Plus data-icon="inline-start" />
            Add filter
          </Button>
        </form>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
