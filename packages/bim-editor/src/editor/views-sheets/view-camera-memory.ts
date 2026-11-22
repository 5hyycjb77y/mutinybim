import type { View3dCamera, ViewElement } from '@permitzip/bim-kernel'
import { FREE_3D_KEY } from '../../contracts/building-model/view-camera-prefs'

/**
 * Which camera a person's last look is remembered under: the open 3D view's
 * id, or the model's own 3D when no view is open. Plans, sections, sheets and
 * printed drawings have no remembered camera (their framing is the view's).
 */
export function cameraMemoryKey(open: { readonly kind: string; readonly mode?: string }, openView: Pick<ViewElement, 'id' | 'viewType'> | null, showDrawing: boolean): string | null {
  if (showDrawing) return null
  if (openView) return openView.viewType === 'three_d' ? openView.id : null
  return open.kind === 'model' && open.mode === '3d' ? FREE_3D_KEY : null
}

/** Within a millimetre and a hundredth of a degree: the same look (a settle that didn't move isn't saved again). */
export function sameCamera(a: View3dCamera | undefined, b: View3dCamera): boolean {
  if (!a) return false
  const near = (p: View3dCamera['eye'], q: View3dCamera['eye']) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1 && Math.abs(p.z - q.z) < 1
  return near(a.eye, b.eye) && near(a.target, b.target) && Math.abs(a.fovDeg - b.fovDeg) < 0.01 && Math.abs(a.orthoHeightMm - b.orthoHeightMm) < 1
}

/**
 * Whether any camera placement is in flight. Opening a view moves the camera in
 * steps (the mode conversion, isolating the level, the saved camera), and every
 * step settles: a settle that lands while a placement is still running says
 * where the camera was before the view opened (the previous view's position),
 * not where this person is — remembering it would make the view open at the
 * previous view's camera from then on. Overlapping placements may finish in any
 * order (a newer view can finish before an older one exits an awaited step), so
 * each start returns a unique token and remembering stays paused until every
 * active placement has finished.
 */
export class CameraPlacement {
  private next = 0
  private readonly active = new Set<number>()

  start(): number {
    const token = ++this.next
    this.active.add(token)
    return token
  }

  finish(token: number): void {
    this.active.delete(token)
  }

  get inFlight(): boolean {
    return this.active.size > 0
  }
}

/**
 * What re-frames the canvas when a view changes. A 3D view is framed by its
 * saved camera and its level only; hiding a category, a visual style, phases
 * or line weights change what is drawn, never where you are looking (the product owner,
 * 50:35: hiding ceilings "zoomed out and reset the whole thing").
 */
export function framingSignature(view: ViewElement): string {
  const { projection: _projection, ...props } = view.props ?? {}
  if (view.viewType !== 'three_d') return JSON.stringify([view.viewType, view.cropMin, view.cropMax, props])
  return JSON.stringify([view.viewType, props.camera3d ?? null, props.camera3d ? null : [view.cropMin, view.cropMax], props.level ?? null])
}
