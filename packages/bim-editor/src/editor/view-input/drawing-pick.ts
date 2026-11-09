import {
  drawingToPaper,
  paperDeltaToModel,
  paperToDrawing,
  pickAt,
  pickInBox,
  type BoxMode,
  type RunPoint,
  type Vec2,
  type ViewOnPaper,
  type ViewPickIndex,
} from '@permitzip/bim-kernel'

/**
 * Pointer → element ids and drags → model moves for a view on paper (the
 * view opened by itself, or a viewport opened on a sheet). Paper millimetres
 * in, model millimetres out; screen pixels only set the tolerances.
 */

/** How near (screen px) the pointer must be to pick a thin duct or a grid line. */
export const PICK_PX = 6

/** Drawing-frame mm for `px` screen pixels at this zoom. */
export function toleranceMm(vop: ViewOnPaper, paperMmPerPx: number, px = PICK_PX): number {
  return px * paperMmPerPx * vop.frame.scale
}

/** Ids under a paper point, best first; empty outside the view's frame. */
export function idsAt(index: ViewPickIndex, vop: ViewOnPaper, paper: Vec2, paperMmPerPx: number): string[] {
  const r = vop.paperRect
  if (paper.x < r.min.x || paper.x > r.max.x || paper.y < r.min.y || paper.y > r.max.y) return []
  return pickAt(index, paperToDrawing(vop, paper), toleranceMm(vop, paperMmPerPx))
}

/** Ids a paper box selects (window left to right, crossing right to left). */
export function idsInBox(index: ViewPickIndex, vop: ViewOnPaper, a: Vec2, b: Vec2): { ids: string[]; mode: BoxMode } {
  const mode: BoxMode = b.x >= a.x ? 'window' : 'crossing'
  // A turned plan's paper box is a turned box in the model: take its drawing-frame bounds.
  const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }].map((p) => paperToDrawing(vop, p))
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  return { ids: pickInBox(index, { x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) }, mode), mode }
}

/** An element's outline on paper (for highlights); null when the view doesn't draw it. */
export function outlineOnPaper(index: ViewPickIndex, vop: ViewOnPaper, id: string): Vec2[] | null {
  const f = index.footprints.get(id)
  return f ? f.poly.map((q) => drawingToPaper(vop, q)) : null
}

/**
 * The model move for a drag on paper, whole millimetres. In a section the
 * drag keeps to the stronger direction (along the cut, or up and down) so a
 * riser stays plumb and a level run stays level; `free` (Alt) lets it go both ways.
 */
export function dragToModel(vop: ViewOnPaper, from: Vec2, to: Vec2, free: boolean): RunPoint | null {
  let end = to
  if (vop.mapping.kind === 'section' && !free) {
    end = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
  }
  const d = paperDeltaToModel(vop, from, end)
  return d ? { x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z) } : null
}

/** Where on paper the dragged outline sits: the snapped drag, back on paper. */
export function paperOffsetFor(vop: ViewOnPaper, from: Vec2, to: Vec2, free: boolean): Vec2 {
  if (vop.mapping.kind === 'section' && !free) return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? { x: to.x - from.x, y: 0 } : { x: 0, y: to.y - from.y }
  return { x: to.x - from.x, y: to.y - from.y }
}
