import type { DrawingItem } from "../documents";
import type { Vec2 } from "../types";
import { itemPath } from "./detailing";

/**
 * Curves for drafting edits: a detail line or arc as a parametric curve (t = 0
 * at its start, 1 at its end), their crossings (as drawn, or extended: a line
 * to infinity, an arc to its full circle), and the stored points of a curve cut
 * or lengthened to new parameters. Trim / extend, split, fillet arc and offset
 * all work through these, so lines and arcs behave the same way.
 */

export type Curve =
  | { readonly k: "line"; readonly a: Vec2; readonly b: Vec2 }
  /** `sweep` is signed: positive counter-clockwise (stored frame). A circle sweeps 2π. */
  | { readonly k: "arc"; readonly c: Vec2; readonly r: number; readonly a0: number; readonly sweep: number; readonly full?: boolean };

export interface Hit {
  readonly at: Vec2;
  readonly t1: number;
  readonly t2: number;
}

const TAU = 2 * Math.PI;
const EPS = 1e-9;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => len(sub(a, b));

/** Angle of `p` about `c`. */
const angleOf = (c: Vec2, p: Vec2) => Math.atan2(p.y - c.y, p.x - c.x);

/** The arc's signed sweep from start to end, counter-clockwise unless `ccw` is false. */
export function arcSweep(a0: number, a1: number, ccw: boolean): number {
  const d = (((a1 - a0) % TAU) + TAU) % TAU;
  if (ccw) return d < 1e-12 ? TAU : d;
  return d < 1e-12 ? -TAU : d - TAU;
}

/** The curve a line, arc or circle is (null for anything else). */
export function curveOf(item: Pick<DrawingItem, "shape" | "points" | "ccw">): Curve | null {
  const [p0, p1, p2] = item.points;
  if (item.shape === "line" && p0 && p1) return { k: "line", a: p0, b: p1 };
  if (item.shape === "arc" && p0 && p1 && p2) {
    const a0 = angleOf(p0, p1);
    return { k: "arc", c: p0, r: dist(p1, p0), a0, sweep: arcSweep(a0, angleOf(p0, p2), item.ccw !== false) };
  }
  if (item.shape === "circle" && p0 && p1) return { k: "arc", c: p0, r: dist(p1, p0), a0: angleOf(p0, p1), sweep: TAU, full: true };
  return null;
}

/** Every curve an item's outline is made of: a line or arc itself, or the straight pieces of anything else with a path. */
export function boundaryCurves(item: DrawingItem): Curve[] {
  const own = curveOf(item);
  if (own) return [own];
  const path = itemPath(item) ?? [];
  const out: Curve[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b && dist(a, b) > EPS) out.push({ k: "line", a, b });
  }
  return out;
}

export function pointAt(c: Curve, t: number): Vec2 {
  if (c.k === "line") return add(c.a, mul(sub(c.b, c.a), t));
  const a = c.a0 + c.sweep * t;
  return { x: c.c.x + c.r * Math.cos(a), y: c.c.y + c.r * Math.sin(a) };
}

/** Unit direction of travel at `t`. */
export function tangentAt(c: Curve, t: number): Vec2 {
  if (c.k === "line") {
    const d = sub(c.b, c.a);
    return mul(d, 1 / (len(d) || 1));
  }
  const a = c.a0 + c.sweep * t;
  const s = Math.sign(c.sweep) || 1;
  return { x: -Math.sin(a) * s, y: Math.cos(a) * s };
}

/**
 * The parameter of the point on the (extended) curve nearest `p`. On an arc a
 * point outside the sweep maps to the nearer extension: just past the end
 * (t > 1) or just before the start (t < 0).
 */
export function paramOf(c: Curve, p: Vec2): number {
  if (c.k === "line") {
    const d = sub(c.b, c.a);
    return dot(sub(p, c.a), d) / (dot(d, d) || 1);
  }
  const s = Math.sign(c.sweep) || 1;
  const delta = ((((angleOf(c.c, p) - c.a0) * s) % TAU) + TAU) % TAU;
  const span = Math.abs(c.sweep);
  let t = delta / span;
  if (!c.full && t > 1) {
    const before = (TAU - delta) / span;
    if (before < t - 1) t = -before;
  }
  return t;
}

export function curveLength(c: Curve): number {
  return c.k === "line" ? dist(c.a, c.b) : Math.abs(c.sweep) * c.r;
}

function lineLine(a: Curve & { k: "line" }, b: Curve & { k: "line" }): Hit[] {
  const r = sub(a.b, a.a);
  const s = sub(b.b, b.a);
  const den = cross(r, s);
  if (Math.abs(den) < EPS * Math.max(1, len(r) * len(s))) return [];
  const t1 = cross(sub(b.a, a.a), s) / den;
  const t2 = cross(sub(b.a, a.a), r) / den;
  return [{ at: add(a.a, mul(r, t1)), t1, t2 }];
}

function lineCircle(l: Curve & { k: "line" }, c: Curve & { k: "arc" }): Array<{ at: Vec2; t: number }> {
  const d = sub(l.b, l.a);
  const f = sub(l.a, c.c);
  const A = dot(d, d);
  const B = 2 * dot(f, d);
  const C = dot(f, f) - c.r * c.r;
  const disc = B * B - 4 * A * C;
  if (A < EPS || disc < -1e-9 * Math.max(1, A * c.r * c.r)) return [];
  const root = Math.sqrt(Math.max(0, disc));
  const ts = disc <= 1e-12 ? [-B / (2 * A)] : [(-B - root) / (2 * A), (-B + root) / (2 * A)];
  return ts.map((t) => ({ at: add(l.a, mul(d, t)), t }));
}

function circleCircle(a: Curve & { k: "arc" }, b: Curve & { k: "arc" }): Vec2[] {
  const d = dist(a.c, b.c);
  if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const u = mul(sub(b.c, a.c), 1 / d);
  const m = add(a.c, mul(u, x));
  const n = { x: -u.y, y: u.x };
  return h < 1e-9 ? [m] : [add(m, mul(n, h)), sub(m, mul(n, h))];
}

const inside = (c: Curve, t: number) => c.k === "arc" && c.full ? true : t >= -1e-9 && t <= 1 + 1e-9;

/**
 * Where two curves cross. `extend1` / `extend2` treat that curve as its
 * extension (infinite line, full circle); otherwise only crossings on the
 * drawn piece count.
 */
export function intersect(c1: Curve, c2: Curve, extend1 = false, extend2 = false): Hit[] {
  let raw: Hit[];
  if (c1.k === "line" && c2.k === "line") raw = lineLine(c1, c2);
  else if (c1.k === "line" && c2.k === "arc") raw = lineCircle(c1, c2).map((h) => ({ at: h.at, t1: h.t, t2: paramOf(c2, h.at) }));
  else if (c1.k === "arc" && c2.k === "line") raw = lineCircle(c2, c1).map((h) => ({ at: h.at, t1: paramOf(c1, h.at), t2: h.t }));
  else if (c1.k === "arc" && c2.k === "arc") raw = circleCircle(c1, c2).map((at) => ({ at, t1: paramOf(c1, at), t2: paramOf(c2, at) }));
  else raw = [];
  return raw.filter((h) => (extend1 || inside(c1, h.t1)) && (extend2 || inside(c2, h.t2)));
}

/** Every crossing of `c` (extended when asked) with an item's outline; `t` is along `c`. */
export function crossingsWith(c: Curve, boundary: DrawingItem, extend: boolean): Array<{ at: Vec2; t: number }> {
  return boundaryCurves(boundary).flatMap((b) => intersect(c, b, extend, false).map((h) => ({ at: h.at, t: h.t1 })));
}

const r3 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 });

/** The stored points of the piece of `c` from `t0` to `t1` (t0 < t1; outside 0..1 lengthens it). */
export function piecePoints(c: Curve, t0: number, t1: number): Vec2[] {
  if (c.k === "line") return [r3(pointAt(c, t0)), r3(pointAt(c, t1))];
  return [r3(c.c), r3(pointAt(c, t0)), r3(pointAt(c, t1))];
}

/** Start and end of a line, arc or open polyline (null when it has no ends: circles, closed shapes, notes). */
export function endsOf(item: Pick<DrawingItem, "shape" | "points" | "closed">): { readonly start: Vec2; readonly end: Vec2 } | null {
  const p = item.points;
  if (item.shape === "line" && p[0] && p[1]) return { start: p[0], end: p[1] };
  if (item.shape === "arc" && p[1] && p[2] && p[0]) {
    // The stored end may sit off the radius; the arc ends on its circle.
    const r = dist(p[1], p[0]);
    const a = angleOf(p[0], p[2]);
    return { start: p[1], end: { x: p[0].x + r * Math.cos(a), y: p[0].y + r * Math.sin(a) } };
  }
  if ((item.shape === "polyline" || item.shape === "spline") && !item.closed && p.length >= 2) {
    const s = p[0];
    const e = p[p.length - 1];
    return s && e ? { start: s, end: e } : null;
  }
  return null;
}

/** The circle through three points (null when they are in a line). */
export function circleThrough(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const center = { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
  return { center, r: dist(a, center) };
}

/** An arc's stored points and direction from its start, a point it passes through, and its end. */
export function arcThrough(start: Vec2, through: Vec2, end: Vec2): { points: Vec2[]; ccw: boolean } | null {
  const circle = circleThrough(start, through, end);
  if (!circle) return null;
  const ccw = cross(sub(through, start), sub(end, through)) > 0;
  return { points: [r3(circle.center), r3(start), r3(end)], ccw };
}

/** The stored points of an item with one end moved (lines, open polylines; arcs keep their bulge). Null when the item has no such end. */
export function withEndMoved(item: DrawingItem, which: "start" | "end", to: Vec2): { points: Vec2[]; ccw?: boolean } | null {
  const p = item.points;
  if (item.shape === "line" && p.length === 2) return { points: which === "start" ? [r3(to), p[1] ?? to] : [p[0] ?? to, r3(to)] };
  if ((item.shape === "polyline" || item.shape === "spline") && !item.closed && p.length >= 2) return { points: which === "start" ? [r3(to), ...p.slice(1)] : [...p.slice(0, -1), r3(to)] };
  if (item.shape === "arc") {
    const c = curveOf(item);
    const ends = endsOf(item);
    if (!c || c.k !== "arc" || !ends) return null;
    const mid = pointAt(c, 0.5);
    const s0 = ends.start;
    const e0 = ends.end;
    // Keep the arc's bulge: the midpoint's height off the chord, as a share of the chord.
    const chord0 = sub(e0, s0);
    const l0 = len(chord0) || 1;
    const h = cross(chord0, sub(mid, s0)) / l0 / l0;
    const s = which === "start" ? to : s0;
    const e = which === "end" ? to : e0;
    const chord = sub(e, s);
    const l = len(chord);
    if (l < 1e-6) return null;
    const n = { x: -chord.y, y: chord.x };
    const through = add(add(s, mul(chord, 0.5)), mul(n, h));
    return arcThrough(s, through, e);
  }
  return null;
}
