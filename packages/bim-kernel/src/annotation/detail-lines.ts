import type { DrawingItem } from "../documents";
import type { Vec2 } from "../types";
import { dist, endsOf } from "./detail-curves";

/**
 * Detail lines the way drafting views in BIM tools work them: every line and
 * arc is its own element, and elements whose ends meet are joined. A joined
 * end follows when the end it meets is moved (drag, Move, trim, fillet), so a
 * rectangle stays closed as its sides are edited. Joins are found from the
 * geometry (ends within `JOIN_TOLERANCE`), so they survive copy, undo and
 * agent edits without a second record to keep in step.
 *
 * The draw helpers here turn one gesture (rectangle, polygon, chain) into the
 * joined lines it makes; the caller adds them as one edit.
 */

/** Stored units (mm). Ends nearer than this are one join. */
export const JOIN_TOLERANCE = 0.01;

export type EndName = "start" | "end";

export interface JoinedEnd {
  readonly item: DrawingItem;
  readonly end: EndName;
}

/** Items (other than `exceptIds`) with an end on `p`. */
export function endsAt(items: readonly DrawingItem[], p: Vec2, exceptIds: ReadonlySet<string> = new Set()): JoinedEnd[] {
  const out: JoinedEnd[] = [];
  for (const it of items) {
    if (it.deleted || exceptIds.has(it.id)) continue;
    const e = endsOf(it);
    if (!e) continue;
    if (dist(e.start, p) <= JOIN_TOLERANCE) out.push({ item: it, end: "start" });
    if (dist(e.end, p) <= JOIN_TOLERANCE) out.push({ item: it, end: "end" });
  }
  return out;
}

/** Ends of lines and arcs bucketed on a grid, for finding joins in large details without a scan per end. */
export class EndIndex {
  private readonly cells = new Map<string, JoinedEnd[]>();
  private static readonly CELL = 1;

  constructor(items: readonly DrawingItem[]) {
    for (const it of items) {
      if (it.deleted) continue;
      const e = endsOf(it);
      if (!e) continue;
      this.put(e.start, { item: it, end: "start" });
      this.put(e.end, { item: it, end: "end" });
    }
  }

  private key(ix: number, iy: number): string {
    return `${ix},${iy}`;
  }

  private put(p: Vec2, j: JoinedEnd): void {
    const k = this.key(Math.floor(p.x / EndIndex.CELL), Math.floor(p.y / EndIndex.CELL));
    const list = this.cells.get(k);
    if (list) list.push(j);
    else this.cells.set(k, [j]);
  }

  /** Ends within the join tolerance of `p`, other than those of `exceptIds`. */
  at(p: Vec2, exceptIds: ReadonlySet<string> = new Set()): JoinedEnd[] {
    const out: JoinedEnd[] = [];
    const ix = Math.floor(p.x / EndIndex.CELL);
    const iy = Math.floor(p.y / EndIndex.CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of this.cells.get(this.key(ix + dx, iy + dy)) ?? []) {
          if (exceptIds.has(j.item.id)) continue;
          const e = endsOf(j.item);
          if (e && dist(e[j.end], p) <= JOIN_TOLERANCE) out.push(j);
        }
      }
    }
    return out;
  }
}

/**
 * The chain an item belongs to: it and every line or arc reachable through
 * joined ends, in walk order (Tab in a BIM drafting view picks this).
 */
export function chainOf(items: readonly DrawingItem[], startId: string, limit = 2000): DrawingItem[] {
  const live = items.filter((i) => !i.deleted && endsOf(i));
  const first = live.find((i) => i.id === startId);
  if (!first) return [];
  const index = new EndIndex(live);
  const seen = new Set<string>([first.id]);
  const out: DrawingItem[] = [first];
  for (let k = 0; k < out.length && out.length < limit; k++) {
    const cur = out[k];
    const e = cur ? endsOf(cur) : null;
    if (!e) continue;
    for (const p of [e.start, e.end]) {
      for (const j of index.at(p, seen)) {
        if (seen.has(j.item.id)) continue;
        seen.add(j.item.id);
        out.push(j.item);
      }
    }
  }
  return out;
}

const r3 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 });

/** The sides of a rectangle from two opposite corners, counter-clockwise from `a`'s horizontal side: four joined lines. */
export function rectangleLines(a: Vec2, b: Vec2): Array<[Vec2, Vec2]> {
  const c1 = r3({ x: b.x, y: a.y });
  const c3 = r3({ x: a.x, y: b.y });
  const A = r3(a);
  const B = r3(b);
  return [
    [A, c1],
    [c1, B],
    [B, c3],
    [c3, A],
  ];
}

/**
 * A regular polygon's sides as joined lines. `inscribed`: the corners sit on
 * the circle through `radiusPoint`; circumscribed: the sides touch it. The
 * first corner (or side midpoint) points at `radiusPoint`.
 */
export function polygonLines(center: Vec2, radiusPoint: Vec2, sides: number, inscribed: boolean): Array<[Vec2, Vec2]> {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const r = dist(center, radiusPoint);
  if (r < 1e-6) return [];
  const a0 = Math.atan2(radiusPoint.y - center.y, radiusPoint.x - center.x) - (inscribed ? 0 : Math.PI / n);
  const R = inscribed ? r : r / Math.cos(Math.PI / n);
  const corners = Array.from({ length: n }, (_, i) => r3({ x: center.x + R * Math.cos(a0 + (2 * Math.PI * i) / n), y: center.y + R * Math.sin(a0 + (2 * Math.PI * i) / n) }));
  return corners.map((p, i) => [p, corners[(i + 1) % n] ?? p]);
}

/** Lines through clicked points, each joined to the next (the Chain option); `closed` joins the last back to the first. */
export function chainLines(points: readonly Vec2[], closed: boolean): Array<[Vec2, Vec2]> {
  const pts = points.map(r3).filter((p, i, all) => i === 0 || dist(p, all[i - 1] ?? p) > JOIN_TOLERANCE);
  const out: Array<[Vec2, Vec2]> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) out.push([a, b]);
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (closed && first && last && pts.length >= 3 && dist(first, last) > JOIN_TOLERANCE) out.push([last, first]);
  return out;
}

/** Start-end-radius arc: centre on the side of start→end that `side` is on (the short way round). */
export function arcStartEndRadius(start: Vec2, end: Vec2, radius: number, side: Vec2): { points: Vec2[]; ccw: boolean } | null {
  const chord = dist(start, end);
  if (chord < 1e-6 || radius < chord / 2 - 1e-9) return null;
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const u = { x: (end.x - start.x) / chord, y: (end.y - start.y) / chord };
  const n = { x: -u.y, y: u.x };
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  const left = (side.x - start.x) * n.x + (side.y - start.y) * n.y > 0;
  // The arc bulges toward `side`, so its centre sits on the other side of the chord.
  const center = { x: mid.x - n.x * h * (left ? 1 : -1), y: mid.y - n.y * h * (left ? 1 : -1) };
  return { points: [r3(center), r3(start), r3(end)], ccw: !left };
}

/** An arc that leaves `start` along `direction` (the line it continues) and ends at `end`: Tangent End Arc. */
export function tangentEndArc(start: Vec2, direction: Vec2, end: Vec2): { points: Vec2[]; ccw: boolean } | null {
  const l = Math.hypot(direction.x, direction.y);
  if (l < 1e-9) return null;
  const d = { x: direction.x / l, y: direction.y / l };
  const n = { x: -d.y, y: d.x };
  const v = { x: end.x - start.x, y: end.y - start.y };
  const vn = v.x * n.x + v.y * n.y;
  if (Math.abs(vn) < 1e-9) return null;
  // Centre on the normal through start, equidistant from start and end.
  const k = (v.x * v.x + v.y * v.y) / (2 * vn);
  const center = { x: start.x + n.x * k, y: start.y + n.y * k };
  return { points: [r3(center), r3(start), r3(end)], ccw: k > 0 };
}
