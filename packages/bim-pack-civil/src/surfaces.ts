import { qty, to, unitAllowed, type Quantity, type UnitFor } from "@permitzip/bim-units";
import type { BimElement, ElementId, ElementKindItem, Vec2 } from "@permitzip/bim-kernel";
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
export function gradingSurfaceRecord(id: ElementId, surface: GradingSurface): BimElement {
  const unit = surface.linearUnit;
  const record = {
    id,
    kind: GRADING_SURFACE_KIND,
    version: 0,
    authoredRev: {},
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

function centroidMm(el: BimElement): Vec2 | null {
  const decoded = decodeGradingRecord(el);
  if (!decoded.ok || decoded.surface.points.length === 0) return null;
  let east = 0;
  let north = 0;
  for (const p of decoded.surface.points) {
    east += to(p.easting, "mm");
    north += to(p.northing, "mm");
  }
  const n = decoded.surface.points.length;
  return { x: east / n, y: north / n };
}

/**
 * The grading surface as an element kind. The mesh is the shape. There is no
 * connector and no plan graphic in this slice: the record is here so cut and
 * fill can read it back. `newForOlderPeers` because no older peer stores it.
 */
export const GRADING_SURFACE_KIND_ROW: ElementKindItem = {
  kind: GRADING_SURFACE_KIND,
  label: "Grading surface",
  nature: "physical",
  classId: CIVIL_CLASS.gradingSurface,
  upgrade: { newForOlderPeers: true },
  shape: {
    fields: [
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
};
