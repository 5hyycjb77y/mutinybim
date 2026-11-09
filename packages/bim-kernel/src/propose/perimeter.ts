import { cross, distance, dot, length, perp, sub, unit } from "../geometry";
import type { Vec2 } from "../types";
import type { PerimeterSpan } from "./types";

/**
 * A room outline walked as one line (the floor line): every point of it has a
 * distance along the perimeter from the first corner. Spacing rules measure
 * along that line, around corners, exactly as NEC 210.52 measures wall space.
 */

const EPS = 1e-6;

export interface Edge {
  readonly index: number;
  readonly a: Vec2;
  readonly b: Vec2;
  /** Unit direction a → b. */
  readonly dir: Vec2;
  readonly length: number;
  /** Distance along the perimeter at `a`. */
  readonly start: number;
}

export interface Perimeter {
  readonly edges: readonly Edge[];
  readonly length: number;
  /** Perimeter distances of the corners. */
  readonly corners: readonly number[];
}

export function signedArea(outline: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a && b) s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** The outline counter-clockwise with repeated and collinear corners removed. */
export function normalizeOutline(outline: readonly Vec2[]): Vec2[] {
  const pts: Vec2[] = [];
  for (const p of outline) {
    const last = pts[pts.length - 1];
    if (!last || distance(last, p) > 1) pts.push(p);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && pts.length > 1 && distance(first, last) <= 1) pts.pop();
  const ccw = signedArea(pts) < 0 ? [...pts].reverse() : pts;
  const out: Vec2[] = [];
  for (let i = 0; i < ccw.length; i++) {
    const prev = ccw[(i - 1 + ccw.length) % ccw.length];
    const here = ccw[i];
    const next = ccw[(i + 1) % ccw.length];
    if (!prev || !here || !next) continue;
    if (Math.abs(cross(unit(sub(here, prev)), unit(sub(next, here)))) < 1e-4 && dot(sub(here, prev), sub(next, here)) > 0) continue;
    out.push(here);
  }
  return out;
}

export function perimeterOf(outline: readonly Vec2[]): Perimeter {
  const edges: Edge[] = [];
  let start = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    const len = distance(a, b);
    if (len < EPS) continue;
    edges.push({ index: edges.length, a, b, dir: unit(sub(b, a)), length: len, start });
    start += len;
  }
  return { edges, length: start, corners: edges.map((e) => e.start) };
}

export const wrap = (s: number, total: number): number => ((s % total) + total) % total;

/** The edge and point at a perimeter distance. */
export function pointAt(p: Perimeter, s: number): { edge: Edge; point: Vec2 } {
  const t = wrap(s, p.length);
  let edge = p.edges[p.edges.length - 1];
  for (const e of p.edges) {
    if (t < e.start + e.length - EPS) {
      edge = e;
      break;
    }
  }
  if (!edge) throw new Error("A room outline needs at least three corners");
  const along = Math.min(Math.max(t - edge.start, 0), edge.length);
  return { edge, point: { x: edge.a.x + edge.dir.x * along, y: edge.a.y + edge.dir.y * along } };
}

/** Into the room from an edge (counter-clockwise outline: the interior is on the left). */
export const inward = (edge: Edge): Vec2 => perp(edge.dir);

/** Nearest point of the perimeter to `q`: its perimeter distance and how far `q` is from the floor line. */
export function project(p: Perimeter, q: Vec2): { s: number; offset: number; edge: Edge } {
  let best: { s: number; offset: number; edge: Edge } | null = null;
  for (const e of p.edges) {
    const t = Math.min(Math.max(dot(sub(q, e.a), e.dir), 0), e.length);
    const foot = { x: e.a.x + e.dir.x * t, y: e.a.y + e.dir.y * t };
    const d = distance(q, foot);
    if (!best || d < best.offset - EPS) best = { s: e.start + t, offset: d, edge: e };
  }
  if (!best) throw new Error("A room outline needs at least three corners");
  return best;
}

/** A segment's shadow on the perimeter where it runs along an edge (parallel, within `tolMm` of it): perimeter spans. */
export function shadowOn(p: Perimeter, a: Vec2, b: Vec2, tolMm: number): PerimeterSpan[] {
  const out: PerimeterSpan[] = [];
  const d = sub(b, a);
  const len = length(d);
  if (len < EPS) return out;
  const u = unit(d);
  for (const e of p.edges) {
    if (Math.abs(cross(u, e.dir)) > 0.02) continue;
    const off = (q: Vec2) => Math.abs(cross(e.dir, sub(q, e.a)));
    if (off(a) > tolMm || off(b) > tolMm) continue;
    const ta = dot(sub(a, e.a), e.dir);
    const tb = dot(sub(b, e.a), e.dir);
    const lo = Math.max(Math.min(ta, tb), 0);
    const hi = Math.min(Math.max(ta, tb), e.length);
    if (hi - lo > 1) out.push({ from: e.start + lo, to: e.start + hi });
  }
  return out;
}

/** Spans merged on the cycle [0, total): sorted, non-overlapping, a span crossing the start split in two. */
export function mergeSpans(spans: readonly PerimeterSpan[], total: number): PerimeterSpan[] {
  const flat: PerimeterSpan[] = [];
  for (const s of spans) {
    const len = s.to - s.from;
    if (len <= EPS) continue;
    if (len >= total - EPS) return [{ from: 0, to: total }];
    const from = wrap(s.from, total);
    const to = from + len;
    if (to <= total + EPS) flat.push({ from, to: Math.min(to, total) });
    else flat.push({ from, to: total }, { from: 0, to: to - total });
  }
  flat.sort((x, y) => x.from - y.from || x.to - y.to);
  const out: PerimeterSpan[] = [];
  for (const s of flat) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + EPS) out[out.length - 1] = { from: last.from, to: Math.max(last.to, s.to) };
    else out.push(s);
  }
  return out;
}

/**
 * The stretches left between blocked spans, in unwrapped coordinates (`to`
 * may pass the perimeter length when a stretch runs through the first
 * corner). No blocks: one closed stretch.
 */
export function openRuns(blocked: readonly PerimeterSpan[], total: number): { runs: PerimeterSpan[]; closed: boolean } {
  const m = mergeSpans(blocked, total);
  if (m.length === 0) return { runs: [{ from: 0, to: total }], closed: true };
  const firstBlock = m[0];
  if (m.length === 1 && firstBlock && firstBlock.from <= EPS && firstBlock.to >= total - EPS) return { runs: [], closed: false };
  // A block touching the end and one touching the start are one block.
  const blocks = [...m];
  const head = blocks[0];
  const tail = blocks[blocks.length - 1];
  if (blocks.length > 1 && head && tail && head.from <= EPS && tail.to >= total - EPS) {
    blocks.shift();
    blocks[blocks.length - 1] = { from: tail.from, to: total + head.to };
  }
  const runs: PerimeterSpan[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const here = blocks[i];
    const next = blocks[(i + 1) % blocks.length];
    if (!here || !next) continue;
    let from = here.to;
    let to = i + 1 < blocks.length ? next.from : next.from + total;
    if (from >= total - EPS) {
      from -= total;
      to -= total;
    }
    if (to - from > EPS) runs.push({ from, to });
  }
  return { runs, closed: false };
}

/** `s` (any perimeter distance) moved into a run's unwrapped range, or null when it is outside the run. */
export function inRun(run: PerimeterSpan, s: number, total: number): number | null {
  const t = wrap(s, total);
  for (const c of [t, t + total, t - total]) if (c >= run.from - 1 && c <= run.to + 1) return Math.min(Math.max(c, run.from), run.to);
  return null;
}

/** Furthest any point of the run is from one of `points` (already in the run's range). Infinity with none. */
export function worstDistance(run: PerimeterSpan, points: readonly number[], closed: boolean): number {
  const sorted = [...points].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return Number.POSITIVE_INFINITY;
  let worst = 0;
  for (let i = 1; i < sorted.length; i++) worst = Math.max(worst, ((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)) / 2);
  if (closed) return Math.max(worst, (first + (run.to - run.from) - last) / 2);
  return Math.max(worst, first - run.from, run.to - last);
}

/**
 * The fewest new points, evenly spread in each uncovered stretch, so no point
 * of the run is more than `reach` from a point. `existing` are in the run's
 * range. Deterministic: the same run and points always give the same answer.
 */
export function fillRun(run: PerimeterSpan, existing: readonly number[], reach: number, closed: boolean): number[] {
  const len = run.to - run.from;
  if (len <= EPS) return [];
  if (closed && existing.length === 0) {
    const n = Math.max(1, Math.ceil(len / (2 * reach) - 1e-9));
    return Array.from({ length: n }, (_, i) => run.from + (i * len) / n);
  }
  let span = run;
  let pts = [...existing].sort((a, b) => a - b);
  if (closed) {
    // Unroll the loop at the first existing device.
    const e0 = pts[0] ?? run.from;
    span = { from: e0, to: e0 + len };
    pts = [...pts, e0 + len];
  }
  const covered: PerimeterSpan[] = pts.map((p) => ({ from: p - reach, to: p + reach }));
  const out: number[] = [];
  let cursor = span.from;
  const gaps: PerimeterSpan[] = [];
  for (const c of covered) {
    if (c.from > cursor + EPS) gaps.push({ from: cursor, to: Math.min(c.from, span.to) });
    cursor = Math.max(cursor, c.to);
    if (cursor >= span.to) break;
  }
  if (cursor < span.to - EPS) gaps.push({ from: cursor, to: span.to });
  for (const g of gaps) {
    const glen = g.to - g.from;
    if (glen <= 1) continue;
    const n = Math.max(1, Math.ceil(glen / (2 * reach) - 1e-9));
    for (let i = 0; i < n; i++) out.push(g.from + ((i + 0.5) * glen) / n);
  }
  return out;
}

/**
 * Slide new points off corners (a device in a corner is hard to use and
 * to install) when the run stays covered. Existing points never move.
 */
export function clearCorners(run: PerimeterSpan, existing: readonly number[], fresh: readonly number[], reach: number, closed: boolean, corners: readonly number[], total: number, clearMm: number): number[] {
  const out = [...fresh];
  const cornerIn = corners.flatMap((c) => [c, c + total, c - total]).filter((c) => c > run.from + EPS && c < run.to - EPS);
  for (let i = 0; i < out.length; i++) {
    const s = out[i] ?? 0;
    const near = cornerIn.find((c) => Math.abs(c - s) < clearMm);
    if (near === undefined) continue;
    for (const target of [near + clearMm, near - clearMm]) {
      if (target < run.from || target > run.to) continue;
      const trial = [...out];
      trial[i] = target;
      if (worstDistance(run, [...existing, ...trial], closed) <= reach + 1) {
        out[i] = target;
        break;
      }
    }
  }
  return out;
}

/** Shortest distance from a point to a polygon's edges (0 inside is not special: the edge distance). */
export function distanceToOutline(q: Vec2, outline: readonly Vec2[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    const d = sub(b, a);
    const len = length(d);
    const t = len < EPS ? 0 : Math.min(Math.max(dot(sub(q, a), d) / (len * len), 0), 1);
    best = Math.min(best, distance(q, { x: a.x + d.x * t, y: a.y + d.y * t }));
  }
  return best;
}

export function pointInOutline(q: Vec2, outline: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (!a || !b) continue;
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function centroid(outline: readonly Vec2[]): Vec2 {
  const n = outline.length || 1;
  return { x: outline.reduce((a, p) => a + p.x, 0) / n, y: outline.reduce((a, p) => a + p.y, 0) / n };
}

/** A rectangle footprint's long and short sides and the long side's direction. */
export function rectSides(outline: readonly Vec2[]): { long: number; short: number; dir: Vec2; longEdge: [Vec2, Vec2] } {
  const edges: Array<[Vec2, Vec2]> = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (a && b) edges.push([a, b]);
  }
  const lens = edges.map(([a, b]) => distance(a, b));
  let li = 0;
  for (let i = 1; i < lens.length; i++) if ((lens[i] ?? 0) > (lens[li] ?? 0) + EPS) li = i;
  const longEdge = edges[li] ?? [outline[0] ?? { x: 0, y: 0 }, outline[1] ?? { x: 0, y: 0 }];
  const dir = unit(sub(longEdge[1], longEdge[0]));
  const across = perp(dir);
  const spread = (axis: Vec2) => {
    const vals = outline.map((p) => dot(p, axis));
    return Math.max(...vals) - Math.min(...vals);
  };
  return { long: spread(dir), short: spread(across), dir, longEdge };
}

export const MM_PER_FT = 304.8;

/** 14' 2" (rounded to the inch). */
export function feetInches(mm: number): string {
  const inches = Math.round(mm / 25.4);
  const ft = Math.floor(inches / 12);
  const inch = inches - ft * 12;
  return inch === 0 ? `${ft}'` : `${ft}' ${inch}"`;
}
