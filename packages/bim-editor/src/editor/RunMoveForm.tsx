'use client'

import { useState } from 'react'
import type { Command, RunFitting, RunSegment } from '@permitzip/bim-kernel'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Separator } from '../ui/separator'
import { feetInches } from './placement'
import { parseFeet } from './parse-feet'

const MM_PER_FT = 304.8

export { parseFeet } from './parse-feet'

/**
 * A riser's typed top height: its top end moves (the run above rides with it);
 * the rise gets taller or shorter.
 */
export function RunTopHeightForm({ element: el, canEdit, onCommand }: { element: RunSegment; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const topEnd = el.end.z >= el.start.z ? 'end' : 'start'
  const top = Math.max(el.start.z, el.end.z)
  const [value, setValue] = useState(String(Math.round((top / MM_PER_FT) * 100) / 100))
  const [error, setError] = useState<string | null>(null)
  const id = `bm-run-top-${el.id}`
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ft = parseFeet(value)
    if (ft === null) {
      setError("Enter the new top height in feet, like 14 or 13'6\".")
      return
    }
    const dz = ft * MM_PER_FT - top
    if (Math.abs(dz) < 1) {
      setError(`The top is already at ${feetInches(top)}.`)
      return
    }
    setError(onCommand({ type: 'drag_run', elementId: el.id, delta: { x: 0, y: 0, z: Math.round(dz * 1000) / 1000 }, grip: topEnd }))
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="run-top-height">
      <Separator />
      <Field>
        <FieldLabel htmlFor={id}>Top height (ft)</FieldLabel>
        <Input id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit} />
      </Field>
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="run-top-height-error">
          {error}
        </FieldDescription>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={!canEdit} title={canEdit ? undefined : "Live editing isn't connected, so changes can't be saved"}>
        Set top height
      </Button>
      <FieldDescription>The rise gets taller or shorter; the run above it moves with its top.</FieldDescription>
    </form>
  )
}

/**
 * A typed move for a level piece or an elbow: east, north and up in feet, any
 * of them alone or together, as one `drag_run` (one undo step), the same
 * command a drag in the view sends. Neighbours stretch; risers attached to it
 * stretch; a leg pulled back past its elbow flips it, as dragging does.
 */
export function RunMoveForm({ element: el, canEdit, onCommand }: { element: RunSegment | RunFitting; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const [east, setEast] = useState('')
  const [north, setNorth] = useState('')
  const [up, setUp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = `bm-run-move-${el.id}`
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const read = (text: string) => (text.trim() === '' ? 0 : parseFeet(text))
    const x = read(east)
    const y = read(north)
    const z = read(up)
    if (x === null || y === null || z === null) {
      setError("Enter feet, like 2, -1.5 or 2'6\". East, north and up are positive; west, south and down negative.")
      return
    }
    if (Math.abs(x) < 0.001 && Math.abs(y) < 0.001 && Math.abs(z) < 0.001) {
      setError('Enter a distance east, north or up other than zero.')
      return
    }
    const mm = (ft: number) => Math.round(ft * MM_PER_FT * 1000) / 1000
    const plain: Command = { type: 'drag_run', elementId: el.id, delta: { x: mm(x), y: mm(y), z: mm(z) } }
    const refused = onCommand(plain)
    // Only a plan move can be pulled back past an elbow; a rise alone has no other way to go.
    const flipped = refused && (Math.abs(x) >= 0.001 || Math.abs(y) >= 0.001) ? onCommand({ ...plain, reroute: true }) : refused
    setError(refused && flipped ? flipped : null)
    if (!refused || !flipped) {
      setEast('')
      setNorth('')
      setUp('')
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="run-move">
      <Separator />
      <div className="grid grid-cols-3 gap-2">
        <Field>
          <FieldLabel htmlFor={`${id}-e`}>Move east (ft)</FieldLabel>
          <Input id={`${id}-e`} inputMode="decimal" value={east} placeholder="-2 is west" onChange={(e) => setEast(e.target.value)} disabled={!canEdit} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-n`}>Move north (ft)</FieldLabel>
          <Input id={`${id}-n`} inputMode="decimal" value={north} placeholder="-2 is south" onChange={(e) => setNorth(e.target.value)} disabled={!canEdit} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-u`}>Move up (ft)</FieldLabel>
          <Input id={`${id}-u`} inputMode="decimal" value={up} placeholder="-4 is down" onChange={(e) => setUp(e.target.value)} disabled={!canEdit} />
        </Field>
      </div>
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="run-move-error">
          {error}
        </FieldDescription>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={!canEdit} title={canEdit ? undefined : "Live editing isn't connected, so changes can't be saved"}>
        Move
      </Button>
      <FieldDescription>East, north or up alone, or up with either, in one step (east and north together is at an angle; move one way at a time). What it meets follows: risers stretch; past an elbow the elbow flips, as dragging does. Or drag it in the view; arrow keys nudge it.</FieldDescription>
    </form>
  )
}
