import { elementsOfKind, isCalibrated, levelOf, modelToSource, paperToDrawing, sourceToModel, type DrawingUnderlay, type ElementId, type ModelState, type UnderlayCalibration, type Vec2, type ViewOnPaper } from '@permitzip/bim-kernel'

/**
 * Draw space / trace tool geometry, in model millimetres: where an underlay's
 * page sits, the points a click snaps to (underlay linework, room corners and
 * edges, the outline's own first corner), and the live area. Pure.
 */

export type SnapKind = 'close' | 'corner' | 'edge' | 'linework' | 'linked' | 'none'

export interface Snapped {
  readonly point: Vec2
  readonly kind: SnapKind
}

/** A line to snap to, model mm. */
export interface SnapSegment {
  readonly a: Vec2
  readonly b: Vec2
  readonly source: 'linework' | 'room' | 'linked'
}

function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return a
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The point a click lands on: closing the outline beats a corner beats an
 * edge, all within `toleranceMm` (the tool passes about 8 screen pixels in mm).
 */
export function snapPoint(p: Vec2, segments: readonly SnapSegment[], outline: readonly Vec2[], toleranceMm: number): Snapped {
  const first = outline[0]
  if (first && outline.length >= 3 && dist(p, first) <= toleranceMm) return { point: first, kind: 'close' }
  let corner: Vec2 | null = null
  let cornerD = toleranceMm
  let edge: { p: Vec2; source: SnapSegment['source'] } | null = null
  let edgeD = toleranceMm
  for (const s of segments) {
    for (const c of [s.a, s.b]) {
      const d = dist(p, c)
      if (d <= cornerD) {
        corner = c
        cornerD = d
      }
    }
    const on = nearestOnSegment(p, s.a, s.b)
    const d = dist(p, on)
    if (d <= edgeD) {
      edge = { p: on, source: s.source }
      edgeD = d
    }
  }
  if (corner) return { point: corner, kind: 'corner' }
  if (edge) return { point: edge.p, kind: edge.source === 'linework' ? 'linework' : edge.source === 'linked' ? 'linked' : 'edge' }
  return { point: p, kind: 'none' }
}

/** Holding Shift squares the next leg to the last one (walls are usually orthogonal). */
export function orthogonal(p: Vec2, last: Vec2 | undefined): Vec2 {
  if (!last) return p
  return Math.abs(p.x - last.x) >= Math.abs(p.y - last.y) ? { x: p.x, y: last.y } : { x: last.x, y: p.y }
}

export function rectangleOutline(a: Vec2, b: Vec2): Vec2[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
}

export function polygonAreaFt2(outline: readonly Vec2[]): number {
  let twice = 0
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Vec2
    const b = outline[(i + 1) % outline.length] as Vec2
    twice += a.x * b.y - b.x * a.y
  }
  return (Math.abs(twice) / 2 / 1e6) * 10.7639104
}

/** Room edges on a level, as snap lines. Read by kind (rooms only), not over the model. */
export function roomSnapSegments(model: ModelState, levelId: ElementId): SnapSegment[] {
  const out: SnapSegment[] = []
  for (const r of elementsOfKind(model.elements, 'room')) {
    if (levelOf(model.elements, r)?.id !== levelId) continue
    for (let i = 0; i < r.outline.length; i++) {
      const a = r.outline[i] as Vec2
      const b = r.outline[(i + 1) % r.outline.length] as Vec2
      out.push({ a, b, source: 'room' })
    }
  }
  return out
}

/** Underlay linework (source units, from the linework route) in model mm. */
export function lineworkSnapSegments(cal: UnderlayCalibration, segments: ReadonlyArray<readonly [number, number, number, number]>): SnapSegment[] {
  return segments.map(([x1, y1, x2, y2]) => ({ a: sourceToModel(cal, { x: x1, y: y1 }), b: sourceToModel(cal, { x: x2, y: y2 }), source: 'linework' as const }))
}

/** The page's four corners in model mm (bottom-left, bottom-right, top-right, top-left), for drawing the picture. */
export function underlayCorners(cal: UnderlayCalibration, width: number, height: number): readonly [Vec2, Vec2, Vec2, Vec2] {
  return [sourceToModel(cal, { x: 0, y: 0 }), sourceToModel(cal, { x: width, y: 0 }), sourceToModel(cal, { x: width, y: height }), sourceToModel(cal, { x: 0, y: height })]
}

/** The calibrated, visible underlays on a level that tracing can use (first one wins for the traced origin). */
export function traceableUnderlays(model: ModelState, levelId: ElementId): DrawingUnderlay[] {
  return elementsOfKind(model.elements, 'drawing_underlay').filter((u) => u.levelId === levelId && !u.hidden && isCalibrated(u))
}

interface PaperRect {
  readonly min: Vec2
  readonly max: Vec2
}

/**
 * The model point under a paper point for tracing: the whole drawing under the
 * plan, past the crop window too (a PDF often hangs outside the plan's crop).
 * The crop still decides what prints; `paperToModelPoint` keeps refusing
 * outside it for every other tool.
 */
export function tracePointAt(vop: ViewOnPaper, paper: Vec2, elevationMm: number): Vec2 | null {
  const at = vop.mapping.toModel(paperToDrawing(vop, paper), { elevationMm })
  return at ? { x: at.x, y: at.y } : null
}

/** Where Draw space takes clicks, paper mm: the plan's crop and the drawing being traced (its page corners), with a margin. */
export function traceHitRect(crop: PaperRect, tracedCorners: readonly Vec2[], marginMm: number): PaperRect {
  let min = crop.min
  let max = crop.max
  for (const c of tracedCorners) {
    min = { x: Math.min(min.x, c.x - marginMm), y: Math.min(min.y, c.y - marginMm) }
    max = { x: Math.max(max.x, c.x + marginMm), y: Math.max(max.y, c.y + marginMm) }
  }
  return { min, max }
}

/** Where a model point falls on the page, for the calibration preview. */
export function onPage(cal: UnderlayCalibration, p: Vec2): Vec2 {
  return modelToSource(cal, p)
}
