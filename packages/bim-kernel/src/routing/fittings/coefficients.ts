import { z } from "zod";
import type { CoefficientEntry, CoefficientOverride, CoefficientTable } from "../types";
import type { FittingFamily } from "./library";

/**
 * Loss coefficients, from pluggable sources. A fitting's loss is C x VP, with
 * VP the velocity pressure at the section the coefficient is referenced to.
 *
 * Sources, first match wins:
 * 1. the engineer's override on the fitting instance (who and when recorded);
 * 2. coefficient tables an engineer enters (per project on the system, per firm from the host);
 * 3. licensed databases, through `LicensedCoefficientImporter` (interface and schema only; none is bundled);
 * 4. the built-in published-correlation formulas below.
 *
 * The built-in formulas are general engineering correlations from the
 * original research (Idelchik's Handbook of Hydraulic Resistance, 1986;
 * Locklin 1950; Weisbach), not copies of the ASHRAE Duct Fitting Database or
 * Fundamentals tables, and every value they give is labelled "formula,
 * verify for permit work". Where a factor is tabulated in the source it is
 * interpolated from those points rather than fitted with a curve.
 */

export type CoefficientRole = "body" | "branch" | "main";

/** Which velocity pressure C multiplies. */
export type VpReference = "own" | "upstream" | "branch" | "small_end";

export interface CoefficientQuery {
  readonly family: FittingFamily;
  readonly params: Readonly<Record<string, number | string>>;
  readonly role: CoefficientRole;
  /** Elbows: the turn. Takeoffs: the angle the branch enters at. */
  readonly angleDeg: number;
  /** Elbows and offsets: centreline radius over the in-plane dimension. */
  readonly rOverW: number;
  /** Elbows: out-of-plane / in-plane dimension (H/W). */
  readonly aspectRatio: number;
  /** Transitions: small area / large area. */
  readonly areaRatio: number;
  /** Transitions: true when air goes from the small end to the large end. */
  readonly expanding: boolean;
  /** Transitions: the included angle the wall angle gives. */
  readonly includedAngleDeg: number;
  /** Takeoffs: branch (role branch) or downstream-trunk (role main) velocity over upstream-trunk velocity. */
  readonly velocityRatio: number;
  /** Takeoffs: air leaves the trunk into the branch (supply); false when it joins it (return, exhaust). */
  readonly diverging: boolean;
  /** Pipe: the pipe's fully turbulent Darcy friction factor fT, which K = (L/D) x fT scales by. */
  readonly turbulentFrictionFactor?: number;
}

export type CoefficientSourceKind = "override" | "table" | "licensed" | "formula";

export interface CoefficientValue {
  readonly c: number;
  readonly reference: VpReference;
  readonly sourceKind: CoefficientSourceKind;
  readonly sourceId: string;
  /** What a person sees next to the number: "Formula, verify for permit work", "Project table: Acme 2026", "Override by Priya, 2026-10-19". */
  readonly sourceLabel: string;
  /** How the number was found, in words. */
  readonly method: string;
  readonly verify: boolean;
}

export interface CoefficientSource {
  readonly id: string;
  readonly label: string;
  readonly kind: Exclude<CoefficientSourceKind, "override">;
  lookup(q: CoefficientQuery): CoefficientValue | null;
}

export const FORMULA_LABEL = "Formula, verify for permit work";

// ------------------------------------------------------------------ built-in correlations

const rad = (deg: number) => (deg * Math.PI) / 180;

type Curve = ReadonlyArray<readonly [number, number]>;

/** Linear between the points of an ascending curve, held at its ends. */
function onCurve(curve: Curve, x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a && b && x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return last[1];
}

/** Idelchik (1986) Diagram 6-1, A1: a smooth bend's loss at angle δ as a share of a 90° bend's. */
const BEND_ANGLE_A1: Curve = [
  [0, 0],
  [20, 0.31],
  [30, 0.45],
  [45, 0.6],
  [60, 0.78],
  [75, 0.9],
  [90, 1],
  [110, 1.13],
  [130, 1.2],
  [150, 1.28],
  [180, 1.4],
];

/** Angle factor for smooth bends: the turn's share of a 90° bend's loss (Idelchik Diagram 6-1, A1). */
export function bendAngleFactor(deg: number): number {
  return onCurve(BEND_ANGLE_A1, Math.max(0, Math.min(180, deg)));
}

/** Radius factor for smooth bends (Idelchik form): 0.21 / (r/W)^0.5 from r/W = 1 up, 0.21 / (r/W)^2.5 below it. */
export function bendRadiusFactor(rOverW: number): number {
  const r = Math.max(0.5, rOverW);
  return r >= 1 ? 0.21 / Math.sqrt(r) : 0.21 / r ** 2.5;
}

/** Idelchik (1986) Diagram 6-1, C1: smooth bends, by H/W (H out of the plane of the turn). Squat sections lose more; 1.0 for square and round. */
const BEND_ASPECT_C1: Curve = [
  [0.25, 1.3],
  [0.5, 1.17],
  [0.75, 1.09],
  [1, 1],
  [1.5, 0.9],
  [2, 0.85],
  [3, 0.85],
  [4, 0.9],
  [5, 0.95],
  [6, 0.98],
  [8, 1],
];

/** Aspect-ratio factor for rectangular smooth bends (H/W, H out of the plane of the turn), Idelchik Diagram 6-1, C1. */
export function bendAspectFactor(aspect: number): number {
  return onCurve(BEND_ASPECT_C1, aspect);
}

/** Idelchik (1986) Diagram 6-5, A: the multiplier on Weisbach's form that sharp (mitred) elbows measure at, by angle. */
const SHARP_ANGLE_A: Curve = [
  [20, 2.5],
  [30, 2.22],
  [45, 1.87],
  [60, 1.5],
  [75, 1.28],
  [90, 1.2],
  [180, 1.2],
];

/** Idelchik (1986) Diagram 6-5, C1: sharp elbows, by H/W. Tall sections lose less than smooth bends do. */
const SHARP_ASPECT_C1: Curve = [
  [0.25, 1.1],
  [0.5, 1.07],
  [0.75, 1.04],
  [1, 1],
  [1.5, 0.95],
  [2, 0.9],
  [3, 0.83],
  [4, 0.78],
  [5, 0.75],
  [6, 0.72],
  [8, 0.71],
];

/**
 * Sharp (mitred) elbow, square or round section: A x (0.95 sin²(δ/2) + 2.05 sin⁴(δ/2)),
 * Weisbach's form with Idelchik's Diagram 6-5 angle multiplier A. 1.19 at 90°, 0.34 at 45°.
 */
export function mitreCoefficient(deg: number): number {
  const d = Math.max(0, Math.min(180, deg));
  const s2 = Math.sin(rad(d) / 2) ** 2;
  return onCurve(SHARP_ANGLE_A, d) * (0.95 * s2 + 2.05 * s2 * s2);
}

/** Aspect-ratio factor for rectangular mitred elbows (Idelchik Diagram 6-5, C1). */
export function mitreAspectFactor(aspect: number): number {
  return onCurve(SHARP_ASPECT_C1, aspect);
}

/** Locklin (1950), 90° gored round elbows by number of pieces and r/D (pieces outside 3 to 5 take the nearest). */
const GORED_90: Readonly<Record<number, Curve>> = {
  3: [
    [0.75, 0.54],
    [1, 0.42],
    [1.5, 0.34],
    [2, 0.33],
  ],
  4: [
    [0.75, 0.5],
    [1, 0.37],
    [1.5, 0.27],
    [2, 0.24],
  ],
  5: [
    [0.75, 0.46],
    [1, 0.33],
    [1.5, 0.24],
    [2, 0.19],
  ],
};

/** A 90° gored round elbow's loss from Locklin's data, before the angle factor. */
export function goredElbow90(gores: number, rOverD: number): number {
  const n = Math.max(3, Math.min(5, Math.round(gores)));
  return onCurve(GORED_90[n] ?? GORED_90[5] ?? [], rOverD);
}

/** Locklin (1950): 90° die-stamped or pleated round elbows by r/D. */
const STAMPED_90: Curve = [
  [0.5, 0.71],
  [0.75, 0.33],
  [1, 0.22],
  [1.5, 0.15],
  [2, 0.13],
  [2.5, 0.12],
];

/** A 90° smooth (die-stamped or pleated) round elbow's loss, before the angle factor. */
export function stampedElbow90(rOverD: number): number {
  return onCurve(STAMPED_90, rOverD);
}

/** Typical turning-vane rail losses at 90° (single-wall about 0.15, double-wall about 0.25); scaled by the bend angle factor. */
const VANE_C90: Readonly<Record<string, number>> = { single: 0.15, double: 0.25 };

/**
 * Gradual area change (Crane TP-410 correlation form), referenced to the
 * small end. β² = small / large area, θ the included angle.
 * Contraction: 0.8 sin(θ/2)(1 − β²) up to 45°, 0.5 √sin(θ/2) (1 − β²) beyond.
 * Expansion: 2.6 sin(θ/2)(1 − β²)² up to 45°, (1 − β²)² beyond.
 */
export function transitionCoefficient(areaRatio: number, includedDeg: number, expanding: boolean): number {
  const b2 = Math.max(0, Math.min(1, areaRatio));
  const half = Math.sin(rad(Math.max(0, Math.min(180, includedDeg))) / 2);
  if (expanding) return includedDeg <= 45 ? 2.6 * half * (1 - b2) ** 2 : (1 - b2) ** 2;
  return includedDeg <= 45 ? 0.8 * half * (1 - b2) : 0.5 * Math.sqrt(half) * (1 - b2);
}

/**
 * Diverging takeoff, branch path (Idelchik's general tee form):
 * ζ_c = A'(1 + r² − 2 r cos α), r = Vb / Vc, referenced to the upstream trunk;
 * returned referenced to the branch velocity (ζ_c / r²), as takeoff tables are.
 * A' is the entry-shape factor (1 square-edged, lower for conical / bellmouth).
 */
export function branchCoefficient(velocityRatio: number, angleDeg: number, entryFactor: number): number {
  const r = Math.max(0.05, velocityRatio);
  const zc = entryFactor * (1 + r * r - 2 * r * Math.cos(rad(angleDeg)));
  return Math.max(0, zc / (r * r));
}

/** Diverging takeoff, straight-through path: ζ = 0.4 (1 − Vs / Vc)², referenced to the upstream trunk. */
export function mainCoefficient(velocityRatio: number): number {
  return 0.4 * (1 - Math.max(0, Math.min(1.5, velocityRatio))) ** 2;
}

function num(params: Readonly<Record<string, number | string>>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function formulaValue(c: number, reference: VpReference, method: string): CoefficientValue {
  return { c: Math.round(c * 10_000) / 10_000, reference, sourceKind: "formula", sourceId: "builtin-formulas", sourceLabel: FORMULA_LABEL, method, verify: true };
}

/** The built-in source. Always answers for duct families; pipe fittings return null (not calculated). */
export const FORMULA_SOURCE: CoefficientSource = {
  id: "builtin-formulas",
  label: "Built-in engineering correlations",
  kind: "formula",
  lookup(q) {
    const { family, params } = q;
    const angle = bendAngleFactor(q.angleDeg);
    switch (family.loss) {
      case "radius_elbow": {
        const ar = q.family.shapes.includes("round") && !q.family.shapes.includes("rect") ? 1 : bendAspectFactor(q.aspectRatio);
        return formulaValue(angle * bendRadiusFactor(q.rOverW) * ar, "own", `Smooth bend: angle factor ${angle.toFixed(3)} x radius factor at r/W ${q.rOverW.toFixed(2)} x aspect factor ${ar.toFixed(3)}`);
      }
      case "stamped_elbow": {
        const c90 = stampedElbow90(q.rOverW);
        return formulaValue(angle * c90, "own", `Die-stamped round elbow, ${c90.toFixed(3)} at 90° and r/D ${q.rOverW.toFixed(2)} (Locklin) x angle factor ${angle.toFixed(3)}`);
      }
      case "gored_elbow": {
        const gores = num(params, "gores", 5);
        const c90 = goredElbow90(gores, q.rOverW);
        return formulaValue(angle * c90, "own", `${gores}-piece round elbow, ${c90.toFixed(3)} at 90° and r/D ${q.rOverW.toFixed(2)} (Locklin) x angle factor ${angle.toFixed(3)}`);
      }
      case "mitred_elbow": {
        const ar = mitreAspectFactor(q.aspectRatio);
        return formulaValue(mitreCoefficient(q.angleDeg) * ar, "own", `Sharp bend at ${q.angleDeg.toFixed(0)}° (Weisbach x Idelchik angle multiplier) x aspect factor ${ar.toFixed(3)}`);
      }
      case "vaned_elbow": {
        const vanes = typeof params.vanes === "string" ? params.vanes : "single";
        const c90 = VANE_C90[vanes] ?? 0.15;
        return formulaValue(c90 * angle, "own", `Typical ${vanes}-wall turning vanes (${c90} at 90°) x angle factor ${angle.toFixed(3)}`);
      }
      case "transition":
        return formulaValue(
          transitionCoefficient(q.areaRatio, q.includedAngleDeg, q.expanding),
          "small_end",
          `Gradual ${q.expanding ? "expansion" : "contraction"}, area ratio ${q.areaRatio.toFixed(3)}, included angle ${q.includedAngleDeg.toFixed(1)}°`,
        );
      case "ogee_offset": {
        const one = bendAngleFactor(q.angleDeg) * bendRadiusFactor(q.rOverW) * bendAspectFactor(q.aspectRatio);
        return formulaValue(2 * one, "own", `Two ${q.angleDeg.toFixed(0)}° smooth bends at r/W ${q.rOverW.toFixed(2)}, no interaction credit`);
      }
      case "branch_takeoff": {
        const t = family.takeoff ?? { angleDeg: 90, entryFactor: 1 };
        const flow = q.diverging ? "" : " (joining flow uses the diverging form)";
        if (q.role === "branch") {
          return formulaValue(branchCoefficient(q.velocityRatio, t.angleDeg, t.entryFactor), "branch", `Takeoff branch, Vb/Vc ${q.velocityRatio.toFixed(3)}, ${t.angleDeg}° entry, entry factor ${t.entryFactor}${flow}`);
        }
        return formulaValue(mainCoefficient(q.velocityRatio), "upstream", `Takeoff straight-through, Vs/Vc ${q.velocityRatio.toFixed(3)}${flow}`);
      }
      case "cap":
        return formulaValue(0, "own", "Closed end: no flow");
      case "pipe_k": {
        const lOverD = family.pipe?.lOverD?.[q.role] ?? family.pipe?.lOverD?.body ?? 0;
        const fT = q.turbulentFrictionFactor ?? 0.02;
        return formulaValue(lOverD * fT, "own", `Typical equivalent length ${lOverD} diameters x turbulent friction factor ${fT.toFixed(4)}`);
      }
      case "not_calculated":
        return null;
    }
  },
};

// ------------------------------------------------------------------ engineer-entered tables

const entryVariable = (q: CoefficientQuery, v: NonNullable<CoefficientEntry["variable"]>): number => {
  switch (v) {
    case "r_over_w":
      return q.rOverW;
    case "angle_deg":
      return q.angleDeg;
    case "area_ratio":
      return q.areaRatio;
    case "velocity_ratio":
      return q.velocityRatio;
    case "aspect_ratio":
      return q.aspectRatio;
  }
};

/** C along a curve: linear between points, held at the first and last. */
export function interpolate(points: ReadonlyArray<{ readonly x: number; readonly c: number }>, x: number): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  if (x <= first.x) return first.c;
  if (x >= last.x) return last.c;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a && b && x <= b.x) return b.x === a.x ? b.c : a.c + ((b.c - a.c) * (x - a.x)) / (b.x - a.x);
  }
  return last.c;
}

/** The reference a family's coefficient uses, so table entries are read the same way as the formulas. */
export function referenceFor(family: FittingFamily, role: CoefficientRole): VpReference {
  if (family.loss === "transition") return "small_end";
  if (family.loss === "branch_takeoff") return role === "branch" ? "branch" : "upstream";
  return "own";
}

export const coefficientEntrySchema = z.object({
  family: z.string().min(1).max(80),
  role: z.enum(["body", "branch", "main"]),
  c: z.number().finite().min(0).max(100).optional(),
  variable: z.enum(["r_over_w", "angle_deg", "area_ratio", "velocity_ratio", "aspect_ratio"]).optional(),
  points: z.array(z.object({ x: z.number().finite(), c: z.number().finite().min(0).max(100) })).min(1).max(64).optional(),
  when: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  note: z.string().max(200).optional(),
});

export const coefficientTableSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  scope: z.enum(["firm", "project"]),
  entries: z.array(coefficientEntrySchema).max(500),
});

/** Why a table entry can't be used, or null. */
export function entryIssue(e: CoefficientEntry): string | null {
  if (e.c === undefined && !(e.variable && e.points && e.points.length > 0)) return `The ${e.family} ${e.role} entry needs a value, or a variable and points`;
  if (e.c !== undefined && e.points) return `The ${e.family} ${e.role} entry has both a value and points; keep one`;
  return null;
}

/** A source from a firm's or project's table. */
export function tableSource(table: CoefficientTable): CoefficientSource {
  const scope = table.scope === "firm" ? "Firm table" : "Project table";
  return {
    id: table.id,
    label: `${scope}: ${table.label}`,
    kind: "table",
    lookup(q) {
      for (const e of table.entries) {
        if (e.family !== q.family.id || e.role !== q.role) continue;
        if (e.when && Object.entries(e.when).some(([k, v]) => String(q.params[k]) !== String(v))) continue;
        const c = e.c ?? (e.variable && e.points ? interpolate(e.points, entryVariable(q, e.variable)) : null);
        if (c === null || c === undefined) continue;
        const how = e.variable ? `${scope} curve over ${e.variable.replace(/_/g, " ")}` : `${scope} value`;
        return { c, reference: referenceFor(q.family, q.role), sourceKind: "table", sourceId: table.id, sourceLabel: `${scope}: ${table.label}`, method: e.note ? `${how}: ${e.note}` : how, verify: false };
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------ licensed databases (interface and schema; no data)

/**
 * A licensed coefficient package as an importer hands it over: the vendor's
 * own fitting codes mapped to library families, with the licence it was
 * issued under. No package ships with MutinyBIM; a firm that holds a licence
 * supplies its own file and importer.
 */
export const licensedCoefficientPackageSchema = z.object({
  vendor: z.string().min(1).max(80),
  product: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  license: z.object({ holder: z.string().min(1).max(120), licenseId: z.string().min(1).max(120), expires: z.string().max(40).optional() }),
  fittings: z
    .array(
      coefficientEntrySchema.extend({
        /** The vendor's own fitting code; kept for traceability, never shown as ours. */
        vendorCode: z.string().min(1).max(80),
      }),
    )
    .max(20_000),
});
export type LicensedCoefficientPackage = z.infer<typeof licensedCoefficientPackageSchema>;

export interface LicensedCoefficientImporter {
  readonly vendor: string;
  /** Turn the vendor's export into a package, or throw with the reason it can't be read. */
  parse(raw: unknown): LicensedCoefficientPackage;
}

/** A source over an imported package. Expired licences are refused by the caller, which knows today's date. */
export function licensedSource(pkg: LicensedCoefficientPackage): CoefficientSource {
  const inner = tableSource({ id: `licensed:${pkg.vendor}:${pkg.version}`, label: `${pkg.product} ${pkg.version}`, scope: "firm", entries: pkg.fittings });
  return {
    id: inner.id,
    label: `Licensed: ${pkg.product} ${pkg.version} (${pkg.license.holder})`,
    kind: "licensed",
    lookup(q) {
      const v = inner.lookup(q);
      return v ? { ...v, sourceKind: "licensed", sourceLabel: `Licensed: ${pkg.product} ${pkg.version}` } : null;
    },
  };
}

// ------------------------------------------------------------------ resolution

function overrideValue(q: CoefficientQuery, o: CoefficientOverride): CoefficientValue {
  const day = o.at.slice(0, 10);
  return {
    c: o.c,
    reference: referenceFor(q.family, q.role),
    sourceKind: "override",
    sourceId: "override",
    sourceLabel: `Override by ${o.by}, ${day}`,
    method: o.note ? `Engineer's value: ${o.note}` : "Engineer's value",
    verify: false,
  };
}

/** The coefficient for one path through a fitting: override, then the sources in order, then the formulas. */
export function resolveCoefficient(q: CoefficientQuery, sources: readonly CoefficientSource[], override?: CoefficientOverride): CoefficientValue | null {
  if (override && override.role === q.role) return overrideValue(q, override);
  for (const s of sources) {
    const v = s.lookup(q);
    if (v) return v;
  }
  return FORMULA_SOURCE.lookup(q);
}
