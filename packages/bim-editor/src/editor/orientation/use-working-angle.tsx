'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { workFrameOf, type Command, type ModelState, type Vec2, type ViewElement, type WorkFrame } from '@permitzip/bim-kernel'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { viewerEdgePicker, type EdgeHit, type EdgePicker } from './edge-pick'
import type { WorkingAngleTarget } from './WorkingAnglePick'

const WorkingAnglePick = dynamic(() => import('./WorkingAnglePick').then((m) => m.WorkingAnglePick), { ssr: false })

interface Args {
  readonly viewer: ModelViewer3D | null
  readonly model: ModelState | null
  /** The view open in the canvas; its own working angle wins there. */
  readonly openView: ViewElement | null
  /** Takes the work frame the route and placement snaps follow. */
  readonly applyFrame: (frame: WorkFrame) => void
  /** The elevation picks land on when nothing is under the pointer (the active level, else the project origin). */
  readonly workPlaneMm: number
  /** A drawing (sheet or detail) covers the live view: picking is off. */
  readonly drawingShown: boolean
  readonly submit: (command: Command, label: string) => string | null
  readonly alignCropToEdge: (from: Vec2, to: Vec2) => string | null
  readonly onHint: (message: string) => void
  /** Edges of the surface under the pointer (linked-model faces), when the viewer offers a surface pick. */
  readonly surfaceEdges?: (clientX: number, clientY: number) => Promise<EdgeHit | null>
  /** The newest model at pick time; with it the edges are read when a pick runs (once per model), not on every edit. */
  readonly currentModel?: () => ModelState | null
}

export interface WorkingAngle {
  /** The frame route snaps, the placement grid and new crop boxes follow in the open view. */
  readonly frame: WorkFrame
  /** What an edge pick in progress will set; null when not picking. */
  readonly picking: WorkingAngleTarget | null
  readonly startPick: (target: WorkingAngleTarget) => void
  readonly stopPick: () => void
  /** The pick overlay to mount over the live view (null when not picking). */
  readonly overlay: ReactNode
}

/**
 * The working angle in the Building Model: keeps the session's snaps on the
 * open view's work frame, and runs "Align axes to an edge" (for the model, a
 * view, or the 3D crop box) as an overlay on the live view.
 */
export function useWorkingAngle({ viewer, model, openView, applyFrame, workPlaneMm, drawingShown, submit, alignCropToEdge, onHint, surfaceEdges, currentModel }: Args): WorkingAngle {
  const frame = useMemo(() => workFrameOf(model ?? { elements: {} }, openView), [model, openView])
  useEffect(() => {
    applyFrame(frame)
  }, [applyFrame, frame])

  const [picking, setPicking] = useState<WorkingAngleTarget | null>(null)
  const startPick = useCallback(
    (target: WorkingAngleTarget) => {
      setPicking(target)
      onHint(target.kind === 'crop' ? 'Click a wall, or two points along a building edge, to square the crop box to it.' : 'Click a wall, or two points along a building edge. Esc cancels.')
    },
    [onHint],
  )
  const stopPick = useCallback(() => setPicking(null), [])
  // Leaving the live view drops the pick.
  const [wasDrawing, setWasDrawing] = useState(drawingShown)
  if (wasDrawing !== drawingShown) {
    setWasDrawing(drawingShown)
    if (drawingShown) setPicking(null)
  }

  const picker = useMemo<EdgePicker | null>(() => {
    if (!viewer || !model) return null
    const extra = surfaceEdges ? { surfaceEdges } : {}
    if (!currentModel) return viewerEdgePicker({ viewer, model, elevationMm: workPlaneMm, ...extra })
    let built: { readonly model: ModelState; readonly picker: EdgePicker } | null = null
    const now = (): EdgePicker => {
      const m = currentModel() ?? model
      if (built?.model !== m) built = { model: m, picker: viewerEdgePicker({ viewer, model: m, elevationMm: workPlaneMm, ...extra }) }
      return built.picker
    }
    return { edgeAt: (x, y) => now().edgeAt(x, y), pointAt: (x, y) => now().pointAt(x, y) }
  }, [viewer, model, workPlaneMm, surfaceEdges, currentModel])
  const toCanvas = useCallback((p: Vec2) => viewer?.canvasPointOf(p.x, p.y, workPlaneMm) ?? null, [viewer, workPlaneMm])
  const canvasXY = useCallback(
    (clientX: number, clientY: number) => {
      const rect = viewer?.renderer.domElement.getBoundingClientRect()
      return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY }
    },
    [viewer],
  )

  const overlay =
    picking && picker && !drawingShown ? (
      <WorkingAnglePick picker={picker} target={picking} toCanvas={toCanvas} canvasXY={canvasXY} onCommit={submit} onCropEdge={alignCropToEdge} onExit={stopPick} onHint={onHint} />
    ) : null

  return { frame, picking, startPick, stopPick, overlay }
}
