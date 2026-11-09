'use client'

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { editableLinePlacement, hostLineOf, joinedEndFollowers, type BimElement, type Command, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import { feetInches } from '../placement'
import { ToolHintBar } from '../ToolHintBar'
import { DRAFTING_GRID_MM, snapPoint, type Snap } from './tools/snap'

type End = 'start' | 'end'
type ToScreen = (p: Vec2) => { readonly x: number; readonly y: number } | null

/** How near (screen pixels) the pointer must come to snap, as the Wall tool. */
const SNAP_PX = 12

/** The wall a pair of end grips is for, and its ends: null when `id` is not a wall drawn on `levelId`. */
export function wallEnds(model: ModelState, id: string | undefined, levelId: string | null): { readonly id: string; readonly start: Vec2; readonly end: Vec2 } | null {
  const el = id ? model.elements[id] : undefined
  if (!el || el.kind !== 'wall' || !levelId) return null
  const p = editableLinePlacement(el, model.elements)
  const line = hostLineOf(el, model.elements)
  return p && line && p.levelId === levelId ? { id: el.id, start: line.start, end: line.end } : null
}

/** What the hint says while an end grip is held: what follows and how to stop. */
export function endDragHint(elements: Readonly<Record<string, BimElement>>, wallId: string, end: End, snap: Snap | null, lengthMm: number | null): string {
  const n = joinedEndFollowers(elements, wallId, end).length
  const follows = n === 0 ? 'Nothing is joined at this end' : `${n} joined ${n === 1 ? 'wall follows' : 'walls follow'}`
  const length = lengthMm === null ? '' : ` · ${feetInches(lengthMm)} long`
  return `Drag the wall's end${length} · ${follows}${snap && snap.kind !== 'grid' ? ` · ${snap.label}` : ''} · Esc cancels`
}

/** The command a drop makes, or why there is none, in words. */
export function endDropCommand(wall: { readonly id: string; readonly start: Vec2; readonly end: Vec2 }, end: End, to: Vec2): Command | string {
  const from = end === 'start' ? wall.start : wall.end
  if (from.x === to.x && from.y === to.y) return 'The end is where it was; nothing moved.'
  return { type: 'move_line_end', elementId: wall.id, end, to }
}

interface Props {
  readonly model: ModelState
  readonly levelId: string
  readonly wall: { readonly id: string; readonly start: Vec2; readonly end: Vec2 }
  readonly toScreen: ToScreen
  readonly pickPlanPointAt: (clientX: number, clientY: number) => Vec2 | null
  readonly submit: (command: Command, label: string) => string | null
  readonly notify: (message: string, kind?: 'info' | 'error') => void
  readonly hintClassName?: string
}

interface Drag {
  readonly end: End
  readonly at: Vec2 | null
  readonly snap: Snap | null
}

/**
 * A grip at each end of the one selected wall in the live plan (and 3D, on
 * the wall's level). Dragging one moves only that end, snapping as the Wall
 * tool does (other walls' ends and faces, square off a wall, perpendicular);
 * the walls joined at that end follow in the same change, so one Undo puts
 * everything back. Esc while dragging cancels.
 */
export function WallEndGrips({ model, levelId, wall, toScreen, pickPlanPointAt, submit, notify, hintClassName }: Props): ReactNode {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<End | null>(null)
  const dragRef = useRef<Drag | null>(null)
  useLayoutEffect(() => {
    dragRef.current = drag
  })
  // The camera moves under still grips (wheel zoom, pan): redraw on the next frame.
  const [, setFrame] = useState(0)
  useEffect(() => {
    let raf = 0
    const redraw = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setFrame((n) => n + 1))
    }
    window.addEventListener('wheel', redraw, { passive: true })
    window.addEventListener('pointermove', redraw)
    window.addEventListener('resize', redraw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('wheel', redraw)
      window.removeEventListener('pointermove', redraw)
      window.removeEventListener('resize', redraw)
    }
  }, [])
  useEffect(() => {
    if (!drag) return undefined
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDrag(null)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [drag])

  const fixedOf = (end: End): Vec2 => (end === 'start' ? wall.end : wall.start)
  const aim = (end: End, clientX: number, clientY: number): Drag => {
    const raw = pickPlanPointAt(clientX, clientY)
    if (!raw) return { end, at: null, snap: null }
    const beside = pickPlanPointAt(clientX + SNAP_PX, clientY)
    const toleranceMm = beside ? Math.hypot(beside.x - raw.x, beside.y - raw.y) : 300
    // The walls at a corner with this end move with it: snapping to their old end would snap back.
    const partners = joinedEndFollowers(model.elements, wall.id, end).filter((id) => {
      const other = model.elements[id]
      const l = other ? hostLineOf(other, model.elements) : null
      const p = end === 'start' ? wall.start : wall.end
      return l !== null && ((l.start.x === p.x && l.start.y === p.y) || (l.end.x === p.x && l.end.y === p.y))
    })
    const snap = snapPoint({ model, levelId, raw, toleranceMm, corners: [fixedOf(end)], gridMm: DRAFTING_GRID_MM, ignoreIds: [wall.id, ...partners] })
    return { end, at: snap.point, snap }
  }

  const down = (end: End) => (e: ReactPointerEvent<SVGCircleElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(aim(end, e.clientX, e.clientY))
  }
  const move = (e: ReactPointerEvent<SVGCircleElement>) => {
    const d = dragRef.current
    if (!d) return
    e.stopPropagation()
    setDrag(aim(d.end, e.clientX, e.clientY))
  }
  const up = (e: ReactPointerEvent<SVGCircleElement>) => {
    const d = dragRef.current
    if (!d) return
    e.stopPropagation()
    setDrag(null)
    if (!d.at) {
      notify("That is off the plan; the wall's end stayed where it was.", 'info')
      return
    }
    const command = endDropCommand(wall, d.end, d.at)
    if (typeof command === 'string') return
    const err = submit(command, "Move the wall's end")
    if (err) {
      console.error('[WallEndGrips] moving a wall end was refused', { wallId: wall.id, end: d.end, err })
      notify(err, 'error')
    }
  }

  const ends: readonly End[] = ['start', 'end']
  const fixed = drag ? toScreen(fixedOf(drag.end)) : null
  const tip = drag?.at ? toScreen(drag.at) : null
  const shown = drag?.end ?? hover
  const lengthMm = drag?.at ? Math.hypot(drag.at.x - fixedOf(drag.end).x, drag.at.y - fixedOf(drag.end).y) : null
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible" data-testid="architecture-wall-end-grips" data-wall={wall.id} data-dragging={drag?.end ?? ''}>
        {fixed && tip && <path d={`M${fixed.x.toFixed(1)} ${fixed.y.toFixed(1)} L${tip.x.toFixed(1)} ${tip.y.toFixed(1)}`} className="fill-none stroke-primary" strokeWidth={2} strokeDasharray="8 5" data-testid="architecture-wall-end-preview" />}
        {tip && drag?.snap && drag.snap.kind !== 'grid' && <rect x={tip.x - 5} y={tip.y - 5} width={10} height={10} className="fill-none stroke-warning-500" strokeWidth={2} data-testid="architecture-wall-end-snap" data-kind={drag.snap.kind} />}
        {ends.map((end) => {
          const p = toScreen(end === 'start' ? wall.start : wall.end)
          if (!p) return null
          return (
            <circle
              key={end}
              cx={p.x}
              cy={p.y}
              r={7}
              role="button"
              aria-label={`Drag the wall's ${end === 'start' ? 'first' : 'second'} end`}
              className="cursor-grab fill-background stroke-primary"
              strokeWidth={2}
              style={{ pointerEvents: 'auto' }}
              data-testid="architecture-wall-end-grip"
              data-end={end}
              onPointerEnter={() => setHover(end)}
              onPointerLeave={() => setHover(null)}
              onPointerDown={down(end)}
              onPointerMove={move}
              onPointerUp={up}
              onClick={(e) => e.stopPropagation()}
            />
          )
        })}
      </svg>
      {shown ? <ToolHintBar text={endDragHint(model.elements, wall.id, shown, drag?.snap ?? null, lengthMm)} tone="info" testId="architecture-end-hint" className={hintClassName} /> : null}
    </>
  )
}
