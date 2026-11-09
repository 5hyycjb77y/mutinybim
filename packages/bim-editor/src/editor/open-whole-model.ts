/**
 * Opening the whole model (3D model, or Top-down plan: all levels, looking
 * down) in the canvas. Review video (Nov 6, 23:38): Top-down plan opened
 * blank. Coming from a saved plan, the viewer was already in plan mode, so the
 * plan's crop box and cut height stayed on, and nothing framed the model, so
 * the camera kept looking at whatever the last view looked at.
 */
import type { ModelViewer3D, PlanCameraState } from '@permitzip/bim-viewer-3d'

export type WholeModelViewer = Pick<ModelViewer3D, 'setAuthoredLevels' | 'setVerticalSection' | 'setMode' | 'setPlanCrop' | 'resetPlanCut' | 'isolateLevel' | 'frame' | 'setPlanCamera'>

/**
 * `frame: false`: the viewer already shows this whole-model plan (the person looked at a drawing and came
 * back), so it keeps where they were, zoom and all. Framing again reset it under them.
 * `planCamera`: the Top-down plan as this person left it before opening other views; it reopens there
 * instead of framing everything.
 */
export async function openWholeModel(viewer: WholeModelViewer, mode: 'plan' | '3d', levelFilter: string, opts: { readonly frame?: boolean; readonly planCamera?: PlanCameraState | null } = {}): Promise<void> {
  viewer.setAuthoredLevels(null)
  await viewer.setVerticalSection(null)
  viewer.setMode(mode)
  if (mode === 'plan') {
    // A saved plan's crop box and cut height belong to that plan, not to "All levels".
    viewer.setPlanCrop(null)
    viewer.resetPlanCut()
  }
  await viewer.isolateLevel(levelFilter === 'all' ? null : levelFilter)
  if (mode !== 'plan') return
  // Coming back after other views or a drawing: where this person left the Top-down plan, zoom and all.
  if (opts.planCamera) await viewer.setPlanCamera(opts.planCamera)
  // Framed once as it opens; Properties opening on a pick must not move the plan under the pointer.
  else if (opts.frame !== false) await viewer.frame(undefined, false, { followInsets: false })
}

/** The canvas key the Top-down plan opens under (`model:plan`). */
export const TOP_DOWN_PLAN_KEY = 'model:plan'

/**
 * Where the Top-down plan was left, for one tab and one viewer: kept as the
 * person opens another view, given back when they reopen it. View state, so
 * it lives with the tab and is not saved (the free 3D view's camera is).
 */
export class TopDownPlanMemory {
  private kept: { readonly viewer: unknown; readonly camera: PlanCameraState } | null = null
  // A drawing covers the plan: the viewer under it can be re-fitted to a resized canvas, so the camera
  // kept as the drawing opened stands until the plan is shown again.
  private covered = false

  /** The canvas is switching from `from` to `to`; leaving the Top-down plan keeps its camera. */
  switching(viewer: Pick<ModelViewer3D, 'planCameraState'>, from: string | null, to: string): void {
    if (from !== TOP_DOWN_PLAN_KEY || to === from) return
    if (this.covered) {
      this.covered = false
      return
    }
    const camera = viewer.planCameraState()
    if (camera) this.kept = { viewer, camera }
  }

  /** A drawing opens over what the canvas last showed (`shown`); over the Top-down plan, its camera is kept. */
  coveredByDrawing(viewer: Pick<ModelViewer3D, 'planCameraState'>, shown: string | null): void {
    if (shown !== TOP_DOWN_PLAN_KEY || this.covered) return
    this.switching(viewer, shown, 'drawing')
    this.covered = true
  }

  /** The camera to reopen `key` with on this viewer, given back once; null to frame it (or keep it, coming back). */
  cameraFor(viewer: unknown, key: string): PlanCameraState | null {
    const kept = this.kept
    if (key !== TOP_DOWN_PLAN_KEY || kept === null || kept.viewer !== viewer) return null
    this.kept = null
    this.covered = false
    return kept.camera
  }
}
