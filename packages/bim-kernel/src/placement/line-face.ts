import { roundVec } from "../geometry";
import type { Vec2 } from "../types";
import type { GeometricPlacement, LinePlacement } from "./geometric";

/**
 * A line element's line written once. Walls, beams and grids keep their line
 * twice: the flat `start` / `end` every older reader uses, and the stored
 * `placement` (justification, end offsets, a top level). The flat line is
 * authoritative; these keep the placement equal to it, so a move or a joined
 * end that follows never leaves the two copies describing different lines.
 */

/** The line a placement describes, for a centreline and the placement's lateral justification (the inverse of `lineCentreline`). */
export function faceOf(start: Vec2, end: Vec2, lateral: LinePlacement["lateral"], widthMm: number): { start: Vec2; end: Vec2 } {
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  const shift = lateral === "left" ? widthMm / 2 : lateral === "right" ? -widthMm / 2 : 0;
  if (len === 0 || shift === 0) return { start, end };
  const nx = (-(end.y - start.y) / len) * shift;
  const ny = ((end.x - start.x) / len) * shift;
  return { start: { x: start.x + nx, y: start.y + ny }, end: { x: end.x + nx, y: end.y + ny } };
}

const shift = (p: Vec2, d: Vec2): Vec2 => roundVec({ x: p.x + d.x, y: p.y + d.y });

/** A stored placement moved by `d` in plan, whatever its shape (unknown shapes are kept as they are). */
export function translatedPlacement(p: GeometricPlacement, d: Vec2): GeometricPlacement {
  switch (p.kind) {
    case "point":
      return { ...p, position: shift(p.position, d) };
    case "line":
      return { ...p, start: shift(p.start, d), end: shift(p.end, d) };
    case "path":
      return { ...p, start: shift(p.start, d), segments: p.segments.map((s) => ({ ...s, to: shift(s.to, d) })) };
    case "area":
      return { ...p, outline: p.outline.map((q) => shift(q, d)), ...(p.holes ? { holes: p.holes.map((h) => h.map((q) => shift(q, d))) } : {}) };
    default:
      return p;
  }
}

/**
 * A stored placement re-described for a new centreline `start` → `end` of an
 * element `widthMm` across: a line keeps its justification and offsets; a
 * path keeps its interior points and moves its first point and last `to`.
 */
export function placementForLine(p: GeometricPlacement, start: Vec2, end: Vec2, widthMm: number): GeometricPlacement {
  if (p.kind === "line") {
    const face = faceOf(start, end, p.lateral, widthMm);
    return { ...p, start: roundVec(face.start), end: roundVec(face.end) };
  }
  if (p.kind === "path") {
    const last = p.segments.length - 1;
    return { ...p, start: roundVec(start), segments: p.segments.map((s, i) => (i === last ? { ...s, to: roundVec(end) } : s)) };
  }
  return p;
}

/** A record with a flat line and an optional stored placement, its line set to `start` → `end` with both copies agreeing. */
export function withFlatLine<T extends { readonly start: Vec2; readonly end: Vec2; readonly placement?: GeometricPlacement }>(el: T, start: Vec2, end: Vec2, widthMm: number): T {
  const s = roundVec(start);
  const e = roundVec(end);
  return el.placement ? { ...el, start: s, end: e, placement: placementForLine(el.placement, s, e, widthMm) } : { ...el, start: s, end: e };
}

/**
 * A record with a flat line and an optional stored placement, moved by `d`.
 * A line placement is re-described from the moved flat line, so a record an
 * older edit left disagreeing comes out agreeing; a path moves every point.
 */
export function translatedFlatLine<T extends { readonly start: Vec2; readonly end: Vec2; readonly placement?: GeometricPlacement }>(el: T, d: Vec2, widthMm: number): T {
  const s = shift(el.start, d);
  const e = shift(el.end, d);
  if (!el.placement) return { ...el, start: s, end: e };
  if (el.placement.kind === "line") return withFlatLine(el, s, e, widthMm);
  return { ...el, start: s, end: e, placement: translatedPlacement(el.placement, d) };
}
