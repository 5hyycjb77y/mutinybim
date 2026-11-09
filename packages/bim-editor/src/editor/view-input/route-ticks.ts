import type { Vec2 } from '@permitzip/bim-kernel'

/** A route check's tick: a short stroke across the route. */
export interface RouteTick {
  readonly a: Vec2
  readonly b: Vec2
}

/** The colour of a route check's tick, on drawings and in the live plan. */
export const ROUTE_CHECK_COLOUR = 'var(--color-destructive)'

/**
 * A short tick across the nearest piece at each place a route check found
 * something. Points and pieces share one 2D frame (paper mm on a drawing,
 * canvas px in the live plan); `half` is half the tick's length in it.
 */
export function routeTicksAcross(at: readonly Vec2[], pieces: readonly RouteTick[], half: number): RouteTick[] {
  const out: RouteTick[] = []
  for (const p of at) {
    let best: { d: number; ux: number; uy: number } | null = null
    for (const s of pieces) {
      const dx = s.b.x - s.a.x
      const dy = s.b.y - s.a.y
      const len = Math.hypot(dx, dy)
      if (len === 0) continue
      const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (len * len)))
      const d = Math.hypot(s.a.x + t * dx - p.x, s.a.y + t * dy - p.y)
      if (!best || d < best.d) best = { d, ux: dx / len, uy: dy / len }
    }
    const nx = best ? -best.uy : 0
    const ny = best ? best.ux : 1
    out.push({ a: { x: p.x - nx * half, y: p.y - ny * half }, b: { x: p.x + nx * half, y: p.y + ny * half } })
  }
  return out
}
