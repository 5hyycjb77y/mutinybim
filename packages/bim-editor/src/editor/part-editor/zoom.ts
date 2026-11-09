/**
 * Wheel and trackpad zoom for the part editor's flat views. The step is the
 * one every MutinyBIM view uses (`@permitzip/bim-viewer-3d/wheel-zoom`): it
 * follows the wheel's travel, about 17% per mouse notch, at most 22% per
 * event. Zooming keeps the point under the pointer still
 * (an internal design note §7). Gestures come from
 * `input/flat-view-nav.ts`, as in sheets and drawings.
 */

import { MAX_WHEEL_STEP, wheelMagnification, type WheelDelta } from '@permitzip/bim-viewer-3d/wheel-zoom'

export const MAX_STEP = MAX_WHEEL_STEP

export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 40

export type WheelLike = WheelDelta

/** How much one wheel event magnifies: above 1 zooms in (deltaY < 0), below 1 out. */
export function wheelZoomFactor(e: WheelLike): number {
  return wheelMagnification(e)
}

export interface FlatViewState {
  readonly zoom: number
  /** The view's centre in view coordinates; null: centred on the part. */
  readonly center: { readonly u: number; readonly v: number } | null
}

/** Zoom by `factor` keeping `at` (the point under the pointer) where it is on screen. */
export function zoomAt(view: FlatViewState, factor: number, at: { readonly u: number; readonly v: number }, currentCenter: { readonly u: number; readonly v: number }): FlatViewState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor))
  const f = zoom / view.zoom
  if (f === 1) return view
  return { zoom, center: { u: at.u + (currentCenter.u - at.u) / f, v: at.v + (currentCenter.v - at.v) / f } }
}

/** Pan by a screen drag of (du, dv) view units (v up): the part follows the pointer. */
export function panBy(view: FlatViewState, currentCenter: { readonly u: number; readonly v: number }, du: number, dv: number): FlatViewState {
  return { zoom: view.zoom, center: { u: currentCenter.u - du, v: currentCenter.v - dv } }
}
