import type { ModelViewer3D, Pick as ViewerPick } from '@permitzip/bim-viewer-3d'
import type { BuildingModelTool } from './building-model-ribbon'

/** A press that moves less than this before it is released is a click, px. */
export const CLICK_SLOP_PX = 4

export interface ClickContext {
  readonly tool: BuildingModelTool
  /** Looking down in plan, where the view does not orbit. */
  readonly planOpen: boolean
}

type OrbitPointViewer = Pick<ModelViewer3D, 'setOrbitPoint' | 'pick'>

/**
 * Sets the 3D orbit point from a completed click in Select mode: the surface
 * point the click hit. It only changes what the view turns around; zooming
 * goes toward the pointer either way (the viewer's wheel). A press, a held
 * button and a drag never set it; a double-click on empty space puts it back
 * to the middle of the model. Other tools (route, place, measure, ...) never
 * touch it.
 */
export class OrbitPointClicks {
  private down: { x: number; y: number } | null = null

  /** Pointer down. Only remembers where; the orbit point does not change. */
  press(clientX: number, clientY: number) {
    this.down = { x: clientX, y: clientY }
  }

  /** Pointer up: true when it completes a click (moved under 4 px since the press). Forgets the press either way. */
  release(clientX: number, clientY: number): boolean {
    const start = this.down
    this.down = null
    return start !== null && Math.hypot(clientX - start.x, clientY - start.y) < CLICK_SLOP_PX
  }

  /** After a completed click picked `hit` (what selection used): orbit there from now on. */
  clicked(viewer: OrbitPointViewer | null | undefined, hit: ViewerPick | null, ctx: ClickContext) {
    if (!viewer || !hit || !applies(ctx)) return
    viewer.setOrbitPoint([hit.point.x, hit.point.y, hit.point.z])
  }

  /** A double-click on empty space (nothing under it) goes back to orbiting the middle of the model. */
  async doubleClicked(viewer: OrbitPointViewer | null | undefined, clientX: number, clientY: number, ctx: ClickContext) {
    if (!viewer || !applies(ctx)) return
    const hit = await viewer.pick(clientX, clientY)
    if (!hit) viewer.setOrbitPoint(null)
  }
}

function applies(ctx: ClickContext): boolean {
  return ctx.tool === 'select' && !ctx.planOpen
}
