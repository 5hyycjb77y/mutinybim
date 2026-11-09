'use client'

import { useEffect, useMemo, useState } from 'react'
import { localBounds, modelToPaperPoint, partToWorld, resolveGeometry, type Command, type ModelState, type PartTypeDefinition, type Vec2, type ViewOnPaper, type WorkFrame } from '@permitzip/bim-kernel'
import { ALIGN_SNAP_MM, POINT_SNAP_MM, drawingPlacementCommand, drawingPlacementTarget, newElementId, type DrawingPlacementSpec, type DrawingPlacementTarget } from '../placement'
import { linkedSnapNear } from '../linked-reference/linked-reference-store'

/** How far round the pointer a linked model's ends and faces are read, mm (the farther of the two snap reaches). */
const LINKED_PLACE_REACH_MM = Math.max(POINT_SNAP_MM, ALIGN_SNAP_MM)

const PRIMARY = 'var(--mutiny-selection)'

interface Props {
  readonly model: ModelState
  /** The drawing the person is on: a plan or section by itself, or the viewport opened on a sheet. */
  readonly view: ViewOnPaper
  /** What is being placed. A planned part is placed once; a new part type stays armed for the next click. */
  readonly spec: DrawingPlacementSpec
  /** Paper point under a pointer event on the overlay. */
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  /** The session's one edit path (`ModelEditBridge.submit`): the model's refusal in words, or null. */
  readonly submit: (command: Command, undoLabel: string) => string | null
  /** The status line under the ribbon. */
  readonly hint: (text: string | null) => void
  /** A part landed (its id). */
  readonly onPlaced: (partId: string) => void
  /** Esc: stop placing; nothing changes. */
  readonly onCancel: () => void
  readonly workFrame?: WorkFrame
}

function definitionOf(model: ModelState, spec: DrawingPlacementSpec): PartTypeDefinition | null {
  if (spec.kind === 'new') return spec.definition
  const part = model.elements[spec.partId]
  const type = part?.kind === 'part' ? model.elements[part.typeId] : undefined
  return type?.kind === 'part_type' ? type.definition : null
}

function nameOf(spec: DrawingPlacementSpec): string {
  return spec.kind === 'planned' ? spec.label : spec.definition.typeName
}

/**
 * Place a part on the drawing the person is on (U2, B9): a plan, section or
 * elevation by itself or the viewport opened on a sheet. The outline follows
 * the pointer on the drawing, a click sends one `place_part` (or
 * `place_planned_part` for a part from Not placed yet), R turns it, Esc stops.
 * The view never changes.
 */
export function PlaceOnDrawingLayer({ model, view, spec, paperOf, submit, hint, onPlaced, onCancel, workFrame }: Props) {
  const [rotationDeg, setRotationDeg] = useState(spec.rotationDeg)
  const [target, setTarget] = useState<DrawingPlacementTarget | null>(null)
  const definition = useMemo(() => definitionOf(model, spec), [model, spec])
  const box = useMemo(() => (definition ? localBounds(resolveGeometry(definition)) : null), [definition])
  const r = view.paperRect
  const name = nameOf(spec)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        hint(`Stopped placing ${name}; nothing changed.`)
        onCancel()
      } else if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setRotationDeg((d) => (d + 90) % 360)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hint, name, onCancel])

  const aim = (e: React.PointerEvent<SVGElement>): DrawingPlacementTarget | null => {
    const p = paperOf(e)
    if (!p) return null
    const placed = drawingPlacementTarget(model, view, p, spec.heightMm, workFrame, { ignorePlanes: e.shiftKey, linked: (levelId, at) => linkedSnapNear(model, levelId, at, LINKED_PLACE_REACH_MM) })
    if (!placed.ok) {
      hint(placed.reason)
      setTarget(null)
      return null
    }
    hint(`${name}: ${placed.target.where}. Click to place, R to turn it, Esc to stop.`)
    setTarget(placed.target)
    return placed.target
  }

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const at = aim(e)
    if (!at) return
    const partId = spec.kind === 'planned' ? spec.partId : newElementId('p')
    const refused = submit(drawingPlacementCommand({ ...spec, rotationDeg }, at, partId), `Place ${name}`)
    if (refused) {
      hint(refused)
      return
    }
    hint(`Placed ${name} ${at.where.charAt(0).toLowerCase()}${at.where.slice(1)}.`)
    onPlaced(partId)
  }

  // The footprint on paper: plans show the turned outline; sections a marker on the cut line at its height.
  const outline = useMemo(() => {
    if (!target || !box) return null
    const level = model.elements[target.levelId]
    const z = (level?.kind === 'level' ? level.elevationMm : 0) + target.offsetMm
    const at = { position: target.position, rotationDeg }
    const corners = view.mapping.kind === 'plan' ? [partToWorld(at, { x: box.min[0], y: box.min[1] }), partToWorld(at, { x: box.max[0], y: box.min[1] }), partToWorld(at, { x: box.max[0], y: box.max[1] }), partToWorld(at, { x: box.min[0], y: box.max[1] })].map((q) => modelToPaperPoint(view, { x: q.x, y: q.y, z })) : null
    return { center: modelToPaperPoint(view, { x: target.position.x, y: target.position.y, z }), corners }
  }, [target, box, model, view, rotationDeg])

  return (
    <g data-testid="place-on-drawing-layer" data-placing={spec.kind === 'planned' ? spec.partId : spec.typeId}>
      {outline ? (
        <g pointerEvents="none" data-testid="place-on-drawing-ghost" data-level={target?.levelId} data-x={target?.position.x} data-y={target?.position.y} data-offset={target?.offsetMm} data-plane={target?.planeId}>
          {outline.corners ? <polygon points={outline.corners.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={PRIMARY} strokeWidth={0.35} strokeDasharray="1 0.6" /> : null}
          <line x1={outline.center.x - 1.5} y1={outline.center.y} x2={outline.center.x + 1.5} y2={outline.center.y} stroke={PRIMARY} strokeWidth={0.3} />
          <line x1={outline.center.x} y1={outline.center.y - 1.5} x2={outline.center.x} y2={outline.center.y + 1.5} stroke={PRIMARY} strokeWidth={0.3} />
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
        onPointerLeave={() => setTarget(null)}
        data-testid="place-on-drawing-hit"
      >
        <title>{`Place ${name} in ${view.view.name}: click where it goes, R to turn it, Esc to stop.`}</title>
      </rect>
    </g>
  )
}
