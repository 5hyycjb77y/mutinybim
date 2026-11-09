'use client'

import { useEffect, useState } from 'react'
import type { RunPoint, Vec2 } from '@permitzip/bim-kernel'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { ROUTE_CHECK_COLOUR, routeTicksAcross, type RouteTick } from './view-input/route-ticks'

/** Half a tick's length and its thickness, in screen px. */
const TICK_HALF_PX = 9
const TICK_WIDTH_PX = 2.5

export interface LivePlanRouteTicksProps {
  readonly viewer: Pick<ModelViewer3D, 'canvasPointOf' | 'onCameraChange'>
  /** Where the route checks' ticks go (the session's `routeTicks`, the same points drawings tick). */
  readonly ticks: readonly RunPoint[]
  /** The previewed pieces they sit across (the session's `routeTickPieces`). */
  readonly pieces: readonly { readonly a: RunPoint; readonly b: RunPoint }[]
}

/** A tick as a thin band, so it has area at any angle. */
function band(t: RouteTick): string {
  const dx = t.b.x - t.a.x
  const dy = t.b.y - t.a.y
  const len = Math.hypot(dx, dy) || 1
  const ox = (-dy / len) * (TICK_WIDTH_PX / 2)
  const oy = (dx / len) * (TICK_WIDTH_PX / 2)
  return [
    [t.a.x + ox, t.a.y + oy],
    [t.b.x + ox, t.b.y + oy],
    [t.b.x - ox, t.b.y - oy],
    [t.a.x - ox, t.a.y - oy],
  ]
    .map(([x, y]) => `${x},${y}`)
    .join(' ')
}

/**
 * The route checks' ticks over the live plan while a route is drawn: the
 * same points and the same tick-across-the-piece geometry as the drawings
 * (`ModelDrawingLayer`), placed with the viewer's projection and redrawn as
 * the camera moves.
 */
export function LivePlanRouteTicks({ viewer, ticks, pieces }: LivePlanRouteTicksProps) {
  const [, setCamera] = useState(0)
  useEffect(() => {
    let frame = 0
    const off = viewer.onCameraChange(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setCamera((n) => n + 1))
    })
    return () => {
      cancelAnimationFrame(frame)
      off()
    }
  }, [viewer])

  const onScreen = (p: RunPoint): Vec2 | null => viewer.canvasPointOf(p.x, p.y, p.z)
  const at = ticks.flatMap((p) => onScreen(p) ?? [])
  const strokes = pieces.flatMap((s) => {
    const a = onScreen(s.a)
    const b = onScreen(s.b)
    return a && b ? [{ a, b }] : []
  })
  if (at.length === 0) return null
  const drawn = routeTicksAcross(at, strokes, TICK_HALF_PX)
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden data-testid="live-plan-route-ticks">
      {drawn.map((t, i) => (
        <polygon key={i} points={band(t)} fill={ROUTE_CHECK_COLOUR} data-testid="model-route-check-tick" />
      ))}
    </svg>
  )
}
