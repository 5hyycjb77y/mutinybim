import type { ViewCategory } from "../documents";
import { perp, sub, tiltedZ, unit, type Tilt } from "../geometry";
import { kindRowOf } from "../kinds/rows";
import type { KindSolidShape } from "../registry/kind-row-faces";
import { activeClassRegistry } from "../registry";
import { classSolidsOf, hasClassSolids, type ClassSolidPart } from "../kinds/class-solids-point";
import { localBounds, partToWorld, resolveGeometry } from "../parts";
import { placedGeometry, placedIntakePrimitives } from "../part-placed";
import { mountedPositions } from "../part-mount";
import { flexRings } from "../routing/flex";
import { fittingBody, ringPoint, segmentRings, straightPiece, widthAxisFor, type Ring } from "../routing/fittings/geometry";
import { len3, p3, scale3, sub3, unit3 } from "../routing/geometry";
import { drawnWidth } from "../routing/pipe/geometry";
import { partViewCategory } from "../view-categories";
import { sizeHeight, sizeWidth } from "../routing/rules";
import type { RunPoint, RunSize } from "../routing/types";
import type { BimElement, ModelState, Vec2 } from "../types";
import { partGeometryReady, partMesh } from "../part-model/engine";
import { meshEdges, type WorldMesh } from "./mesh-projection";
import { loadPointPosition } from "../load-points/model";
import { hostSolidBlocks } from "../hosting/voids";
import { wallBodyProfile } from "../placement/surface-bind";

/**
 * Elements as 3D solids for sections, 3D views and plan hiding. A solid is a
 * list of convex pieces; each piece is a loft between two rings with the same
 * number of points (a straight duct is one piece, a radius elbow one piece per
 * pair of consecutive rings, a box one piece with four-point rings). World
 * millimetres: plan x/y, z above project zero (level elevation added).
 */

export interface Piece {
  readonly r0: readonly RunPoint[];
  readonly r1: readonly RunPoint[];
  /** Round or oval: the ring is a sampled curve, so lengthwise edges are only drawn where they are a silhouette. */
  readonly smooth: boolean;
  /** Draw the r0 / r1 ring outline (an open end, a joint, a box face). Interior rings of a smooth bend are not drawn. */
  readonly edge0: boolean;
  readonly edge1: boolean;
}

export type SolidRole = "mep" | "architecture" | "equipment";

export interface ElementSolid {
  readonly owner: string;
  readonly category: ViewCategory;
  readonly role: SolidRole;
  readonly pieces: readonly Piece[];
  /** Duct and pipe centreline, for single-line (coarse) drawing. */
  readonly centerline?: ReadonlyArray<readonly [RunPoint, RunPoint]>;
  /** Duct and pipe: nominal width (single-line cut markers size from it). */
  readonly sizeMm?: number;
  /** Modeled parts: their triangles in world millimetres (drawn instead of pieces). */
  readonly mesh?: WorldMesh;
}

const ROUND_SAMPLES = 16;
const DEFAULT_WALL_HEIGHT_MM = 10 * 304.8;

const cross3 = (a: RunPoint, b: RunPoint): RunPoint => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const lift = (p: RunPoint, dz: number): RunPoint => p3(p.x, p.y, p.z + dz);

/** A ring's outline: a rectangle's four corners, or a round / oval sampled evenly. */
export function ringPoints(r: Ring): RunPoint[] {
  if (r.shape === "rect") return [0, 1, 2, 3].map((k) => ringPoint(r, Math.PI / 4 + (k * Math.PI) / 2));
  const out: RunPoint[] = [];
  for (let i = 0; i < ROUND_SAMPLES; i++) out.push(ringPoint(r, (2 * Math.PI * i) / ROUND_SAMPLES));
  return out;
}

function sizeRing(center: RunPoint, along: RunPoint, size: RunSize): Ring {
  const t = unit3(along);
  const wAxis = widthAxisFor(t, p3(1, 0, 0));
  let hAxis = unit3(cross3(t, wAxis));
  if (hAxis.z < 0 || (Math.abs(hAxis.z) < 1e-9 && hAxis.y < 0)) hAxis = scale3(hAxis, -1);
  const shape = size.shape === "rect" ? "rect" : size.shape === "oval" ? "oval" : "round";
  const w = drawnWidth(size);
  return { center, a: scale3(wAxis, w / 2), b: scale3(hAxis, (size.shape === "rect" || size.shape === "oval" ? sizeHeight(size) : w) / 2), shape };
}

function loft(a: Ring, b: Ring, edge0: boolean, edge1: boolean): Piece {
  return { r0: ringPoints(a), r1: ringPoints(b), smooth: a.shape !== "rect", edge0, edge1 };
}

/** An upright prism over a convex plan outline, from z0 to z1; a tilted end is a sloped plane through that height (`Tilt`). */
function prism(outline: readonly Vec2[], z0: number, z1: number, tilt0?: Tilt, tilt1?: Tilt): Piece {
  return { r0: outline.map((q) => p3(q.x, q.y, tiltedZ(z0, tilt0, q))), r1: outline.map((q) => p3(q.x, q.y, tiltedZ(z1, tilt1, q))), smooth: false, edge0: true, edge1: true };
}

function levelElevation(model: ModelState, levelId: string): number {
  const level = model.elements[levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

const PART_CATEGORY: Readonly<Record<string, ViewCategory>> = { air_terminal: "air_terminal", duct_accessory: "duct_fitting", pipe_accessory: "pipe" };

/** Convex hull of plan points (counter-clockwise). */
export function hull2(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Vec2;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The element as a solid, or null when it has no body (annotations,
 * documents, systems). `floorMm` places legacy elements that carry no level
 * elevation (the drawing view's level).
 */
export function elementSolid(model: ModelState, el: BimElement, floorMm: number): ElementSolid | null {
  const byClass = hasClassSolids() ? classSolidsOf(el, { elements: model.elements, floorMm }, activeClassRegistry()) : null;
  if (byClass) return solidOfParts(el.id, byClass);
  const face = kindRowOf(el.kind)?.solid;
  if (face) {
    const shape = face(el, { elements: model.elements, floorMm });
    return shape ? solidOfShape(el.id, shape) : null;
  }
  switch (el.kind) {
    case "run_segment": {
      const z = levelElevation(model, el.levelId);
      const category: ViewCategory = el.domain === "duct" ? "duct" : "pipe";
      if (el.flex) {
        const rings = flexRings(el).map((r) => ({ ...r, center: lift(r.center, z) }));
        const pieces: Piece[] = [];
        const centerline: Array<readonly [RunPoint, RunPoint]> = [];
        for (let i = 1; i < rings.length; i++) {
          const a = rings[i - 1];
          const b = rings[i];
          if (!a || !b) continue;
          pieces.push(loft(a, b, i === 1, i === rings.length - 1));
          centerline.push([a.center, b.center]);
        }
        return { owner: el.id, category, role: "mep", pieces, centerline, sizeMm: sizeWidth(el.size) };
      }
      const a = lift(el.start, z);
      const b = lift(el.end, z);
      const along = sub3(b, a);
      if (len3(along) < 1e-6) return null;
      const fromLibrary = [el.links.start, el.links.end].some((l) => {
        const f = l ? model.elements[l.elementId] : undefined;
        return f?.kind === "run_fitting" && f.family !== undefined;
      });
      const piece = el.domain !== "conduit" && fromLibrary ? straightPiece(model.elements, el) : null;
      const s = piece ? lift(piece.start, z) : a;
      const e = piece ? lift(piece.end, z) : b;
      // A riser is turned the way the elbows into it turn it.
      const rings = el.domain === "duct" ? segmentRings(model.elements, el) : null;
      const end0 = rings ? { ...rings.start, center: s } : sizeRing(s, along, el.size);
      const end1 = rings ? { ...rings.end, center: e } : sizeRing(e, along, el.size);
      const pieces = piece && piece.lengthMm <= 0 ? [] : [loft(end0, end1, true, true)];
      return { owner: el.id, category, role: "mep", pieces, centerline: [[a, b]], sizeMm: sizeWidth(el.size) };
    }
    case "run_fitting": {
      const z = levelElevation(model, el.levelId);
      const category: ViewCategory = el.domain === "duct" ? "duct_fitting" : "pipe";
      const center = lift(el.position, z);
      const centerline = el.ports.map((port) => [lift(port.position, z), center] as const);
      const size = el.ports[0]?.size;
      const pieces: Piece[] = [];
      if (el.domain !== "conduit" && el.family !== undefined) {
        for (const tube of fittingBody(model.elements, el).tubes) {
          const rings = tube.rings.map((r) => ({ ...r, center: lift(r.center, z) }));
          for (let i = 0; i + 1 < rings.length; i++) {
            const r0 = rings[i];
            const r1 = rings[i + 1];
            if (r0 && r1) pieces.push(loft(r0, r1, i === 0 || tube.faceted, i + 2 === rings.length || tube.faceted));
          }
        }
      }
      if (pieces.length === 0) {
        // No library body: each port's size carried to the fitting's centre.
        for (const port of el.ports) {
          const p = lift(port.position, z);
          const along = sub3(center, p);
          if (len3(along) < 1) continue;
          pieces.push(loft(sizeRing(p, along, port.size), sizeRing(center, along, port.size), true, false));
        }
      }
      return { owner: el.id, category, role: "mep", pieces, centerline, ...(size ? { sizeMm: sizeWidth(size) } : {}) };
    }
    case "part": {
      if (el.planned !== undefined) return null;
      const type = model.elements[el.typeId];
      if (type?.kind !== "part_type") return null;
      const z = levelElevation(model, el.levelId) + el.offsetMm;
      const drawnAs = PART_CATEGORY[type.definition.category] ?? "equipment";
      const role: SolidRole = drawnAs === "air_terminal" || drawnAs === "equipment" ? "equipment" : "mep";
      const category = partViewCategory(model, el) ?? drawnAs;
      // A curb is real: drawn from the host up to the base under the part's footprint, so 3D, sections and elevations show what it stands on.
      const curb: Piece[] = [];
      if (el.curbMm && el.curbMm > 0) {
        const b = localBounds(resolveGeometry(type.definition, el.values));
        const outline = [partToWorld(el, { x: b.min[0], y: b.min[1] }), partToWorld(el, { x: b.max[0], y: b.min[1] }), partToWorld(el, { x: b.max[0], y: b.max[1] }), partToWorld(el, { x: b.min[0], y: b.max[1] })];
        curb.push(prism(outline, z + b.min[2] - el.curbMm, z + b.min[2]));
      }
      // Without the geometry engine (still loading in a browser) a modeled part falls back to its features' bounding boxes below.
      const modeled = type.definition.model !== undefined && partGeometryReady();
      const pieces: Piece[] = [...curb];
      const world = (x: number, y: number) => partToWorld(el, { x, y });
      // A modeled part is its mesh; its hoods, louvers and screens are drawn beside it as primitives.
      for (const prim of modeled ? placedIntakePrimitives(type, el) : placedGeometry(type, el)) {
        if (prim.kind === "box") {
          const [cx, cy, cz] = prim.center;
          const [sx, sy, sz] = prim.size;
          const outline = [world(cx - sx / 2, cy - sy / 2), world(cx + sx / 2, cy - sy / 2), world(cx + sx / 2, cy + sy / 2), world(cx - sx / 2, cy + sy / 2)];
          pieces.push(prism(outline, z + cz - sz / 2, z + cz + sz / 2));
        } else if (prim.kind === "cylinder") {
          const [cx, cy, cz] = prim.center;
          const h = prim.height / 2;
          const local = (x: number, y: number, zz: number) => {
            const q = world(x, y);
            return p3(q.x, q.y, z + zz);
          };
          const axis = prim.axis === "z" ? p3(0, 0, 1) : prim.axis === "x" ? p3(1, 0, 0) : p3(0, 1, 0);
          const c0 = local(cx - axis.x * h, cy - axis.y * h, cz - axis.z * h);
          const c1 = local(cx + axis.x * h, cy + axis.y * h, cz + axis.z * h);
          const ring = (c: RunPoint): Ring => {
            const t = unit3(sub3(c1, c0));
            const wa = widthAxisFor(t, p3(1, 0, 0));
            return { center: c, a: scale3(wa, prim.radius), b: scale3(unit3(cross3(t, wa)), prim.radius), shape: "round" };
          };
          pieces.push(loft(ring(c0), ring(c1), true, true));
        } else {
          pieces.push(prism(hull2(prim.profile.map((q) => world(q.x, q.y))), z + prim.z, z + prim.z + prim.height));
        }
      }
      if (modeled) {
        const local = partMesh(type.definition, el.values, "fine");
        const mounted = mountedPositions(local.positions, el.mount);
        const positions = new Float64Array(mounted.length);
        for (let i = 0; i < mounted.length; i += 3) {
          const w = partToWorld(el, { x: mounted[i] ?? 0, y: mounted[i + 1] ?? 0 });
          positions[i] = w.x;
          positions[i + 1] = w.y;
          positions[i + 2] = z + (mounted[i + 2] ?? 0);
        }
        return { owner: el.id, category, role, pieces, mesh: { positions, indices: local.indices, edges: meshEdges(mounted, local.indices) } };
      }
      return { owner: el.id, category, role, pieces };
    }
    case "wall": {
      const d = sub(el.end, el.start);
      if (Math.hypot(d.x, d.y) < 1e-6) return null;
      const n = perp(unit(d));
      const half = el.thickness / 2;
      const height = el.height > 0 ? el.height : DEFAULT_WALL_HEIGHT_MM;
      const outline = [
        { x: el.start.x + n.x * half, y: el.start.y + n.y * half },
        { x: el.end.x + n.x * half, y: el.end.y + n.y * half },
        { x: el.end.x - n.x * half, y: el.end.y - n.y * half },
        { x: el.start.x - n.x * half, y: el.start.y - n.y * half },
      ];
      // A wall whose top or base follows a surface (or stands off its level) is drawn from its body profile: sloped under a pitched roof, stepped under two floors.
      const profile = wallBodyProfile(el);
      const blocks = hostSolidBlocks(model.elements, el, height, profile);
      return { owner: el.id, category: "walls", role: "architecture", pieces: blocks?.map((b) => prism(b.outline, floorMm + b.z0, floorMm + b.z1, b.tilt0, b.tilt1)) ?? [prism(outline, floorMm, floorMm + height)] };
    }
    case "column": {
      const hx = el.size.x / 2;
      const hy = el.size.y / 2;
      const c = el.position;
      return { owner: el.id, category: "structure", role: "architecture", pieces: [prism([{ x: c.x - hx, y: c.y - hy }, { x: c.x + hx, y: c.y - hy }, { x: c.x + hx, y: c.y + hy }, { x: c.x - hx, y: c.y + hy }], floorMm, floorMm + DEFAULT_WALL_HEIGHT_MM)] };
    }
    case "load_point": {
      // A short octagonal stub at its pipe end ("nub"), so it shows and can be picked in 3D.
      const at = loadPointPosition(model.elements, el);
      if (!at) return null;
      const z = levelElevation(model, at.levelId) + at.point.z;
      const r = 60;
      const outline = Array.from({ length: 8 }, (_, i) => ({ x: at.point.x + r * Math.cos((i * Math.PI) / 4), y: at.point.y + r * Math.sin((i * Math.PI) / 4) }));
      return { owner: el.id, category: "pipe", role: "mep", pieces: [prism(outline, z - r, z + r)] };
    }
    default:
      return null;
  }
}

/** A row's solid shape as pieces: a run lofted end to end, a prism as one box piece. */
function solidOfShape(owner: string, shape: KindSolidShape): ElementSolid | null {
  if (shape.form === "prism") return { owner, category: shape.category, role: shape.role, pieces: [prism(shape.outline, shape.z0, shape.z1)] };
  if (shape.form === "prisms") return { owner, category: shape.category, role: shape.role, pieces: shape.blocks.map((b) => prism(b.outline, b.z0, b.z1, b.tilt0, b.tilt1)) };
  const along = sub3(shape.b, shape.a);
  if (len3(along) < 1e-6) return null;
  return { owner, category: shape.category, role: shape.role, pieces: [loft(sizeRing(shape.a, along, shape.size), sizeRing(shape.b, along, shape.size), true, true)], centerline: [[shape.a, shape.b]], sizeMm: shape.sizeMm };
}

/** A class body's parts as one solid: every part's pieces, cut alike in sections; category and role from the first part. */
function solidOfParts(owner: string, parts: readonly ClassSolidPart[]): ElementSolid | null {
  const first = parts[0];
  if (!first) return null;
  const pieces: Piece[] = [];
  for (const part of parts) pieces.push(...(solidOfShape(owner, part.shape)?.pieces ?? []));
  return pieces.length > 0 ? { owner, category: first.shape.category, role: first.shape.role, pieces } : null;
}

/**
 * True when records of `kind` have a body (the kernel's runs, fittings and parts, or a row with a `solid` face).
 * A class body (`kernel.class_solids`) fills its host's void: plans keep drawing it as its class plan graphics in the host's gap, never hidden under the host.
 */
export function kindHasBody(kind: string): boolean {
  return KERNEL_BODY_KINDS.has(kind) || kindRowOf(kind)?.solid !== undefined;
}

const KERNEL_BODY_KINDS: ReadonlySet<string> = new Set(["run_segment", "run_fitting", "part"]);

/** Plan points of an element, for the quick reject before building its solid. */
export function planPointsOf(el: BimElement): Vec2[] {
  if ("start" in el && "end" in el) return [el.start, el.end];
  if (el.kind === "run_fitting") return [el.position, ...el.ports.map((p) => p.position)];
  if ("position" in el) return [el.position];
  if ("outline" in el) return [...el.outline];
  return [];
}

