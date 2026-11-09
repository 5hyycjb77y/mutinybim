'use client'

import { useEffect, useMemo, useState } from 'react'
import { modelToPaperPoint, spaceAt, spaceOutlines, viewModelLevel, type Command, type ModelState, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'
import { newElementId } from '../placement'
import { orthogonal, roomSnapSegments, snapPoint, tracePointAt, type SnapKind } from '../spaces/trace-geometry'
import { fillSpaceCommand, heightAtCursorText, outlineCeilingCommand, showsHeightAtCursor, type CeilingToolSettings, type ParsedCeilingSettings } from './ceiling-tool'

const PRIMARY = 'var(--mutiny-selection)'
const FILL = 'color-mix(in oklab, var(--mutiny-selection) 12%, transparent)'

interface Props {
  readonly model: ModelState
  /** The ceiling plan the person is on (by itself, or its viewport opened on a sheet). */
  readonly view: ViewOnPaper
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  /** Paper millimetres per screen pixel now, so snapping feels the same at every zoom. */
  readonly paperPerPixel: number
  /** The session's one edit path: the model's refusal in words, or null. */
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly hint: (text: string | null) => void
  readonly settings: CeilingToolSettings
  readonly parsed: ParsedCeilingSettings
  /** A ceiling was made (what to say), or the model refused (its words). */
  readonly onResult: (outcome: { readonly ok: boolean; readonly message: string }) => void
  /** Esc: stop the tool; nothing changes. */
  readonly onCancel: () => void
}

/**
 * The Ceiling tool on a ceiling plan. Draw outline: clicks add corners
 * (snapping to room corners and edges), Enter or a click on the first corner
 * closes it, Backspace takes back a corner, Shift squares the leg; a sloped
 * or cloud ceiling shows its height at the cursor. Fill a space: the space
 * under the pointer lights up and a click fills it. Esc stops with nothing
 * changed. Drawn ceilings themselves come from the plan's own drawing.
 */
export function CeilingPlanLayer({ model, view, paperOf, paperPerPixel, submit, hint, settings, parsed, onResult, onCancel }: Props) {
  const level = viewModelLevel(model, view.view.props?.level, view.view.props?.levelElevationMm)
  const levelId = level?.id ?? null
  const z = level?.elevationMm ?? 0
  const [corners, setCorners] = useState<Vec2[]>([])
  const [cursor, setCursor] = useState<{ point: Vec2; kind: SnapKind } | null>(null)
  const [shift, setShift] = useState(false)
  const drawing = settings.how === 'outline'

  const snapLines = useMemo(() => (levelId && drawing ? roomSnapSegments(model, levelId) : []), [model, levelId, drawing])
  const toPaper = (p: Vec2): Vec2 => modelToPaperPoint(view, { x: p.x, y: p.y, z })
  const o = toPaper({ x: 0, y: 0 })
  const e1 = toPaper({ x: 1000, y: 0 })
  const paperPerModel = Math.max(1e-9, Math.hypot(e1.x - o.x, e1.y - o.y) / 1000)
  const toleranceMm = (8 * paperPerPixel) / paperPerModel

  useEffect(() => {
    setCorners([])
    hint(
      !levelId
        ? 'This ceiling plan isn’t on a level yet; choose its level in the view’s properties.'
        : drawing
          ? 'Click the corners of the ceiling; clicks snap to room corners and edges. Enter closes it, Backspace takes back a corner, Esc stops.'
          : 'Click a space to fill it with a ceiling at the height in the bar. Esc stops.',
    )
    // Re-announce only when the tool starts, the way of making changes, or the level changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, levelId])

  const finish = (points: readonly Vec2[]) => {
    if (!levelId) return
    if (!parsed.ok) {
      hint(parsed.message)
      onResult({ ok: false, message: parsed.message })
      return
    }
    if (points.length < 3) {
      hint('A ceiling needs at least three corners. Keep clicking, or press Esc to stop.')
      return
    }
    const command = outlineCeilingCommand({ ceilingId: newElementId('ceiling'), levelId, outline: points, form: settings.form, parsed })
    const refused = submit(command, 'Draw ceiling')
    if (refused) {
      hint(refused)
      onResult({ ok: false, message: refused })
      return
    }
    setCorners([])
    const message = 'Drew a ceiling. Undo takes it back; keep clicking to draw the next one.'
    hint(message)
    onResult({ ok: true, message })
  }

  const fill = (point: Vec2) => {
    if (!levelId) return
    if (!parsed.ok) {
      hint(parsed.message)
      onResult({ ok: false, message: parsed.message })
      return
    }
    const made = fillSpaceCommand({ model, levelId, point, ceilingId: newElementId('ceiling'), form: settings.form, parsed })
    if (!made.ok) {
      hint(made.message)
      onResult({ ok: false, message: made.message })
      return
    }
    const refused = submit(made.command, made.label)
    const message = refused ?? `Filled ${made.spaceName} with a ceiling. Undo takes it back.`
    hint(message)
    onResult({ ok: refused === null, message })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShift(e.type === 'keydown')
      if (e.type !== 'keydown') return
      if (e.key === 'Escape') {
        e.stopPropagation()
        setCorners([])
        hint('Stopped the Ceiling tool; nothing changed.')
        onCancel()
      } else if (drawing && e.key === 'Enter') {
        e.preventDefault()
        finish(corners)
      } else if (drawing && e.key === 'Backspace' && corners.length > 0) {
        e.preventDefault()
        setCorners((c) => c.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  })

  const aim = (e: React.PointerEvent<SVGElement>): { point: Vec2; kind: SnapKind } | null => {
    const p = paperOf(e)
    const at = p ? tracePointAt(view, p, z) : null
    if (!at) {
      setCursor(null)
      return null
    }
    const raw = shift ? orthogonal({ x: at.x, y: at.y }, corners[corners.length - 1]) : { x: at.x, y: at.y }
    const snapped = drawing ? snapPoint(raw, snapLines, corners, toleranceMm) : { point: raw, kind: 'none' as const }
    setCursor(snapped)
    return snapped
  }

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const at = aim(e)
    if (!at) return
    if (!drawing) fill(at.point)
    else if (at.kind === 'close') finish(corners)
    else setCorners((c) => [...c, at.point])
  }

  const outline = drawing && cursor ? [...corners, cursor.point] : corners
  const hovered = !drawing && cursor && levelId ? spaceAt(model.elements, levelId, cursor.point) : null
  const hoveredOutline = hovered ? spaceOutlines(model.elements, hovered).filter((poly) => poly.length >= 3) : []
  const cursorHeight = cursor && drawing && showsHeightAtCursor(settings.form) ? heightAtCursorText(parsed, corners[0], cursor.point) : null
  const points = (poly: readonly Vec2[]) => poly.map((p) => { const q = toPaper(p); return `${q.x},${q.y}` }).join(' ')
  const r = view.paperRect

  return (
    <g data-testid="ceiling-plan-layer" data-level={levelId ?? ''} data-how={settings.how}>
      {hoveredOutline.map((poly, i) => (
        <polygon key={i} points={points(poly)} fill={FILL} stroke={PRIMARY} strokeWidth={0.35} pointerEvents="none" data-testid="ceiling-fill-target" />
      ))}
      {drawing && outline.length >= 2 ? <polygon points={points(outline)} fill={FILL} stroke={PRIMARY} strokeWidth={0.35} pointerEvents="none" data-testid="ceiling-draw-preview" data-corners={corners.length} /> : null}
      {cursor ? (
        <g pointerEvents="none" data-testid="ceiling-cursor" data-snap={cursor.kind}>
          <circle cx={toPaper(cursor.point).x} cy={toPaper(cursor.point).y} r={cursor.kind === 'none' ? 0.6 : 1} fill="none" stroke={PRIMARY} strokeWidth={0.3} />
          {cursorHeight ? (
            <text x={toPaper(cursor.point).x + 2} y={toPaper(cursor.point).y - 2} fontSize={2.4} fill={PRIMARY} data-testid="ceiling-cursor-height">
              {cursorHeight}
            </text>
          ) : null}
        </g>
      ) : null}
      {levelId ? (
        <rect
          x={r.min.x}
          y={r.min.y}
          width={r.max.x - r.min.x}
          height={r.max.y - r.min.y}
          fill="transparent"
          className="cursor-crosshair"
          onPointerMove={(e) => {
            aim(e)
          }}
          onPointerDown={onPointerDown}
          onDoubleClick={() => drawing && finish(corners)}
          onPointerLeave={() => setCursor(null)}
          data-testid="ceiling-hit"
        >
          <title>{drawing ? 'Draw a ceiling: click its corners, Enter to close, Esc to stop.' : 'Click a space to fill it with a ceiling. Esc stops.'}</title>
        </rect>
      ) : null}
    </g>
  )
}
