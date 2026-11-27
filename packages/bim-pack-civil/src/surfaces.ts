import { qty, to, unitAllowed, type Quantity, type UnitFor } from "@permitzip/bim-units";
import type { BimElement, ElementId, ElementKindItem, KindSolidShape, PlanGraphic, Tilt, Vec2 } from "@permitzip/bim-kernel";
import { CIVIL_CLASS } from "./ids";

/**
 * A grading TIN owned by the civil add-on.
 *
 * LandXML point order is northing, easting, elevation. Stored here the way
 * the model is drawn: easting is plan x (east), northing is plan y (north),
 * elevation is z. Lengths stay in the file's unit (`linearUnit`), wrapped as
 * bim-units quantities. The record on the model stores the same numbers as
 * plain fields because a pack parameter is only a number, a short string or
 * a flag (`ParamValue`, and a string stops at 400 characters), which cannot
 * hold a mesh. The open shape forms `civil.tin_vertices` and `civil.tin_faces`
 * are this add-on's; the kernel keeps them and does not interpret them.
 */

export const GRADING_SURFACE_KIND = CIVIL_CLASS.gradingSurface;

export const SURFACE_ROLES = ["existing", "proposed", "unassigned"] as const;
export type SurfaceRole = (typeof SURFACE_ROLES)[number];

export interface TinVertex {
  readonly id: string;
  readonly easting: Quantity<"length">;
  readonly northing: Quantity<"length">;
  readonly elevation: Quantity<"length">;
}

/** Corner indices into `points`. */
export interface TinFace {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export interface GradingSurface {
  /** Element id once the surface is in a model; a slug until then. */
  readonly id: string;
  readonly name: string;
  readonly role: SurfaceRole;
  /** The unit the vertex numbers are written in. Always a bim-units length code. */
  readonly linearUnit: UnitFor<"length">;
  /**
   * The LandXML `linearUnit` token (`foot`, `meter`, `USSurveyFoot`, …).
   * US survey feet are converted to metres at import, because bim-units has
   * the international foot and not the survey foot; `linearUnit` is then `m`.
   */
  readonly sourceLinearUnit: string;
  readonly points: readonly TinVertex[];
  readonly faces: readonly TinFace[];
}

export interface StoredTinPoint {
  readonly id: string;
  readonly easting: number;
  readonly northing: number;
  readonly elevation: number;
}

export interface StoredTinFace {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export type DecodedSurface = { readonly ok: true; readonly surface: GradingSurface } | { readonly ok: false; readonly reason: string };

function isRole(value: unknown): value is SurfaceRole {
  return value === "existing" || value === "proposed" || value === "unassigned";
}

function isLengthUnit(value: unknown): value is UnitFor<"length"> {
  return typeof value === "string" && unitAllowed("length", value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decodePoint(value: unknown, index: number): StoredTinPoint | string {
  if (typeof value !== "object" || value === null) return `point ${index + 1} isn't a point`;
  const p = value as { id?: unknown; easting?: unknown; northing?: unknown; elevation?: unknown };
  if (typeof p.id !== "string" || p.id.trim() === "") return `point ${index + 1} has no id`;
  if (!finite(p.easting) || !finite(p.northing) || !finite(p.elevation)) return `point ${p.id} needs a finite easting, northing and elevation`;
  return { id: p.id, easting: p.easting, northing: p.northing, elevation: p.elevation };
}

function decodeFace(value: unknown, index: number, pointCount: number): StoredTinFace | string {
  if (typeof value !== "object" || value === null) return `face ${index + 1} isn't a triangle`;
  const f = value as { a?: unknown; b?: unknown; c?: unknown };
  const corners = [f.a, f.b, f.c];
  if (!corners.every((n) => typeof n === "number" && Number.isInteger(n))) return `face ${index + 1} needs three point indexes`;
  const [a, b, c] = corners as [number, number, number];
  if (a < 0 || b < 0 || c < 0 || a >= pointCount || b >= pointCount || c >= pointCount) return `face ${index + 1} names a point that isn't in the surface`;
  return { a, b, c };
}

/** Read a stored grading-surface record. Anything it can't use is a reason, in words. */
export function decodeGradingRecord(record: object): DecodedSurface {
  const raw = record as {
    id?: unknown;
    kind?: unknown;
    name?: unknown;
    role?: unknown;
    linearUnit?: unknown;
    sourceLinearUnit?: unknown;
    points?: unknown;
    faces?: unknown;
  };
  if (raw.kind !== undefined && raw.kind !== GRADING_SURFACE_KIND) return { ok: false, reason: `${String(raw.kind)} isn't a grading surface` };
  if (typeof raw.id !== "string" || raw.id.trim() === "") return { ok: false, reason: "This grading surface has no id" };
  if (typeof raw.name !== "string" || raw.name.trim() === "") return { ok: false, reason: `${raw.id} has no name` };
  if (!isRole(raw.role)) return { ok: false, reason: `${raw.name} needs a role of existing, proposed or unassigned` };
  if (!isLengthUnit(raw.linearUnit)) return { ok: false, reason: `${raw.name} needs a length unit (ft, m, …)` };
  if (!Array.isArray(raw.points) || raw.points.length < 3) return { ok: false, reason: `${raw.name} needs at least three points` };
  if (!Array.isArray(raw.faces) || raw.faces.length < 1) return { ok: false, reason: `${raw.name} needs at least one triangle` };
  const points: StoredTinPoint[] = [];
  for (let i = 0; i < raw.points.length; i++) {
    const p = decodePoint(raw.points[i], i);
    if (typeof p === "string") return { ok: false, reason: `${raw.name}: ${p}` };
    points.push(p);
  }
  const faces: StoredTinFace[] = [];
  for (let i = 0; i < raw.faces.length; i++) {
    const f = decodeFace(raw.faces[i], i, points.length);
    if (typeof f === "string") return { ok: false, reason: `${raw.name}: ${f}` };
    faces.push(f);
  }
  const unit = raw.linearUnit;
  const source = typeof raw.sourceLinearUnit === "string" && raw.sourceLinearUnit.trim() !== "" ? raw.sourceLinearUnit : unit;
  return {
    ok: true,
    surface: {
      id: raw.id,
      name: raw.name,
      role: raw.role,
      linearUnit: unit,
      sourceLinearUnit: source,
      points: points.map((p) => ({
        id: p.id,
        easting: qty("length", p.easting, unit),
        northing: qty("length", p.northing, unit),
        elevation: qty("length", p.elevation, unit),
      })),
      faces,
    },
  };
}

function storedPoint(unit: UnitFor<"length">, p: TinVertex): StoredTinPoint {
  return { id: p.id, easting: to(p.easting, unit), northing: to(p.northing, unit), elevation: to(p.elevation, unit) };
}

/**
 * The element a host stores. Lengths are in `surface.linearUnit`, not millimetres.
 *
 * The kind is not merged into `AddOnElementTypes`. Doing that puts it on
 * `ElementKind`, and the kernel's `ELEMENT_KINDS` list is exhaustive
 * (`MissingKind extends never` in `registry/element-kinds.ts`), so the merge
 * does not compile without a kernel edit. The kernel keeps a stored record of
 * a kind it doesn't name (`elementKindsInForce`); this cast is that boundary.
 */
export function gradingSurfaceRecord(
  id: ElementId,
  surface: GradingSurface,
  level?: { readonly levelId: string; readonly levelName: string },
): BimElement {
  const unit = surface.linearUnit;
  const record = {
    id,
    kind: GRADING_SURFACE_KIND,
    version: 0,
    authoredRev: {},
    ...(level ? { levelId: level.levelId, partition: { level: level.levelName, zone: "Z1", discipline: "civil" } } : {}),
    classId: CIVIL_CLASS.gradingSurface,
    name: surface.name,
    role: surface.role,
    linearUnit: unit,
    sourceLinearUnit: surface.sourceLinearUnit,
    points: surface.points.map((p) => storedPoint(unit, p)),
    faces: surface.faces.map((f) => ({ a: f.a, b: f.b, c: f.c })),
  };
  return record as unknown as BimElement;
}

export interface GradingModel {
  readonly surfaces: readonly GradingSurface[];
  readonly problems: readonly string[];
}

/** Every grading surface in a model. A record of the kind that doesn't read is listed, not dropped silently. */
export function readGradingSurfaces(elements: Readonly<Record<string, BimElement>>): GradingModel {
  const surfaces: GradingSurface[] = [];
  const problems: string[] = [];
  for (const el of Object.values(elements)) {
    // Compared as text: the kind is not one of `ElementKind` (see `gradingSurfaceRecord`).
    if (String(el.kind) !== GRADING_SURFACE_KIND) continue;
    const decoded = decodeGradingRecord(el);
    if (decoded.ok) surfaces.push(decoded.surface);
    else problems.push(decoded.reason);
  }
  return { surfaces, problems };
}

interface PointMm {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface GradingSurfaceStats {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly planAreaM2: number;
  readonly minElevationMm: number;
  readonly maxElevationMm: number;
  readonly centroidMm: Vec2;
}

function surfacePointsMm(surface: GradingSurface): PointMm[] {
  return surface.points.map((p) => ({
    x: to(p.easting, "mm"),
    y: to(p.northing, "mm"),
    z: to(p.elevation, "mm"),
  }));
}

/** Plan area, elevation bounds, counts and centroid of a decoded grading surface. */
export function gradingSurfaceStats(surface: GradingSurface): GradingSurfaceStats | null {
  const pts = surfacePointsMm(surface);
  if (pts.length === 0) return null;
  let east = 0;
  let north = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    east += p.x;
    north += p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  let areaMm2 = 0;
  for (const f of surface.faces) {
    const a = pts[f.a];
    const b = pts[f.b];
    const c = pts[f.c];
    if (!a || !b || !c) continue;
    areaMm2 += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }
  return {
    vertexCount: pts.length,
    faceCount: surface.faces.length,
    planAreaM2: areaMm2 / 1_000_000,
    minElevationMm: minZ,
    maxElevationMm: maxZ,
    centroidMm: { x: east / pts.length, y: north / pts.length },
  };
}

function centroidMm(el: BimElement): Vec2 | null {
  const decoded = decodeGradingRecord(el);
  if (!decoded.ok) return null;
  return gradingSurfaceStats(decoded.surface)?.centroidMm ?? null;
}

/** Max triangles turned into individual 3D prism solids (keeps large 8k-face TINs responsive in WebGL). */
const MAX_SOLID_FACES = 320;
const TERRAIN_BASE_DEPTH_MM = 300;
const DEGENERATE_AREA_MM2 = 1;

function trianglePlane(a: PointMm, b: PointMm, c: PointMm): { readonly z1: number; readonly tilt1: Tilt } | null {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const det = ux * vy - uy * vx;
  if (Math.abs(det) <= DEGENERATE_AREA_MM2) return null;
  const dz1 = b.z - a.z;
  const dz2 = c.z - a.z;
  const riseX = (dz1 * vy - dz2 * uy) / det;
  const riseY = (ux * dz2 - vx * dz1) / det;
  return {
    z1: a.z,
    tilt1: { at: { x: a.x, y: a.y }, rise: { x: riseX, y: riseY } },
  };
}

function gradingSolid(el: BimElement, elements: Readonly<Record<string, BimElement>>): KindSolidShape | null {
  const decoded = decodeGradingRecord(el);
  if (!decoded.ok) return null;
  const surface = decoded.surface;
  // When both existing and proposed TINs are loaded, draw proposed in 3D so the two meshes don't Z-fight.
  if (surface.role === "existing") {
    const hasProposed = Object.values(elements).some((other) => {
      if (other.id === el.id || String(other.kind) !== GRADING_SURFACE_KIND) return false;
      const d = decodeGradingRecord(other);
      return d.ok && d.surface.role === "proposed";
    });
    if (hasProposed) return null;
  }
  if (surface.faces.length > MAX_SOLID_FACES) return null;
  const pts = surfacePointsMm(surface);
  let minZ = Infinity;
  for (const p of pts) if (p.z < minZ) minZ = p.z;
  if (!Number.isFinite(minZ)) return null;
  const z0 = minZ - TERRAIN_BASE_DEPTH_MM;
  const blocks: { readonly outline: readonly Vec2[]; readonly z0: number; readonly z1: number; readonly tilt1: Tilt }[] = [];
  for (const f of surface.faces) {
    const a = pts[f.a];
    const b = pts[f.b];
    const c = pts[f.c];
    if (!a || !b || !c) continue;
    const plane = trianglePlane(a, b, c);
    if (!plane) continue;
    blocks.push({
      outline: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }],
      z0,
      z1: plane.z1,
      tilt1: plane.tilt1,
    });
  }
  if (blocks.length === 0) return null;
  return { form: "prisms", blocks, category: "structure", role: "architecture" };
}

function boundaryEdges(pts: readonly PointMm[], faces: readonly TinFace[]): readonly [Vec2, Vec2][] {
  const counts = new Map<string, { readonly a: number; readonly b: number; count: number }>();
  const addEdge = (u: number, v: number) => {
    const lo = Math.min(u, v);
    const hi = Math.max(u, v);
    const key = `${lo}:${hi}`;
    const hit = counts.get(key);
    if (hit) hit.count += 1;
    else counts.set(key, { a: lo, b: hi, count: 1 });
  };
  for (const f of faces) {
    addEdge(f.a, f.b);
    addEdge(f.b, f.c);
    addEdge(f.c, f.a);
  }
  const out: [Vec2, Vec2][] = [];
  for (const e of counts.values()) {
    if (e.count !== 1) continue;
    const a = pts[e.a];
    const b = pts[e.b];
    if (a && b) out.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
  }
  return out;
}

function contourSegments(pts: readonly PointMm[], faces: readonly TinFace[], zLevel: number): readonly [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  const interp = (p: PointMm, q: PointMm): Vec2 | null => {
    const dp = p.z - zLevel;
    const dq = q.z - zLevel;
    if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0)) return null;
    const denom = q.z - p.z;
    if (Math.abs(denom) < 1e-6) return null;
    const t = (zLevel - p.z) / denom;
    if (t < 0 || t > 1) return null;
    return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
  };
  for (const f of faces) {
    const a = pts[f.a];
    const b = pts[f.b];
    const c = pts[f.c];
    if (!a || !b || !c) continue;
    const hits: Vec2[] = [];
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const h = interp(p, q);
      if (h && !hits.some((prev) => Math.hypot(prev.x - h.x, prev.y - h.y) < 1e-3)) hits.push(h);
    }
    if (hits.length === 2 && hits[0] && hits[1]) out.push([hits[0], hits[1]]);
  }
  return out;
}

function gradingPlanGraphics(el: BimElement, discipline: string | undefined, lookingUp: boolean): readonly PlanGraphic[] | null {
  // Draw site grading contours on civil/site/general plans only; keep architectural/structural/MEP sheets clean.
  if (lookingUp) return [];
  if (discipline !== undefined && discipline !== "civil" && discipline !== "site") return [];
  const decoded = decodeGradingRecord(el);
  if (!decoded.ok) return null;
  const surface = decoded.surface;
  const pts = surfacePointsMm(surface);
  const stats = gradingSurfaceStats(surface);
  if (!stats) return null;

  const isExisting = surface.role === "existing";
  const graphics: PlanGraphic[] = [];
  // Outer perimeter of the TIN
  for (const [a, b] of boundaryEdges(pts, surface.faces)) {
    graphics.push({
      form: "line",
      a,
      b,
      pen: isExisting ? "thin" : "medium",
      ...(isExisting ? { dash: "dashed", tone: "halftone" as const } : {}),
    });
  }
  // Exact triangle-plane elevation contours (1 ft interval for imperial surfaces, 0.5 m for metric)
  const stepMm = surface.linearUnit === "ft" || surface.linearUnit === "in" ? 304.8 : 500;
  const first = Math.ceil((stats.minElevationMm + 1) / stepMm) * stepMm;
  const last = Math.floor((stats.maxElevationMm - 1) / stepMm) * stepMm;
  const maxLines = 24;
  let count = 0;
  for (let z = first; z <= last + 1e-6 && count < maxLines; z += stepMm, count++) {
    const segs = contourSegments(pts, surface.faces, z);
    for (const [a, b] of segs) {
      graphics.push({
        form: "line",
        a,
        b,
        pen: "thin",
        ...(isExisting ? { dash: "dashed", tone: "halftone" as const } : {}),
      });
    }
    const mid = segs[Math.floor(segs.length / 2)];
    if (mid) {
      const label = surface.linearUnit === "ft" || surface.linearUnit === "in"
        ? `${isExisting ? "EG" : "FG"} ${(z / 304.8).toFixed(1)}'`
        : `${isExisting ? "EG" : "FG"} ${(z / 1000).toFixed(2)}m`;
      graphics.push({
        form: "text",
        at: { x: (mid[0].x + mid[1].x) / 2, y: (mid[0].y + mid[1].y) / 2 },
        text: label,
        heightMm: 1.7,
        rotationDeg: 0,
        anchor: "middle",
      });
    }
  }
  return graphics;
}

function gradingBoundsOutline(el: BimElement): readonly Vec2[] | null {
  const decoded = decodeGradingRecord(el);
  if (!decoded.ok) return null;
  const pts = surfacePointsMm(decoded.surface);
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/**
 * The grading surface as an element kind. The mesh is the shape; `solid`
 * renders the proposed terrain TIN in 3D via tilted triangle prisms, and
 * `planGraphics` draws boundary and contour linework on civil/site plans.
 * `newForOlderPeers` because no older peer stores it.
 */
export const GRADING_SURFACE_KIND_ROW: ElementKindItem = {
  kind: GRADING_SURFACE_KIND,
  label: "Grading surface",
  nature: "physical",
  classId: CIVIL_CLASS.gradingSurface,
  upgrade: { newForOlderPeers: true },
  shape: {
    fields: [
      { name: "levelId", form: "text", optional: true },
      { name: "name", form: "text", authored: true },
      { name: "role", form: "text", authored: true },
      { name: "linearUnit", form: "text", authored: true },
      { name: "sourceLinearUnit", form: "text", optional: true },
      { name: "points", form: "civil.tin_vertices", authored: true },
      { name: "faces", form: "civil.tin_faces", authored: true },
    ],
    accepts: (record) => decodeGradingRecord(record).ok,
    points: (el) => {
      const at = centroidMm(el);
      return at ? [at] : [];
    },
  },
  anchor: (el) => centroidMm(el),
  read: (record) => {
    const decoded = decodeGradingRecord(record);
    return decoded.ok ? { ok: true } : { ok: false, reason: decoded.reason };
  },
  tagText: (el) => {
    const decoded = decodeGradingRecord(el);
    return decoded.ok ? `${decoded.surface.name} (${decoded.surface.role})` : null;
  },
  pickShape: (el) => {
    const outline = gradingBoundsOutline(el);
    return outline ? { form: "outline", points: outline } : null;
  },
  planGraphics: (el, ctx) => gradingPlanGraphics(el, ctx.discipline, ctx.lookingUp),
  solid: (el, ctx) => gradingSolid(el, ctx.elements),
};
