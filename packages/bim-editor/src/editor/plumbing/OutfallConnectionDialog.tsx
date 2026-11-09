'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, Crosshair, Wrench } from 'lucide-react'
import { asElementId, type ModelState } from '@permitzip/bim-kernel'
import { OUTFALL_CONNECTION_WORDS, outfallConnectionChoices, routedSegmentsOf, outfallConnectionCommands, outfallFixCommand, outfallWalk, type OutfallConnectionPlan, type OutfallWalkFinding } from '@permitzip/bim-pack-plumbing'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Label } from '../../ui/label'
import { RadioGroup, RadioGroupItem } from '../../ui/radio-group'
import { newId, type SubmitCommand } from '../views-sheets/types'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly model: ModelState
  /** The selected building drain (the pipe whose end leaves the building). */
  readonly drainId: string
  /** Null when this person may edit; otherwise why not, in words. */
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
  readonly select: (ids: readonly string[]) => void
}

const MM_PER_FT = 304.8
const NEW = 'new'

/** Feet typed by a person, as mm above project zero; null when blank, undefined when not a number. */
function feetToMm(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v * MM_PER_FT : undefined
}

/**
 * Systems › the outfall connection: take the selected building drain to
 * a manhole (one in the model, or a new one with its invert and rim), then
 * walk the drawn drain to it and list what's wrong, each with Select and its
 * Fix. Every step is one undoable command.
 */
export function OutfallConnectionDialog({ open, onOpenChange, model, drainId, editBlocked, submit, select }: Props) {
  const choices = useMemo(() => outfallConnectionChoices(model), [model])
  const [picked, setPicked] = useState<string>(choices[0]?.id ?? NEW)
  const [mark, setMark] = useState('MH-1')
  const [invert, setInvert] = useState('')
  const [rim, setRim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ readonly prefix: string; readonly next: NonNullable<OutfallConnectionPlan['next']> } | null>(null)
  const [walkedFrom, setWalkedFrom] = useState<string | null>(null)

  const routedOn = pending !== null && routedSegmentsOf(model, pending.prefix).length > 0

  const placeManhole = () => {
    if (!pending) return
    const next = pending.next(model)
    if ('refused' in next) {
      setError(next.refused)
      return
    }
    for (const c of next) {
      const refusal = submit(c, OUTFALL_CONNECTION_WORDS.joinUndo)
      if (refusal) {
        setError(refusal)
        return
      }
    }
    setPending(null)
    setWalkedFrom(drainId)
  }

  const walk = walkedFrom ? outfallWalk(model, asElementId(walkedFrom)) : null
  const invertMm = feetToMm(invert)
  const rimMm = feetToMm(rim)
  const badNumber = picked === NEW && (invertMm === undefined || rimMm === undefined) ? 'Type the invert and rim in feet above project zero (for example -8.5), or leave them blank to add later.' : null
  const blocked = editBlocked ?? badNumber ?? (picked === NEW && mark.trim() === '' ? 'Give the manhole a mark (MH-1).' : null)

  const connect = () => {
    setError(null)
    const prefix = newId('outfall')
    const plan = outfallConnectionCommands(model, drainId, picked === NEW ? { kind: 'new', partId: newId('mh'), mark: mark.trim(), invertMm: invertMm ?? null, rimMm: rimMm ?? null } : { kind: 'existing', manholeId: asElementId(picked) }, prefix)
    if ('refused' in plan) {
      setError(plan.refused)
      return
    }
    for (const c of plan.first) {
      const refusal = submit(c, OUTFALL_CONNECTION_WORDS.routeUndo)
      if (refusal) {
        setError(refusal)
        return
      }
    }
    if (plan.next) setPending({ prefix, next: plan.next })
    else setWalkedFrom(drainId)
  }

  const fix = (f: OutfallWalkFinding) => {
    if (!f.fix) return
    const cmd = outfallFixCommand(model, f.fix, newId(f.fix.places === 'ejector' ? 'ejector' : 'bwv'))
    const refusal = 'refused' in cmd ? cmd.refused : submit(cmd, f.fix.label.toLowerCase())
    setError(refusal)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="outfall-connection-dialog">
        <DialogHeader>
          <DialogTitle>{OUTFALL_CONNECTION_WORDS.title}</DialogTitle>
          <DialogDescription>{OUTFALL_CONNECTION_WORDS.intro}</DialogDescription>
        </DialogHeader>

        {walk === null ? (
          <div className="flex flex-col gap-4">
            <RadioGroup value={picked} onValueChange={setPicked} aria-label="Manhole">
              {choices.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <RadioGroupItem value={c.id} id={`outfall-${c.id}`} />
                  <Label htmlFor={`outfall-${c.id}`}>
                    {c.label}
                    {c.invertMm !== null ? `, invert ${(c.invertMm / MM_PER_FT).toFixed(2)} ft` : ', no invert yet'}
                  </Label>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <RadioGroupItem value={NEW} id="outfall-new" />
                <Label htmlFor="outfall-new">A new manhole</Label>
              </div>
            </RadioGroup>
            {picked === NEW && (
              <div className="grid grid-cols-3 gap-3">
                <Field>
                  <FieldLabel htmlFor="outfall-mark">Mark</FieldLabel>
                  <Input id="outfall-mark" value={mark} onChange={(e) => setMark(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="outfall-invert">Invert (ft)</FieldLabel>
                  <Input id="outfall-invert" inputMode="decimal" value={invert} onChange={(e) => setInvert(e.target.value)} placeholder="-8.5" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="outfall-rim">Rim (ft)</FieldLabel>
                  <Input id="outfall-rim" inputMode="decimal" value={rim} onChange={(e) => setRim(e.target.value)} placeholder="-2" />
                </Field>
                <FieldDescription className="col-span-3">Feet above project zero. Leave one blank and the check says what to add; it never guesses.</FieldDescription>
              </div>
            )}
          </div>
        ) : walk.findings.length === 0 ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>The drain reaches {walk.outfall?.label ?? 'the manhole'} by gravity</AlertTitle>
            <AlertDescription>No backwater valve is needed for the floors it serves.</AlertDescription>
          </Alert>
        ) : (
          <ItemGroup data-testid="outfall-walk-findings">
            {walk.findings.map((f) => (
              <Item key={`${f.code}-${f.message}`} variant="outline">
                <ItemContent>
                  <ItemTitle>{f.message}</ItemTitle>
                  {f.fix && <ItemDescription>{f.fix.label} places the starter part on that pipe; connect it there.</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Button size="sm" variant="outline" onClick={() => select(f.selectIds)}>
                    <Crosshair />
                    Select
                  </Button>
                  {f.fix && (
                    <Button size="sm" onClick={() => fix(f)} disabled={editBlocked !== null} title={editBlocked ?? undefined}>
                      <Wrench />
                      {f.fix.label}
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}

        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>That didn&apos;t go through</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {walk ? 'Done' : 'Cancel'}
          </Button>
          {walk === null && pending === null && (
            <Button onClick={connect} disabled={blocked !== null} title={blocked ?? undefined}>
              Connect and check
            </Button>
          )}
          {walk === null && pending !== null && (
            <Button onClick={placeManhole} disabled={!routedOn || editBlocked !== null} title={routedOn ? (editBlocked ?? undefined) : 'Routing the drain on…'}>
              {routedOn ? `Place ${mark.trim()} and check` : 'Routing the drain on…'}
            </Button>
          )}
        </DialogFooter>
        {walk === null && blocked && <p className="text-muted-foreground text-sm">{blocked}</p>}
      </DialogContent>
    </Dialog>
  )
}
