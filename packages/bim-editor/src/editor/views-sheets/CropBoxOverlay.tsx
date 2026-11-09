'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import type { Rect, Vec2, ViewElement } from '@permitzip/bim-kernel'
import { CROP_HANDLES, HANDLE_CURSOR, HANDLE_LABEL, annotationCropRect, dragRect, feet, handlePoint, type CropHandle } from './crop-geometry'
import type { SubmitCommand } from './types'

/** Smallest crop box side while dragging, mm (1 ft). */
const MIN_CROP_MM = 304.8

interface Props {
  readonly viewer: Pick<ModelViewer3D, 'onCameraChange' | 'setNavigationEnabled' | 'canvasPointOf' | 'planPointAt'>
  readonly view: ViewElement
  /** The crop box in the view's own frame (plan mm; sections along-cut mm by elevation mm). */
  readonly crop: Rect
  /** Plans and 3D views: elevation the box is drawn at (the level's floor). */
  readonly elevationMm: number
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: SubmitCommand
}

interface Drag {
  readonly handle: CropHandle
  readonly startClient: Vec2
  /** Plans: the plan point under the pointer at the start. Sections: unused. */
  readonly startPlan: Vec2 | null
  readonly startCrop: Rect
  readonly rect: Rect
}

/**
 * The open view's crop box over the live model: its boundary and eight grips
 * (four edges, four corners). Dragging previews here only; releasing saves
 * one set_view_crop, which undo reverses. Plans and 3D views draw the box on
 * the level's floor; sections draw it on the cut plane (width along the cut
 * by height).
 */
export function CropBoxOverlay({ viewer, view, crop, elevationMm, canEdit, blockedReason, submit }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => viewer.onCameraChange(redraw), [viewer])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag) {
        setDrag(null)
        viewer.setNavigationEnabled(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag, viewer])

  const cut = view.viewType === 'section' ? view.props?.section ?? null : null
  const axis = cut ? unit({ x: cut.end.x - cut.start.x, y: cut.end.y - cut.start.y }) : null

  /** Canvas pixel of a point in the crop's frame. */
  const toScreen = (p: Vec2): Vec2 | null => {
    if (cut && axis) return viewer.canvasPointOf(cut.start.x + axis.x * p.x, cut.start.y + axis.y * p.x, p.y)
    return viewer.canvasPointOf(p.x, p.y, elevationMm)
  }

  /** Model movement for a pointer movement: plans read the floor under the pointer; sections invert the cut plane's on-screen axes. */
  const deltaFor = (d: Drag, client: Vec2): Vec2 | null => {
    if (!cut) {
      const now = viewer.planPointAt(client.x, client.y, elevationMm)
      return now && d.startPlan ? { x: now.x - d.startPlan.x, y: now.y - d.startPlan.y } : null
    }
    const at = handlePoint(d.startCrop, d.handle, true)
    const s0 = toScreen(at)
    const su = toScreen({ x: at.x + 1000, y: at.y })
    const sv = toScreen({ x: at.x, y: at.y + 1000 })
    if (!s0 || !su || !sv) return null
    const a = (su.x - s0.x) / 1000
    const c = (su.y - s0.y) / 1000
    const b = (sv.x - s0.x) / 1000
    const e = (sv.y - s0.y) / 1000
    const det = a * e - b * c
    if (Math.abs(det) < 1e-9) return null
    const dx = client.x - d.startClient.x
    const dy = client.y - d.startClient.y
    return { x: (e * dx - b * dy) / det, y: (a * dy - c * dx) / det }
  }

  const grab = (handle: CropHandle) => (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (!canEdit) {
      setError(blockedReason)
      return
    }
    svgRef.current?.setPointerCapture(e.pointerId)
    viewer.setNavigationEnabled(false)
    setError(null)
    setDrag({ handle, startClient: { x: e.clientX, y: e.clientY }, startPlan: cut ? null : viewer.planPointAt(e.clientX, e.clientY, elevationMm), startCrop: crop, rect: crop })
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const delta = deltaFor(drag, { x: e.clientX, y: e.clientY })
    if (delta) setDrag({ ...drag, rect: dragRect(drag.startCrop, drag.handle, delta, MIN_CROP_MM, true) })
  }

  const onUp = () => {
    const d = drag
    if (!d) return
    setDrag(null)
    viewer.setNavigationEnabled(true)
    const moved = Math.abs(d.rect.min.x - d.startCrop.min.x) + Math.abs(d.rect.max.x - d.startCrop.max.x) + Math.abs(d.rect.min.y - d.startCrop.min.y) + Math.abs(d.rect.max.y - d.startCrop.max.y)
    if (moved < 1) return
    const rounded: Rect = { min: { x: Math.round(d.rect.min.x), y: Math.round(d.rect.min.y) }, max: { x: Math.round(d.rect.max.x), y: Math.round(d.rect.max.y) } }
    setError(submit({ type: 'set_view_crop', viewId: view.id, crop: rounded }, `change the crop box of ${view.name}`))
  }

  const shown = drag?.rect ?? crop
  const screenPolygon = (r: Rect): Vec2[] | null => {
    const corners = [r.min, { x: r.max.x, y: r.min.y }, r.max, { x: r.min.x, y: r.max.y }].map(toScreen)
    return corners.every((c): c is Vec2 => c !== null) ? corners : null
  }
  const polygon = screenPolygon(shown)
  const notesRect = annotationCropRect(shown, view.props)
  const notesPolygon = notesRect ? screenPolygon(notesRect) : null
  const size = { w: shown.max.x - shown.min.x, h: shown.max.y - shown.min.y }

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 h-full w-full ${drag ? 'pointer-events-auto' : 'pointer-events-none'}`}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        setDrag(null)
        viewer.setNavigationEnabled(true)
      }}
      aria-label={`Crop box of ${view.name}`}
      data-testid="crop-overlay"
      data-crop={`${Math.round(shown.min.x)},${Math.round(shown.min.y)},${Math.round(shown.max.x)},${Math.round(shown.max.y)}`}
    >
      {notesPolygon && (
        <g data-testid="annotation-crop-region">
          <polygon points={notesPolygon.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--mutiny-selection)" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="2 3" />
          {notesPolygon[2] && (
            <text x={notesPolygon[2].x - 4} y={notesPolygon[2].y - 6} fontSize={11} textAnchor="end" fill="var(--mutiny-selection)">
              Annotation crop: notes, tags and dimensions may reach this far
            </text>
          )}
        </g>
      )}
      {polygon && (
        <>
          <polygon points={polygon.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--mutiny-selection)" strokeWidth={1.5} strokeDasharray="8 4" />
          {polygon[3] && (
            <text x={polygon[3].x + 4} y={polygon[3].y - 6} fontSize={11} fill="var(--mutiny-selection)">
              {drag ? `Crop box ${feet(size.w)} × ${feet(size.h)} ft. Release to save, Esc to cancel.` : 'Crop box'}
            </text>
          )}
          {CROP_HANDLES.map((h) => {
            const at = toScreen(handlePoint(shown, h, true))
            if (!at) return null
            return (
              <rect
                key={h}
                x={at.x - 5}
                y={at.y - 5}
                width={10}
                height={10}
                fill="var(--mutiny-panel)"
                stroke="var(--mutiny-selection)"
                strokeWidth={1.5}
                className={`pointer-events-auto ${canEdit ? HANDLE_CURSOR[h] : 'cursor-not-allowed'}`}
                onPointerDown={grab(h)}
                data-testid={`crop-handle-${h}`}
              >
                <title>{canEdit ? `Drag the crop box's ${HANDLE_LABEL[h]}` : blockedReason}</title>
              </rect>
            )
          })}
        </>
      )}
      {error && (
        <foreignObject x={8} y={8} width={420} height={48}>
          <div className="pointer-events-auto rounded-md border bg-background/95 px-2 py-1 text-xs text-danger-600 shadow-sm" role="alert">
            {error}
          </div>
        </foreignObject>
      )}
    </svg>
  )
}

function unit(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y) || 1
  return { x: v.x / len, y: v.y / len }
}
