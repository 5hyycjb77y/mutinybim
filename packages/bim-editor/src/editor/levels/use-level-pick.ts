'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { snapLevelHeight, viewerSurfacePicker, type SurfaceHit, type SurfacePicker } from './surface-pick'

/** A press that travels further than this (screen px) is an orbit or pan, not a pick. */
const CLICK_PX = 4

export const LEVEL_PICK_HINT = 'Click a roof or floor to take its height for the level. Orbit as usual; Esc to stop.'

/**
 * "Pick a surface" for a level, in the 3D view. While armed, a completed
 * click (not a drag: orbit and pan still work) asks the surface picker for
 * the surface under the pointer and hands back its height, snapped to 1/8".
 * The press is kept from the surface's own select / place handlers (so the
 * click goes to the level only); the camera's listeners still see it. Esc stops.
 */
export function useLevelPick({
  viewer,
  armed,
  onPicked,
  onCancel,
  hint,
  picker,
}: {
  readonly viewer: ModelViewer3D | null
  readonly armed: boolean
  readonly onPicked: (elevationMm: number, hit: SurfaceHit) => void
  readonly onCancel: () => void
  readonly hint: (text: string | null) => void
  /** Defaults to the viewer's surface pick. */
  readonly picker?: SurfacePicker
}) {
  const handlers = useRef({ onPicked, onCancel, hint })
  useLayoutEffect(() => {
    handlers.current = { onPicked, onCancel, hint }
  })

  useEffect(() => {
    if (!armed || !viewer) return
    const el = viewer.renderer.domElement
    const source = picker ?? viewerSurfacePicker(viewer)
    let down: { x: number; y: number; id: number } | null = null
    const previousCursor = el.style.getPropertyValue('cursor')
    el.style.setProperty('cursor', 'crosshair')
    handlers.current.hint(LEVEL_PICK_HINT)

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      down = { x: e.clientX, y: e.clientY, id: e.pointerId }
      // The surface's select / place handlers don't see the press; the camera's own listeners on the canvas still do.
      e.stopPropagation()
    }
    const onUp = (e: PointerEvent) => {
      const start = down
      down = null
      // Not stopped: the camera listens for the release on the document. The surface saw no press, so it does nothing with it.
      if (!start || start.id !== e.pointerId) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_PX) return
      source
        .pickSurface(e.clientX, e.clientY)
        .then((hit) => {
          if (!hit) {
            handlers.current.hint('Nothing under the pointer to take a height from. Click a roof or a floor slab, or Esc to stop.')
            return
          }
          handlers.current.onPicked(snapLevelHeight(hit.point.z), hit)
        })
        .catch((err: unknown) => {
          console.error('[useLevelPick] picking a surface for the level failed', err)
          handlers.current.hint("That surface couldn't be read. Try another spot, or Esc to stop.")
        })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      handlers.current.hint(null)
      handlers.current.onCancel()
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointerup', onUp, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      if (previousCursor) el.style.setProperty('cursor', previousCursor)
      else el.style.removeProperty('cursor')
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [armed, viewer, picker])
}
