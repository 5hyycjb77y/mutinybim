import type { ElementId, Vec2 } from "../../types";
import type { BoundaryRef } from "../types";

/**
 * The closed region around one plan point, from a handful of boundary
 * segments: a local planar arrangement (split every segment where another
 * meets it, drop dangling ends, walk the faces) and the smallest bounded face
 * holding the point. Pure: the caller hands it only the segments near the
 * point (the boundary index), never a level.
 */

export interface WalkSegment {
  readonly elementId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
}

export interface FaceFound {
  readonly ok: true;
  /** Counter-clockwise, no repeated or collinear corners (model mm). */
  readonly outline: readonly Vec2[];
  /** One per straight run of one element, in outline order. */
  readonly boundary: readonly BoundaryRef[];
}

export interface NoFace {
  readonly ok: false;
  /** The loose end nearest the point: where the walls leave a gap. Absent: nothing near it bounds at all. */
  readonly gap?: { readonly at: Vec2; readonly elementId: ElementId };
}

/** Corners closer than this are one corner (model mm). */
export const SAME_POINT_MM = 0.5;
const PARALLEL = 1e-9;

interface Vertex {
  readonly p: Vec2;
  /** Ids of the vertices it connects to. */
  readonly out: Set<number>;
}

class Vertices {
  readonly all: Vertex[] = [];
  private readonly byCell = new Map<string, number[]>();

  at(p: Vec2): number {
    const cx = Math.floor(p.x / SAME_POINT_MM);
    const cy = Math.floor(p.y / SAME_POINT_MM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.byCell.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = (this.all[i] as Vertex).p;
          if (Math.hypot(q.x - p.x, q.y - p.y) <= SAME_POINT_MM) return i;
        }
      }
    }
    const id = this.all.length;
    this.all.push({ p: { x: p.x, y: p.y }, out: new Set() });
    const key = `${cx},${cy}`;
    const list = this.byCell.get(key);
    if (list) list.push(id);
    else this.byCell.set(key, [id]);
    return id;
  }
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Where along `a→b` (0..1) the segment `c→d` meets it; collinear overlaps give `c` and `d` where they lie on it. */
function cuts(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number[] {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const len = Math.hypot(rx, ry);
  if (len === 0) return [];
  const denom = rx * sy - ry * sx;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const tol = SAME_POINT_MM / len;
  if (Math.abs(denom) <= PARALLEL * len * Math.hypot(sx, sy)) {
    // Parallel: only collinear pieces cut it, at the other segment's ends.
    if (Math.abs(qx * ry - qy * rx) / len > SAME_POINT_MM) return [];
    const out: number[] = [];
    for (const p of [c, d]) {
      const t = ((p.x - a.x) * rx + (p.y - a.y) * ry) / (len * len);
      if (t > -tol && t < 1 + tol) out.push(Math.min(1, Math.max(0, t)));
    }
    return out;
  }
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const tolU = SAME_POINT_MM / Math.max(Math.hypot(sx, sy), 1e-9);
  if (t < -tol || t > 1 + tol || u < -tolU || u > 1 + tolU) return [];
  return [Math.min(1, Math.max(0, t))];
}

function boxesMeet(a: WalkSegment, b: WalkSegment): boolean {
  const pad = SAME_POINT_MM;
  return (
    Math.min(a.start.x, a.end.x) - pad <= Math.max(b.start.x, b.end.x) &&
    Math.min(b.start.x, b.end.x) - pad <= Math.max(a.start.x, a.end.x) &&
    Math.min(a.start.y, a.end.y) - pad <= Math.max(b.start.y, b.end.y) &&
    Math.min(b.start.y, b.end.y) - pad <= Math.max(a.start.y, a.end.y)
  );
}

function signedArea(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function inside(points: readonly Vec2[], p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i] as Vec2;
    const b = points[j] as Vec2;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function collinear(a: Vec2, b: Vec2, c: Vec2): boolean {
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
  return dot > 0 && Math.abs(cross) <= SAME_POINT_MM * Math.hypot(c.x - a.x, c.y - a.y);
}

interface Arrangement {
  readonly vs: Vertices;
  readonly segs: readonly WalkSegment[];
  readonly owner: ReadonlyMap<string, ElementId>;
  readonly order: ReadonlyMap<number, readonly number[]>;
  readonly tails: ReadonlyMap<number, number>;
}

/** Split every segment where another meets it, peel the loose ends, and order each corner's edges by angle. */
function arrange(segments: readonly WalkSegment[]): Arrangement {
  const segs = [...segments].filter((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > SAME_POINT_MM).sort((a, b) => (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0));
  const vs = new Vertices();
  const owner = new Map<string, ElementId>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as WalkSegment;
    const ts = [0, 1];
    for (let j = 0; j < segs.length; j++) {
      if (j === i) continue;
      const o = segs[j] as WalkSegment;
      if (boxesMeet(s, o)) ts.push(...cuts(s.start, s.end, o.start, o.end));
    }
    ts.sort((a, b) => a - b);
    let prev: number | null = null;
    for (const t of ts) {
      const v = vs.at({ x: s.start.x + (s.end.x - s.start.x) * t, y: s.start.y + (s.end.y - s.start.y) * t });
      if (prev !== null && prev !== v) {
        const key = edgeKey(prev, v);
        if (!owner.has(key)) owner.set(key, s.elementId);
        (vs.all[prev] as Vertex).out.add(v);
        (vs.all[v] as Vertex).out.add(prev);
      }
      prev = v;
    }
  }

  const ends = vs.all.flatMap((v, i) => (v.out.size === 1 ? [i] : []));
  const tails = new Map(ends.map((i) => [i, tailLength(vs, i)] as const));

  // Loose ends (a wall stub, the overshoot past a corner, a gap) bound nothing: peel them off.
  const stack = [...ends];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const v = vs.all[i] as Vertex;
    if (v.out.size !== 1) continue;
    const [n] = v.out;
    v.out.clear();
    if (n === undefined) continue;
    const other = vs.all[n] as Vertex;
    other.out.delete(i);
    if (other.out.size === 1) stack.push(n);
  }

  const order = new Map<number, number[]>();
  for (let i = 0; i < vs.all.length; i++) {
    const v = vs.all[i] as Vertex;
    if (v.out.size === 0) continue;
    order.set(i, [...v.out].sort((a, b) => angle(v.p, (vs.all[a] as Vertex).p) - angle(v.p, (vs.all[b] as Vertex).p)));
  }
  return { vs, segs, owner, order, tails };
}

/** Every bounded face (counter-clockwise, positive area), each once. */
function boundedCycles(arr: Arrangement): Array<{ readonly cycle: number[]; readonly points: Vec2[]; readonly area: number }> {
  const visited = new Set<string>();
  const out: Array<{ cycle: number[]; points: Vec2[]; area: number }> = [];
  for (const [u, outs] of arr.order) {
    for (const v of outs) {
      if (visited.has(`${u}>${v}`)) continue;
      const cycle: number[] = [];
      let a = u;
      let b = v;
      while (!visited.has(`${a}>${b}`)) {
        visited.add(`${a}>${b}`);
        cycle.push(a);
        const around = arr.order.get(b) ?? [];
        const k = around.indexOf(a);
        const next = around[(k - 1 + around.length) % around.length] as number;
        a = b;
        b = next;
      }
      const points = cycle.map((i) => (arr.vs.all[i] as Vertex).p);
      const area = signedArea(points);
      if (area > 0) out.push({ cycle, points, area });
    }
  }
  return out;
}

/**
 * The smallest closed region holding `seed`, bounded by `segments`. Overlapping
 * pieces of two elements are one edge, kept for the element that sorts first.
 */
export function faceAround(segments: readonly WalkSegment[], seed: Vec2): FaceFound | NoFace {
  const arr = arrange(segments);
  let best: { readonly cycle: number[]; readonly area: number } | null = null;
  for (const f of boundedCycles(arr)) if ((!best || f.area < best.area) && inside(f.points, seed)) best = f;
  if (!best) return gapNear(arr.vs, arr.segs, arr.tails, seed);
  return tidy(best.cycle, (i) => (arr.vs.all[i] as Vertex).p, arr.owner);
}

/**
 * Every closed region `segments` make, each with a point inside it, in
 * outline order (lowest, then leftmost first corner). A region holding
 * another region's loop (an island) is listed as its outer loop.
 */
export function regionsOf(segments: readonly WalkSegment[]): Array<FaceFound & { readonly inside: Vec2 }> {
  const arr = arrange(segments);
  return boundedCycles(arr).flatMap((f) => {
    const found = tidy(f.cycle, (i) => (arr.vs.all[i] as Vertex).p, arr.owner);
    const at = pointInside(found.outline);
    return at ? [{ ...found, inside: at }] : [];
  });
}

/** A point strictly inside a simple outline: its centroid when that is inside, else a point just inside its longest edge. */
export function pointInside(outline: readonly Vec2[]): Vec2 | null {
  const a = signedArea(outline);
  if (outline.length < 3 || a === 0) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i] as Vec2;
    const q = outline[(i + 1) % outline.length] as Vec2;
    const c = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  const centroid = { x: cx / (6 * a), y: cy / (6 * a) };
  if (inside(outline, centroid)) return centroid;
  let best = 0;
  let len = -1;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i] as Vec2;
    const q = outline[(i + 1) % outline.length] as Vec2;
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l > len) {
      len = l;
      best = i;
    }
  }
  const p = outline[best] as Vec2;
  const q = outline[(best + 1) % outline.length] as Vec2;
  const sign = a > 0 ? 1 : -1;
  const step = Math.min(10, len / 4);
  const at = { x: (p.x + q.x) / 2 - (sign * (q.y - p.y) * step) / len, y: (p.y + q.y) / 2 + (sign * (q.x - p.x) * step) / len };
  return inside(outline, at) ? at : null;
}

/** A loose end this far from where its line last met another is a real opening, not the short overshoot past a butt corner. */
const OPEN_TAIL_MM = 1000;

/** From a loose end, how far its line runs before it meets another (Infinity: it never does). */
function tailLength(vs: Vertices, from: number): number {
  let length = 0;
  let prev = -1;
  let at = from;
  for (;;) {
    const v = vs.all[at] as Vertex;
    const next = [...v.out].find((n) => n !== prev);
    if (next === undefined) return Infinity;
    const q = (vs.all[next] as Vertex).p;
    length += Math.hypot(q.x - v.p.x, q.y - v.p.y);
    const degree = (vs.all[next] as Vertex).out.size;
    if (degree >= 3) return length;
    if (degree === 1) return Infinity;
    prev = at;
    at = next;
  }
}

/** Whether the straight sight line from `seed` to `p` crosses no segment short of `p`. */
function seen(segs: readonly WalkSegment[], seed: Vec2, p: Vec2): boolean {
  const len = Math.hypot(p.x - seed.x, p.y - seed.y);
  if (len <= SAME_POINT_MM) return true;
  const stop = 1 - SAME_POINT_MM / len;
  return segs.every((s) => cuts(seed, p, s.start, s.end).every((t) => t >= stop));
}

/**
 * Where the walls leave a gap: the loose end nearest the point that can be
 * seen from it, preferring a real opening over a corner overshoot; else the
 * nearest loose end at all.
 */
function gapNear(vs: Vertices, segs: readonly WalkSegment[], tails: ReadonlyMap<number, number>, seed: Vec2): NoFace {
  const ends = [...tails].flatMap(([i, tail]) => {
    const p = (vs.all[i] as Vertex).p;
    const seg = segs.find((s) => Math.hypot(s.start.x - p.x, s.start.y - p.y) <= SAME_POINT_MM || Math.hypot(s.end.x - p.x, s.end.y - p.y) <= SAME_POINT_MM);
    return seg ? [{ at: p, elementId: seg.elementId, open: tail >= OPEN_TAIL_MM, d: Math.hypot(p.x - seed.x, p.y - seed.y) }] : [];
  });
  ends.sort((a, b) => a.d - b.d);
  const pick = ends.find((e) => e.open && seen(segs, seed, e.at)) ?? ends.find((e) => seen(segs, seed, e.at)) ?? ends[0];
  return pick ? { ok: false, gap: { at: pick.at, elementId: pick.elementId } } : { ok: false };
}

function angle(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Corners and runs: drop corners in the middle of a straight run of one element, then one ref per run. */
function tidy(cycle: readonly number[], point: (i: number) => Vec2, owner: ReadonlyMap<string, ElementId>): FaceFound {
  const n = cycle.length;
  const edgeOwner = (k: number): ElementId => owner.get(edgeKey(cycle[k] as number, cycle[(k + 1) % n] as number)) as ElementId;
  const keepCorner = (k: number): boolean => {
    const before = (k - 1 + n) % n;
    return edgeOwner(before) !== edgeOwner(k) || !collinear(point(cycle[before] as number), point(cycle[k] as number), point(cycle[(k + 1) % n] as number));
  };
  let start = 0;
  while (start < n && !keepCorner(start)) start++;
  const corners: number[] = [];
  for (let s = 0; s < n; s++) {
    const k = (start + s) % n;
    if (keepCorner(k)) corners.push(k);
  }
  const at = (k: number): Vec2 => {
    const p = point(cycle[k] as number);
    return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
  };
  // The same room traced again (from another set of segments read) starts at the same corner: lowest, then leftmost.
  let first = 0;
  for (let i = 1; i < corners.length; i++) {
    const p = at(corners[i] as number);
    const q = at(corners[first] as number);
    if (p.y < q.y || (p.y === q.y && p.x < q.x)) first = i;
  }
  const ordered = [...corners.slice(first), ...corners.slice(0, first)];
  const outline = ordered.map(at);
  const boundary: BoundaryRef[] = ordered.map((k, i) => ({ elementId: edgeOwner(k), start: outline[i] as Vec2, end: outline[(i + 1) % outline.length] as Vec2 }));
  return { ok: true, outline, boundary };
}
