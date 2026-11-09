import type { Vec2 } from "../types";
import type { ImportGeometry, ImportPoint } from "./types";

/**
 * The few readings of a solid every import rule shares, trade-free: a
 * vertical prism (a footprint pushed up: walls, slabs, rooms, columns), a
 * straight sweep (a section pushed along a line: beams and every kind of run
 * segment), and a plan rectangle's long axis. Each answers null with no
 * guess when the solid isn't that shape.
 */

const VERTICAL_TOLERANCE = 0.02;

const len = (p: ImportPoint): number => Math.hypot(p.x, p.y, p.z);

export interface VerticalPrism {
  readonly outline: readonly Vec2[];
  /** Bottom and top heights, mm. */
  readonly bottom: number;
  readonly top: number;
}

/** The solid as one footprint pushed straight up (or down), or null. */
export function verticalPrism(geometry: ImportGeometry): VerticalPrism | null {
  const [only, ...rest] = geometry.extrusions;
  if (!only || rest.length > 0 || geometry.unread) return null;
  const l = len(only.along);
  if (l <= 0 || Math.hypot(only.along.x, only.along.y) / l > VERTICAL_TOLERANCE) return null;
  const zs = only.base.map((p) => p.z);
  const flat = Math.max(...zs) - Math.min(...zs);
  if (flat > 1) return null;
  const z0 = zs[0] ?? 0;
  const z1 = z0 + only.along.z;
  const outline = dedupe(only.base.map((p) => ({ x: p.x, y: p.y })));
  if (outline.length < 3) return null;
  return { outline, bottom: Math.min(z0, z1), top: Math.max(z0, z1) };
}

export type SweepSection = { readonly shape: "rect"; readonly width: number; readonly height: number } | { readonly shape: "round"; readonly diameter: number };

export interface StraightSweep {
  readonly start: ImportPoint;
  readonly end: ImportPoint;
  readonly section: SweepSection;
}

/** The solid as a rectangle or circle pushed along a straight line (its centre line), or null. */
export function straightSweep(geometry: ImportGeometry): StraightSweep | null {
  const [only, ...rest] = geometry.extrusions;
  if (!only || rest.length > 0 || geometry.unread) return null;
  const centre = only.circle?.centre ?? centroid3(only.base);
  const end = { x: centre.x + only.along.x, y: centre.y + only.along.y, z: centre.z + only.along.z };
  if (len(only.along) < 1) return null;
  if (only.circle) return { start: centre, end, section: { shape: "round", diameter: only.circle.radius * 2 } };
  if (!only.rectangle) return null;
  // Width across in plan, height up: the profile side closer to vertical is the height.
  const [a, b, c] = only.base;
  if (!a || !b || !c) return null;
  const side1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const side1Up = Math.abs(side1.z) / Math.max(len(side1), 1e-9);
  const l1 = len(side1);
  const l2 = len({ x: c.x - b.x, y: c.y - b.y, z: c.z - b.z });
  const [width, height] = side1Up > 0.5 ? [l2, l1] : [l1, l2];
  return { start: centre, end, section: { shape: "rect", width, height } };
}

export interface PlanAxis {
  readonly start: Vec2;
  readonly end: Vec2;
  /** The short side. */
  readonly thickness: number;
}

/** A plan rectangle's centre line along its long side, or null when the outline isn't a rectangle. */
export function rectangleAxis(outline: readonly Vec2[]): PlanAxis | null {
  if (outline.length !== 4) return null;
  const [a, b, c, d] = outline;
  if (!a || !b || !c || !d) return null;
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
  if (ab < 1 || bc < 1 || Math.abs(dot) / (ab * bc) > 0.01) return null;
  const mid = (p: Vec2, q: Vec2): Vec2 => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  return ab >= bc ? { start: mid(a, d), end: mid(b, c), thickness: bc } : { start: mid(a, b), end: mid(d, c), thickness: ab };
}

/** Plan area of a closed outline, mm². */
export function outlineArea(outline: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    if (p && q) s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s / 2);
}

/** The outline's centre (vertex mean). */
export function outlineCentre(outline: readonly Vec2[]): Vec2 {
  const n = Math.max(outline.length, 1);
  return { x: outline.reduce((s, p) => s + p.x, 0) / n, y: outline.reduce((s, p) => s + p.y, 0) / n };
}

/** Whether a plan rectangle's sides run east-west and north-south (within half a degree). */
export function axisAligned(outline: readonly Vec2[]): boolean {
  const [a, b] = outline;
  if (!a || !b) return false;
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const off = Math.abs(((angle % 90) + 90) % 90);
  return off < 0.5 || off > 89.5;
}

function centroid3(points: readonly ImportPoint[]): ImportPoint {
  const n = Math.max(points.length, 1);
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n, z: points.reduce((s, p) => s + p.z, 0) / n };
}

function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && out.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= 0.5) out.pop();
  return out;
}

/** Round a plan point to 0.1 mm, as kernel commands do. */
export function roundPlan(p: Vec2): Vec2 {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}