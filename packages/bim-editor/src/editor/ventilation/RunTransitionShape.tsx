'use client'

import { useState } from 'react'
import { FlipVertical2 } from 'lucide-react'
import { fittingFamily, type Command, type RunFitting } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Separator } from '../../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'

const ECCENTRIC = 'duct.transition.eccentric'
const CONCENTRIC = 'duct.transition.concentric'
const RECT_ROUND = 'duct.transition.rect_round'
type Flat = 'top' | 'bottom' | 'left' | 'right'
const FLATS: readonly Flat[] = ['top', 'bottom', 'left', 'right']
const OPPOSITE: Readonly<Record<Flat, Flat>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"

const isFlat = (v: unknown): v is Flat => typeof v === 'string' && (FLATS as readonly string[]).includes(v)

/**
 * A duct transition's shape: concentric (every side slopes) or eccentric,
 * flat on one side so the top of duct stays level under structure (or the
 * bottom on a hanger line, or one side along a wall), and Mirror to put the
 * flat on the opposite side. Each change is one `swap_fitting`.
 */
export function RunTransitionShape({ fitting, canEdit, onCommand }: { fitting: RunFitting; canEdit: boolean; onCommand: (command: Command) => string | null }) {
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  if (fitting.fittingType !== 'transition' || fitting.domain !== 'duct') return null
  const [a, b] = fitting.ports
  const shapeChange = a && b ? a.size.shape !== b.size.shape : false
  const eccentric = fitting.family === ECCENTRIC
  const authoredFlat = fitting.params?.flat
  const flat: Flat = eccentric && isFlat(authoredFlat) ? authoredFlat : 'top'
  const name = fittingFamily(fitting.family ?? '')?.name ?? 'The system’s default transition'

  const send = (family: string, params: Record<string, string> | undefined, done: string) => {
    const err = onCommand({ type: 'swap_fitting', fittingId: fitting.id, family, ...(params ? { params } : {}) })
    setMessage(err ? { error: true, text: err } : { error: false, text: done })
  }
  const setFlat = (side: Flat) => send(ECCENTRIC, { flat: side }, `Flat on the ${side} now. Ctrl+Z undoes it.`)

  return (
    <div className="flex flex-col gap-2" data-testid="run-transition-shape">
      <Separator />
      <Field>
        <FieldLabel htmlFor="bm-transition-kind">Transition shape</FieldLabel>
        <FieldDescription>Now: {eccentric ? `${name}, flat on the ${flat}` : name}.</FieldDescription>
        <ToggleGroup
          id="bm-transition-kind"
          type="single"
          variant="outline"
          size="sm"
          value={eccentric ? 'eccentric' : 'concentric'}
          disabled={!canEdit}
          onValueChange={(v) => {
            if (v === 'eccentric' && !eccentric) setFlat('top')
            if (v === 'concentric' && eccentric) send(shapeChange ? RECT_ROUND : CONCENTRIC, undefined, 'Every side slopes now. Ctrl+Z undoes it.')
          }}
          aria-label="Transition shape"
        >
          <ToggleGroupItem value="concentric" data-testid="transition-concentric">
            {shapeChange ? 'Centred' : 'Concentric'}
          </ToggleGroupItem>
          <ToggleGroupItem value="eccentric" data-testid="transition-eccentric">
            Flat on one side
          </ToggleGroupItem>
        </ToggleGroup>
        {eccentric && (
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={flat} disabled={!canEdit} onValueChange={(v) => isFlat(v) && v !== flat && setFlat(v)} aria-label="Flat side">
              {FLATS.map((s) => (
                <ToggleGroupItem key={s} value={s} data-testid={`transition-flat-${s}`}>
                  {s[0]?.toUpperCase()}
                  {s.slice(1)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="sm" variant="outline" disabled={!canEdit} title={canEdit ? `Put the flat on the ${OPPOSITE[flat]}` : NOT_LIVE} onClick={() => setFlat(OPPOSITE[flat])} data-testid="transition-mirror">
              <FlipVertical2 data-icon="inline-start" />
              Mirror
            </Button>
          </div>
        )}
        {message && (
          <FieldDescription className={message.error ? 'text-danger-600' : 'text-success-700'} role={message.error ? 'alert' : 'status'} data-testid="transition-shape-message">
            {message.text}
          </FieldDescription>
        )}
        <FieldDescription>Left and right are as seen looking from the end that kept its size into the resized duct.</FieldDescription>
      </Field>
    </div>
  )
}
