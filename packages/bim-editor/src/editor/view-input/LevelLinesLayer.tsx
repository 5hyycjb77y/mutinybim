'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { drawingToPaper, levelHeightLabel, modelLevels, paperDeltaToModel, type Level, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import type { ModelEditBridge } from './bridge'

const PRIMARY = 'var(--mutiny-selection)'
/** How near (screen px) the pointer must be to grab a level line. */
const GRAB_PX = 4
/** A press that travels less than this (screen px) is a click. */
const CLICK_PX = 3
/** Dragged heights keep to the nearest 1/8". */
const EIGHTH_INCH_MM = 25.4 / 8
const MM_PER_FT = 304.8

export interface LevelLineOnPaper {
  readonly level: Level
  /** The line across the view's crop window, paper mm. */
  readonly from: Vec2
  readonly to: Vec2
}

/** Each level a section shows, as its datum line on paper (the drawing draws the line and head; this is where to grab it). */
export function levelLinesOnPaper(model: ModelState, view: ViewOnPaper): LevelLineOnPaper[] {
  if (view.mapping.kind !== 'section') return []
  const w = view.window
  return modelLevels(model)
    .filter((l) => l.elevationMm >= w.min.y && l.elevationMm <= w.max.y)
    .map((level) => ({
      level,
      from: drawingToPaper(view, { x: w.min.x, y: level.elevationMm }),
      to: drawingToPaper(view, { x: w.max.x, y: level.elevationMm }),
    }))
}

/** The level height a vertical drag on paper gives, snapped to 1/8". */
export function draggedElevation(view: ViewOnPaper, level: Level, from: Vec2, to: Vec2): number {
  const d = paperDeltaToModel(view, from, { x: from.x, y: to.y })
  const raw = level.elevationMm + (d?.z ?? 0)
  return Math.round(Math.round(raw / EIGHTH_INCH_MM) * EIGHTH_INCH_MM * 1000) / 1000
}

type Drag = {
  readonly id: string
  readonly from: Vec2
  readonly to: Vec2
  readonly moved: boolean
}

/**
 * Levels in a section or elevation: hover a datum line to see it is a level,
 * drag it up or down to change the level's height (everything on the level
 * goes with it), double-click it to rename it or type its height. One edit is
 * one command through the same session as everywhere else; Esc cancels a drag.
 */
export function LevelLinesLayer({
  model,
  view,
  bridge,
  paperOf,
  paperMmPerPx,
}: {
  readonly model: ModelState
  readonly view: ViewOnPaper
  readonly bridge: ModelEditBridge
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly paperMmPerPx: number
}) {
  const lines = useMemo(() => levelLinesOnPaper(model, view), [model, view])
  const [hover, setHover] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [editing, setEditing] = useState<Level | null>(null)

  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDrag(null)
      bridge.hint('Level move cancelled; nothing changed.')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag, bridge])

  if (lines.length === 0) return null
  const fontSize = 2.6
  const grab = Math.max(GRAB_PX * paperMmPerPx * 2, 0.8)

  const onDown = (e: React.PointerEvent<SVGLineElement>, id: string) => {
    if (e.button !== 0) return
    const p = paperOf(e)
    if (!p) return
    e.stopPropagation()
    if (!bridge.canEdit) {
      toast.error(bridge.blockedReason)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id, from: p, to: p, moved: false })
  }
  const onMove = (e: React.PointerEvent<SVGLineElement>, id: string) => {
    if (!drag) {
      if (hover !== id) {
        setHover(id)
        const level = lines.find((l) => l.level.id === id)?.level
        if (level) bridge.hint(`${level.name} at ${levelHeightLabel(level.elevationMm)}. Drag it up or down to move the level; double-click to rename it.`)
      }
      return
    }
    const p = paperOf(e)
    if (!p || drag.id !== id) return
    setDrag({
      ...drag,
      to: p,
      moved: drag.moved || Math.abs(p.y - drag.from.y) >= CLICK_PX * paperMmPerPx,
    })
  }
  const onUp = (id: string) => {
    const d = drag
    setDrag(null)
    if (!d || d.id !== id || !d.moved) return
    const level = lines.find((l) => l.level.id === id)?.level
    if (!level) return
    const elevationMm = draggedElevation(view, level, d.from, d.to)
    if (Math.abs(elevationMm - level.elevationMm) < 0.5) return
    const refused = bridge.submit({ type: 'update_level', levelId: level.id, elevationMm }, `${level.name} moved to ${levelHeightLabel(elevationMm)}`)
    if (refused) toast.error(refused)
  }

  return (
    <g data-testid="level-lines-layer" data-view-id={view.view.id}>
      {lines.map(({ level, from, to }) => {
        const active = drag?.id === level.id ? drag : null
        const dy = active && active.moved ? active.to.y - active.from.y : 0
        const hot = hover === level.id || active !== null
        const target = active && active.moved ? draggedElevation(view, level, active.from, active.to) : null
        return (
          <g key={level.id} data-testid="level-line" data-level-id={level.id} data-level-name={level.name}>
            {hot && <line x1={from.x} y1={from.y + dy} x2={to.x} y2={to.y + dy} stroke={PRIMARY} strokeWidth={0.45} strokeDasharray={active ? '1.5 1' : undefined} pointerEvents="none" />}
            {target !== null && (
              <text x={to.x - 2} y={to.y + dy - 1.5} textAnchor="end" fontSize={fontSize} fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.6} pointerEvents="none" data-testid="level-drag-readout">
                {`${level.name} to ${levelHeightLabel(target)} (${target > level.elevationMm ? 'up' : 'down'} ${levelHeightLabel(Math.abs(target - level.elevationMm))}). Release to move, Esc to cancel.`}
              </text>
            )}
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="transparent"
              strokeWidth={grab}
              className={active ? 'cursor-grabbing' : 'cursor-ns-resize'}
              onPointerDown={(e) => onDown(e, level.id)}
              onPointerMove={(e) => onMove(e, level.id)}
              onPointerUp={() => onUp(level.id)}
              onPointerLeave={() => {
                if (drag) return
                setHover(null)
                bridge.hint(null)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setDrag(null)
                setEditing(level)
              }}
              data-testid="level-line-grab"
            >
              <title>{`${level.name} at ${levelHeightLabel(level.elevationMm)}: drag to move the level, double-click to rename it`}</title>
            </line>
          </g>
        )
      })}
      {editing && (
        <LevelEditDialog
          level={editing}
          existing={modelLevels(model)}
          onCancel={() => setEditing(null)}
          onSave={(name, elevationMm) => {
            const patch = {
              ...(name !== editing.name ? { name } : {}),
              ...(Math.abs(elevationMm - editing.elevationMm) >= 0.5 ? { elevationMm } : {}),
            }
            if (Object.keys(patch).length === 0) return null
            return bridge.submit({ type: 'update_level', levelId: editing.id, ...patch }, patch.name ? `rename level to ${patch.name}` : `${editing.name} moved to ${levelHeightLabel(elevationMm)}`)
          }}
        />
      )}
    </g>
  )
}

/** Rename a level or type its height. Everything on it goes with a height change; plans and schedules follow a rename. */
export function LevelEditDialog({ level, existing, onCancel, onSave }: { readonly level: Level; readonly existing: readonly Level[]; readonly onCancel: () => void; readonly onSave: (name: string, elevationMm: number) => string | null }) {
  const [name, setName] = useState(level.name)
  const [elevation, setElevation] = useState(String(Math.round((level.elevationMm / MM_PER_FT) * 1000) / 1000))
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ft = Number(elevation)
    if (name.trim() === '' || elevation.trim() === '' || !Number.isFinite(ft)) {
      setError('Give the level a name and a floor elevation in feet.')
      return
    }
    const clash = existing.find((l) => l.id !== level.id && l.name.toLowerCase() === name.trim().toLowerCase())
    if (clash) {
      setError(`There is already a level called ${clash.name}. Pick another name.`)
      return
    }
    const refusal = onSave(name.trim(), ft * MM_PER_FT)
    if (refusal) setError(refusal)
    else onCancel()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm" data-testid="level-edit-dialog">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Level {level.name}</DialogTitle>
            <DialogDescription>Everything on the level moves with it. Plans and schedules for it follow a new name. You can undo this.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="grid grid-cols-2 gap-2">
            <Field>
              <FieldLabel htmlFor="bm-level-edit-name">Name</FieldLabel>
              <Input id="bm-level-edit-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="bm-level-edit-elev">Floor (ft)</FieldLabel>
              <Input id="bm-level-edit-elev" inputMode="decimal" value={elevation} onChange={(e) => setElevation(e.target.value)} />
            </Field>
          </FieldGroup>
          {level.source && <FieldDescription>Made from the linked model&apos;s {level.source.storeyName}. A rename here stays when the levels are synced again.</FieldDescription>}
          {error && (
            <FieldDescription className="text-danger-600" role="alert">
              {error}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-testid="level-edit-save">
              <Pencil data-icon="inline-start" />
              Save level
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
