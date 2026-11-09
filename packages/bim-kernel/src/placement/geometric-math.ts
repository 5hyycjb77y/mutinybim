import type { Vec2 } from "../types";
import type { AreaPlacement, LinePlacement, PathPlacement, PathSegment } from "./geometric";

/**
 * Measuring the geometric placements (`geometric.ts`): path length, the point
 * and direction at a station, the station of a point, profile elevations,
 * net area and centroid with holes, and a line placement's centreline after
 * justification. Pure functions of plain data, millimetres and degrees, so a
 * pack measures an alignment or a deck with no code of its own.
 */

/** One measured piece of a path: a straight line, or an arc with its centre, radius and signed sweep (radians, + counter-clockwise). */
export type PathPiece =
  | { readonly kind: "line"; readonly from: Vec2; readonly to: Vec2; readonly lengthMm: number }
  | { readonly kind: "arc"; readonly from: Vec2; readonly to: Vec2; readonly lengthMm: number; readonly center: Vec2; readonly radiusMm: number; readonly startAngle: number; readonly sweep: number };

/** Below this bulge an arc is drawn as its chord (|bulge| 1e-9 is a sagitta of nanometres on a kilometre chord). */
const FLAT_BULGE = 1e-9;

function piece(from: Vec2, seg: PathSegment): PathPiece {
  const dx = seg.to.x - from.x;
  const dy = seg.to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (seg.kind === "line" || Math.abs(seg.bulge) < FLAT_BULGE || chord === 0) return { kind: "line", from, to: seg.to, lengthMm: chord };
  const b = seg.bulge;
  const sweep = 4 * Math.atan(b);
  const radiusMm = (chord * (1 + b * b)) / (4 * Math.abs(b));
  // Centre: from the chord's midpoint along its left normal, signed by the bulge.
  const h = (chord * (1 - b * b)) / (4 * b);
  const center = { x: (from.x + seg.to.x) / 2 - (dy / chord) * h, y: (from.y + seg.to.y) / 2 + (dx / chord) * h };
  const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  return { kind: "arc", from, to: seg.to, lengthMm: radiusMm * Math.abs(sweep), center, radiusMm, startAngle, sweep };
}

/** The path's pieces in order, each measured. */
export function pathPieces(path: Pick<PathPlacement, "start" | "segments">): PathPiece[] {
  const out: PathPiece[] = [];
  let at = path.start;
  for (const seg of path.segments) {
    out.push(piece(at, seg));
    at = seg.to;
  }
  return out;
}

export function pathLength(path: Pick<PathPlacement, "start" | "segments">): number {
  let s = 0;
  for (const p of pathPieces(path)) s += p.lengthMm;
  return s;
}

/** The last point of a path. */
export function pathEnd(path: Pick<PathPlacement, "start" | "segments">): Vec2 {
  return path.segments.length > 0 ? (path.segments[path.segments.length - 1]?.to ?? path.start) : path.start;
}

const DEG = 180 / Math.PI;

function along(p: PathPiece, s: number): { point: Vec2; directionDeg: number } {
  if (p.kind === "line") {
    const t = p.lengthMm === 0 ? 0 : s / p.lengthMm;
    return { point: { x: p.from.x + (p.to.x - p.from.x) * t, y: p.from.y + (p.to.y - p.from.y) * t }, directionDeg: Math.atan2(p.to.y - p.from.y, p.to.x - p.from.x) * DEG };
  }
  const dir = Math.sign(p.sweep);
  const a = p.startAngle + (dir * s) / p.radiusMm;
  return { point: { x: p.center.x + p.radiusMm * Math.cos(a), y: p.center.y + p.radiusMm * Math.sin(a) }, directionDeg: (a + (dir * Math.PI) / 2) * DEG };
}

/** Normalise degrees to (-180, 180]. */
function normDeg(d: number): number {
  let x = d % 360;
  if (x <= -180) x += 360;
  if (x > 180) x -= 360;
  return x;
}

/**
 * The point and direction of travel at a station (stations count from
 * `startStationMm`), or null off the path's ends: a station past the end is a
 * question about another element, not this one.
 */
export function pointAtStation(path: PathPlacement, stationMm: number, toleranceMm = 1e-6): { readonly point: Vec2; readonly directionDeg: number } | null {
  let s = stationMm - (path.startStationMm ?? 0);
  const pieces = pathPieces(path);
  const total = pieces.reduce((t, p) => t + p.lengthMm, 0);
  if (s < -toleranceMm || s > total + toleranceMm) return null;
  s = Math.min(Math.max(s, 0), total);
  for (const p of pieces) {
    if (s <= p.lengthMm || p === pieces[pieces.length - 1]) {
      const r = along(p, Math.min(s, p.lengthMm));
      return { point: r.point, directionDeg: normDeg(r.directionDeg) };
    }
    s -= p.lengthMm;
  }
  return { point: path.start, directionDeg: 0 };
}

function closestOn(p: PathPiece, q: Vec2): { s: number; point: Vec2 } {
  if (p.kind === "line") {
    const dx = p.to.x - p.from.x;
    const dy = p.to.y - p.from.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((q.x - p.from.x) * dx + (q.y - p.from.y) * dy) / l2));
    return { s: t * p.lengthMm, point: { x: p.from.x + dx * t, y: p.from.y + dy * t } };
  }
  const dir = Math.sign(p.sweep);
  let delta = (Math.atan2(q.y - p.center.y, q.x - p.center.x) - p.startAngle) * dir;
  delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (delta <= Math.abs(p.sweep)) {
    const s = delta * p.radiusMm;
    return { s, point: along(p, s).point };
  }
  const dFrom = Math.hypot(q.x - p.from.x, q.y - p.from.y);
  const dTo = Math.hypot(q.x - p.to.x, q.y - p.to.y);
  return dFrom <= dTo ? { s: 0, point: p.from } : { s: p.lengthMm, point: p.to };
}

/** The station of the path point nearest `q`, and how far `q` is from the path (+ left of travel, − right). */
export function stationOfPoint(path: PathPlacement, q: Vec2): { readonly stationMm: number; readonly offsetMm: number; readonly point: Vec2 } {
  const pieces = pathPieces(path);
  let best: { stationMm: number; offsetMm: number; point: Vec2; d: number } | null = null;
  let before = 0;
  for (const p of pieces) {
    const c = closestOn(p, q);
    const d = Math.hypot(q.x - c.point.x, q.y - c.point.y);
    if (!best || d < best.d - 1e-9) {
      const dir = along(p, c.s).directionDeg / DEG;
      const cross = Math.cos(dir) * (q.y - c.point.y) - Math.sin(dir) * (q.x - c.point.x);
      best = { stationMm: (path.startStationMm ?? 0) + before + c.s, offsetMm: cross >= 0 ? d : -d, point: c.point, d };
    }
    before += p.lengthMm;
  }
  if (!best) return { stationMm: path.startStationMm ?? 0, offsetMm: Math.hypot(q.x - path.start.x, q.y - path.start.y), point: path.start };
  return { stationMm: best.stationMm, offsetMm: best.offsetMm, point: best.point };
}

/**
 * The elevation above the level at a station: linear between profile points,
 * held flat past the first and last (a profile ends where the designer
 * stopped grading); `offsetMm` everywhere when there is no profile.
 */
export function profileElevationAt(path: Pick<PathPlacement, "profile" | "offsetMm">, stationMm: number): number {
  const prof = path.profile;
  if (!prof || prof.length === 0) return path.offsetMm;
  const first = prof[0];
  const last = prof[prof.length - 1];
  if (!first || !last) return path.offsetMm;
  if (stationMm <= first.stationMm) return first.elevationMm;
  if (stationMm >= last.stationMm) return last.elevationMm;
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1];
    const b = prof[i];
    if (!a || !b || stationMm > b.stationMm) continue;
    const span = b.stationMm - a.stationMm;
    return span <= 0 ? b.elevationMm : a.elevationMm + ((b.elevationMm - a.elevationMm) * (stationMm - a.stationMm)) / span;
  }
  return last.elevationMm;
}

/** Twice the signed area (+ counter-clockwise) and the area-weighted centroid sums of one ring. */
function ring(points: readonly Vec2[]): { a2: number; cx6a: number; cy6a: number } {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    if (!p || !q) continue;
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { a2, cx6a: cx, cy6a: cy };
}

/** Plan area of an outline minus its holes (mm²), whichever way each ring winds, and the centroid of what is left. Null centroid for no area. */
export function polygonAreaAndCentroid(outline: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): { readonly areaMm2: number; readonly centroid: Vec2 | null } {
  const rings = [{ r: ring(outline), sign: 1 }, ...holes.map((h) => ({ r: ring(h), sign: -1 }))];
  let area = 0;
  let mx = 0;
  let my = 0;
  for (const { r, sign } of rings) {
    // Each ring counts by its magnitude; flip its moments to match.
    const s = sign * Math.sign(r.a2 || 1);
    area += s * r.a2;
    mx += s * r.cx6a;
    my += s * r.cy6a;
  }
  const areaMm2 = area / 2;
  if (Math.abs(areaMm2) < 1e-9) return { areaMm2: 0, centroid: null };
  return { areaMm2, centroid: { x: mx / (3 * area), y: my / (3 * area) } };
}

/** An area placement measured: plan area, centroid, and the true surface area of a sloped one (a roof, a ramp). */
export function areaOf(placement: Pick<AreaPlacement, "outline" | "holes" | "slope">): { readonly planAreaMm2: number; readonly surfaceAreaMm2: number; readonly centroid: Vec2 | null } {
  const { areaMm2, centroid } = polygonAreaAndCentroid(placement.outline, placement.holes ?? []);
  const rise = placement.slope?.rise ?? 0;
  return { planAreaMm2: areaMm2, surfaceAreaMm2: areaMm2 * Math.sqrt(1 + rise * rise), centroid };
}

export interface PlacedPoint {
  readonly x: number;
  readonly y: number;
  /** Above the placement's level. */
  readonly z: number;
}

/**
 * A line placement's centreline once justification is applied, for an
 * element `widthMm` wide (across the line, plan) and `depthMm` deep: a wall
 * placed by its left face sits half its thickness to the right; a beam placed
 * by its top sits half its depth below. Offsets are above the level.
 */
export function lineCentreline(placement: LinePlacement, widthMm: number, depthMm = 0): { readonly start: PlacedPoint; readonly end: PlacedPoint; readonly lengthMm: number } {
  const dx = placement.end.x - placement.start.x;
  const dy = placement.end.y - placement.start.y;
  const len = Math.hypot(dx, dy);
  const nx = len === 0 ? 0 : -dy / len;
  const ny = len === 0 ? 0 : dx / len;
  // The described line is the left face: the centre is to its right.
  const lateral = placement.lateral === "left" ? -widthMm / 2 : placement.lateral === "right" ? widthMm / 2 : 0;
  const vertical = placement.vertical === "top" ? -depthMm / 2 : placement.vertical === "bottom" ? depthMm / 2 : 0;
  const start = { x: placement.start.x + nx * lateral, y: placement.start.y + ny * lateral, z: placement.startOffsetMm + vertical };
  const end = { x: placement.end.x + nx * lateral, y: placement.end.y + ny * lateral, z: placement.endOffsetMm + vertical };
  return { start, end, lengthMm: Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) };
}
