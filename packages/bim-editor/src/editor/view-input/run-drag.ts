import {
  drawingToPaper,
  isPitchedOrLevel,
  paperToDrawing,
  type BimElement,
  type ModelState,
  type RunPoint,
  type RunSize,
  type Vec2,
  type ViewOnPaper,
  elementEntries, elementValues, elementsOfKind,
} from '@permitzip/bim-kernel'
import { dragToModel } from './drawing-pick'

/**
 * Dragging routed duct and pipe on a plan, section or elevation drawing (by
 * itself or opened on a sheet). The drawing finds the piece and the model
 * point under the pointer; the session grabs it exactly as the 3D view does
 * (middle moves the piece, an open end stretches, an elbow moves its corner)
 * and previews and commits one `drag_run`, with the same elbow flips (Alt
 * stops at the elbow instead), undo and live sync.
 */
export interface RunDragBridge {
  /** Start on a run piece at a model point (mm above project zero); null when it isn't one (the drawing moves it instead). */
  begin(id: string, at: RunPoint): string | null
  /** The drag so far, as a model move; returns the hint (distance, limits, refusals). `strict` (Alt): stop at an elbow instead of flipping it. */
  preview(delta: RunPoint, strict: boolean): string | null
  /** The model as the drag would leave it; null when nothing would change yet. */
  previewModel(): ModelState | null
  /** Release (save) or Esc (nothing changes). Returns the model's refusal, or null. */
  end(commit: boolean): string | null
  /** A typed length while dragging an open end: the piece becomes exactly that long. Returns the hint. */
  toLength(lengthMm: number): string | null
}

/** An open run end, by piece and port (a segment's `start` / `end`, or a fitting's port id). */
export interface OpenEnd {
  readonly elementId: string
  readonly port: string
}

/** The side of a straight run under the pointer, for a tap: the piece and the model point (mm above project zero). */
export interface RunSide {
  readonly segmentId: string
  readonly at: RunPoint
}

/**
 * The straight run under a paper point the Route tool can tap off (level, or
 * a pitched pipe such as a sloped drain), and the point on it; null over
 * anything else (a riser, an elbow, empty paper).
 */
export function runSideUnder(model: ModelState, vop: ViewOnPaper, ids: readonly string[], paper: Vec2): RunSide | null {
  for (const id of ids) {
    const el = model.elements[id]
    if (el?.kind !== 'run_segment' || Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y) < 1) continue
    if (Math.abs(el.start.z - el.end.z) > 0.5 && !(el.domain === 'pipe' && isPitchedOrLevel(el))) continue
    const at = runPointUnder(model, vop, id, paper)
    if (at) return { segmentId: id, at }
  }
  return null
}

/** A point a drawing gives the route: mm above project zero; `z` only where the drawing shows height (a section). */
export interface DrawingModelPoint {
  readonly x: number
  readonly y: number
  readonly z?: number
}

/** Split and Route on a drawing: the session's own tools, given model points instead of screen pixels. */
export interface RouteSplitBridge {
  previewSplit(id: string, at: RunPoint): string
  split(id: string, at: RunPoint): string
  /** What a click would do with the Route tool; `vertical`: straight up or down from the last point (a riser); `side`: on a straight run's side (a tap off it). */
  previewRoute(p: DrawingModelPoint, vertical: boolean, end: OpenEnd | null, side: RunSide | null): string | null
  clickRoute(p: DrawingModelPoint, vertical: boolean, end: OpenEnd | null, side: RunSide | null): string | null
  finishRoute(): string | null
  /** Esc: drop the route being drawn; false when there was none. */
  cancelRoute(): boolean
  routeLastPoint(): RunPoint | null
  routePreviewModel(): ModelState | null
  /** Where the route checks found something along the route being drawn (a rated wall): a red tick goes across the route there. */
  routeTicks?(): readonly RunPoint[]
}

/** The open run end of `domain` nearest a paper point, within `toleranceMm` of drawing distance; null when none is. */
export function openEndNear(model: ModelState, vop: ViewOnPaper, paper: Vec2, toleranceMm: number): (OpenEnd & { readonly at: RunPoint }) | null {
  const p = paperToDrawing(vop, paper)
  let best: (OpenEnd & { at: RunPoint; d: number }) | null = null
  for (const el of elementsOfKind(model.elements, 'run_segment', 'run_fitting')) {
    const f = floorOf(model, el.levelId)
    const ends =
      el.kind === 'run_segment'
        ? [...(el.links.start ? [] : [{ port: 'start', q: el.start }]), ...(el.links.end ? [] : [{ port: 'end', q: el.end }])]
        : el.ports.filter((q) => !q.link).map((q) => ({ port: q.id, q: q.position }))
    for (const e of ends) {
      const at = { x: e.q.x, y: e.q.y, z: e.q.z + f }
      if (!shownBy(vop, at, f)) continue
      const d = vop.mapping.toDrawing(at)
      const dist = Math.hypot(d.u - p.x, d.v - p.y)
      if (dist <= toleranceMm && (!best || dist < best.d)) best = { elementId: el.id, port: e.port, at, d: dist }
    }
  }
  return best ? { elementId: best.elementId, port: best.port, at: best.at } : null
}

/** Is a model point in what the view looks at (a plan: its own level's height band; a section: between the cut and its far clip)? */
function shownBy(vop: ViewOnPaper, p: RunPoint, levelFloorMm: number): boolean {
  const m = vop.mapping
  if (m.kind === 'section') {
    const beyond = -m.toDrawing(p).depth
    return beyond >= -1 && beyond <= (m.depthRangeMm ?? Infinity) + 1
  }
  return m.kind === 'plan' && Math.abs(levelFloorMm - m.floorMm) < 1
}

export interface SnapHit {
  /** The snapped paper point. */
  readonly paper: Vec2
  readonly label: string
}

/**
 * 2D snapping on a drawing: the nearest run end, elbow or part within
 * `toleranceMm` (drawing mm) of a paper point, skipping `exclude` (what is
 * being dragged). Null when nothing is that near.
 */
export function snapOnPaper(model: ModelState, vop: ViewOnPaper, paper: Vec2, toleranceMm: number, exclude: ReadonlySet<string>): SnapHit | null {
  const p = paperToDrawing(vop, paper)
  const found: { best: { at: RunPoint; label: string; d: number } | null } = { best: null }
  const consider = (at: RunPoint, label: string, levelFloorMm: number) => {
    if (!shownBy(vop, at, levelFloorMm)) return
    const d = vop.mapping.toDrawing(at)
    const dist = Math.hypot(d.u - p.x, d.v - p.y)
    if (dist <= toleranceMm && (!found.best || dist < found.best.d)) found.best = { at, label, d: dist }
  }
  for (const el of elementValues(model.elements)) {
    if (exclude.has(el.id)) continue
    if (el.kind === 'run_segment') {
      const f = floorOf(model, el.levelId)
      consider({ x: el.start.x, y: el.start.y, z: el.start.z + f }, 'end', f)
      consider({ x: el.end.x, y: el.end.y, z: el.end.z + f }, 'end', f)
    } else if (el.kind === 'run_fitting') {
      const f = floorOf(model, el.levelId)
      consider({ x: el.position.x, y: el.position.y, z: el.position.z + f }, el.fittingType === 'elbow' ? 'elbow' : 'fitting', f)
    } else if (el.kind === 'part') {
      const f = floorOf(model, el.levelId)
      consider({ x: el.position.x, y: el.position.y, z: el.offsetMm + f }, 'part', f)
    }
  }
  const hit = found.best
  if (!hit) return null
  const d = vop.mapping.toDrawing(hit.at)
  return { paper: drawingToPaper(vop, { x: d.u, y: d.v }), label: hit.label }
}

export function isRunPiece(el: BimElement | undefined): el is Extract<BimElement, { kind: 'run_segment' | 'run_fitting' }> {
  return el?.kind === 'run_segment' || el?.kind === 'run_fitting'
}

function floorOf(model: ModelState, levelId: string): number {
  const level = model.elements[levelId]
  return level?.kind === 'level' ? level.elevationMm : 0
}

/** A run piece's ends above project zero (the drawing frame's z). */
function absEnds(model: ModelState, el: Extract<BimElement, { kind: 'run_segment' }>): [RunPoint, RunPoint] {
  const f = floorOf(model, el.levelId)
  return [
    { x: el.start.x, y: el.start.y, z: el.start.z + f },
    { x: el.end.x, y: el.end.y, z: el.end.z + f },
  ]
}

/**
 * The model point on a run piece under a paper point: the nearest point along
 * a straight piece as the drawing shows it (a riser seen from above grabs its
 * middle, so it moves whole), or an elbow's centre.
 */
export function runPointUnder(model: ModelState, vop: ViewOnPaper, id: string, paper: Vec2): RunPoint | null {
  const el = model.elements[id]
  if (el?.kind === 'run_fitting') {
    const f = floorOf(model, el.levelId)
    return { x: el.position.x, y: el.position.y, z: el.position.z + f }
  }
  if (el?.kind !== 'run_segment') return null
  const [a, b] = absEnds(model, el)
  const p = paperToDrawing(vop, paper)
  const da = vop.mapping.toDrawing(a)
  const db = vop.mapping.toDrawing(b)
  const ux = db.u - da.u
  const uy = db.v - da.v
  const len2 = ux * ux + uy * uy
  const t = len2 < 1 ? 0.5 : Math.min(1, Math.max(0, ((p.x - da.u) * ux + (p.y - da.v) * uy) / len2))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

/**
 * The model move for a run drag on paper. Plans move in plan; Shift on a plan
 * turns the drag's up/down into a height change (up on paper is up), since a
 * plan has no vertical to drag along. Sections keep to along-the-cut or
 * up-and-down, whichever the drag is more of (a riser stays plumb, a level run
 * level); Shift lets a section drag go both ways.
 */
export function runDragDelta(vop: ViewOnPaper, from: Vec2, to: Vec2, shift: boolean): RunPoint | null {
  if (vop.mapping.kind === 'plan' && shift) return { x: 0, y: 0, z: Math.round((from.y - to.y) * vop.frame.scale) }
  return dragToModel(vop, from, to, vop.mapping.kind === 'section' && shift)
}

function across(size: RunSize, vertical: boolean, section: boolean): number {
  const w = size.shape === 'rect' || size.shape === 'oval' ? size.width : size.shape === 'round' ? size.diameter : size.shape === 'pipe' ? size.nominalMm : size.tradeSizeMm
  const h = size.shape === 'rect' || size.shape === 'oval' ? size.height : w
  // A plan sees a level piece's width; a section sees its height, and a riser's width either way.
  return section && !vertical ? h : w
}

export interface RunPreviewStroke {
  readonly id: string
  readonly a: Vec2
  readonly b: Vec2
  /** Paper mm. */
  readonly width: number
}

/** The pieces a run drag changes, drawn on paper: one stroke per changed straight piece, a dot per changed elbow. */
export function runPreviewOnPaper(before: ModelState, after: ModelState, vop: ViewOnPaper, limit: number): RunPreviewStroke[] {
  const out: RunPreviewStroke[] = []
  const section = vop.mapping.kind === 'section'
  const onPaper = (p: RunPoint) => {
    const d = vop.mapping.toDrawing(p)
    return drawingToPaper(vop, { x: d.u, y: d.v })
  }
  for (const [id, el] of elementEntries(after.elements)) {
    if (out.length >= limit) break
    if (before.elements[id] === el) continue
    if (el.kind === 'run_segment') {
      const [a, b] = absEnds(after, el)
      const vertical = Math.hypot(b.x - a.x, b.y - a.y) < 1
      out.push({ id, a: onPaper(a), b: onPaper(b), width: across(el.size, vertical, section) / vop.frame.scale })
    } else if (el.kind === 'run_fitting') {
      const f = floorOf(after, el.levelId)
      const c = onPaper({ x: el.position.x, y: el.position.y, z: el.position.z + f })
      const size = el.ports[0]?.size
      if (size) out.push({ id, a: c, b: c, width: across(size, false, section) / vop.frame.scale })
    }
  }
  return out
}
