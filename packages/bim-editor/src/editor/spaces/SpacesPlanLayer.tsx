'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  isCalibrated,
  modelToPaperPoint,
  spaceLabel,
  spaceOutlines,
  spacesOnLevel,
  underlaysOnLevel,
  viewModelLevel,
  separatorsOnLevel,
  type Command,
  type DrawingUnderlay,
  type ElementId,
  type ModelState,
  type Vec2,
  type ViewOnPaper,
} from '@permitzip/bim-kernel'
import { newElementId } from '../placement'
import type { ReviewedProposal } from './propose-rooms'
import { SeparatorTool, type SeparatorLine } from './separator-tool'
import { WallsRoomTool } from './walls-room-tool'
import { formatFt2, nextSpaceNumber } from './space-rows'
import { linkedReferenceWords, linkedSnapNear } from '../linked-reference/linked-reference-store'
import { useLinkedReferenceState } from '../linked-reference/use-linked-reference'
import { lineworkSnapSegments, orthogonal, polygonAreaFt2, rectangleOutline, roomSnapSegments, snapPoint, traceHitRect, tracePointAt, traceableUnderlays, underlayCorners, type SnapKind, type SnapSegment } from './trace-geometry'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useUnderlayPageFrom } from './use-underlays'

const PRIMARY = 'var(--mutiny-selection)'
const SPACE_FILL = 'color-mix(in oklab, var(--mutiny-selection) 10%, transparent)'

/** What the Draw space tool is doing; null when it's off. */
export type DrawSpaceMode =
  | { readonly kind: 'new'; readonly shape: 'polygon' | 'rectangle' }
  /** Redraw an existing space's outline (a typed row, or a fix). */
  | { readonly kind: 'redraw'; readonly spaceId: ElementId; readonly shape: 'polygon' | 'rectangle' }
  /** Rooms proposed from the drawing, shown as ghosts while the person accepts or rejects each in the Spaces panel. */
  /** `label` names each ghost ("Fire area 2"); absent: "Room". */
  | { readonly kind: 'review'; readonly proposals: readonly ReviewedProposal[]; readonly label?: string }
  /** Room from walls: hover previews the room the walls close, a click makes it. */
  | { readonly kind: 'from_walls' }
  /** Separation line across a room, then the Split space dialog. */
  | { readonly kind: 'separator' }

interface Props {
  readonly projectId: string
  readonly model: ModelState
  /** The plan the person is on (a plan by itself, or its viewport on a sheet). */
  readonly view: ViewOnPaper
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  /** Paper millimetres per screen pixel now, so snapping feels the same at every zoom. */
  readonly paperPerPixel: number
  /** The session's one edit path: the model's refusal in words, or null. */
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly hint: (text: string | null) => void
  /** The Draw space tool, or proposed rooms to show as ghosts; null shows spaces and underlays only. */
  readonly mode: DrawSpaceMode | null
  /** A space was drawn or redrawn (its id). */
  readonly onDrawn: (spaceId: ElementId) => void
  /** Esc: stop drawing; nothing changes. */
  readonly onCancel: () => void
  readonly selectedSpaceId?: ElementId | null
  /** A separation line was drawn across a room (Split space asks the rest). */
  readonly onSeparatorLine?: (line: SeparatorLine) => void
}

/** How much of an underlay shows past the plan's crop while tracing (the crop still prints). */
const OUTSIDE_CROP_DIM = 0.45
/** Draw space takes clicks this far past the traced drawing's page, paper mm. */
const TRACE_HIT_MARGIN_MM = 10

/**
 * One drawing under the plan. Cropped to the plan's crop like everything that
 * prints; while tracing, the rest of the page shows dimmed so the corners
 * outside the crop can be clicked too.
 */
function UnderlayPicture({ projectId, underlay, view, z, tracing }: { readonly projectId: string; readonly underlay: DrawingUnderlay; readonly view: ViewOnPaper; readonly z: number; readonly tracing: boolean }) {
  const { page } = useUnderlayPageFrom(useEditorHost().data.underlays, projectId, underlay)
  if (!isCalibrated(underlay) || page.state !== 'ready') return null
  const [bl, br, , tl] = underlayCorners(underlay.calibration, page.value.width, page.value.height).map((q) => modelToPaperPoint(view, { x: q.x, y: q.y, z }))
  if (!bl || !br || !tl) return null
  // The picture's own (0,0) is its top-left; map it with an affine transform from three corners.
  const w = page.value.width
  const h = page.value.height
  const a = (br.x - bl.x) / w
  const b = (br.y - bl.y) / w
  const c = (bl.x - tl.x) / h
  const d = (bl.y - tl.y) / h
  const opacity = (underlay.opacityPct ?? 50) / 100
  const crop = view.paperRect
  const clipId = `underlay-crop-${view.view.id}-${underlay.id}`
  const picture = (props: { readonly opacity: number; readonly clipPath?: string; readonly testId: string }) => (
    <image
      href={page.value.imageUrl}
      x={0}
      y={0}
      width={w}
      height={h}
      preserveAspectRatio="none"
      opacity={props.opacity}
      transform={`matrix(${a} ${b} ${c} ${d} ${tl.x} ${tl.y})`}
      pointerEvents="none"
      clipPath={props.clipPath}
      data-testid={props.testId}
      data-underlay={underlay.id}
    />
  )
  return (
    <g data-testid="underlay" data-underlay={underlay.id} data-past-crop={tracing ? 'shown' : 'cropped'}>
      <clipPath id={clipId}>
        <rect x={crop.min.x} y={crop.min.y} width={crop.max.x - crop.min.x} height={crop.max.y - crop.min.y} />
      </clipPath>
      {tracing ? picture({ opacity: opacity * OUTSIDE_CROP_DIM, testId: 'underlay-picture-past-crop' }) : null}
      {picture({ opacity, clipPath: `url(#${clipId})`, testId: 'underlay-picture' })}
    </g>
  )
}

/**
 * Spaces on a plan (F3): the drawings placed under the level, every space's
 * outline with its number, name and area, and the Draw space tool. Clicks add
 * corners (snapping to the drawing's linework, room corners and edges); Enter
 * or a click on the first corner closes it; Backspace takes back a corner;
 * Shift squares the leg; Esc stops with nothing changed. Area shows live.
 */
export function SpacesPlanLayer({ projectId, model, view, paperOf, paperPerPixel, submit, hint, mode, onDrawn, onCancel, selectedSpaceId, onSeparatorLine }: Props) {
  const level = viewModelLevel(model, view.view.props?.level, view.view.props?.levelElevationMm)
  const levelId = level?.id ?? null
  const z = level?.elevationMm ?? 0
  const underlays = useMemo(() => (levelId ? underlaysOnLevel(model.elements, levelId).filter((u) => !u.hidden) : []), [model, levelId])
  const spaces = useMemo(() => (levelId ? spacesOnLevel(model.elements, levelId) : []), [model, levelId])
  // Drawing tools act only in a drawing mode; a review only shows ghosts.
  const draw = mode && (mode.kind === 'new' || mode.kind === 'redraw') ? mode : null
  const separators = useMemo(() => (levelId ? separatorsOnLevel(model, levelId) : []), [model, levelId])
  const review = mode?.kind === 'review' ? mode : null
  const traceOver = useMemo(() => (levelId ? (traceableUnderlays(model, levelId)[0] ?? null) : null), [model, levelId])
  const { page: tracePage, linework } = useUnderlayPageFrom(useEditorHost().data.underlays, projectId, traceOver)
  const [corners, setCorners] = useState<Vec2[]>([])
  const [cursor, setCursor] = useState<{ point: Vec2; kind: SnapKind } | null>(null)
  const [shift, setShift] = useState(false)
  const linkedReference = useLinkedReferenceState()

  const snapLines = useMemo<SnapSegment[]>(() => {
    if (!draw || !levelId) return []
    const rooms = roomSnapSegments(model, levelId)
    return traceOver && isCalibrated(traceOver) ? [...lineworkSnapSegments(traceOver.calibration, linework), ...rooms] : rooms
  }, [draw, levelId, model, traceOver, linework])

  const toPaper = (p: Vec2): Vec2 => modelToPaperPoint(view, { x: p.x, y: p.y, z })
  // Paper mm per model mm along the plan's x axis.
  const paperPerModel = Math.max(1e-9, Math.hypot(toPaper({ x: 1000, y: 0 }).x - toPaper({ x: 0, y: 0 }).x, toPaper({ x: 1000, y: 0 }).y - toPaper({ x: 0, y: 0 }).y) / 1000)
  const toleranceMm = (8 * paperPerPixel) / paperPerModel

  const outline = draw?.shape === 'rectangle' ? (corners[0] && cursor ? rectangleOutline(corners[0], cursor.point) : []) : cursor && draw ? [...corners, cursor.point] : corners

  const finish = (points: readonly Vec2[]) => {
    if (!draw || !levelId) return
    if (points.length < 3) {
      hint('A space needs at least three corners. Keep clicking, or press Esc to stop.')
      return
    }
    const outlineMm = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
    const traced = traceOver ? traceOver.id : null
    let command: Command
    let spaceId: ElementId
    if (draw.kind === 'redraw') {
      spaceId = draw.spaceId
      command = { type: 'edit_space', spaceId, levelId, outline: outlineMm, ...(traced ? { tracedOver: traced } : {}) }
    } else {
      spaceId = newElementId('space') as ElementId
      const number = nextSpaceNumber(model, levelId)
      command = { type: 'create_space', spaces: [{ spaceId, number, name: `Space ${number}`, levelId, outline: outlineMm, origin: traced ? { kind: 'traced', underlayId: traced } : { kind: 'drawn' } }] }
    }
    const refused = submit(command, draw.kind === 'redraw' ? 'Redraw space' : 'Draw space')
    if (refused) {
      hint(refused)
      return
    }
    hint(`${draw.kind === 'redraw' ? 'Redrew' : 'Drew'} a space of ${formatFt2(polygonAreaFt2(outlineMm))}${traced ? ` over ${traceOver?.source.name}` : ''}. Name it and give it a use in the Spaces panel.`)
    setCorners([])
    onDrawn(spaceId)
  }

  useEffect(() => {
    if (!draw) return
    setCorners([])
    const base = traceOver
      ? `Tracing over ${traceOver.source.name}: click the corners of a space; clicks snap to its lines. Enter closes it, Backspace takes back a corner, Esc stops.`
      : underlays.some((u) => !isCalibrated(u))
        ? "The drawing on this level isn't calibrated yet, so tracing over it is off until you set its scale (Spaces panel › Calibrate). You can still draw spaces; clicks snap to room edges."
        : 'Click the corners of a space; clicks snap to room corners and edges. Enter closes it, Esc stops.'
    const linkedNote = linkedReference.status === 'ready' && linkedReference.index.items.length > 0 ? `Clicks also snap to the walls of ${linkedReference.index.sources.map((x) => x.label).join(', ')}.` : linkedReferenceWords(linkedReference)
    hint(linkedNote ? `${base} ${linkedNote}` : base)
    // Re-announce only when the tool starts, the drawing under it changes, or the linked model loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, traceOver?.id, linkedReference])

  useEffect(() => {
    if (!draw) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShift(e.type === 'keydown')
      if (e.type !== 'keydown') return
      if (e.key === 'Escape') {
        e.stopPropagation()
        setCorners([])
        hint('Stopped drawing; nothing changed.')
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish(corners)
      } else if (e.key === 'Backspace' && corners.length > 0) {
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
    // The linked model's wall faces and centre lines round the pointer snap too.
    const linked = linkedSnapNear(model, levelId, raw, toleranceMm)
    const linkedLines: SnapSegment[] = linked ? linked.lines.map((l) => ({ a: l.start, b: l.end, source: 'linked' as const })) : []
    const snapped = snapPoint(raw, linkedLines.length > 0 ? [...snapLines, ...linkedLines] : snapLines, corners, toleranceMm)
    setCursor(snapped)
    return snapped
  }

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0 || !draw) return
    e.stopPropagation()
    const at = aim(e)
    if (!at) return
    if (draw.shape === 'rectangle') {
      if (!corners[0]) setCorners([at.point])
      else finish(rectangleOutline(corners[0], at.point))
      return
    }
    if (at.kind === 'close') finish(corners)
    else setCorners((c) => [...c, at.point])
  }

  // Clicks land anywhere over the drawing being traced, not just inside the crop.
  const tracedCorners = traceOver && isCalibrated(traceOver) && tracePage.state === 'ready' ? underlayCorners(traceOver.calibration, tracePage.value.width, tracePage.value.height).map(toPaper) : []
  const r = traceHitRect(view.paperRect, tracedCorners, TRACE_HIT_MARGIN_MM)
  const liveArea = outline.length >= 3 ? polygonAreaFt2(outline) : null

  return (
    <g data-testid="spaces-plan-layer" data-level={levelId ?? ''}>
      {underlays.map((u) => (
        <UnderlayPicture key={u.id} projectId={projectId} underlay={u} view={view} z={z} tracing={draw !== null} />
      ))}
      {spaces.map((s) => {
        const polys = spaceOutlines(model.elements, s)
        if (polys.length === 0) return null
        const first = polys[0] ?? []
        const centre = first.reduce((acc, p) => ({ x: acc.x + p.x / first.length, y: acc.y + p.y / first.length }), { x: 0, y: 0 })
        const c = toPaper(centre)
        const selected = s.id === selectedSpaceId
        return (
          <g key={s.id} pointerEvents="none" data-testid="space-outline" data-space={s.id}>
            {polys.map((poly, i) => (
              <polygon key={i} points={poly.map((p) => { const q = toPaper(p); return `${q.x},${q.y}` }).join(' ')} fill={SPACE_FILL} stroke={PRIMARY} strokeWidth={selected ? 0.5 : 0.25} strokeDasharray={selected ? undefined : '1.2 0.6'} />
            ))}
            <text x={c.x} y={c.y} fontSize={2.2} textAnchor="middle" fill="currentColor">
              {spaceLabel(s)}
            </text>
          </g>
        )
      })}
      {separators.map((l) => {
        const a = toPaper(l.start)
        const b = toPaper(l.end)
        return <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PRIMARY} strokeWidth={0.3} strokeDasharray="1.6 0.8" pointerEvents="none" data-testid="space-separator" data-separator={l.id} />
      })}
      {review ? <ProposalGhosts proposals={review.proposals} label={review.label ?? 'Room'} toPaper={toPaper} /> : null}
      {mode?.kind === 'from_walls' && levelId ? <WallsRoomTool model={model} levelId={levelId} view={view} z={z} toPaper={toPaper} paperOf={paperOf} submit={submit} hint={hint} onDrawn={onDrawn} onCancel={onCancel} /> : null}
      {mode?.kind === 'separator' && levelId && onSeparatorLine ? <SeparatorTool model={model} levelId={levelId} view={view} z={z} toPaper={toPaper} paperOf={paperOf} hint={hint} onLine={onSeparatorLine} onCancel={onCancel} /> : null}
      {draw ? (
        <>
          {outline.length >= 2 ? (
            <polygon
              points={outline.map((p) => { const q = toPaper(p); return `${q.x},${q.y}` }).join(' ')}
              fill={SPACE_FILL}
              stroke={PRIMARY}
              strokeWidth={0.35}
              pointerEvents="none"
              data-testid="draw-space-preview"
              data-corners={corners.length}
            />
          ) : null}
          {cursor ? (
            <g pointerEvents="none" data-testid="draw-space-cursor" data-snap={cursor.kind}>
              <circle cx={toPaper(cursor.point).x} cy={toPaper(cursor.point).y} r={cursor.kind === 'none' ? 0.6 : 1} fill="none" stroke={PRIMARY} strokeWidth={0.3} />
              {liveArea !== null ? (
                <text x={toPaper(cursor.point).x + 2} y={toPaper(cursor.point).y - 2} fontSize={2.4} fill={PRIMARY} data-testid="draw-space-area">
                  {formatFt2(liveArea)}
                </text>
              ) : null}
            </g>
          ) : null}
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
            onDoubleClick={() => finish(corners)}
            onPointerLeave={() => setCursor(null)}
            data-testid="draw-space-hit"
          >
            <title>Draw a space: click its corners, Enter to close, Esc to stop.</title>
          </rect>
        </>
      ) : null}
    </g>
  )
}

const GHOST_STROKE: Record<ReviewedProposal['decision'], string> = {
  pending: PRIMARY,
  accepted: PRIMARY,
  rejected: 'currentColor',
}

/** Proposed rooms as ghosts: dashed until accepted, faint once rejected, door openings marked. Nothing here is in the model yet. */
function ProposalGhosts({ proposals, label, toPaper }: { readonly proposals: readonly ReviewedProposal[]; readonly label: string; readonly toPaper: (p: Vec2) => Vec2 }) {
  return (
    <g pointerEvents="none" data-testid="proposed-rooms">
      {proposals.map((p, i) => {
        const c = toPaper(p.room.centre)
        return (
          <g key={p.room.key} data-testid="proposed-room" data-room={p.room.key} data-decision={p.decision} opacity={p.decision === 'rejected' ? 0.35 : 1}>
            <polygon
              points={p.room.outline.map((q) => { const t = toPaper(q); return `${t.x},${t.y}` }).join(' ')}
              fill={p.decision === 'accepted' ? SPACE_FILL : 'transparent'}
              stroke={GHOST_STROKE[p.decision]}
              strokeWidth={0.35}
              strokeDasharray={p.decision === 'accepted' ? undefined : '1.6 0.8'}
            />
            {p.room.openings.map((o, k) => {
              const a = toPaper(o.a)
              const b = toPaper(o.b)
              return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={GHOST_STROKE[p.decision]} strokeWidth={0.6} data-testid="proposed-room-opening" />
            })}
            <text x={c.x} y={c.y} fontSize={2.2} textAnchor="middle" fill="currentColor">
              {`${label} ${i + 1}`}
            </text>
          </g>
        )
      })}
    </g>
  )
}
