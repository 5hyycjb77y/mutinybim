import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_WIDTH_MM,
  MARKUP_WIDTH_PRESETS,
  type DrawingItem,
  type MarkupSmartShape,
  type MarkupTool,
  type Vec2,
} from '@permitzip/bim-kernel'

/** Classic felt-tip ink colours for human sheet review markups (default red). */
export const MARKUP_COLOR_SWATCHES: ReadonlyArray<{ readonly color: string; readonly label: string }> = [
  { color: '#dc2626', label: 'Red (redline)' },
  { color: '#9333ea', label: 'Purple' },
  { color: '#2563eb', label: 'Blue' },
  { color: '#16a34a', label: 'Green' },
  { color: '#ea580c', label: 'Orange' },
  { color: '#eab308', label: 'Yellow' },
]

export interface MarkupBrushState {
  readonly tool: MarkupTool
  readonly color: string
  readonly widthMm: number
  readonly smartShapes: boolean
  readonly eraser: boolean
  readonly showMarkups: boolean
  readonly showResolved: boolean
}

export const DEFAULT_MARKUP_BRUSH: MarkupBrushState = {
  tool: 'marker',
  color: DEFAULT_MARKER_COLOR,
  widthMm: DEFAULT_MARKER_WIDTH_MM,
  smartShapes: false,
  eraser: false,
  showMarkups: true,
  showResolved: false,
}

/** Primary single-key shortcut for the sheet Marker tool. */
export const SHEET_MARKUP_SHORTCUT = 'M'

export interface MarkupShortcutResult {
  readonly nextTool: 'markup' | 'select'
  readonly brush: MarkupBrushState
}

/**
 * Pure keyboard shortcut handler for sheet review markups.
 * - `M` toggles Marker on/off (or switches back from Highlighter/Eraser to Marker).
 * - `H` toggles Highlighter on/off (or switches straight to Highlighter from Select/Marker/Eraser).
 * - While in Marker mode: `E` toggles Eraser, `S` toggles Smart snap, `1`–`6` picks ink colour.
 */
export function applyMarkupShortcut(key: string, inMarkupMode: boolean, brush: MarkupBrushState): MarkupShortcutResult | null {
  const lower = key.toLowerCase()
  if (lower === 'm') {
    if (inMarkupMode && !brush.eraser && brush.tool === 'marker') {
      return { nextTool: 'select', brush }
    }
    return { nextTool: 'markup', brush: { ...switchMarkupTool(brush, 'marker'), showMarkups: true } }
  }
  if (lower === 'h') {
    if (inMarkupMode && !brush.eraser && brush.tool === 'highlighter') {
      return { nextTool: 'select', brush }
    }
    return { nextTool: 'markup', brush: { ...switchMarkupTool(brush, 'highlighter'), showMarkups: true } }
  }
  if (!inMarkupMode) return null
  if (lower === 'e') {
    return { nextTool: 'markup', brush: { ...brush, eraser: !brush.eraser, showMarkups: true } }
  }
  if (lower === 's') {
    return { nextTool: 'markup', brush: { ...brush, smartShapes: !brush.smartShapes, eraser: false, showMarkups: true } }
  }
  if (lower.length === 1 && lower >= '1' && lower <= '9') {
    const swatch = MARKUP_COLOR_SWATCHES[Number(lower) - 1]
    if (!swatch) return null
    return { nextTool: 'markup', brush: { ...brush, color: swatch.color, eraser: false, showMarkups: true } }
  }
  return null
}

/** Switches between felt-tip Marker and broad Highlighter, mapping width to the matching preset tier. */
export function switchMarkupTool(brush: MarkupBrushState, nextTool: MarkupTool): MarkupBrushState {
  if (brush.tool === nextTool && !brush.eraser) return brush
  const currentPresets = MARKUP_WIDTH_PRESETS[brush.tool]
  const nextPresets = MARKUP_WIDTH_PRESETS[nextTool]
  let closestIdx = 1
  let bestDiff = Infinity
  currentPresets.forEach((p, i) => {
    const d = Math.abs(p.widthMm - brush.widthMm)
    if (d < bestDiff) {
      bestDiff = d
      closestIdx = i
    }
  })
  const nextWidth = nextPresets[closestIdx]?.widthMm ?? nextPresets[1]!.widthMm
  // Highlighter defaults to vivid yellow if the person was on default red marker; marker switches back to red if they were on yellow highlighter.
  const nextColor =
    nextTool === 'highlighter' && brush.color === DEFAULT_MARKER_COLOR
      ? '#eab308'
      : nextTool === 'marker' && brush.tool === 'highlighter' && brush.color === '#eab308'
        ? DEFAULT_MARKER_COLOR
        : brush.color
  return { ...brush, tool: nextTool, widthMm: nextWidth, color: nextColor, eraser: false }
}

/** Perpendicular distance from point `p` to segment `a`→`b`. */
function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Ramer-Douglas-Peucker simplification keeping stroke shape crisp within the kernel's 500-point budget. */
export function simplifyMarkupStroke(points: readonly Vec2[], toleranceMm = 0.55, maxPoints = 400): Vec2[] {
  if (points.length <= 2) return points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }))

  const rdp = (pts: readonly Vec2[], eps: number): Vec2[] => {
    if (pts.length <= 2) return [...pts]
    const first = pts[0]!
    const last = pts[pts.length - 1]!
    let maxDist = -1
    let maxIdx = 0
    for (let i = 1; i < pts.length - 1; i++) {
      const d = pointToSegmentDistance(pts[i]!, first, last)
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxDist > eps) {
      const left = rdp(pts.slice(0, maxIdx + 1), eps)
      const right = rdp(pts.slice(maxIdx), eps)
      return [...left.slice(0, -1), ...right]
    }
    return [first, last]
  }

  let eps = toleranceMm
  let simplified = rdp(points, eps)
  while (simplified.length > maxPoints && eps < 12) {
    eps *= 1.5
    simplified = rdp(points, eps)
  }
  if (simplified.length > maxPoints) {
    // Fallback uniform decimation while keeping start and end exact.
    const step = (simplified.length - 1) / (maxPoints - 1)
    const decimated: Vec2[] = []
    for (let i = 0; i < maxPoints; i++) {
      decimated.push(simplified[Math.min(simplified.length - 1, Math.round(i * step))]!)
    }
    simplified = decimated
  }
  return simplified.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }))
}

/**
 * Optional smart-shape cleanup for freehand marker strokes:
 * - Straight lines (snaps strictly horizontal or vertical within 8°)
 * - Closed circles (snaps to a clean 36-point loop)
 * - Closed rectangles / squares (snaps to a crisp 5-point axis-aligned box)
 * Leaves handwriting, arrows, leaders and irregular sketches untouched.
 */
export function recognizeSmartShape(points: readonly Vec2[]): { readonly points: Vec2[]; readonly smartShape?: MarkupSmartShape } {
  if (points.length < 3) return { points: [...points] }
  const first = points[0]!
  const last = points[points.length - 1]!

  let pathLen = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
    if (i > 0) {
      const prev = points[i - 1]!
      pathLen += Math.hypot(p.x - prev.x, p.y - prev.y)
    }
  }
  const bw = maxX - minX
  const bh = maxY - minY
  const diag = Math.hypot(bw, bh)
  const chord = Math.hypot(last.x - first.x, last.y - first.y)

  // 1. Straight line (with orthogonal H/V snap within 8°)
  if (chord >= 10 && pathLen <= chord * 1.18) {
    let maxDev = 0
    for (let i = 1; i < points.length - 1; i++) {
      const d = pointToSegmentDistance(points[i]!, first, last)
      if (d > maxDev) maxDev = d
    }
    if (maxDev <= Math.max(2.5, chord * 0.05)) {
      const dx = last.x - first.x
      const dy = last.y - first.y
      const angleDeg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 180
      let end: Vec2 = last
      if (angleDeg <= 8 || angleDeg >= 172) {
        const y = Math.round(((first.y + last.y) / 2) * 100) / 100
        return { points: [{ x: first.x, y }, { x: last.x, y }], smartShape: 'line' }
      }
      if (Math.abs(angleDeg - 90) <= 8) {
        const x = Math.round(((first.x + last.x) / 2) * 100) / 100
        return { points: [{ x, y: first.y }, { x, y: last.y }], smartShape: 'line' }
      }
      return { points: [first, end], smartShape: 'line' }
    }
  }

  // 2. Closed shapes (circle or rectangle)
  const closedGap = Math.max(10, diag * 0.24)
  if (diag >= 14 && bw >= 6 && bh >= 6 && chord <= closedGap && pathLen >= diag * 2.1 && pathLen <= diag * 5.2) {
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    // 2a. Circle check
    const aspect = bw / bh
    if (aspect >= 0.76 && aspect <= 1.32) {
      const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy))
      const meanR = radii.reduce((a, b) => a + b, 0) / radii.length
      if (meanR >= 5) {
        const variance = radii.reduce((acc, r) => acc + (r - meanR) * (r - meanR), 0) / radii.length
        const cv = Math.sqrt(variance) / meanR
        // Verify angular sweep covers at least ~270° so arcs aren't misread as circles.
        const bins = new Set<number>()
        for (const p of points) {
          const a = Math.atan2(p.y - cy, p.x - cx)
          bins.add(Math.floor(((a + Math.PI) / (2 * Math.PI)) * 12) % 12)
        }
        if (cv <= 0.145 && bins.size >= 9) {
          const segments = 36
          const ring: Vec2[] = []
          for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2
            ring.push({
              x: Math.round((cx + Math.cos(theta) * meanR) * 100) / 100,
              y: Math.round((cy + Math.sin(theta) * meanR) * 100) / 100,
            })
          }
          return { points: ring, smartShape: 'circle' }
        }
      }
    }

    // 2b. Rectangle / square check: points hug the 4 bounding box edges
    const edgeTol = Math.max(3.0, diag * 0.065)
    let nearLeft = 0
    let nearRight = 0
    let nearTop = 0
    let nearBottom = 0
    let totalEdgeErr = 0
    for (const p of points) {
      const dl = Math.abs(p.x - minX)
      const dr = Math.abs(p.x - maxX)
      const dt = Math.abs(p.y - minY)
      const db = Math.abs(p.y - maxY)
      const d = Math.min(dl, dr, dt, db)
      totalEdgeErr += d
      if (dl <= edgeTol) nearLeft++
      if (dr <= edgeTol) nearRight++
      if (dt <= edgeTol) nearTop++
      if (db <= edgeTol) nearBottom++
    }
    const meanEdgeErr = totalEdgeErr / points.length
    if (meanEdgeErr <= edgeTol * 0.72 && nearLeft >= 2 && nearRight >= 2 && nearTop >= 2 && nearBottom >= 2) {
      const r = (n: number) => Math.round(n * 100) / 100
      return {
        points: [
          { x: r(minX), y: r(minY) },
          { x: r(maxX), y: r(minY) },
          { x: r(maxX), y: r(maxY) },
          { x: r(minX), y: r(maxY) },
          { x: r(minX), y: r(minY) },
        ],
        smartShape: 'rect',
      }
    }
  }

  return { points: [...points] }
}

/** Hit-tests a paper-mm click/drag point against a sheet markup stroke. */
export function hitTestMarkupStroke(item: DrawingItem, atMm: Vec2, baseReachMm: number): boolean {
  if (item.deleted || item.shape !== 'markup' || item.points.length === 0) return false
  const reach = Math.max(baseReachMm, (item.markup?.widthMm ?? DEFAULT_MARKER_WIDTH_MM) * 0.75 + 2)
  if (item.points.length === 1) {
    const p = item.points[0]!
    return Math.hypot(atMm.x - p.x, atMm.y - p.y) <= reach
  }
  for (let i = 1; i < item.points.length; i++) {
    if (pointToSegmentDistance(atMm, item.points[i - 1]!, item.points[i]!) <= reach) return true
  }
  return false
}
