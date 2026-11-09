'use client'

import { useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { loadsForRunEnd, type Command, type ModelState, type RunFitting, type RunSegment } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { openEndsForLoadPoint } from '../plumbing/PlaceLoadPoint'
import { PIPE_LOAD_ROW_LABEL, pipeLoadRowCommand } from './loads-list'

const END_LABEL: Readonly<Record<string, string>> = { start: 'Start', end: 'End', branch: 'Branch' }

/**
 * On a selected pipe with an open end: put one of the Loads list's rows there
 * (a fixture typed before anything was drawn). Only rows this pipe's system
 * carries are offered (cold water fixture units on cold water, drainage on
 * sanitary, gas input on gas). The row keeps its id, so the Loads list shows
 * it piped and the totals stay the same. Hidden when there is no open end or
 * no row to put there.
 */
export function PipeLoadRow({ model, element, canEdit, onCommand }: { readonly model: ModelState; readonly element: RunSegment | RunFitting; readonly canEdit: boolean; readonly onCommand: (command: Command) => string | null }) {
  const ends = element.domain === 'pipe' ? openEndsForLoadPoint(model, element) : []
  const system = model.elements[element.systemId]
  const rows = ends.length > 0 ? loadsForRunEnd(model.elements, system?.kind === 'mep_system' ? system.systemKind : null) : []
  const [loadId, setLoadId] = useState('')
  const [end, setEnd] = useState(ends[ends.length - 1] ?? '')
  const [error, setError] = useState<string | null>(null)
  if (rows.length === 0) return null
  const at = ends.includes(end) ? end : (ends[0] ?? '')
  const picked = rows.some((r) => r.id === loadId) ? loadId : ''
  const why = !canEdit ? "Live editing isn't connected, so nothing can be moved" : picked === '' ? 'Pick the row first' : null
  const id = `pipe-load-row-${element.id}`
  return (
    <div className="flex flex-col gap-2" data-testid="pipe-load-row">
      <Field>
        <FieldLabel htmlFor={id} className="text-xs">
          {PIPE_LOAD_ROW_LABEL}
        </FieldLabel>
        {ends.length > 1 && (
          <ToggleGroup type="single" size="sm" variant="outline" value={at} onValueChange={(v) => v && setEnd(v)} aria-label="Which open end">
            {ends.map((e) => (
              <ToggleGroupItem key={e} value={e} data-testid={`pipe-load-row-end-${e}`}>
                {END_LABEL[e] ?? e}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <Select value={picked} onValueChange={setLoadId} disabled={!canEdit}>
          <SelectTrigger id={id} size="sm" data-testid="pipe-load-row-pick">
            <SelectValue placeholder={`${rows.length} row${rows.length === 1 ? '' : 's'} not on a pipe yet`} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {rows.map((r) => (
                <SelectItem key={r.id} value={r.id} data-testid={`pipe-load-row-option-${r.id}`}>
                  {[r.mark || r.id, r.note || r.connectionType].filter(Boolean).join(' · ')}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription className="text-xs">The row moves onto the open {END_LABEL[at]?.toLowerCase() ?? at} and keeps its id: the pipe carries it, the Loads list shows it piped, and the totals don&apos;t change. Undo puts it back.</FieldDescription>
      </Field>
      {error && (
        <FieldDescription className="text-xs text-danger-600" role="alert" data-testid="pipe-load-row-error">
          {error}
        </FieldDescription>
      )}
      <Button size="sm" variant="outline" disabled={why !== null} title={why ?? undefined} data-testid="pipe-load-row-button" onClick={() => setError(onCommand(pipeLoadRowCommand(picked, element.id, at)))}>
        <ArrowDownToLine data-icon="inline-start" />
        Put on the pipe end
      </Button>
    </div>
  )
}
