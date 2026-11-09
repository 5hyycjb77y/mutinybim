/**
 * Convex solids and the two exact tests the clash rules need.
 *
 * Every body the lint reads is a union of convex pieces: a straight run is
 * one oriented box (or a sampled round), a fitting is one piece per port, a
 * part is one piece per feature box, and a linked element is an upright
 * prism over its plan hull. A piece keeps its points, its face normals and
 * its edge directions, which is everything both tests use:
 *
 * - `penetration` is the separating-axis test. For two convex polyhedra the
 *   smallest overlap over the face normals of both and the cross products of
 *   their edge directions is the exact penetration depth; a positive gap on
 *   any axis means they don't touch.
 * - `distance` is GJK on the same points, the exact gap between two
 *   separated pieces (the separating-axis gap is only a lower bound at
 *   corners).
 *
 * Millimetres, world frame (plan x/y, z above project zero).
 */

export interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Convex {
  readonly points: readonly P3[];
  /** Unit face normals (one per distinct face direction is enough). */
  readonly normals: readonly P3[];
  /** Unit edge directions, deduplicated. */
  readonly edges: readonly P3[];
}

export interface Aabb {
  readonly min: P3;
  readonly max: P3;
}

export const p3 = (x: number, y: number, z: number): P3 => ({ x, y, z });
const sub = (a: P3, b: P3): P3 => p3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a: P3, b: P3): P3 => p3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a: P3, k: number): P3 => p3(a.x * k, a.y * k, a.z * k);
const dot = (a: P3, b: P3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: P3, b: P3): P3 => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: P3): number => Math.hypot(a.x, a.y, a.z);

function unit(a: P3): P3 | null {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : null;
}

/** Adds a direction unless it (or its opposite) is already there. */
function addDirection(list: P3[], d: P3 | null): void {
  if (!d) return;
  for (const e of list) if (Math.abs(Math.abs(dot(e, d)) - 1) < 1e-9) return;
  list.push(d);
}

/**
 * A loft between two rings with the same number of points (a box is two
 * four-point rings, a round sixteen): the caps, the side quads, the ring
 * edges and the lengthwise edges.
 */
export function loftConvex(r0: readonly P3[], r1: readonly P3[]): Convex {
  const n = r0.length;
  const normals: P3[] = [];
  const edges: P3[] = [];
  if (n >= 3) {
    addDirection(normals, unit(cross(sub(r0[1] as P3, r0[0] as P3), sub(r0[2] as P3, r0[0] as P3))));
    addDirection(normals, unit(cross(sub(r1[1] as P3, r1[0] as P3), sub(r1[2] as P3, r1[0] as P3))));
  }
  for (let i = 0; i < n; i++) {
    const a0 = r0[i] as P3;
    const b0 = r0[(i + 1) % n] as P3;
    const a1 = r1[i] as P3;
    const b1 = r1[(i + 1) % n] as P3;
    const e0 = sub(b0, a0);
    const along = sub(a1, a0);
    addDirection(normals, unit(cross(e0, along)) ?? unit(cross(sub(b1, a1), sub(b1, b0))));
    addDirection(edges, unit(e0));
    addDirection(edges, unit(sub(b1, a1)));
    addDirection(edges, unit(along));
  }
  return { points: [...r0, ...r1], normals, edges };
}

/**
 * A convex hull given as triangles (a modeled part's convex piece, already
 * placed): its corners, its face directions, and the directions of its real
 * edges (an edge between two triangles of one flat face is not an edge).
 */
export function hullConvex(points: readonly P3[], indices: ArrayLike<number>): Convex {
  const normals: P3[] = [];
  const edges: P3[] = [];
  const near = (list: P3[], d: P3 | null) => {
    if (!d) return;
    for (const e of list) if (Math.abs(Math.abs(dot(e, d)) - 1) < 1e-6) return;
    list.push(d);
  };
  const triNormal: Array<P3 | null> = [];
  const byEdge = new Map<string, number[]>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t] ?? 0;
    const ib = indices[t + 1] ?? 0;
    const ic = indices[t + 2] ?? 0;
    const a = points[ia];
    const b = points[ib];
    const c = points[ic];
    if (!a || !b || !c) continue;
    const n = unit(cross(sub(b, a), sub(c, a)));
    const ti = triNormal.length;
    triNormal.push(n);
    near(normals, n);
    for (const [p, q] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      const list = byEdge.get(key) ?? [];
      list.push(ti);
      byEdge.set(key, list);
    }
  }
  for (const [key, tris] of byEdge) {
    const [na, nb] = [triNormal[tris[0] ?? -1], triNormal[tris[1] ?? -1]];
    if (na && nb && dot(na, nb) > 1 - 1e-6) continue;
    const [p, q] = key.split(",").map(Number) as [number, number];
    const a = points[p];
    const b = points[q];
    if (a && b) near(edges, unit(sub(b, a)));
  }
  return { points, normals, edges };
}

/** An upright prism over a convex plan outline (counter-clockwise or not), from z0 to z1. */
export function prismConvex(outline: ReadonlyArray<{ readonly x: number; readonly y: number }>, z0: number, z1: number): Convex {
  return loftConvex(
    outline.map((q) => p3(q.x, q.y, z0)),
    outline.map((q) => p3(q.x, q.y, z1)),
  );
}

export function boxConvex(b: Aabb): Convex {
  const { min, max } = b;
  return prismConvex(
    [
      { x: min.x, y: min.y },
      { x: max.x, y: min.y },
      { x: max.x, y: max.y },
      { x: min.x, y: max.y },
    ],
    min.z,
    max.z,
  );
}

export function aabbOfPoints(points: readonly P3[]): Aabb {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.z < z0) z0 = p.z;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
    if (p.z > z1) z1 = p.z;
  }
  return { min: p3(x0, y0, z0), max: p3(x1, y1, z1) };
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  return { min: p3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)), max: p3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)) };
}

export function growAabb(a: Aabb, by: number): Aabb {
  return { min: p3(a.min.x - by, a.min.y - by, a.min.z - by), max: p3(a.max.x + by, a.max.y + by, a.max.z + by) };
}

export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/** Centre of the box two boxes share (or the midpoint between them when they don't). */
export function sharedCentre(a: Aabb, b: Aabb): P3 {
  const mid = (lo0: number, hi0: number, lo1: number, hi1: number) => (Math.max(lo0, lo1) + Math.min(hi0, hi1)) / 2;
  return p3(mid(a.min.x, a.max.x, b.min.x, b.max.x), mid(a.min.y, a.max.y, b.min.y, b.max.y), mid(a.min.z, a.max.z, b.min.z, b.max.z));
}

/**
 * Separating-axis test. Positive: the pieces overlap by that much along the
 * shallowest axis (the exact penetration depth). Zero or negative: they
 * don't overlap; the magnitude is a lower bound on the gap.
 */
export function penetration(a: Convex, b: Convex): number {
  // Same arithmetic as projecting with `dot` and normalising with `unit(cross(…))`, without allocating per axis.
  const ap = a.points;
  const bp = b.points;
  let least = Infinity;
  for (const n of a.normals) {
    const overlap = axisOverlap(ap, bp, n.x, n.y, n.z);
    if (overlap < least) least = overlap;
    if (!(overlap > 0)) return least;
  }
  for (const n of b.normals) {
    const overlap = axisOverlap(ap, bp, n.x, n.y, n.z);
    if (overlap < least) least = overlap;
    if (!(overlap > 0)) return least;
  }
  for (const ea of a.edges) {
    for (const eb of b.edges) {
      const cx = ea.y * eb.z - ea.z * eb.y;
      const cy = ea.z * eb.x - ea.x * eb.z;
      const cz = ea.x * eb.y - ea.y * eb.x;
      const l = Math.hypot(cx, cy, cz);
      if (!(l > 1e-9)) continue;
      const k = 1 / l;
      const overlap = axisOverlap(ap, bp, cx * k, cy * k, cz * k);
      if (overlap < least) least = overlap;
      if (!(overlap > 0)) return least;
    }
  }
  return least;
}

/** How far two point sets' projections on an axis overlap (negative: the gap between them). */
function axisOverlap(ap: readonly P3[], bp: readonly P3[], x: number, y: number, z: number): number {
  let a0 = Infinity;
  let a1 = -Infinity;
  for (const p of ap) {
    const d = p.x * x + p.y * y + p.z * z;
    if (d < a0) a0 = d;
    if (d > a1) a1 = d;
  }
  let b0 = Infinity;
  let b1 = -Infinity;
  for (const p of bp) {
    const d = p.x * x + p.y * y + p.z * z;
    if (d < b0) b0 = d;
    if (d > b1) b1 = d;
  }
  return Math.min(a1, b1) - Math.max(a0, b0);
}

// ---------------------------------------------------------------------------
// GJK distance (Ericson, Real-Time Collision Detection §9.5, closest point on
// the simplex by its Voronoi regions).

function support(c: Convex, d: P3): P3 {
  let best = c.points[0] as P3;
  let bestDot = dot(best, d);
  for (const p of c.points) {
    const v = dot(p, d);
    if (v > bestDot) {
      bestDot = v;
      best = p;
    }
  }
  return best;
}

interface Closest {
  readonly point: P3;
  readonly keep: readonly P3[];
}

function closestOnSegment(a: P3, b: P3): Closest {
  const ab = sub(b, a);
  const t = -dot(a, ab) / Math.max(dot(ab, ab), 1e-18);
  if (t <= 0) return { point: a, keep: [a] };
  if (t >= 1) return { point: b, keep: [b] };
  return { point: add(a, scale(ab, t)), keep: [a, b] };
}

function closestOnTriangle(a: P3, b: P3, c: P3): Closest {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = scale(a, -1);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, keep: [a] };
  const bp = scale(b, -1);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, keep: [b] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: add(a, scale(ab, v)), keep: [a, b] };
  }
  const cp = scale(c, -1);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, keep: [c] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: add(a, scale(ac, w)), keep: [a, c] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { point: add(b, scale(sub(c, b), w)), keep: [b, c] };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return { point: add(a, add(scale(ab, v), scale(ac, w))), keep: [a, b, c] };
}

function closestOnTetra(a: P3, b: P3, c: P3, d: P3): Closest | null {
  // Origin outside the face (opposite the fourth point)?
  const outside = (p: P3, q: P3, r: P3, s: P3): boolean => {
    const n = cross(sub(q, p), sub(r, p));
    const sp = dot(scale(p, -1), n);
    const ss = dot(sub(s, p), n);
    return sp * ss < 0;
  };
  let best: Closest | null = null;
  let bestD = Infinity;
  const faces: Array<[P3, P3, P3, P3]> = [
    [a, b, c, d],
    [a, c, d, b],
    [a, d, b, c],
    [b, d, c, a],
  ];
  for (const [p, q, r, s] of faces) {
    if (!outside(p, q, r, s)) continue;
    const cl = closestOnTriangle(p, q, r);
    const dd = dot(cl.point, cl.point);
    if (dd < bestD) {
      bestD = dd;
      best = cl;
    }
  }
  return best; // null: the origin is inside
}

/** Exact distance between two convex pieces; 0 when they touch or overlap. */
export function distance(a: Convex, b: Convex): number {
  const minkowski = (d: P3): P3 => sub(support(a, d), support(b, scale(d, -1)));
  let simplex: P3[] = [minkowski(p3(1, 0, 0))];
  let v = simplex[0] as P3;
  for (let iter = 0; iter < 64; iter++) {
    const vv = dot(v, v);
    if (vv < 1e-12) return 0;
    const w = minkowski(scale(v, -1));
    if (vv - dot(v, w) <= 1e-9 * vv + 1e-9) return Math.sqrt(vv);
    simplex = [...simplex, w];
    let cl: Closest | null;
    if (simplex.length === 2) cl = closestOnSegment(simplex[0] as P3, simplex[1] as P3);
    else if (simplex.length === 3) cl = closestOnTriangle(simplex[0] as P3, simplex[1] as P3, simplex[2] as P3);
    else cl = closestOnTetra(simplex[0] as P3, simplex[1] as P3, simplex[2] as P3, simplex[3] as P3);
    if (!cl) return 0;
    const next = cl.point;
    if (dot(next, next) >= vv - 1e-12) return Math.sqrt(Math.min(vv, dot(next, next)));
    v = next;
    simplex = [...cl.keep];
  }
  return Math.sqrt(dot(v, v));
}

export type PairMeasure = { readonly kind: "overlap"; readonly depthMm: number } | { readonly kind: "gap"; readonly gapMm: number };

/**
 * The closest two bodies (each a union of convex pieces) come: the deepest
 * overlap of any two pieces, else the smallest gap. Gaps wider than
 * `farMm` are not measured exactly (only "farther than that").
 */
export function measurePair(a: readonly Convex[], b: readonly Convex[], farMm: number): PairMeasure {
  let deepest = 0;
  let nearest = Infinity;
  for (const pa of a) {
    for (const pb of b) {
      const s = penetration(pa, pb);
      if (s > 0) {
        if (s > deepest) deepest = s;
        continue;
      }
      if (deepest > 0 || -s >= farMm || -s >= nearest) continue;
      const d = distance(pa, pb);
      if (d < nearest) nearest = d;
    }
  }
  if (deepest > 0) return { kind: "overlap", depthMm: deepest };
  return { kind: "gap", gapMm: nearest };
}
