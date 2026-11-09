'use client'

import { useEffect, useMemo, useState } from 'react'
import { previewRoomFromWalls, spaceAt, type Command, type ElementId, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import { newElementId } from '../placement'
import { formatFt2, nextSpaceNumber } from './space-rows'
import { tracePointAt } from './trace-geometry'

const PRIMARY = 'var(--mutiny-selection)'
const FILL = 'color-mix(in oklab, var(--mutiny-selection) 14%, transparent)'
const GAP = 'var(--color-danger-600, currentColor)'
const FT2_PER_M2 = 10.7639104
/** Hover asks again only when the pointer moves this far (model mm): the room under it rarely changes in between. */
const HOVER_STEP_MM = 50

/** What the pointer is over, for the hover preview: the room it would make with its area, or why not and the gap to show. */
export type WallsRoomHover =
  | { readonly kind: 'room'; readonly outline: readonly Vec2[]; readonly area: string }
  | { readonly kind: 'taken'; readonly outline: readonly Vec2[]; readonly message: string }
  | { readonly kind: 'gap'; readonly message: string; readonly at: Vec2 | null; readonly elementId: ElementId | null }

export function wallsRoomHover(model: ModelState, levelId: ElementId, seed: Vec2): WallsRoomHover {
  const found = previewRoomFromWalls(model.elements, levelId, seed)
  if (!found.ok) return { kind: 'gap', message: found.message, at: found.gap?.at ?? null, elementId: found.gap?.elementId ?? null }
  const there = spaceAt(model.elements, levelId, seed)
  const label = there ? [there.name, there.number].filter((t) => t.trim() !== '').join(' ') : ''
  if (there && there.bounds.kind === 'bounded') return { kind: 'taken', outline: found.outline, message: `${label || 'A space'} already fills this room` }
  return { kind: 'room', outline: found.outline, area: formatFt2(found.areaM2 * FT2_PER_M2) }
}

/** The command a click makes: a space bounded by the walls around the point, numbered on from the level's highest. */
export function roomFromWallsCommand(model: ModelState, levelId: ElementId, seed: Vec2): { readonly command: Command; readonly spaceId: ElementId } {
  const spaceId = newElementId('space') as ElementId
  const number = nextSpaceNumber(model, levelId)
  return { spaceId, command: { type: 'place_space_in_walls', spaceId, levelId, seed: { x: Math.round(seed.x), y: Math.round(seed.y) }, number, name: `Space ${number}` } }
}

interface Props {
  readonly model: ModelState
  readonly levelId: ElementId
  readonly view: ViewOnPaper
  readonly z: number
  readonly toPaper: (p: Vec2) => Vec2
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly hint: (text: string | null) => void
  readonly onDrawn: (spaceId: ElementId) => void
  readonly onCancel: () => void
}

/**
 * Room from walls on a plan: hover inside walls and the room it would make
 * shows with its area; a click makes it. Over a gap it says where the walls
 * are open and rings the loose end; a click there changes nothing. Esc stops.
 */
export function WallsRoomTool({ model, levelId, view, z, toPaper, paperOf, submit, hint, onDrawn, onCancel }: Props) {
  const [at, setAt] = useState<Vec2 | null>(null)
  const key = at ? `${Math.round(at.x / HOVER_STEP_MM)},${Math.round(at.y / HOVER_STEP_MM)}` : null
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-asked per hover step, not per pixel
  const hover = useMemo(() => (at ? wallsRoomHover(model, levelId, at) : null), [model, levelId, key])

  useEffect(() => {
    hint('Room from walls: hover inside the walls to see the room and its area, click to make it. Esc stops.')
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      hint('Stopped; nothing changed.')
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hint, onCancel])

  const aim = (e: React.PointerEvent<SVGElement>): Vec2 | null => {
    const p = paperOf(e)
    const m = p ? tracePointAt(view, p, z) : null
    setAt(m)
    return m
  }

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const seed = aim(e)
    if (!seed) return
    const now = wallsRoomHover(model, levelId, seed)
    if (now.kind !== 'room') {
      hint(now.message)
      return
    }
    const { command, spaceId } = roomFromWallsCommand(model, levelId, seed)
    const refused = submit(command, 'Room from walls')
    if (refused) {
      hint(refused)
      return
    }
    hint(`Made a space of ${now.area} from the walls around it. Name it and give it a use in the Spaces panel.`)
    onDrawn(spaceId)
  }

  const points = (o: readonly Vec2[]) => o.map((p) => { const q = toPaper(p); return `${q.x},${q.y}` }).join(' ')
  const cursor = at ? toPaper(at) : null
  const r = view.paperRect
  return (
    <g data-testid="walls-room-tool">
      {hover && hover.kind !== 'gap' ? (
        <polygon points={points(hover.outline)} fill={FILL} stroke={PRIMARY} strokeWidth={0.4} pointerEvents="none" data-testid="walls-room-preview" data-state={hover.kind} />
      ) : null}
      {hover?.kind === 'room' && cursor ? (
        <text x={cursor.x + 2} y={cursor.y - 2} fontSize={2.4} fill={PRIMARY} pointerEvents="none" data-testid="walls-room-area">
          {hover.area}
        </text>
      ) : null}
      {hover?.kind === 'gap' && hover.at ? (
        <circle cx={toPaper(hover.at).x} cy={toPaper(hover.at).y} r={1.6} fill="none" stroke={GAP} strokeWidth={0.5} pointerEvents="none" data-testid="walls-room-gap" data-element={hover.elementId ?? ''} />
      ) : null}
      {hover && hover.kind !== 'room' ? (
        <text x={(cursor?.x ?? 0) + 2} y={(cursor?.y ?? 0) + 4} fontSize={2} fill={GAP} pointerEvents="none" data-testid="walls-room-why">
          {hover.message}
        </text>
      ) : null}
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
        data-testid="walls-room-hit"
      >
        <title>Room from walls: click inside the walls of a room. Esc stops.</title>
      </rect>
    </g>
  )
}
