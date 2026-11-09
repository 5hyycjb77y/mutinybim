import { pointInOutline, signedArea } from "../propose/perimeter";
import type { BimElement, Room, Vec2 } from "../types";
import type { DrawingUnderlay, Space, UnderlayCalibration } from "./types";

/**
 * Plan geometry for spaces and underlays: outline area, containment, and the
 * mapping between an underlay's own units (PDF points, pixels, CAD units) and
 * model millimetres. Pure functions; the index and the commands read these.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const MM2_PER_M2 = 1_000_000;
/** Smallest outline a person can mean: a 300 mm square. Anything smaller is a stray double-click. */
export const MIN_SPACE_AREA_MM2 = 90_000;
/** Corners closer than this are the same corner (a double-click). */
export const SAME_CORNER_MM = 1;

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function boxOf(points: readonly Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function inBox(p: Vec2, b: Box): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

export function outlineAreaMm2(outline: readonly Vec2[]): number {
  return Math.abs(signedArea(outline));
}

/** Drops repeated corners and the closing point a click-to-close leaves behind. */
export function cleanOutline(outline: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of outline) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < SAME_CORNER_MM) continue;
    out.push({ x: p.x, y: p.y });
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first.x - last.x, first.y - last.y) < SAME_CORNER_MM) out.pop();
  return out;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** True when two non-adjacent edges cross (a bow tie). O(n²) on the outline's own corners, never on the model. */
export function selfIntersects(outline: readonly Vec2[]): boolean {
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i] as Vec2;
    const b = outline[(i + 1) % n] as Vec2;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a, b, outline[j] as Vec2, outline[(j + 1) % n] as Vec2)) return true;
    }
  }
  return false;
}

/** Why an outline can't be a space, in words, or null when it can. */
export function outlineProblem(outline: readonly Vec2[]): string | null {
  if (outline.length < 3) return `A space needs at least 3 corners; this outline has ${outline.length}`;
  if (outline.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return "An outline corner is not a number";
  if (selfIntersects(outline)) return "The outline crosses itself. Click the corners in order around the space";
  if (outlineAreaMm2(outline) < MIN_SPACE_AREA_MM2) return "That outline encloses almost no floor (under 1 sq ft). Click at least three corners around the space";
  return null;
}

export function containsPoint(outline: readonly Vec2[], p: Vec2): boolean {
  return pointInOutline(p, outline);
}

/** The rooms a space follows, skipping any that are gone. */
export function roomsOfSpace(elements: Elements, space: Space): Room[] {
  if (space.bounds.kind !== "rooms") return [];
  const out: Room[] = [];
  for (const id of space.bounds.roomIds) {
    const r = elements[id];
    if (r?.kind === "room") out.push(r);
  }
  return out;
}

/** The outlines that make up a space's floor: its own outline, or each room it follows. */
export function spaceOutlines(elements: Elements, space: Space): Array<readonly Vec2[]> {
  if (space.bounds.kind === "outline" || space.bounds.kind === "bounded") return [space.bounds.outline];
  if (space.bounds.kind === "rooms") return roomsOfSpace(elements, space).map((r) => r.outline);
  return [];
}

/** Floor area in m², always from geometry (the outline, or the rooms' areas). Null when the space isn't drawn yet. */
export function spaceAreaM2(elements: Elements, space: Space): number | null {
  if (space.bounds.kind === "outline" || space.bounds.kind === "bounded") return outlineAreaMm2(space.bounds.outline) / MM2_PER_M2;
  if (space.bounds.kind === "rooms") {
    const rooms = roomsOfSpace(elements, space);
    if (rooms.length === 0) return null;
    return rooms.reduce((sum, r) => sum + (Number.isFinite(r.areaSqM) && r.areaSqM > 0 ? r.areaSqM : outlineAreaMm2(r.outline) / MM2_PER_M2), 0);
  }
  return null;
}

export function spaceLabel(space: Pick<Space, "number" | "name">): string {
  return [space.number, space.name].filter((s) => s.trim() !== "").join(" ") || "Unnamed space";
}

// ---------------------------------------------------------------- underlay calibration

/** Typography points per inch: a PDF page's own unit. */
export const PDF_POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

function rotate(v: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A point on the underlay (source units) in model mm. */
export function sourceToModel(cal: UnderlayCalibration, p: Vec2): Vec2 {
  const local = rotate({ x: (p.x - cal.sourceOrigin.x) * cal.mmPerUnit, y: (p.y - cal.sourceOrigin.y) * cal.mmPerUnit }, cal.rotationDeg);
  return { x: cal.modelOrigin.x + local.x, y: cal.modelOrigin.y + local.y };
}

/** A model point (mm) on the underlay, in source units. */
export function modelToSource(cal: UnderlayCalibration, p: Vec2): Vec2 {
  const local = rotate({ x: p.x - cal.modelOrigin.x, y: p.y - cal.modelOrigin.y }, -cal.rotationDeg);
  return { x: cal.sourceOrigin.x + local.x / cal.mmPerUnit, y: cal.sourceOrigin.y + local.y / cal.mmPerUnit };
}

/**
 * Calibration from two points picked on the underlay and the real distance
 * between them. The first point lands at `modelAt` (default: where it already
 * maps, or the model origin), rotation is kept, so a person calibrates scale
 * first and then moves the underlay.
 */
export function calibrateTwoPoints(a: Vec2, b: Vec2, distanceMm: number, opts: { readonly modelAt?: Vec2; readonly rotationDeg?: number } = {}): UnderlayCalibration | string {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(span > 1e-9)) return "The two points are on top of each other. Pick two points far apart, such as both ends of a dimension string";
  if (!(distanceMm > 0) || !Number.isFinite(distanceMm)) return "Type the real distance between the two points (for example 24'-0\")";
  return { sourceOrigin: a, modelOrigin: opts.modelAt ?? { x: 0, y: 0 }, mmPerUnit: distanceMm / span, rotationDeg: opts.rotationDeg ?? 0, method: "two_points" };
}

/**
 * A drawing scale written the way sheets print it: `1/8" = 1'-0"`, `1/4"=1'`,
 * `3/16" = 1'-0"`, `1" = 20'`, `1:100`. Returns real millimetres per paper
 * millimetre, or null when it can't be read.
 */
export function parseDrawingScale(text: string): number | null {
  const t = text.trim().replace(/[″”]/g, '"').replace(/[′’]/g, "'");
  const ratio = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (ratio) return Number(ratio[1]);
  const m = /^(\d+(?:\s+\d+)?(?:\/\d+)?|\d*\.\d+)\s*"\s*=\s*(\d+(?:\.\d+)?)\s*'(?:\s*-?\s*(\d+(?:\.\d+)?)\s*"?)?$/.exec(t);
  if (!m) return null;
  const paperIn = fractionInches(m[1] ?? "");
  const realIn = Number(m[2]) * 12 + (m[3] ? Number(m[3]) : 0);
  if (!(paperIn > 0) || !(realIn > 0)) return null;
  return realIn / paperIn;
}

function fractionInches(s: string): number {
  const parts = s.trim().split(/\s+/);
  let total = 0;
  for (const p of parts) {
    const [num, den] = p.split("/");
    total += den ? Number(num) / Number(den) : Number(num);
  }
  return total;
}

/**
 * Model mm per source unit for a stated scale. A PDF page is in points (1/72");
 * an image needs its pixels per inch (from the file, or typed); CAD files are
 * drawn full size, so they take their drawing unit instead.
 */
export function statedScaleMmPerUnit(format: DrawingUnderlay["source"]["format"], realPerPaper: number, pixelsPerInch?: number): number | string {
  if (format === "pdf") return (realPerPaper * MM_PER_INCH) / PDF_POINTS_PER_INCH;
  if (format === "image") {
    if (!(pixelsPerInch && pixelsPerInch > 0)) return "This image doesn't say how many pixels make an inch, so a printed scale can't be applied. Calibrate it with two points and a known distance instead";
    return (realPerPaper * MM_PER_INCH) / pixelsPerInch;
  }
  return "A CAD file is drawn full size; set its drawing unit (inches, feet or millimetres) instead of a printed scale";
}

export const CAD_UNIT_MM = { mm: 1, cm: 10, m: 1000, in: MM_PER_INCH, ft: 304.8 } as const;
export type CadUnit = keyof typeof CAD_UNIT_MM;

export function isCalibrated(u: DrawingUnderlay): u is DrawingUnderlay & { readonly calibration: UnderlayCalibration } {
  return u.calibration !== undefined && u.calibration.mmPerUnit > 0;
}

/** Why tracing over this underlay is off, in words, or null when it is on. */
export function tracingRefusal(u: DrawingUnderlay): string | null {
  if (!isCalibrated(u)) return `${u.source.name} isn't calibrated yet, so tracing over it is off. Set its scale first: pick two points and type the distance between them, or enter the printed scale`;
  if (u.hidden) return `${u.source.name} is hidden. Show it to trace over it`;
  return null;
}