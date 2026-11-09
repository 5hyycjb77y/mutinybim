import type { Vec2 } from "../types";
import { regionsOf, type WalkSegment } from "../spaces/boundaries/face-walk";
import { boxOf, containsPoint, type Box } from "../spaces/space-geometry";
import { linkedBoundarySegments, lineLikeOf, type LinkedElementRef, type LinkedReferenceIndex, type ReferenceItem, type ReferenceLine } from "./index-geometry";

/**
 * The building envelope a linked model shows at one height, read-only: which
 * of its envelope walls face outside (and which face of each), and the
 * windows and doors set in them. Then, for a space's outline, the outside
 * walls along its edges and the windows in those stretches, for loads.
 *
 * "Outside" is geometric: a point just beyond a wall face that no closed
 * region of the room-bounding elements holds. Nothing is stored; a new
 * version of the link gives new answers.
 */

export interface ExteriorWall {
  readonly ref: LinkedElementRef;
  readonly name: string;
  /** The face that looks outside. */
  readonly outsideFace: ReferenceLine;
  /** The face that looks in. */
  readonly insideFace: ReferenceLine;
  /** Unit normal pointing outside, model frame. */
  readonly outward: Vec2;
  readonly heightMm: number;
}

export interface EnvelopeOpening {
  readonly ref: LinkedElementRef;
  readonly name: string;
  readonly role: "window" | "door";
  /** The outside wall it sits in. */
  readonly wall: LinkedElementRef;
  readonly centre: Vec2;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly sillMm: number;
}

export interface LinkedEnvelope {
  readonly zMm: number;
  readonly walls: readonly ExteriorWall[];
  readonly openings: readonly EnvelopeOpening[];
}

/** How far past a face the outside test looks, mm. */
const PROBE_MM = 300;
/** An opening this close to a wall's outline is in it, mm. */
const IN_WALL_MM = 100;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (l: ReferenceLine): Vec2 => ({ x: (l.start.x + l.end.x) / 2, y: (l.start.y + l.end.y) / 2 });

function grow(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

function nearOutline(outline: readonly Vec2[], p: Vec2, by: number): boolean {
  const b = grow(boxOf(outline), by);
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** The envelope the linked models show at height `zMm`. */
export function linkedEnvelopeAt(index: LinkedReferenceIndex, zMm: number): LinkedEnvelope {
  const segments: WalkSegment[] = linkedBoundarySegments(index, zMm);
  const regions = regionsOf(segments).map((r) => ({ outline: r.outline, box: boxOf(r.outline) }));
  const indoors = (p: Vec2): boolean => regions.some((r) => p.x >= r.box.minX && p.x <= r.box.maxX && p.y >= r.box.minY && p.y <= r.box.maxY && containsPoint(r.outline, p));
  const walls: ExteriorWall[] = [];
  const wallItems: ReferenceItem[] = [];
  for (const item of index.items) {
    if (item.rule.envelope !== "wall" || !item.line || zMm < item.minZ || zMm > item.maxZ) continue;
    const [f0, f1] = item.line.faces;
    const c = mid(item.line.axis);
    const probe = (f: ReferenceLine): { at: Vec2; n: Vec2 } => {
      const m = mid(f);
      const d = sub(m, c);
      const len = Math.hypot(d.x, d.y) || 1;
      const n = { x: d.x / len, y: d.y / len };
      return { at: { x: m.x + n.x * PROBE_MM, y: m.y + n.y * PROBE_MM }, n };
    };
    const p0 = probe(f0);
    const p1 = probe(f1);
    const in0 = indoors(p0.at);
    const in1 = indoors(p1.at);
    if (in0 === in1) continue;
    const [outsideFace, insideFace, outward] = in0 ? [f1, f0, p1.n] : [f0, f1, p0.n];
    walls.push({ ref: item.ref, name: item.name, outsideFace, insideFace, outward, heightMm: item.maxZ - item.minZ });
    wallItems.push(item);
  }
  const openings: EnvelopeOpening[] = [];
  for (const item of index.items) {
    const role = item.rule.envelope;
    if ((role !== "window" && role !== "door") || item.maxZ < zMm - 3000 || item.minZ > zMm + 3000) continue;
    const box = boxOf(item.outline);
    const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const host = wallItems.find((w) => w.minZ <= item.maxZ && w.maxZ >= item.minZ && nearOutline(w.outline, centre, IN_WALL_MM) && (containsPoint(w.outline, centre) || distanceToOutline(w.outline, centre) <= IN_WALL_MM));
    if (!host) continue;
    const shape = lineLikeOf(item.outline);
    const widthMm = shape ? Math.hypot(shape.axis.end.x - shape.axis.start.x, shape.axis.end.y - shape.axis.start.y) : Math.max(box.maxX - box.minX, box.maxY - box.minY);
    openings.push({ ref: item.ref, name: item.name, role, wall: host.ref, centre, widthMm, heightMm: item.maxZ - item.minZ, sillMm: item.minZ });
  }
  return { zMm, walls, openings };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function distanceToOutline(outline: readonly Vec2[], p: Vec2): number {
  let d = Infinity;
  for (let i = 0; i < outline.length; i++) d = Math.min(d, distanceToSegment(p, outline[i] as Vec2, outline[(i + 1) % outline.length] as Vec2));
  return d;
}

export interface SpaceEnvelopeWall {
  readonly wall: LinkedElementRef;
  readonly name: string;
  /** Length of the space's edge along the wall, mm. */
  readonly lengthMm: number;
  /** Which way it faces, degrees counter-clockwise from the model's +x axis. */
  readonly facingDeg: number;
  readonly heightMm: number;
}

export interface SpaceEnvelope {
  readonly walls: readonly SpaceEnvelopeWall[];
  readonly openings: readonly EnvelopeOpening[];
  /** Outside wall length along the space, mm. */
  readonly exteriorLengthMm: number;
  /** Window area in those walls, m². */
  readonly windowAreaM2: number;
}

/** A space edge this close to an outside wall's inside face runs along it, mm. */
const ALONG_MM = 150;

/** The outside walls along a space's outline and the windows and doors in those stretches. */
export function spaceEnvelopeOf(envelope: LinkedEnvelope, outline: readonly Vec2[]): SpaceEnvelope {
  const walls: SpaceEnvelopeWall[] = [];
  const openings: EnvelopeOpening[] = [];
  for (const w of envelope.walls) {
    const a = w.insideFace.start;
    const b = w.insideFace.end;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const spans: [number, number][] = [];
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i] as Vec2;
      const q = outline[(i + 1) % outline.length] as Vec2;
      const off = (r: Vec2): number => Math.abs((r.x - a.x) * -u.y + (r.y - a.y) * u.x);
      if (off(p) > ALONG_MM || off(q) > ALONG_MM) continue;
      const t0 = (p.x - a.x) * u.x + (p.y - a.y) * u.y;
      const t1 = (q.x - a.x) * u.x + (q.y - a.y) * u.y;
      const lo = Math.max(0, Math.min(t0, t1));
      const hi = Math.min(len, Math.max(t0, t1));
      if (hi - lo > 1) spans.push([lo, hi]);
    }
    if (spans.length === 0) continue;
    const lengthMm = spans.reduce((s, [lo, hi]) => s + (hi - lo), 0);
    walls.push({ wall: w.ref, name: w.name, lengthMm, facingDeg: ((Math.atan2(w.outward.y, w.outward.x) * 180) / Math.PI + 360) % 360, heightMm: w.heightMm });
    for (const o of envelope.openings) {
      if (o.wall.sourceId !== w.ref.sourceId || o.wall.globalId !== w.ref.globalId) continue;
      const t = (o.centre.x - a.x) * u.x + (o.centre.y - a.y) * u.y;
      if (spans.some(([lo, hi]) => t >= lo && t <= hi)) openings.push(o);
    }
  }
  const windowAreaM2 = openings.filter((o) => o.role === "window").reduce((s, o) => s + (o.widthMm * o.heightMm) / 1_000_000, 0);
  return { walls, openings, exteriorLengthMm: walls.reduce((s, w) => s + w.lengthMm, 0), windowAreaM2 };
}
