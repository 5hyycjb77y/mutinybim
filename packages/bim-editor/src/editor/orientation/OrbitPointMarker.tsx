'use client'

import { useEffect, useRef, useState } from 'react'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { cn } from '../../ui/cn'

/** The marker fades out this long after the orbit stops, ms. */
export const ORBIT_MARKER_IDLE_MS = 1200
const SIZE_PX = 18

type MarkerViewer = Pick<ModelViewer3D, 'onCameraChange' | 'orbitPointScreen' | 'orbiting'>

/**
 * What the 3D view turns around: a small flat ring and dot drawn over the
 * canvas (not an object in the 3D scene) at the orbit point the last click or
 * wheel zoom chose, else the middle of the model. It shows only while an
 * orbit turns the view, and fades out after a moment of stillness. Zooming
 * and setting the point do not show it; it never follows the pointer and
 * carries no label.
 */
export function OrbitPointMarker({ viewer, enabled }: { readonly viewer: MarkerViewer; readonly enabled: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const off = viewer.onCameraChange(() => {
      if (!viewer.orbiting()) return
      setAt(viewer.orbitPointScreen())
      setVisible(true)
      if (idle.current) clearTimeout(idle.current)
      idle.current = setTimeout(() => setVisible(false), ORBIT_MARKER_IDLE_MS)
    })
    return () => {
      off()
      if (idle.current) clearTimeout(idle.current)
      idle.current = null
    }
  }, [viewer, enabled])

  if (!at) return null
  return (
    <svg
      aria-hidden
      data-testid="orbit-point-marker"
      data-visible={visible && enabled ? 'true' : 'false'}
      width={SIZE_PX}
      height={SIZE_PX}
      viewBox="0 0 18 18"
      className={cn('pointer-events-none absolute text-(--mutiny-viewer-selection-outline) transition-opacity duration-300 ease-out', visible && enabled ? 'opacity-90' : 'opacity-0')}
      style={{ left: at.x - SIZE_PX / 2, top: at.y - SIZE_PX / 2 }}
    >
      <circle cx="9" cy="9" r="6.5" fill="none" className="stroke-(--mutiny-surface)" strokeWidth="3.5" strokeOpacity="0.7" />
      <circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="1.75" fill="currentColor" />
    </svg>
  )
}
