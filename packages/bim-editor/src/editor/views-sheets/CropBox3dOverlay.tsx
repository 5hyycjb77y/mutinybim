'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import type { GripOnScreen, ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { faceSnapOffsets, pushFace, snapOffset, type Aabb3, type CropBox3d, type CropFace, type ModelState } from '@permitzip/bim-kernel'
import { feet } from './crop-geometry'

const FT = 304.8
/** Arrow keys on a focused grip move its face this far (Shift: both faces). */
const NUDGE_MM = FT

export const FACE_LABEL: Readonly<Record<CropFace, string>> = { 'x+': 'east side', 'x-': 'west side', 'y+': 'north side', 'y-': 'south side', 'z+': 'top', 'z-': 'bottom' }

interface Props {
  readonly viewer: ModelViewer3D
  readonly model: ModelState
  readonly box: CropBox3d
  /** Crop is on (the drag clips live); off, the drag moves only the outline. */
  readonly cropOn: boolean
  /** The model's extent (linked models included): faces snap to it. */
  readonly extent: Aabb3 | null
  readonly canEdit: boolean
  readonly blockedReason: string
  /** Save the new box; returns the refusal, if any. */
  readonly onCommit: (box: CropBox3d, label: string) => string | null
}

interface Drag {
  readonly face: CropFace
  readonly startBox: CropBox3d
  /** Pointer's offset along the face normal when grabbed (mm), so the face doesn't jump to the pointer. */
  readonly grabOffsetMm: number
  readonly box: CropBox3d
  readonly snapped: boolean
}

/**
 * Six flat face grips over the 3D crop box. Dragging one pushes or pulls that
 * face along its own normal (Shift: the opposite face too, keeping the
 * centre), snapping to levels and the model's extents (Alt: no snapping). The
 * model is clipped live while dragging; releasing saves one change that undo
 * reverses; Esc cancels. Dragging never moves the camera.
 */
export function CropBox3dOverlay({ viewer, model, box, cropOn, extent, canEdit, blockedReason, onCommit }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [drag, setDragState] = useState<Drag | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The drag as of the last pointer event (handlers run between renders). */
  const dragRef = useRef<Drag | null>(null)
  /** Gives the pointer back to the camera (the grip claims it for the drag; the wheel keeps zooming). */
  const releasePointerRef = useRef<(() => void) | null>(null)
  const setDrag = (next: Drag | null) => {
    dragRef.current = next
    setDragState(next)
  }
  const releasePointer = () => {
    const release = releasePointerRef.current
    releasePointerRef.current = null
    release?.()
  }

  useEffect(() => () => {
    releasePointerRef.current?.()
    releasePointerRef.current = null
  }, [viewer])

  useEffect(() => viewer.onCameraChange(redraw), [viewer])

  const preview = (next: CropBox3d | null) => {
    // The live clip follows the drag; the saved box comes back when the drag ends.
    viewer.setCropBox(next ?? box, { crop: cropOn, show: true })
  }

  const cancel = () => {
    if (!dragRef.current) return
    setDrag(null)
    releasePointer()
    preview(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const grab = (face: CropFace) => (e: React.PointerEvent<SVGElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (!canEdit) {
      setError(blockedReason)
      return
    }
    const offset = viewer.cropFaceOffsetAt(face, e.clientX, e.clientY)
    if (offset === null) {
      setError(`You're looking straight at the ${FACE_LABEL[face]}. Turn the view a little to drag it, or type its size in the properties.`)
      return
    }
    svgRef.current?.setPointerCapture(e.pointerId)
    releasePointer()
    releasePointerRef.current = viewer.claimPointer('crop-grip')
    setError(null)
    setDrag({ face, startBox: box, grabOffsetMm: offset, box, snapped: false })
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d) return
    // Measured from the face where the drag started (the viewer's box is the preview by now).
    const start = d.startBox
    const raw = viewer.cropFaceOffsetAt(d.face, e.clientX, e.clientY, start)
    if (raw === null) return
    const delta = raw - d.grabOffsetMm
    const candidates = e.altKey ? [] : faceSnapOffsets(model, start, d.face, extent)
    const side = d.face[0] === 'x' ? start.halfSize.x : d.face[0] === 'y' ? start.halfSize.y : start.halfSize.z
    const { offsetMm, snapped } = snapOffset(delta, candidates, Math.max(150, side * 0.04))
    const next = pushFace(start, d.face, offsetMm, e.shiftKey)
    setDrag({ ...d, box: next, snapped })
    preview(next)
  }

  const onUp = () => {
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    releasePointer()
    if (d.box === d.startBox) {
      preview(null)
      return
    }
    const refusal = onCommit(d.box, `move the 3D crop box's ${FACE_LABEL[d.face]}`)
    setError(refusal)
    if (refusal) preview(null)
  }

  const nudge = (face: CropFace) => (e: React.KeyboardEvent<SVGElement>) => {
    const out = e.key === 'ArrowUp' || e.key === 'ArrowRight'
    const back = e.key === 'ArrowDown' || e.key === 'ArrowLeft'
    if (!out && !back) return
    e.preventDefault()
    if (!canEdit) {
      setError(blockedReason)
      return
    }
    setError(onCommit(pushFace(box, face, out ? NUDGE_MM : -NUDGE_MM, e.shiftKey), `move the 3D crop box's ${FACE_LABEL[face]}`))
  }

  const grips: readonly GripOnScreen[] = viewer.cropGrips() ?? []
  const shown = drag?.box ?? box
  const size = `${feet(shown.halfSize.x * 2)} × ${feet(shown.halfSize.y * 2)} × ${feet(shown.halfSize.z * 2)} ft`

  return (
    <svg
      ref={svgRef}
      className={`absolute inset-0 h-full w-full ${drag ? 'pointer-events-auto' : 'pointer-events-none'}`}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={cancel}
      aria-label="3D crop box"
      data-testid="crop-3d-overlay"
      data-crop-box={JSON.stringify(shown)}
    >
      {grips.map((g) => (
        <circle
          key={g.face}
          cx={g.x}
          cy={g.y}
          r={drag?.face === g.face ? 7 : 6}
          fill={g.facing ? 'var(--mutiny-selection)' : 'var(--mutiny-panel)'}
          stroke="var(--mutiny-selection)"
          strokeWidth={1.5}
          opacity={g.facing ? 0.95 : 0.6}
          tabIndex={0}
          role="slider"
          aria-label={`Crop box ${FACE_LABEL[g.face]}. Drag, or press the arrow keys, to move it. Shift moves the opposite side too.`}
          aria-valuetext={size}
          className={`pointer-events-auto ${canEdit ? 'cursor-grab' : 'cursor-not-allowed'} outline-none focus-visible:stroke-[3]`}
          onPointerDown={grab(g.face)}
          onKeyDown={nudge(g.face)}
          data-testid={`crop-3d-grip-${g.face}`}
        >
          <title>{canEdit ? `Drag to move the ${FACE_LABEL[g.face]} (Shift: both sides, Alt: no snapping)` : blockedReason}</title>
        </circle>
      ))}
      {drag && (
        <foreignObject x={8} y={8} width={460} height={32}>
          <div className="rounded-md border bg-background/95 px-2 py-1 text-xs shadow-sm" role="status" data-testid="crop-3d-drag-status">
            {`Crop box ${size}${drag.snapped ? ', lined up with a level or the model edge' : ''}. Release to save, Esc to cancel.`}
          </div>
        </foreignObject>
      )}
      {error && !drag && (
        <foreignObject x={8} y={8} width={460} height={48}>
          <div className="pointer-events-auto rounded-md border bg-background/95 px-2 py-1 text-xs text-danger-600 shadow-sm" role="alert">
            {error}
          </div>
        </foreignObject>
      )}
    </svg>
  )
}
