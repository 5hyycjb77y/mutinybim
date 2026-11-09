'use client'

import { useEffect, useState } from 'react'
import type { LevelPlanes, LevelPlaneSpec, ModelViewer3D, PlanExtentMm } from '@permitzip/bim-viewer-3d'

/**
 * Mount the 3D level planes on the viewer. `show` is the person's toggle and
 * the view mode together (plans cut through levels; they draw none).
 * `extentKey` changes when what's loaded changes (a linked model arrives), so
 * the outlines re-fit the building.
 *
 * The planes are three.js objects, so they are built once the viewer exists,
 * from the same dynamic import that brought the viewer (already loaded by
 * then); the surface's first load carries no three.js.
 */
export function useLevelPlanes({
  viewer,
  levels,
  show,
  highlightedId,
  extentKey,
}: {
  readonly viewer: ModelViewer3D | null
  readonly levels: readonly LevelPlaneSpec[]
  readonly show: boolean
  readonly highlightedId: string | null
  readonly extentKey: unknown
}) {
  const [planes, setPlanes] = useState<LevelPlanes | null>(null)

  useEffect(() => {
    if (!viewer || planes) return
    let cancelled = false
    import('@permitzip/bim-viewer-3d')
      .then((m) => {
        if (!cancelled) setPlanes(new m.LevelPlanes({ line: '#0f2a4a', highlight: '#ff7a1a', background: '#ffffff' }))
      })
      .catch((err: unknown) => console.error('[useLevelPlanes] loading the 3D level planes failed; the 3D view shows no level outlines', err))
    return () => {
      cancelled = true
    }
  }, [viewer, planes])

  useEffect(() => (planes ? () => planes.dispose() : undefined), [planes])

  useEffect(() => {
    if (!viewer || !planes) return
    const c = viewer.colors
    planes.setColors({ line: c.edges, highlight: c.selection, background: c.background })
    viewer.scene.add(planes.object)
    return () => {
      planes.object.removeFromParent()
    }
  }, [viewer, planes])

  useEffect(() => {
    if (!viewer || !planes) return
    let cancelled = false
    viewer
      .sceneExtentMm()
      .then((box) => {
        if (cancelled) return
        const extent: PlanExtentMm | null = box ? { min: { x: box.min.x, y: box.min.y }, max: { x: box.max.x, y: box.max.y } } : null
        // Nothing to fit yet: a 30 m square round the origin, so new levels still show.
        planes.set(levels, extent ?? { min: { x: -15000, y: -15000 }, max: { x: 15000, y: 15000 } })
      })
      .catch((err: unknown) => console.error('[useLevelPlanes] measuring the scene for the level planes failed', err))
    return () => {
      cancelled = true
    }
  }, [viewer, planes, levels, extentKey])

  useEffect(() => planes?.setVisible(show), [planes, show])
  useEffect(() => planes?.setHighlighted(highlightedId), [planes, highlightedId])
}
