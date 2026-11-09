'use client'

import { useState } from 'react'
import { CirclePlus } from 'lucide-react'
import { endHasLoadPoint, type Command, type ModelState, type RunFitting, type RunSegment } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { ConnectionTypeSelect } from '../connection-types/ConnectionTypeSelect'
import { tradeForSystem } from './LoadPointProperties'

/** The open ends (or a tap's open branch) of a run element that have no load point yet. */
export function openEndsForLoadPoint(model: ModelState, el: RunSegment | RunFitting): string[] {
  if (el.kind === 'run_segment') return (['start', 'end'] as const).filter((end) => !el.links[end] && !endHasLoadPoint(model.elements, el.id, end))
  return el.ports.filter((p) => !p.link && !endHasLoadPoint(model.elements, el.id, p.id)).map((p) => p.id)
}

const END_LABEL: Readonly<Record<string, string>> = { start: 'Start', end: 'End', branch: 'Branch' }

/**
 * "Place load point" on the selected pipe's open end: say what is connected
 * there (a connection type: P01 water closet, FD floor drain…) and the pipe
 * carries its load, with no fixture modelled. The same command as
 * bim_place_load_points.
 */
export function PlaceLoadPoint({ model, element, canEdit, onCommand }: { readonly model: ModelState; readonly element: RunSegment | RunFitting; readonly canEdit: boolean; readonly onCommand: (command: Command) => string | null }) {
  const ends = openEndsForLoadPoint(model, element)
  const [end, setEnd] = useState(ends[ends.length - 1] ?? '')
  const [type, setType] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (ends.length === 0) return null
  const system = model.elements[element.systemId]
  const trade = tradeForSystem(system?.kind === 'mep_system' ? system.systemKind : null, element.domain)
  const at = ends.includes(end) ? end : (ends[0] ?? '')
  const why = !canEdit ? "Live editing isn't connected, so nothing can be placed" : type === '' ? 'Pick what is connected there first' : null
  return (
    <div className="flex flex-col gap-2" data-testid="place-load-point">
      <Field>
        <FieldLabel htmlFor={`place-lp-${element.id}`} className="text-xs">
          Place load point
        </FieldLabel>
        {ends.length > 1 && (
          <ToggleGroup type="single" size="sm" variant="outline" value={at} onValueChange={(v) => v && setEnd(v)} aria-label="Which open end">
            {ends.map((e) => (
              <ToggleGroupItem key={e} value={e} data-testid={`place-load-point-end-${e}`}>
                {END_LABEL[e] ?? e}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <ConnectionTypeSelect model={model} trade={trade} id={`place-lp-${element.id}`} value={type} onChange={setType} disabled={!canEdit} testId="place-load-point-type" />
        <FieldDescription className="text-xs">What is connected at the open {END_LABEL[at]?.toLowerCase() ?? at}. The pipe then carries its load; a fixture can be attached later.</FieldDescription>
      </Field>
      {error && (
        <FieldDescription className="text-xs text-danger-600" role="alert" data-testid="place-load-point-error">
          {error}
        </FieldDescription>
      )}
      <Button size="sm" variant="outline" disabled={why !== null} title={why ?? undefined} data-testid="place-load-point-button" onClick={() => setError(onCommand({ type: 'create_load_point', points: [{ hostId: element.id, port: at, connectionType: type }] }))}>
        <CirclePlus data-icon="inline-start" />
        Place load point
      </Button>
    </div>
  )
}
