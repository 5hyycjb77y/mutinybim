import { z } from "zod";
import { elementSolid, planPointsOf } from "./drawing/solids";
import { levelContentExtent, type Rect } from "./view-extents";
import { round } from "./geometry";
import { modelLevels, viewFloorMm } from "./levels";
import { levelOf } from "./fields/providers/level-room";
import { elementValues } from "./store";
import type { RunPoint } from "./routing/types";
import type { ViewProps } from "./documents";
import type { BimElement, ModelState, ViewElement } from "./types";
import { workingAngleOf } from "./work-frame";

/**
 * Saved 3D views: a camera and a 3D crop box. The box is oriented (centre,
 * half sizes along its own axes, turned about the vertical); a view with crop
 * on shows only what is inside it, live and on sheets. "Crop on" is the view's
 * existing Crop view switch and "Show crop box" its existing Show crop box
 * switch, so a 3D view has one of each, like every other view.
 *
 * Every 3D view owns its box from the moment it exists, sized to the model;
 * fitting it to a selection resizes that box out to the model's own datums
 * (levels, grid lines) rather than drawing a new box around the selection
 * (internal design note).
 *
 * World millimetres: plan x east, y north, z up from project zero.
 */

export type Point3 = RunPoint;

/** Where a saved 3D view looks from. Its projection is the view's `projection` prop. */
export interface View3dCamera {
  readonly eye: Point3;
  readonly target: Point3;
  readonly up: Point3;
  /** Perspective: vertical field of view, degrees. */
  readonly fovDeg: number;
  /** Orthographic: height of the picture at the target, mm. */
  readonly orthoHeightMm: number;
}

/** An oriented crop box. Rotation turns its local x and y axes counter-clockwise about +z. */
export interface CropBox3d {
  readonly center: Point3;
  readonly halfSize: Point3;
  readonly rotationDeg: number;
}

export const CROP_FACES = ["x+", "x-", "y+", "y-", "z+", "z-"] as const;
export type CropFace = (typeof CROP_FACES)[number];

export interface Aabb3 {
  readonly min: Point3;
  readonly max: Point3;
}

/** A plane as `normal · p + constant >= 0` on the kept side. */
export interface KeepPlane {
  readonly normal: Point3;
  readonly constant: number;
}

const FT = 304.8;
/** Smallest box side, mm (1 in). */
export const MIN_CROP_BOX_MM = 25.4;
const MAX_MM = 2_000_000;
/** Storey height assumed above the top level when nothing is above it. */
const STOREY_MM = 14 * FT;
/** A grid line farther than this from a selection's side is another bay's, not this one's: the side goes to the planning module instead. */
const GRID_REACH_MM = 40 * FT;
/** Where there is no grid line within reach, a side goes out to the next line of this plan module (multiples of 10 ft from project zero). */
const PLAN_MODULE_MM = 10 * FT;
/** Height of the default box when the model has no levels. */
const NO_LEVEL_TOP_MM = 30 * FT;
const DEFAULT_FOV_DEG = 45;

const coord = z.number().finite().min(-MAX_MM).max(MAX_MM);
const point3 = z.object({ x: coord, y: coord, z: coord }).strict();
const unit = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();

export const camera3dSchema = z
  .object({ eye: point3, target: point3, up: unit, fovDeg: z.number().min(5).max(120), orthoHeightMm: z.number().positive().max(MAX_MM) })
  .strict();

export const cropBox3dSchema = z
  .object({
    center: point3,
    halfSize: z.object({ x: z.number().min(MIN_CROP_BOX_MM / 2).max(MAX_MM), y: z.number().min(MIN_CROP_BOX_MM / 2).max(MAX_MM), z: z.number().min(MIN_CROP_BOX_MM / 2).max(MAX_MM) }).strict(),
    rotationDeg: z.number().finite().min(-360).max(360),
  })
  .strict();

export const aabb3Schema = z.object({ min: point3, max: point3 }).strict();

/** The saved-3D-view fields a view record carries (restore and undo take them back). */
export const view3dPropsShape = {
  camera3d: camera3dSchema,
  cropBox3d: cropBox3dSchema,
  /** A person's working 3D view (their "{3D}"): the user id it belongs to. Not placed on sheets. */
  workingFor: z.string().min(1).max(200),
} as const;

// ── Box math ─────────────────────────────────────────────────────────────────

const p = (x: number, y: number, zz: number): Point3 => ({ x, y, z: zz });
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: Point3, b: Point3) => p(a.x + b.x, a.y + b.y, a.z + b.z);
const scaled = (a: Point3, k: number) => p(a.x * k, a.y * k, a.z * k);
const round3 = (a: Point3): Point3 => p(round(a.x), round(a.y), round(a.z));

/** The box's local x, y and z axes in world space. */
export function boxAxes(box: CropBox3d): readonly [Point3, Point3, Point3] {
  const r = (box.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [p(c, s, 0), p(-s, c, 0), p(0, 0, 1)];
}

function halfAlong(box: CropBox3d, axis: 0 | 1 | 2): number {
  return axis === 0 ? box.halfSize.x : axis === 1 ? box.halfSize.y : box.halfSize.z;
}

function faceAxis(face: CropFace): { axis: 0 | 1 | 2; sign: 1 | -1 } {
  const axis = face[0] === "x" ? 0 : face[0] === "y" ? 1 : 2;
  return { axis, sign: face[1] === "+" ? 1 : -1 };
}

/** The eight corners: bit 0 picks local +x, bit 1 +y, bit 2 +z. */
export function boxCorners(box: CropBox3d): Point3[] {
  const [ex, ey, ez] = boxAxes(box);
  const out: Point3[] = [];
  for (let i = 0; i < 8; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    const sz = i & 4 ? 1 : -1;
    out.push(add(add(add(box.center, scaled(ex, sx * box.halfSize.x)), scaled(ey, sy * box.halfSize.y)), scaled(ez, sz * box.halfSize.z)));
  }
  return out;
}

/** The twelve edges as corner index pairs (into `boxCorners`). */
export const BOX_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Centre of one face and its outward normal. */
export function faceCenter(box: CropBox3d, face: CropFace): { point: Point3; normal: Point3 } {
  const { axis, sign } = faceAxis(face);
  const n = scaled(boxAxes(box)[axis], sign);
  return { point: add(box.center, scaled(n, halfAlong(box, axis))), normal: n };
}

/** The six planes that keep the inside of the box (`normal · p + constant >= 0` inside), in `CROP_FACES` order. */
export function boxKeepPlanes(box: CropBox3d): KeepPlane[] {
  const axes = boxAxes(box);
  return CROP_FACES.map((face) => {
    const { axis, sign } = faceAxis(face);
    const u = axes[axis];
    const h = halfAlong(box, axis);
    // +face keeps u·p <= u·c + h; -face keeps u·p >= u·c - h.
    const normal = scaled(u, -sign);
    return { normal, constant: sign * dot(u, box.center) + h };
  });
}

export function insideBox(box: CropBox3d, q: Point3, toleranceMm = 0): boolean {
  return boxKeepPlanes(box).every((pl) => dot(pl.normal, q) + pl.constant >= -toleranceMm);
}

/** World axis-aligned bounds of the box. */
export function boxAabb(box: CropBox3d): Aabb3 {
  return aabbOf(boxCorners(box));
}

export function aabbOf(points: readonly Point3[]): Aabb3 {
  let min = p(Infinity, Infinity, Infinity);
  let max = p(-Infinity, -Infinity, -Infinity);
  for (const q of points) {
    min = p(Math.min(min.x, q.x), Math.min(min.y, q.y), Math.min(min.z, q.z));
    max = p(Math.max(max.x, q.x), Math.max(max.y, q.y), Math.max(max.z, q.z));
  }
  return { min, max };
}

/** An unturned box over world bounds. */
export function boxFromAabb(bounds: Aabb3, rotationDeg = 0): CropBox3d {
  const half = p(
    Math.max(MIN_CROP_BOX_MM / 2, (bounds.max.x - bounds.min.x) / 2),
    Math.max(MIN_CROP_BOX_MM / 2, (bounds.max.y - bounds.min.y) / 2),
    Math.max(MIN_CROP_BOX_MM / 2, (bounds.max.z - bounds.min.z) / 2),
  );
  return normalizeBox({ center: scaled(add(bounds.min, bounds.max), 0.5), halfSize: half, rotationDeg });
}

/**
 * The smallest box turned by `rotationDeg` that holds world bounds: what a new
 * crop box over the model is when the model has a working angle, so the box
 * comes in square to the building instead of square to model east.
 */
export function boxAroundAabb(bounds: Aabb3, rotationDeg = 0): CropBox3d {
  if (rotationDeg === 0) return boxFromAabb(bounds);
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const corners = [p(bounds.min.x, bounds.min.y, 0), p(bounds.max.x, bounds.min.y, 0), p(bounds.min.x, bounds.max.y, 0), p(bounds.max.x, bounds.max.y, 0)];
  // Local coordinates: world turned back by the box's angle.
  const us = corners.map((q) => q.x * c + q.y * s);
  const vs = corners.map((q) => -q.x * s + q.y * c);
  const u0 = Math.min(...us);
  const u1 = Math.max(...us);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  const center = p(uc * c - vc * s, uc * s + vc * c, (bounds.min.z + bounds.max.z) / 2);
  const halfSize = p(Math.max(MIN_CROP_BOX_MM / 2, (u1 - u0) / 2), Math.max(MIN_CROP_BOX_MM / 2, (v1 - v0) / 2), Math.max(MIN_CROP_BOX_MM / 2, (bounds.max.z - bounds.min.z) / 2));
  return normalizeBox({ center, halfSize, rotationDeg });
}

/**
 * A box turned to a new angle about its own middle, its size kept: the crop
 * box's "Align to the working angle" and "Align to an edge" commands. A
 * command (or a typed number), never a rotate handle on the box
 * (internal design note).
 */
export function boxTurnedTo(box: CropBox3d, rotationDeg: number): CropBox3d {
  return normalizeBox({ center: box.center, halfSize: box.halfSize, rotationDeg });
}

/** Rounded to the micron and with a rotation in (-180, 180]. */
export function normalizeBox(box: CropBox3d): CropBox3d {
  let r = box.rotationDeg % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  const minHalf = MIN_CROP_BOX_MM / 2;
  return {
    center: round3(box.center),
    halfSize: round3(p(Math.max(minHalf, box.halfSize.x), Math.max(minHalf, box.halfSize.y), Math.max(minHalf, box.halfSize.z))),
    rotationDeg: round(r, 6),
  };
}

/**
 * Push one face out (positive) or in (negative) along its normal by `deltaMm`.
 * The opposite face stays put; `symmetric` moves it the same amount the other
 * way, so the centre stays put. Never shrinks a side below 1 in.
 */
export function pushFace(box: CropBox3d, face: CropFace, deltaMm: number, symmetric = false): CropBox3d {
  const { axis, sign } = faceAxis(face);
  const u = boxAxes(box)[axis];
  const h = halfAlong(box, axis);
  const minHalf = MIN_CROP_BOX_MM / 2;
  const nextHalf = symmetric ? Math.max(minHalf, h + deltaMm) : Math.max(minHalf, h + deltaMm / 2);
  const grown = nextHalf - h;
  const center = symmetric ? box.center : add(box.center, scaled(u, sign * grown));
  const halfSize = axis === 0 ? { ...box.halfSize, x: nextHalf } : axis === 1 ? { ...box.halfSize, y: nextHalf } : { ...box.halfSize, z: nextHalf };
  return normalizeBox({ center, halfSize, rotationDeg: box.rotationDeg });
}

/** How far (mm, along the outward normal) a face sits from its own position when moved to pass through `q`. */
export function faceOffsetTo(box: CropBox3d, face: CropFace, q: Point3): number {
  const { point, normal } = faceCenter(box, face);
  return dot(normal, p(q.x - point.x, q.y - point.y, q.z - point.z));
}

/** Snap a face offset onto the nearest candidate offset within `toleranceMm` (levels, the model's extents). */
export function snapOffset(offsetMm: number, candidates: readonly number[], toleranceMm: number): { offsetMm: number; snapped: boolean } {
  let best: number | null = null;
  for (const c of candidates) if (Math.abs(c - offsetMm) <= toleranceMm && (best === null || Math.abs(c - offsetMm) < Math.abs(best - offsetMm))) best = c;
  return best === null ? { offsetMm, snapped: false } : { offsetMm: best, snapped: true };
}

/** The plan rectangle a box covers (a 3D view's plan crop follows its box). */
export function boxPlanRect(box: CropBox3d): Rect {
  const b = boxAabb(box);
  return { min: { x: round(b.min.x), y: round(b.min.y) }, max: { x: round(b.max.x), y: round(b.max.y) } };
}

// ── Extents ──────────────────────────────────────────────────────────────────

const NOT_MODEL = new Set<BimElement["kind"]>(["view", "sheet", "viewport", "drawing_item", "level", "tag", "dimension"]);

function floorOf(model: ModelState, el: BimElement): number {
  return levelOf(model.elements, el)?.elevationMm ?? viewFloorMm(model, el.partition?.level) ?? 0;
}

/** World bounds of some elements' bodies (plan outline at their floor when they have no body); null when none can be measured. */
export function elementsAabb(model: ModelState, ids: readonly string[]): Aabb3 | null {
  const points: Point3[] = [];
  for (const id of ids) {
    const el = model.elements[id];
    if (!el || NOT_MODEL.has(el.kind) || ("deleted" in el && el.deleted) || (el.kind === "part" && el.planned !== undefined)) continue;
    const floor = floorOf(model, el);
    const solid = elementSolid(model, el, floor);
    const before = points.length;
    for (const piece of solid?.pieces ?? []) points.push(...piece.r0, ...piece.r1);
    for (const [a, b] of solid?.centerline ?? []) points.push(a, b);
    if (points.length === before) for (const q of planPointsOf(el)) points.push(p(q.x, q.y, floor));
  }
  return points.length === 0 ? null : aabbOf(points);
}

/** Elevations of the model's levels, low to high. */
function levelElevations(model: ModelState): number[] {
  return [...new Set(modelLevels(model).map((l) => l.elevationMm))].sort((a, b) => a - b);
}

/**
 * The whole model as a box, cheaply: the plan extent of everything (no
 * margin) by the floors from the lowest level to a storey above the highest.
 * The viewer, which also knows the linked models, sends its own extent instead.
 */
export function modelAabb(model: ModelState): Aabb3 {
  const plan = levelContentExtent(model, undefined, 2 * FT) ?? { min: { x: 0, y: 0 }, max: { x: 60 * FT, y: 60 * FT } };
  const levels = levelElevations(model);
  const lo = levels.length > 0 ? (levels[0] ?? 0) - FT : -FT;
  const hi = levels.length > 0 ? (levels[levels.length - 1] ?? 0) + STOREY_MM : NO_LEVEL_TOP_MM;
  return { min: p(plan.min.x, plan.min.y, lo), max: p(plan.max.x, plan.max.y, hi) };
}

/** Grid line positions square to world x (lines running north-south) and to world y. */
function gridPositions(model: ModelState): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const el of elementValues(model.elements)) {
    if (el.kind !== "grid" || ("deleted" in el && el.deleted)) continue;
    if (Math.abs(el.start.x - el.end.x) < 1) xs.push((el.start.x + el.end.x) / 2);
    else if (Math.abs(el.start.y - el.end.y) < 1) ys.push((el.start.y + el.end.y) / 2);
  }
  return { xs, ys };
}

const below = (values: readonly number[], v: number, reach = Infinity) => values.filter((x) => x <= v + 1 && v - x <= reach).reduce<number | null>((best, x) => (best === null || x > best ? x : best), null);
const above = (values: readonly number[], v: number, reach = Infinity) => values.filter((x) => x >= v - 1 && x - v <= reach).reduce<number | null>((best, x) => (best === null || x < best ? x : best), null);
const strictlyAbove = (values: readonly number[], v: number) => values.filter((x) => x > v + 1).reduce<number | null>((best, x) => (best === null || x < best ? x : best), null);

/**
 * The crop box for a region of interest, grown out to the model's datums:
 * from the floor of the level the region sits on to the next level above its
 * top (a storey above the top level when none), and in plan to the nearest
 * grid line beyond each side within a bay (40 ft; the next 10 ft planning
 * line when there is none that close). Unturned.
 */
export function boxForRegion(model: ModelState, region: Aabb3): CropBox3d {
  const levels = levelElevations(model);
  const { xs, ys } = gridPositions(model);
  const top = levels.length > 0 ? (strictlyAbove(levels, region.max.z) ?? Math.max(region.max.z, (levels[levels.length - 1] ?? 0) + STOREY_MM)) : Math.ceil(region.max.z / FT) * FT;
  const bottom = (levels.length > 0 ? below(levels, region.min.z) : null) ?? Math.floor(region.min.z / FT) * FT;
  const west = below(xs, region.min.x, GRID_REACH_MM) ?? Math.floor(region.min.x / PLAN_MODULE_MM) * PLAN_MODULE_MM;
  const east = above(xs, region.max.x, GRID_REACH_MM) ?? Math.ceil(region.max.x / PLAN_MODULE_MM) * PLAN_MODULE_MM;
  const south = below(ys, region.min.y, GRID_REACH_MM) ?? Math.floor(region.min.y / PLAN_MODULE_MM) * PLAN_MODULE_MM;
  const north = above(ys, region.max.y, GRID_REACH_MM) ?? Math.ceil(region.max.y / PLAN_MODULE_MM) * PLAN_MODULE_MM;
  // A side already on a module line (or grid line) still leaves the box at least a module wide.
  return boxFromAabb({ min: p(west, south, bottom), max: p(east > west ? east : west + PLAN_MODULE_MM, north > south ? north : south + PLAN_MODULE_MM, Math.max(top, bottom + MIN_CROP_BOX_MM)) });
}

/** Offsets (along a face's outward normal) where it lines up with a level or the model's extent: what a dragged face snaps to. */
export function faceSnapOffsets(model: ModelState, box: CropBox3d, face: CropFace, extent: Aabb3 | null = null): number[] {
  const { normal, point } = faceCenter(box, face);
  const out: number[] = [];
  const along = (q: Point3) => dot(normal, p(q.x - point.x, q.y - point.y, q.z - point.z));
  if (face[0] === "z") for (const e of levelElevations(model)) out.push(along(p(point.x, point.y, e)));
  if (extent) {
    for (const corner of [extent.min, extent.max]) {
      // Only the extent's planes square to this face count.
      if (Math.abs(normal.x) > 0.999) out.push(along(p(corner.x, point.y, point.z)));
      else if (Math.abs(normal.y) > 0.999) out.push(along(p(point.x, corner.y, point.z)));
      else if (Math.abs(normal.z) > 0.999) out.push(along(p(point.x, point.y, corner.z)));
    }
  }
  return out;
}

// ── Printing from the camera ─────────────────────────────────────────────────

/**
 * The drawing frame a 3D view prints in: parallel projection looking the way
 * its camera looks (a perspective camera prints orthographic from the same
 * direction). u runs to the right of the picture, v up it, `near` toward the
 * viewer; all three measured from the camera's target.
 */
export interface CameraFrame {
  readonly right: Point3;
  readonly upward: Point3;
  readonly toViewer: Point3;
  readonly origin: Point3;
  project(q: Point3): { u: number; v: number; near: number };
}

const cross = (a: Point3, b: Point3) => p(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const unitOf = (a: Point3): Point3 => {
  const len = Math.hypot(a.x, a.y, a.z) || 1;
  return p(a.x / len, a.y / len, a.z / len);
};

export function cameraFrame(camera: View3dCamera): CameraFrame {
  const look = unitOf(p(camera.target.x - camera.eye.x, camera.target.y - camera.eye.y, camera.target.z - camera.eye.z));
  let right = cross(look, camera.up);
  // Looking straight along "up": take plan east as the picture's right.
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = cross(look, p(0, 1, 0));
  right = unitOf(right);
  const upward = unitOf(cross(right, look));
  const toViewer = scaled(look, -1);
  const origin = camera.target;
  return {
    right,
    upward,
    toViewer,
    origin,
    project: (q) => {
      const d = p(q.x - origin.x, q.y - origin.y, q.z - origin.z);
      return { u: dot(d, right), v: dot(d, upward), near: dot(d, toViewer) };
    },
  };
}

/** What a 3D view prints with crop off: the plan rectangle by the box's heights. */
export function boxOverRect(crop: Rect, heights: CropBox3d | null): CropBox3d {
  const lo = heights ? heights.center.z - heights.halfSize.z : 0;
  const hi = heights ? heights.center.z + heights.halfSize.z : NO_LEVEL_TOP_MM;
  return boxFromAabb({ min: p(crop.min.x, crop.min.y, lo), max: p(crop.max.x, crop.max.y, hi) });
}

/** The box's outline on paper: the bounds of its corners seen from the camera (model mm in the picture plane). */
export function cameraWindow(camera: View3dCamera, box: CropBox3d): Rect {
  const frame = cameraFrame(camera);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const c of boxCorners(box)) {
    const q = frame.project(c);
    minU = Math.min(minU, q.u);
    maxU = Math.max(maxU, q.u);
    minV = Math.min(minV, q.v);
    maxV = Math.max(maxV, q.v);
  }
  return { min: { x: round(minU), y: round(minV) }, max: { x: round(maxU), y: round(maxV) } };
}

/** Floor an element's level stands on (its level's elevation; 0 when unknown). */
export function elementFloorMm(model: ModelState, el: BimElement): number {
  return floorOf(model, el);
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Looking from the south-west and above at the box (the isometric direction sheets print). */
export function defaultCamera(box: CropBox3d): View3dCamera {
  const diag = 2 * Math.hypot(box.halfSize.x, box.halfSize.y, box.halfSize.z);
  const dir = scaled(p(-1, -1, 1), 1 / Math.sqrt(3));
  const target = round3(box.center);
  return { eye: round3(add(target, scaled(dir, diag * 1.4))), target, up: p(0, 0, 1), fovDeg: DEFAULT_FOV_DEG, orthoHeightMm: round(diag * 0.9) };
}

/** Named directions a 3D view can look from: the four isometric corners, the four elevations, and straight down. */
export const LOOK_FROM = ["south_west", "south_east", "north_west", "north_east", "south", "north", "east", "west", "top"] as const;
export type LookFrom = (typeof LOOK_FROM)[number];

const LOOK_DIRECTION: Readonly<Record<LookFrom, Point3>> = {
  south_west: p(-1, -1, 1),
  south_east: p(1, -1, 1),
  north_west: p(-1, 1, 1),
  north_east: p(1, 1, 1),
  south: p(0, -1, 0),
  north: p(0, 1, 0),
  east: p(1, 0, 0),
  west: p(-1, 0, 0),
  top: p(0, 0, 1),
};

/** A camera looking at the box from a named direction, far enough back to see all of it (straight down: plan north up). */
export function cameraLookingFrom(box: CropBox3d, from: LookFrom): View3dCamera {
  const diag = 2 * Math.hypot(box.halfSize.x, box.halfSize.y, box.halfSize.z);
  const d = LOOK_DIRECTION[from];
  const len = Math.hypot(d.x, d.y, d.z);
  const target = round3(box.center);
  return { eye: round3(add(target, scaled(d, (diag * 1.4) / len))), target, up: from === "top" ? p(0, 1, 0) : p(0, 0, 1), fovDeg: DEFAULT_FOV_DEG, orthoHeightMm: round(diag * 0.9) };
}

/** A legacy 3D view (plan crop only) crops at every height: its box spans the plan crop by the model's floors. */
function boxForPlanCrop(model: ModelState, crop: Rect): CropBox3d {
  const z = modelAabb(model);
  return boxFromAabb({ min: p(crop.min.x, crop.min.y, z.min.z), max: p(crop.max.x, crop.max.y, z.max.z) });
}

/** The box a 3D view crops to: its own, or (legacy views) its plan crop at every height. Null for other view types. */
export function viewCropBox3d(model: ModelState, view: Pick<ViewElement, "viewType" | "cropMin" | "cropMax" | "props">): CropBox3d | null {
  if (view.viewType !== "three_d") return null;
  return view.props?.cropBox3d ?? boxForPlanCrop(model, { min: view.cropMin, max: view.cropMax });
}

/** The camera a 3D view opens with: its own, or one looking at its box. */
export function viewCamera3d(model: ModelState, view: Pick<ViewElement, "viewType" | "cropMin" | "cropMax" | "props">): View3dCamera | null {
  const box = viewCropBox3d(model, view);
  return box ? (view.props?.camera3d ?? defaultCamera(box)) : null;
}

/** A new 3D view's props: its box (the plan crop at every height, square to the working angle, when none is given) and a camera on it. */
export function withDefault3d(model: ModelState, props: ViewProps, crop: Rect): ViewProps {
  const z = modelAabb(model);
  const box = props.cropBox3d ?? boxAroundAabb({ min: p(crop.min.x, crop.min.y, z.min.z), max: p(crop.max.x, crop.max.y, z.max.z) }, workingAngleOf(model));
  return { ...props, cropBox3d: box, camera3d: props.camera3d ?? defaultCamera(box) };
}

/**
 * A 3D view's box after its plan crop was changed some other way (a viewport
 * frame dragged on a sheet, set_view_crop): it keeps its heights and turn and
 * stretches in plan so its plan bounds are the new crop.
 */
export function boxFollowingPlanCrop(box: CropBox3d, crop: Rect): CropBox3d {
  const old = boxPlanRect(box);
  const ow = Math.max(1e-6, old.max.x - old.min.x);
  const oh = Math.max(1e-6, old.max.y - old.min.y);
  const sx = (crop.max.x - crop.min.x) / ow;
  const sy = (crop.max.y - crop.min.y) / oh;
  const r = (box.rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  // Each local half-axis contributes to the world bounds by |cos| and |sin|; scale it by the axes it mostly lies along.
  const kx = c >= s ? sx : sy;
  const ky = c >= s ? sy : sx;
  return normalizeBox({
    center: { x: (crop.min.x + crop.max.x) / 2, y: (crop.min.y + crop.max.y) / 2, z: box.center.z },
    halfSize: { x: box.halfSize.x * kx, y: box.halfSize.y * ky, z: box.halfSize.z },
    rotationDeg: box.rotationDeg,
  });
}

/** Saved-3D-view fields on a view that is not a 3D view, as a refusal; null when fine. */
export function view3dPropsProblem(viewType: ViewElement["viewType"], props: ViewProps): string | null {
  if (viewType === "three_d") return null;
  if (props.camera3d || props.cropBox3d) return "Only 3D views have a 3D camera and crop box.";
  if (props.workingFor) return "Only a 3D view can be someone's working 3D view.";
  return null;
}

/** A 3D view's props as a duplicate gets them: a copy of someone's working view is an ordinary saved 3D view. */
export function withoutWorking(props: ViewProps | undefined): ViewProps | undefined {
  if (!props?.workingFor) return props;
  const { workingFor: _owner, ...rest } = props;
  return rest;
}

/** A person's working 3D view in a model, if they have one. */
export function workingViewOf(views: readonly ViewElement[], userId: string): ViewElement | null {
  return views.find((v) => v.viewType === "three_d" && v.props?.workingFor === userId) ?? null;
}
