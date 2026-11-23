import type { Vec2 } from "../types";

/**
 * Pure 2D polygon geometry and non-convex clipping for arbitrary crop regions
 * (e.g. L-shaped or stepped polyline view crops) and closed boundaries.
 */

const EPS = 1e-6;

/** Signed area (positive for CCW, negative for CW). */
export function signedPolygonArea(poly: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Axis-aligned bounding box of a polygon, or null when empty. */
export function polygonBounds(poly: readonly Vec2[]): { readonly min: Vec2; readonly max: Vec2 } | null {
  if (poly.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** Remove consecutive duplicate vertices and collinear redundant vertices from a closed polygon. */
export function cleanPolygon(poly: readonly Vec2[], eps = 0.5): Vec2[] {
  const dedup: Vec2[] = [];
  for (const p of poly) {
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) dedup.push(p);
  }
  while (dedup.length > 1 && Math.hypot(dedup[0]!.x - dedup[dedup.length - 1]!.x, dedup[0]!.y - dedup[dedup.length - 1]!.y) <= eps) {
    dedup.pop();
  }
  if (dedup.length < 3) return dedup;
  const out: Vec2[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = dedup[(i - 1 + dedup.length) % dedup.length]!;
    const b = dedup[i]!;
    const c = dedup[(i + 1) % dedup.length]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    const lenA = Math.hypot(abx, aby);
    const lenB = Math.hypot(bcx, bcy);
    if (lenA <= eps || lenB <= eps) continue;
    const cross = Math.abs(abx * bcy - aby * bcx) / (lenA * lenB);
    const dot = (abx * bcx + aby * bcy) / (lenA * lenB);
    // Drop strictly collinear middle vertices (same direction along one edge).
    if (cross < 1e-4 && dot > 0) continue;
    out.push(b);
  }
  return out;
}

/** True when a closed polygon is strictly an axis-aligned 4-corner rectangle. */
export function isAxisAlignedRectPolygon(poly: readonly Vec2[], tol = 1.0): boolean {
  const cleaned = cleanPolygon(poly, 0.5);
  if (cleaned.length !== 4) return false;
  const bounds = polygonBounds(cleaned);
  if (!bounds) return false;
  for (const p of cleaned) {
    const onX = Math.abs(p.x - bounds.min.x) <= tol || Math.abs(p.x - bounds.max.x) <= tol;
    const onY = Math.abs(p.y - bounds.min.y) <= tol || Math.abs(p.y - bounds.max.y) <= tol;
    if (!onX || !onY) return false;
  }
  // Ensure all 4 corners are distinct (covers non-degenerate rectangle).
  return Math.abs(signedPolygonArea(cleaned)) > (bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y) * 0.99;
}

/** Distance from point `p` to segment `a–b`. */
function pointToSegmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return (p.x - px) ** 2 + (p.y - py) ** 2;
}

/** Point-in-polygon test (even-odd rule, inclusive of boundary within `boundaryTol`). */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[], boundaryTol = 1e-3): boolean {
  if (poly.length < 3) return false;
  const tolSq = boundaryTol * boundaryTol;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    if (pointToSegmentDistSq(p, a, b) <= tolSq) return true;
    if (a.y > p.y !== b.y > p.y) {
      const xHit = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xHit) inside = !inside;
    }
  }
  return inside;
}

/**
 * Clip segment `a–b` against an arbitrary simple (possibly non-convex) closed
 * polygon. Returns zero, one, or multiple visible sub-segments in order along `a→b`.
 */
export function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: readonly Vec2[]): Array<[Vec2, Vec2]> {
  if (poly.length < 3) return [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < EPS) return pointInPolygon(a, poly) ? [[a, b]] : [];

  const ts: number[] = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % poly.length]!;
    const ex = d.x - c.x;
    const ey = d.y - c.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) {
      // Collinear edge: project edge endpoints onto segment to catch boundary entry/exit.
      const cross = (c.x - a.x) * dy - (c.y - a.y) * dx;
      if (Math.abs(cross) <= 1e-3 * segLen) {
        const tc = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (segLen * segLen);
        const td = ((d.x - a.x) * dx + (d.y - a.y) * dy) / (segLen * segLen);
        if (tc > EPS && tc < 1 - EPS) ts.push(tc);
        if (td > EPS && td < 1 - EPS) ts.push(td);
      }
      continue;
    }
    const qpx = c.x - a.x;
    const qpy = c.y - a.y;
    const t = (qpx * ey - qpy * ex) / denom;
    const u = (qpx * dy - qpy * dx) / denom;
    if (t > -EPS && t < 1 + EPS && u >= -EPS && u <= 1 + EPS) {
      ts.push(Math.max(0, Math.min(1, t)));
    }
  }
  ts.sort((x, y) => x - y);
  const uniq: number[] = [ts[0]!];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i]! - uniq[uniq.length - 1]! > 1e-5) uniq.push(ts[i]!);
  }

  const out: Array<[Vec2, Vec2]> = [];
  let runStart: number | null = null;
  for (let i = 0; i + 1 < uniq.length; i++) {
    const t0 = uniq[i]!;
    const t1 = uniq[i + 1]!;
    const tm = (t0 + t1) / 2;
    const mid = { x: a.x + dx * tm, y: a.y + dy * tm };
    if (pointInPolygon(mid, poly, 1e-3)) {
      if (runStart === null) runStart = t0;
    } else if (runStart !== null) {
      out.push([
        { x: a.x + dx * runStart, y: a.y + dy * runStart },
        { x: a.x + dx * t0, y: a.y + dy * t0 },
      ]);
      runStart = null;
    }
  }
  if (runStart !== null) {
    const tEnd = uniq[uniq.length - 1]!;
    out.push([
      { x: a.x + dx * runStart, y: a.y + dy * runStart },
      { x: a.x + dx * tEnd, y: a.y + dy * tEnd },
    ]);
  }
  return out;
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const c1 = cross2(a, b, p);
  const c2 = cross2(b, c, p);
  const c3 = cross2(c, a, p);
  return c1 >= -EPS && c2 >= -EPS && c3 >= -EPS;
}

/** Normalize polygon orientation to counter-clockwise (CCW). */
function ensureCcw(poly: readonly Vec2[]): Vec2[] {
  const cleaned = cleanPolygon(poly, 0.25);
  if (cleaned.length < 3) return cleaned;
  return signedPolygonArea(cleaned) < 0 ? [...cleaned].reverse() : cleaned;
}

/**
 * Triangulate a simple (possibly non-convex) polygon via ear clipping.
 * Returns CCW triangles; empty if degenerate.
 */
export function triangulateSimplePolygon(poly: readonly Vec2[]): Array<[Vec2, Vec2, Vec2]> {
  const verts = ensureCcw(poly);
  if (verts.length < 3) return [];
  const idx = verts.map((_, i) => i);
  const tris: Array<[Vec2, Vec2, Vec2]> = [];
  let guard = verts.length * verts.length + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = verts[ia]!;
      const b = verts[ib]!;
      const c = verts[ic]!;
      if (cross2(a, b, c) <= EPS) continue;
      let containsAny = false;
      for (let j = 0; j < idx.length; j++) {
        const ij = idx[j]!;
        if (ij === ia || ij === ib || ij === ic) continue;
        if (pointInTriangle(verts[ij]!, a, b, c)) {
          containsAny = true;
          break;
        }
      }
      if (!containsAny) {
        tris.push([a, b, c]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) {
    const a = verts[idx[0]!]!;
    const b = verts[idx[1]!]!;
    const c = verts[idx[2]!]!;
    if (cross2(a, b, c) > EPS) tris.push([a, b, c]);
  }
  return tris;
}

/** Sutherland–Hodgman clip of `subject` against a CCW convex polygon `clip`. */
export function clipPolygonToConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let out = [...subject];
  for (let i = 0; i < clip.length; i++) {
    if (out.length === 0) break;
    const e0 = clip[i]!;
    const e1 = clip[(i + 1) % clip.length]!;
    const next: Vec2[] = [];
    for (let j = 0; j < out.length; j++) {
      const a = out[j]!;
      const b = out[(j + 1) % out.length]!;
      const da = cross2(e0, e1, a);
      const db = cross2(e0, e1, b);
      if (da >= -EPS) next.push(a);
      if ((da >= -EPS) !== (db >= -EPS)) {
        const denom = da - db;
        if (Math.abs(denom) > 1e-12) {
          const t = da / denom;
          next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
    }
    out = next;
  }
  return out;
}

/** A convex piece from a simple polygon decomposition, tracking which edges are internal diagonals. */
export interface ConvexClipPiece {
  readonly vertices: readonly Vec2[];
  /** For each edge i -> (i+1)%n, true when that edge is an internal seam (not part of the outer boundary). */
  readonly internalEdge: readonly boolean[];
}

function edgeKey(a: Vec2, b: Vec2): string {
  return `${Math.round(a.x * 100)},${Math.round(a.y * 100)}->${Math.round(b.x * 100)},${Math.round(b.y * 100)}`;
}

/**
 * Decompose an arbitrary simple polygon into convex pieces (ear-clipping with
 * internal diagonal tracking). External edges stay exact; internal diagonals
 * can be nudged outward by a sub-pixel epsilon during fill clipping to prevent
 * anti-aliasing hairline seams between adjacent convex pieces.
 */
export function decomposePolygonConvex(poly: readonly Vec2[]): ConvexClipPiece[] {
  const ccw = ensureCcw(poly);
  if (ccw.length < 3) return [];
  // Fast path: already convex!
  let convex = true;
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i]!;
    const b = ccw[(i + 1) % ccw.length]!;
    const c = ccw[(i + 2) % ccw.length]!;
    if (cross2(a, b, c) < -EPS) {
      convex = false;
      break;
    }
  }
  if (convex) {
    return [{ vertices: ccw, internalEdge: ccw.map(() => false) }];
  }

  const outerEdges = new Set<string>();
  for (let i = 0; i < ccw.length; i++) {
    outerEdges.add(edgeKey(ccw[i]!, ccw[(i + 1) % ccw.length]!));
  }
  const tris = triangulateSimplePolygon(ccw);
  return tris.map((tri) => ({
    vertices: tri,
    internalEdge: [
      !outerEdges.has(edgeKey(tri[0], tri[1])),
      !outerEdges.has(edgeKey(tri[1], tri[2])),
      !outerEdges.has(edgeKey(tri[2], tri[0])),
    ],
  }));
}

/** Clip `subject` against a precomputed convex decomposition, returning zero or more clipped polygons. */
export function clipPolygonToPieces(subject: readonly Vec2[], pieces: readonly ConvexClipPiece[], internalSeamPad = 0): Vec2[][] {
  if (subject.length < 3 || pieces.length === 0) return [];
  const results: Vec2[][] = [];
  for (const piece of pieces) {
    let out = [...subject];
    const n = piece.vertices.length;
    for (let i = 0; i < n; i++) {
      if (out.length === 0) break;
      const e0 = piece.vertices[i]!;
      const e1 = piece.vertices[(i + 1) % n]!;
      const len = Math.hypot(e1.x - e0.x, e1.y - e0.y);
      if (len < EPS) continue;
      // Only relax internal diagonal half-planes slightly; outer crop edges stay 100% exact.
      const pad = piece.internalEdge[i] ? internalSeamPad * len : 0;
      const next: Vec2[] = [];
      for (let j = 0; j < out.length; j++) {
        const a = out[j]!;
        const b = out[(j + 1) % out.length]!;
        const da = cross2(e0, e1, a) + pad;
        const db = cross2(e0, e1, b) + pad;
        if (da >= -EPS) next.push(a);
        if ((da >= -EPS) !== (db >= -EPS)) {
          const denom = da - db;
          if (Math.abs(denom) > 1e-12) {
            const t = da / denom;
            next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
          }
        }
      }
      out = next;
    }
    if (out.length >= 3 && Math.abs(signedPolygonArea(out)) > 1e-2) {
      results.push(out);
    }
  }
  return results;
}
