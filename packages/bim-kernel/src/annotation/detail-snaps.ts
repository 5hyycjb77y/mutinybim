import type { DrawingItem } from "../documents";
import type { Vec2 } from "../types";
import { itemPath } from "./detailing";

/**
 * Object snaps and tracking for drafting: where a click lands on the linework
 * already drawn (endpoint, midpoint, centre, intersection, perpendicular from
 * the last point, nearest point on a line), and ortho / polar tracking from the
 * last point. Pure and in paper mm, so the canvas and agents' helpers agree.
 * Snapping to model elements (ducts, parts) is the view-input layer's job.
 */

export const SNAP_KINDS = ["endpoint", "midpoint", "center", "intersection", "perpendicular", "nearest"] as const;
export type SnapKind = (typeof SNAP_KINDS)[number];

export interface DetailSnap {
  readonly kind: SnapKind;
  /** Paper mm. */
  readonly at: Vec2;
  readonly itemId: string;
}

export interface SnapOptions {
  readonly kinds: ReadonlySet<SnapKind>;
  readonly reachMm: number;
  /** The last point placed: perpendicular snaps measure from it. */
  readonly from?: Vec2;
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Vec2) => Math.hypot(a.x, a.y);

function segments(item: DrawingItem, toPaper: (p: Vec2) => Vec2): Array<[Vec2, Vec2]> {
  const path = itemPath(item);
  if (!path) return [];
  const pts = path.map(toPaper);
  const out: Array<[Vec2, Vec2]> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) out.push([a, b]);
  }
  return out;
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const l2 = d.x * d.x + d.y * d.y || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2));
  return { x: a.x + d.x * t, y: a.y + d.y * t };
}

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + r.x * t, y: a.y + r.y * t } : null;
}

/** Order of preference when two snaps are equally near: specific points before "nearest". */
const RANK: Readonly<Record<SnapKind, number>> = { endpoint: 0, intersection: 1, center: 2, midpoint: 3, perpendicular: 4, nearest: 5 };

/** The snap a click at `at` (paper mm) lands on, or null. */
export function detailSnap(items: readonly DrawingItem[], toPaper: (p: Vec2) => Vec2, at: Vec2, opts: SnapOptions): DetailSnap | null {
  const near: DetailSnap[] = [];
  const consider = (kind: SnapKind, p: Vec2, itemId: string) => {
    if (opts.kinds.has(kind) && len(sub(p, at)) <= opts.reachMm) near.push({ kind, at: p, itemId });
  };
  const nearbySegs: Array<{ id: string; a: Vec2; b: Vec2 }> = [];
  for (const item of items) {
    if (item.deleted || item.shape === "text" || item.shape === "dimension" || item.shape === "tag") continue;
    const segs = segments(item, toPaper);
    if ((item.shape === "circle" || item.shape === "arc") && item.points[0]) consider("center", toPaper(item.points[0]), item.id);
    if (item.shape === "line" || item.shape === "polyline" || item.shape === "rect" || item.shape === "region") {
      for (const p of item.points) consider("endpoint", toPaper(p), item.id);
    } else if (item.shape === "arc" || item.shape === "spline") {
      const first = segs[0]?.[0];
      const last = segs[segs.length - 1]?.[1];
      if (first) consider("endpoint", first, item.id);
      if (last) consider("endpoint", last, item.id);
    } else if (item.shape === "component" && item.points[0]) consider("endpoint", toPaper(item.points[0]), item.id);
    const straight = item.shape === "line" || item.shape === "polyline" || item.shape === "rect" || item.shape === "region";
    for (const [a, b] of segs) {
      if (straight) consider("midpoint", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, item.id);
      const c = closestOnSegment(at, a, b);
      if (len(sub(c, at)) <= opts.reachMm * 2) nearbySegs.push({ id: item.id, a, b });
      consider("nearest", c, item.id);
      if (opts.from) {
        const d = sub(b, a);
        const l2 = d.x * d.x + d.y * d.y;
        if (l2 > 1e-9) {
          const t = ((opts.from.x - a.x) * d.x + (opts.from.y - a.y) * d.y) / l2;
          if (t >= 0 && t <= 1) consider("perpendicular", { x: a.x + d.x * t, y: a.y + d.y * t }, item.id);
        }
      }
    }
  }
  if (opts.kinds.has("intersection")) {
    for (let i = 0; i < nearbySegs.length; i++)
      for (let j = i + 1; j < nearbySegs.length; j++) {
        const s = nearbySegs[i];
        const t = nearbySegs[j];
        if (!s || !t || s.id === t.id) continue;
        const x = segIntersect(s.a, s.b, t.a, t.b);
        if (x) consider("intersection", x, s.id);
      }
  }
  near.sort((p, q) => RANK[p.kind] - RANK[q.kind] || len(sub(p.at, at)) - len(sub(q.at, at)));
  return near[0] ?? null;
}

/**
 * Ortho / polar tracking: the point at `at` pulled onto the nearest allowed
 * angle from `from` (every `incrementDeg`), keeping its distance along that
 * direction, when it is within `toleranceDeg`. Ortho is a 90° increment.
 */
export function trackAngle(from: Vec2, at: Vec2, incrementDeg: number, toleranceDeg = incrementDeg >= 90 ? 45 : 4): { at: Vec2; angleDeg: number } | null {
  const d = sub(at, from);
  const l = len(d);
  if (l < 1e-6) return null;
  const angle = (Math.atan2(-d.y, d.x) * 180) / Math.PI;
  const snapped = Math.round(angle / incrementDeg) * incrementDeg;
  if (Math.abs(angle - snapped) > toleranceDeg) return null;
  const a = (snapped * Math.PI) / 180;
  const along = d.x * Math.cos(a) - d.y * Math.sin(a);
  return { at: { x: from.x + along * Math.cos(a), y: from.y - along * Math.sin(a) }, angleDeg: ((snapped % 360) + 360) % 360 };
}
