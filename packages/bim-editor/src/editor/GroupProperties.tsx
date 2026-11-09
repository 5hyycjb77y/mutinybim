'use client'

import { useState } from 'react'
import { Maximize, Move, Trash2 } from 'lucide-react'
import type { FittingChoice, RunSize, ScopeSummary } from '@permitzip/bim-kernel'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { MM_PER_IN } from './placement'
import { parseFeet } from './RunMoveForm'

const MM_PER_FT = 304.8

export interface GroupTotals {
  readonly summary: ScopeSummary
  readonly pressure: readonly { readonly system: string; readonly espInWc: number | null; readonly reason: string | null }[]
}

type Shape = 'rect' | 'round' | 'oval'
type TransitionPick = 'auto' | 'concentric' | 'eccentric_top' | 'eccentric_bottom' | 'eccentric_left' | 'eccentric_right' | 'rect_round'

const TRANSITIONS: readonly { value: TransitionPick; label: string }[] = [
  { value: 'auto', label: "The system's default" },
  { value: 'concentric', label: 'Concentric' },
  { value: 'eccentric_top', label: 'Eccentric, flat on top' },
  { value: 'eccentric_bottom', label: 'Eccentric, flat on bottom' },
  { value: 'eccentric_left', label: 'Eccentric, flat on the left' },
  { value: 'eccentric_right', label: 'Eccentric, flat on the right' },
  { value: 'rect_round', label: 'Rectangular-to-round' },
]

function transitionChoice(pick: TransitionPick): FittingChoice | undefined {
  switch (pick) {
    case 'auto':
      return undefined
    case 'concentric':
      return { family: 'duct.transition.concentric' }
    case 'eccentric_top':
      return { family: 'duct.transition.eccentric', params: { flat: 'top' } }
    case 'eccentric_bottom':
      return { family: 'duct.transition.eccentric', params: { flat: 'bottom' } }
    case 'eccentric_left':
      return { family: 'duct.transition.eccentric', params: { flat: 'left' } }
    case 'eccentric_right':
      return { family: 'duct.transition.eccentric', params: { flat: 'right' } }
    case 'rect_round':
      return { family: 'duct.transition.rect_round' }
  }
}

/** "2 straight pieces (the fitting follows)": what Resize changes, so a selection of 3 doesn't read as 2. */
export function resizeLabel(segments: number, fittings: number): string {
  const pieces = `${segments} straight piece${segments === 1 ? '' : 's'}`
  if (fittings === 0) return pieces
  return `${pieces} (the ${fittings === 1 ? 'fitting follows' : `${fittings} fittings follow`})`
}

const SCOPE_WORD: Readonly<Record<string, string>> = { stretch: 'Stretch', run: 'Run', branch: 'Branch', system: 'System', box: 'Box selection', element: 'Selection' }

interface Props {
  readonly scope: string
  readonly count: number
  readonly totals: GroupTotals | null
  readonly canEdit: boolean
  /** East / north in plan and up, mm, as one move. */
  readonly onMove: (deltaMm: { x: number; y: number }, upMm: number) => string | null
  readonly onResize: (size: RunSize, transition: FittingChoice | undefined) => string | null
  readonly onDelete: () => void
}

/** Properties of a run, branch, system or box selection: its totals, and Move / Resize / Delete for all of it at once. */
export function GroupProperties({ scope, count, totals, canEdit, onMove, onResize, onDelete }: Props) {
  const [dx, setDx] = useState('0')
  const [dy, setDy] = useState('0')
  const [dz, setDz] = useState('0')
  const [shape, setShape] = useState<Shape>('rect')
  const [w, setW] = useState('14')
  const [h, setH] = useState('10')
  const [d, setD] = useState('12')
  const [pipeIn, setPipeIn] = useState('2')
  const [transition, setTransition] = useState<TransitionPick>('auto')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const s = totals?.summary
  const isPipe = s?.domain === 'pipe'
  const isDuct = s?.domain === 'duct'
  const flowWord = isPipe ? 'Flow entering (the system\u2019s unit)' : 'Airflow entering'

  const run = (result: string | null, ok: string) => {
    setProblem(result)
    setDone(result ? null : ok)
  }

  const size = (): RunSize | string => {
    const n = (v: string) => Number(v)
    const mm = (inches: number) => Math.round(inches * MM_PER_IN * 1000) / 1000
    if (isPipe) return n(pipeIn) > 0 ? { shape: 'pipe', nominalMm: mm(n(pipeIn)), material: 'copper' } : 'Give the pipe size in inches.'
    if (shape === 'round') return n(d) > 0 ? { shape: 'round', diameter: mm(n(d)) } : 'Give the diameter in inches.'
    if (!(n(w) > 0 && n(h) > 0)) return 'Give the width and height in inches.'
    if (shape === 'oval' && n(w) < n(h)) return 'A flat oval is wider than it is tall; swap the width and height.'
    return { shape, width: mm(n(w)), height: mm(n(h)) }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="group-properties">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium" data-testid="group-title">
          {SCOPE_WORD[scope] ?? 'Selection'} · {count} element{count === 1 ? '' : 's'}
        </span>
        <span className="text-xs text-muted-foreground">Tab while hovering widens what a click selects; Esc clears.</span>
      </div>
      {s ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm" data-testid="group-totals">
          <dt className="text-muted-foreground">Straight pieces</dt>
          <dd data-testid="group-segments">{s.segments}</dd>
          <dt className="text-muted-foreground">Fittings</dt>
          <dd>{s.fittings}</dd>
          <dt className="text-muted-foreground">Parts</dt>
          <dd>{s.parts}</dd>
          <dt className="text-muted-foreground">Length</dt>
          <dd>{(s.lengthMm / MM_PER_FT).toFixed(1)} ft</dd>
          <dt className="text-muted-foreground">{flowWord}</dt>
          <dd data-testid="group-flow">{s.flowEntering === null ? 'None yet' : `${Math.round(s.flowEntering)}${isPipe ? '' : ' CFM'}`}</dd>
          {(totals?.pressure ?? []).map((p) => (
            <div key={p.system} className="contents">
              <dt className="text-muted-foreground">{p.system} fan static</dt>
              <dd data-testid="group-esp">{p.espInWc === null ? (p.reason ? 'Not calculated' : 'No fan yet') : `${p.espInWc.toFixed(2)} in. w.c.`}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <FieldDescription>Totals appear once the model is connected.</FieldDescription>
      )}
      <Separator />
      <FieldSet disabled={!canEdit}>
        <FieldLegend variant="label">Move all of it</FieldLegend>
        <div className="grid grid-cols-3 gap-2">
          <Field>
            <FieldLabel htmlFor="bm-group-dx">East (ft)</FieldLabel>
            <Input id="bm-group-dx" inputMode="decimal" value={dx} onChange={(e) => setDx(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="bm-group-dy">North (ft)</FieldLabel>
            <Input id="bm-group-dy" inputMode="decimal" value={dy} onChange={(e) => setDy(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="bm-group-dz">Up (ft)</FieldLabel>
            <Input id="bm-group-dz" inputMode="decimal" value={dz} onChange={(e) => setDz(e.target.value)} />
          </Field>
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="group-move"
          onClick={() => {
            const read = (text: string) => (text.trim() === '' ? 0 : parseFeet(text))
            const [x, y, z] = [read(dx), read(dy), read(dz)]
            if (x === null || y === null || z === null) return run("Enter feet, like 2, -1.5 or 2'6\". East, north and up are positive; west, south and down negative.", '')
            if (x === 0 && y === 0 && z === 0) return run('Give a distance east, north or up (negative goes west, south or down).', '')
            run(onMove({ x: x * MM_PER_FT, y: y * MM_PER_FT }, z * MM_PER_FT), 'Moved. Ctrl+Z undoes it.')
          }}
        >
          <Move data-icon="inline-start" />
          Move
        </Button>
      </FieldSet>
      {(isDuct || isPipe) && (
        <FieldSet disabled={!canEdit}>
          <FieldLegend variant="label">New size for every {isPipe ? 'pipe' : 'duct'} piece</FieldLegend>
          {isDuct ? (
            <FieldGroup className="flex flex-col gap-2">
              <ToggleGroup type="single" variant="outline" size="sm" value={shape} onValueChange={(v) => (v === 'rect' || v === 'round' || v === 'oval') && setShape(v)} aria-label="Duct shape">
                <ToggleGroupItem value="rect">Rectangular</ToggleGroupItem>
                <ToggleGroupItem value="round">Round</ToggleGroupItem>
                <ToggleGroupItem value="oval">Flat oval</ToggleGroupItem>
              </ToggleGroup>
              {shape === 'round' ? (
                <Field>
                  <FieldLabel htmlFor="bm-group-size">Diameter (in)</FieldLabel>
                  <Input id="bm-group-size" inputMode="decimal" value={d} onChange={(e) => setD(e.target.value)} />
                </Field>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Field>
                    <FieldLabel htmlFor="bm-group-size">Width (in)</FieldLabel>
                    <Input id="bm-group-size" inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bm-group-h">Height (in)</FieldLabel>
                    <Input id="bm-group-h" inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)} />
                  </Field>
                </div>
              )}
              <Field>
                <FieldLabel htmlFor="bm-group-transition">Transitions where it meets another size</FieldLabel>
                <Select value={transition} onValueChange={(v) => setTransition(TRANSITIONS.find((t) => t.value === v)?.value ?? 'auto')}>
                  <SelectTrigger id="bm-group-transition" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TRANSITIONS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>Length follows the wall angle. If it doesn&apos;t fit beside a fitting, nothing changes and you&apos;re told why.</FieldDescription>
              </Field>
            </FieldGroup>
          ) : (
            <Field>
              <FieldLabel htmlFor="bm-group-size">Pipe size (in)</FieldLabel>
              <Input id="bm-group-size" inputMode="decimal" value={pipeIn} onChange={(e) => setPipeIn(e.target.value)} />
            </Field>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="group-resize"
            onClick={() => {
              const next = size()
              if (typeof next === 'string') return run(next, '')
              run(onResize(next, isDuct ? transitionChoice(transition) : undefined), 'Resized in one edit. Ctrl+Z undoes it.')
            }}
          >
            <Maximize data-icon="inline-start" />
            Resize {resizeLabel(s?.segments ?? 0, s?.fittings ?? 0)}
          </Button>
        </FieldSet>
      )}
      {problem && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="group-problem">
          {problem}
        </FieldDescription>
      )}
      {done && (
        <FieldDescription role="status" data-testid="group-done">
          {done}
        </FieldDescription>
      )}
      <Separator />
      <Button size="sm" variant="outline" className="text-danger-600" disabled={!canEdit} onClick={onDelete} data-testid="group-delete">
        <Trash2 data-icon="inline-start" />
        Delete all {count}…
      </Button>
    </div>
  )
}
