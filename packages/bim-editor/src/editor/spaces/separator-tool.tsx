'use client'

import { useEffect, useState } from 'react'
import { spaceAt, type ElementId, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import { orthogonal, tracePointAt } from './trace-geometry'

const PRIMARY = 'var(--mutiny-selection)'

export interface SeparatorLine {
  readonly spaceId: ElementId
  readonly start: Vec2
  readonly end: Vec2
}

/** The room a separation line splits: the bounded space at its middle. Null with the words to show when there isn't one. */
export function roomUnderLine(model: ModelState, levelId: ElementId, start: Vec2, end: Vec2): { readonly spaceId: ElementId } | { readonly why: string } {
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const s = spaceAt(model.elements, levelId, mid)
  if (!s) return { why: 'That line isn’t across a room. Draw it from wall to wall across a room made from walls.' }
  if (s.bounds.kind !== 'bounded') return { why: `${[s.name, s.number].filter((t) => t.trim() !== '').join(' ') || 'That space'} wasn’t made from its walls, so it can’t be split. Make it with Room from walls first.` }
  return { spaceId: s.id }
}

interface Props {
  readonly model: ModelState
  readonly levelId: ElementId
  readonly view: ViewOnPaper
  readonly z: number
  readonly toPaper: (p: Vec2) => Vec2
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly hint: (text: string | null) => void
  /** Both ends are placed across a room: the split dialog asks the rest. */
  readonly onLine: (line: SeparatorLine) => void
  readonly onCancel: () => void
}

/**
 * Separation line on a plan: click where the line starts and where it ends,
 * from wall to wall across a room (Shift keeps it square). Nothing is written
 * here; the Split space dialog that follows asks who keeps which load. Esc
 * stops with nothing changed.
 */
export function SeparatorTool({ model, levelId, view, z, toPaper, paperOf, hint, onLine, onCancel }: Props) {
  const [start, setStart] = useState<Vec2 | null>(null)
  const [at, setAt] = useState<Vec2 | null>(null)
  const [shift, setShift] = useState(false)

  useEffect(() => {
    hint('Separation line: click on one wall, then on the wall across the room. Shift keeps it square. Esc stops.')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShift(e.type === 'keydown')
      if (e.type !== 'keydown' || e.key !== 'Escape') return
      e.stopPropagation()
      hint('Stopped; nothing changed.')
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [hint, onCancel])

  const aim = (e: React.PointerEvent<SVGElement>): Vec2 | null => {
    const p = paperOf(e)
    const m = p ? tracePointAt(view, p, z) : null
    const q = m && shift && start ? orthogonal(m, start) : m
    setAt(q)
    return q
  }

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const p = aim(e)
    if (!p) return
    if (!start) {
      setStart(p)
      return
    }
    const room = roomUnderLine(model, levelId, start, p)
    if ('why' in room) {
      hint(room.why)
      setStart(null)
      return
    }
    setStart(null)
    onLine({ spaceId: room.spaceId, start, end: p })
  }

  const a = start ? toPaper(start) : null
  const b = at ? toPaper(at) : null
  const r = view.paperRect
  return (
    <g data-testid="separator-tool">
      {a && b ? <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PRIMARY} strokeWidth={0.4} strokeDasharray="1.6 0.8" pointerEvents="none" data-testid="separator-preview" /> : null}
      <rect
        x={r.min.x}
        y={r.min.y}
        width={r.max.x - r.min.x}
        height={r.max.y - r.min.y}
        fill="transparent"
        className="cursor-crosshair"
        onPointerMove={aim}
        onPointerDown={onPointerDown}
        onPointerLeave={() => setAt(null)}
        data-testid="separator-hit"
      >
        <title>Separation line: click on one wall, then on the wall across the room. Esc stops.</title>
      </rect>
    </g>
  )
}
