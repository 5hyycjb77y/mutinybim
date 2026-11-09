import type { ModelElementBase, Vec2 } from "./types";

/**
 * Where the model sits in the world: the internal origin, the project base
 * point, the survey point and true north.
 *
 * Model coordinates (millimetres; x east, y plan north, z up) are the frame
 * everything is authored and linked in. The internal origin is model
 * (0, 0, 0) and never moves. The project base point is a model point whose
 * shared coordinates (east/west, north/south, elevation) are known, and true
 * north is an angle from plan north. Together they define the shared site:
 *
 *   shared = T(eastWest, northSouth, elevation) · Rz(θ) · T(−basePoint) · model
 *
 * θ = trueNorthDeg, degrees clockwise from plan north to true north. Rz turns
 * counter-clockwise by θ, which brings true north to shared +Y. The survey
 * point is a marker fixed to the shared site (by default the site's 0, 0, 0).
 *
 * Changing any of this never moves geometry or linked models: model
 * coordinates are untouched, only what they mean on the site changes.
 */

/** A point in model millimetres: plan x east, y north, z elevation above project zero. */
export interface SitePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A point's shared (site) coordinates in millimetres. */
export interface SharedCoordinates {
  readonly eastWest: number;
  readonly northSouth: number;
  readonly elevation: number;
}

export interface SiteElement extends ModelElementBase {
  readonly kind: "site";
  /** Project base point, model mm. Authored. */
  readonly basePoint: SitePoint;
  /** The project base point's shared coordinates. Authored. */
  readonly basePointShared: SharedCoordinates;
  /** Degrees clockwise from plan north to true north, in (−180, 180]. Authored. */
  readonly trueNorthDeg: number;
  /** Survey point, model mm. Authored. */
  readonly surveyPoint: SitePoint;
  /**
   * The model's working angle (`work-frame.ts`): degrees counter-clockwise from
   * model +X to the direction people draw in, in (−45, 45]. Absent: 0. A work
   * frame only; it is not part of the shared-site transform above, so changing
   * it never changes any point's shared coordinates. Authored.
   */
  readonly workingAngleDeg?: number;
}

/** The model's one site element. */
export const SITE_ID = "site";

export const INTERNAL_ORIGIN: SitePoint = { x: 0, y: 0, z: 0 };

/** Which point the origin marker sits on and the coordinates dialog edits. On screen: project origin (the project base point), site point (the survey point), model zero (the internal origin). */
export type OriginPoint = "project_base_point" | "survey_point" | "internal_origin";

export const ORIGIN_POINT_LABEL: Readonly<Record<OriginPoint, string>> = {
  project_base_point: "Project origin",
  survey_point: "Site point",
  internal_origin: "Model zero",
};

/** A model with no site element: shared coordinates equal model coordinates, plan north is true north. */
export const DEFAULT_SITE: Omit<SiteElement, "id" | "version" | "authoredRev" | "partition"> = {
  kind: "site",
  basePoint: INTERNAL_ORIGIN,
  basePointShared: { eastWest: 0, northSouth: 0, elevation: 0 },
  trueNorthDeg: 0,
  surveyPoint: INTERNAL_ORIGIN,
};

export type SiteFrame = Pick<SiteElement, "basePoint" | "basePointShared" | "trueNorthDeg" | "surveyPoint" | "workingAngleDeg">;

/** The site as it stands: the model's site element, or the default when there is none. */
export function siteOf(model: { readonly elements: Readonly<Record<string, { readonly kind: string }>> }): SiteFrame {
  const el = model.elements[SITE_ID];
  return el && isSiteElement(el) ? el : DEFAULT_SITE;
}

function isSiteElement(el: { readonly kind: string }): el is SiteElement {
  return el.kind === "site";
}

const RAD = Math.PI / 180;

/** Angle in (−180, 180], rounded to a millionth of a degree. */
export function normalizeAngleDeg(deg: number): number {
  let a = ((deg % 360) + 360) % 360;
  if (a > 180) a -= 360;
  const r = Math.round(a * 1e6) / 1e6;
  return r === -180 ? 180 : r === 0 ? 0 : r;
}

function rotate(v: Vec2, deg: number): Vec2 {
  const a = deg * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A model point's shared coordinates. */
export function modelToShared(site: SiteFrame, p: SitePoint): SharedCoordinates {
  const r = rotate({ x: p.x - site.basePoint.x, y: p.y - site.basePoint.y }, site.trueNorthDeg);
  return {
    eastWest: site.basePointShared.eastWest + r.x,
    northSouth: site.basePointShared.northSouth + r.y,
    elevation: site.basePointShared.elevation + (p.z - site.basePoint.z),
  };
}

/** The model point at shared coordinates. */
export function sharedToModel(site: SiteFrame, s: SharedCoordinates): SitePoint {
  const r = rotate({ x: s.eastWest - site.basePointShared.eastWest, y: s.northSouth - site.basePointShared.northSouth }, -site.trueNorthDeg);
  return { x: site.basePoint.x + r.x, y: site.basePoint.y + r.y, z: site.basePoint.z + (s.elevation - site.basePointShared.elevation) };
}

/** True north as a unit direction in plan (model x east, y plan north). */
export function trueNorthInPlan(site: Pick<SiteFrame, "trueNorthDeg">): Vec2 {
  const a = site.trueNorthDeg * RAD;
  return { x: Math.sin(a), y: Math.cos(a) };
}

/** Degrees clockwise from plan north to the direction from `from` to `to`; null when they coincide. */
export function bearingDeg(from: Vec2, to: Vec2): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return normalizeAngleDeg(Math.atan2(dx, dy) / RAD);
}

/** Where a named origin point is, in model mm. */
export function originPointPosition(site: SiteFrame, which: OriginPoint): SitePoint {
  switch (which) {
    case "project_base_point":
      return site.basePoint;
    case "survey_point":
      return site.surveyPoint;
    case "internal_origin":
      return INTERNAL_ORIGIN;
  }
}

/** Row-major 4×4, acting on column vectors. */
export type SiteMatrix = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

/**
 * Model → shared as a matrix in metres, IFC axes (x east, y north, z up):
 * T(shared of the internal origin) · Rz(θ). This is the placement an export
 * writes and the basis shared coordinates are read in (TRANSFORMS.md, "The
 * shared site").
 */
export function siteMatrixMetres(site: SiteFrame): SiteMatrix {
  const o = modelToShared(site, INTERNAL_ORIGIN);
  const a = site.trueNorthDeg * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, -s, 0, o.eastWest / 1000],
    [s, c, 0, o.northSouth / 1000],
    [0, 0, 1, o.elevation / 1000],
    [0, 0, 0, 1],
  ];
}

/**
 * What an exported IFC file must carry so its geometry (written in model
 * coordinates, internal origin at the file origin) lands on the shared site:
 * an `IfcMapConversion` from the file's local frame. Metres.
 */
export interface SiteMapConversion {
  readonly eastings: number;
  readonly northings: number;
  readonly orthogonalHeight: number;
  /** cos θ and sin θ: the file's +X in the shared frame. */
  readonly xAxisAbscissa: number;
  readonly xAxisOrdinate: number;
  readonly scale: 1;
}

export function siteMapConversion(site: SiteFrame): SiteMapConversion {
  const m = siteMatrixMetres(site);
  return { eastings: m[0][3], northings: m[1][3], orthogonalHeight: m[2][3], xAxisAbscissa: m[0][0], xAxisOrdinate: m[1][0], scale: 1 };
}

const FT_MM = 304.8;

/** Feet with one decimal, the way the coordinates read on screen and in the dialog. */
export function formatSharedFt(mm: number): string {
  const ft = Math.round((mm / FT_MM) * 10) / 10;
  return (ft === 0 ? 0 : ft).toFixed(1);
}
