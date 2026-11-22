import { elementsOfKind, hostVoidsOf, type BimElement, type ElementKindItem, type FacePair, type KindSolidShape, type PlanGraphic, type SectionGraphic, type SurfaceFaceRow, type Vec2 } from "@permitzip/bim-kernel";

/**
 * The Architecture add-on's own kinds: roofs and stairs.
 *
 * - `architecture.roof`: a footprint on a level with a thickness and an
 *   optional single-plane slope; it hosts skylights, hatches and rooftop
 *   units. Voids cut in it (`kernel.host_void`) are plan outlines in model
 *   coordinates; its body is left in blocks round them.
 * - `architecture.stair`: one straight run from its start to its end on a
 *   level, rising to the level above; risers and treads come from the
 *   level-to-level height (or the risers asked for).
 *
 * A roof's slope is one plane rising from its low edge (`roofPlane`); its
 * body is drawn pitched and its faces are offered to walls run to its
 * underside (`kernel.surface_face`). A footprint is drawn as its convex hull
 * when cut.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const ROOF_KIND = "architecture.roof";
export const STAIR_KIND = "architecture.stair";

/** Highest riser the stair tool picks when none is asked for, mm (7 in). */
export const MAX_RISER_MM = 178;
const DEFAULT_ROOF_THICKNESS_MM = 250;
const DEFAULT_STAIR_WIDTH_MM = 1100;

export type RoofForm = "flat" | "shed" | "gable" | "hip";

export interface RoofSlope {
  /** The way the roof rises, degrees counter-clockwise from east (for gable: perpendicular to the ridge). */
  readonly directionDeg: number;
  /** Rise per unit run (0.25 is 3 in 12; 0.5 is 6 in 12). */
  readonly rise: number;
}

export interface RoofRecord {
  readonly id: string;
  readonly kind: typeof ROOF_KIND;
  readonly levelId: string;
  readonly outline: readonly Vec2[];
  readonly thicknessMm: number;
  /** Bottom above the level, mm. */
  readonly baseOffsetMm: number;
  /** Roof form: flat, single-slope shed, two-slope gable, or four-slope hip. */
  readonly form?: RoofForm;
  readonly slope?: RoofSlope;
}

export type StairForm = "straight" | "l_shape" | "u_shape";
export type StairTurn = "left" | "right";

export interface StairRecord {
  readonly id: string;
  readonly kind: typeof STAIR_KIND;
  readonly levelId: string;
  /** The level it rises to. Absent: the next level up. */
  readonly topLevelId?: string;
  /** Foot of the run and the top nosing line's centre, in plan (for L/U stairs: foot and direction of Flight 1). */
  readonly start: Vec2;
  readonly end: Vec2;
  readonly widthMm: number;
  /** Risers asked for. Absent: the fewest that keep each riser at most `MAX_RISER_MM`. */
  readonly risers?: number;
  /** Stair configuration: straight, 90° quarter-turn L-shape with landing, or 180° U-shape switchback (high-rise core). */
  readonly form?: StairForm;
  /** Turn direction at the landing when climbing (`left` = CCW, `right` = CW). Default: `right`. */
  readonly turn?: StairTurn;
  /** Clear landing depth along the run direction (IBC min = stair width, >= 1120 mm). */
  readonly landingDepthMm?: number;
  /** Open stairwell gap between parallel switchback flights (U-shape), mm. Default: 150 mm. */
  readonly wellGapMm?: number;
}

export interface StairFlightLayout {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly u: Vec2;
  /** Unit normal pointing to the left of travel direction `u`. */
  readonly n: Vec2;
  readonly widthMm: number;
  readonly runMm: number;
  readonly z0: number;
  readonly z1: number;
  readonly risers: number;
  readonly treads: number;
  readonly riserMm: number;
  readonly treadMm: number;
}

export interface StairLandingLayout {
  readonly outline: readonly Vec2[];
  readonly zTop: number;
  readonly zBot: number;
  /** Perimeter edges of the landing not attached to a flight (for 3D guardrails). */
  readonly openEdges: readonly (readonly [Vec2, Vec2])[];
}

export interface StairLayout {
  readonly form: StairForm;
  readonly flights: readonly StairFlightLayout[];
  readonly landings: readonly StairLandingLayout[];
  /** Continuous centerline walk path across all flights and landings. */
  readonly walkPath: readonly Vec2[];
}

const STAIR_FORM_SET = new Set<string>(["straight", "l_shape", "u_shape"]);
const STAIR_TURN_SET = new Set<string>(["left", "right"]);

const isVec = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const ROOF_FORM_SET = new Set<string>(["flat", "shed", "gable", "hip"]);

/** A stored record as a roof, or null when it isn't one in this shape (kept as stored). */
export function asRoof(el: BimElement): RoofRecord | null {
  const r: Record<string, unknown> = { ...el };
  if (r.kind !== ROOF_KIND || typeof r.levelId !== "string" || !Array.isArray(r.outline) || !r.outline.every(isVec) || num(r.thicknessMm) === null) return null;
  const slope = r.slope;
  const okSlope = typeof slope === "object" && slope !== null && num((slope as { directionDeg?: unknown }).directionDeg) !== null && num((slope as { rise?: unknown }).rise) !== null;
  const rawForm = typeof r.form === "string" ? r.form.toLowerCase() : undefined;
  const form = rawForm && ROOF_FORM_SET.has(rawForm) ? (rawForm as RoofForm) : undefined;
  return { id: el.id, kind: ROOF_KIND, levelId: r.levelId, outline: r.outline, thicknessMm: num(r.thicknessMm) ?? 0, baseOffsetMm: num(r.baseOffsetMm) ?? 0, ...(form ? { form } : {}), ...(okSlope ? { slope: slope as RoofSlope } : {}) };
}

/** A stored record as a stair, or null. */
export function asStair(el: BimElement): StairRecord | null {
  const r: Record<string, unknown> = { ...el };
  if (r.kind !== STAIR_KIND || typeof r.levelId !== "string" || !isVec(r.start) || !isVec(r.end) || num(r.widthMm) === null) return null;
  const risers = num(r.risers);
  const vals = typeof r.values === "object" && r.values !== null ? (r.values as Record<string, unknown>) : undefined;
  const rawForm = typeof vals?.["architecture.stair_form"] === "string" ? String(vals["architecture.stair_form"]).toLowerCase() : typeof r.form === "string" ? r.form.toLowerCase() : undefined;
  const form = rawForm && STAIR_FORM_SET.has(rawForm) ? (rawForm as StairForm) : undefined;
  const rawTurn = typeof vals?.["architecture.stair_turn"] === "string" ? String(vals["architecture.stair_turn"]).toLowerCase() : typeof r.turn === "string" ? r.turn.toLowerCase() : undefined;
  const turn = rawTurn && STAIR_TURN_SET.has(rawTurn) ? (rawTurn as StairTurn) : undefined;
  const landingDepthMm = num(vals?.["architecture.landing_depth_mm"]) ?? num(r.landingDepthMm);
  const wellGapMm = num(vals?.["architecture.well_gap_mm"]) ?? num(r.wellGapMm);
  return {
    id: el.id,
    kind: STAIR_KIND,
    levelId: r.levelId,
    start: r.start,
    end: r.end,
    widthMm: num(r.widthMm) ?? 0,
    ...(typeof r.topLevelId === "string" ? { topLevelId: r.topLevelId } : {}),
    ...(risers !== null && risers >= 2 ? { risers: Math.round(risers) } : {}),
    ...(form ? { form } : {}),
    ...(turn ? { turn } : {}),
    ...(landingDepthMm !== null && landingDepthMm > 0 ? { landingDepthMm } : {}),
    ...(wellGapMm !== null && wellGapMm >= 0 ? { wellGapMm } : {}),
  };
}

function elevationOf(elements: Elements, levelId: string): number | null {
  const l = elements[levelId];
  return l?.kind === "level" ? l.elevationMm : null;
}

/** The level just above `levelId`, or null when it is the top one. */
function levelAbove(elements: Elements, levelId: string): string | null {
  const z = elevationOf(elements, levelId);
  if (z === null) return null;
  let best: { id: string; z: number } | null = null;
  for (const l of elementsOfKind(elements, "level")) if (l.elevationMm > z && (!best || l.elevationMm < best.z)) best = { id: l.id, z: l.elevationMm };
  return best?.id ?? null;
}

/** How a stair climbs: from its level to the one above. Null when it has nowhere to rise to. */
export interface StairGeometry {
  readonly heightMm: number;
  readonly runMm: number;
  readonly risers: number;
  readonly riserMm: number;
  readonly treads: number;
  readonly treadMm: number;
  readonly topLevelId: string;
}

export function stairGeometry(s: StairRecord, elements: Elements): StairGeometry | null {
  const topLevelId = s.topLevelId ?? levelAbove(elements, s.levelId);
  const z0 = elevationOf(elements, s.levelId);
  const z1 = topLevelId ? elevationOf(elements, topLevelId) : null;
  if (!topLevelId || z0 === null || z1 === null || z1 <= z0) return null;
  const heightMm = z1 - z0;
  const runMm = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y);
  const risers = s.risers ?? Math.max(2, Math.ceil(heightMm / MAX_RISER_MM));
  const treads = risers - 1;
  return { heightMm, runMm, risers, riserMm: heightMm / risers, treads, treadMm: runMm / treads, topLevelId };
}

/**
 * Resolve every flight, landing platform, guardrail edge, and continuous walk
 * path for a straight, 90° L-shape, or 180° U-shape switchback stair.
 */
export function stairLayout(s: StairRecord, g: StairGeometry, z0: number): StairLayout {
  const form: StairForm = s.form ?? "straight";
  const w = s.widthMm;
  const halfW = w / 2;
  const waistMm = 215;
  const dx = s.end.x - s.start.x;
  const dy = s.end.y - s.start.y;
  const dist = Math.hypot(dx, dy);
  const u: Vec2 = dist > 1e-6 ? { x: dx / dist, y: dy / dist } : { x: 1, y: 0 };
  const nL: Vec2 = { x: -u.y, y: u.x };
  const turnSign = s.turn === "left" ? 1 : -1;
  const nT: Vec2 = { x: nL.x * turnSign, y: nL.y * turnSign };
  const add = (p: Vec2, v: Vec2, k = 1): Vec2 => ({ x: p.x + v.x * k, y: p.y + v.y * k });
  const z1 = z0 + g.heightMm;

  // 1. Classic single-flight straight stair (100% identical to legacy geometry for IFC round-trips)
  if (form === "straight" && !(s.landingDepthMm && s.landingDepthMm > 0)) {
    const flight: StairFlightLayout = {
      start: s.start,
      end: s.end,
      u,
      n: nL,
      widthMm: w,
      runMm: g.runMm,
      z0,
      z1,
      risers: g.risers,
      treads: g.treads,
      riserMm: g.riserMm,
      treadMm: g.treadMm,
    };
    return { form, flights: [flight], landings: [], walkPath: [s.start, s.end] };
  }

  // Shared two-flight split (exact equal risers across Flight 1 + landing + Flight 2)
  const r1 = Math.max(2, Math.ceil(g.risers / 2));
  const r2 = Math.max(2, g.risers - r1);
  const t1 = Math.max(1, r1 - 1);
  const t2 = Math.max(1, r2 - 1);
  const riserMm = g.heightMm / (r1 + r2);
  const zMid = z0 + r1 * riserMm;
  const landingD = Math.max(s.landingDepthMm ?? Math.max(w, 1120), w);

  // 2. Straight stair with mid-flight rest landing
  if (form === "straight") {
    const treadMm = Math.max(280, (Math.max(dist, (t1 + t2) * 280 + landingD) - landingD) / (t1 + t2));
    const run1 = t1 * treadMm;
    const run2 = t2 * treadMm;
    const f1End = add(s.start, u, run1);
    const f2Start = add(f1End, u, landingD);
    const f2End = add(f2Start, u, run2);
    const cA = add(f1End, nL, halfW);
    const cB = add(f1End, nL, -halfW);
    const cC = add(f2Start, nL, -halfW);
    const cD = add(f2Start, nL, halfW);
    return {
      form,
      flights: [
        { start: s.start, end: f1End, u, n: nL, widthMm: w, runMm: run1, z0, z1: zMid, risers: r1, treads: t1, riserMm, treadMm },
        { start: f2Start, end: f2End, u, n: nL, widthMm: w, runMm: run2, z0: zMid, z1, risers: r2, treads: t2, riserMm, treadMm },
      ],
      landings: [{ outline: [cA, cB, cC, cD], zTop: zMid, zBot: zMid - waistMm, openEdges: [[cB, cC], [cD, cA]] }],
      walkPath: [s.start, f1End, f2Start, f2End],
    };
  }

  // Shared tread depth for L-shape & U-shape flights (IBC 280 mm minimum, respects Flight 1 span when larger)
  const treadMm = Math.max(280, Math.min(330, dist > 1 ? dist / t1 : 280));
  const run1 = t1 * treadMm;
  const run2 = t2 * treadMm;
  const f1End = add(s.start, u, run1);

  // 3. 90° Quarter-turn L-shape stair with square corner landing
  if (form === "l_shape") {
    const cA = add(f1End, nT, -halfW);
    const cB = add(f1End, nT, halfW);
    const cC = add(cB, u, landingD);
    const cD = add(cA, u, landingD);
    const u2 = nT;
    const n2: Vec2 = { x: -u2.y, y: u2.x };
    const landMid = add(f1End, u, landingD / 2);
    const f2Start = add(landMid, nT, halfW);
    const f2End = add(f2Start, u2, run2);
    return {
      form,
      flights: [
        { start: s.start, end: f1End, u, n: nL, widthMm: w, runMm: run1, z0, z1: zMid, risers: r1, treads: t1, riserMm, treadMm },
        { start: f2Start, end: f2End, u: u2, n: n2, widthMm: w, runMm: run2, z0: zMid, z1, risers: r2, treads: t2, riserMm, treadMm },
      ],
      landings: [{ outline: [cA, cB, cC, cD], zTop: zMid, zBot: zMid - waistMm, openEdges: [[cC, cD], [cD, cA]] }],
      walkPath: [s.start, f1End, landMid, f2Start, f2End],
    };
  }

  // 4. 180° Switchback U-shape stair (commercial / high-rise egress core & architectural residence)
  const wellGap = Math.max(0, s.wellGapMm ?? 150);
  const cA = add(f1End, nT, -halfW);
  const cB = add(f1End, nT, halfW + wellGap + w);
  const cC = add(cB, u, landingD);
  const cD = add(cA, u, landingD);
  const u2: Vec2 = { x: -u.x, y: -u.y };
  const n2: Vec2 = { x: -u2.y, y: u2.x };
  const f2Start = add(f1End, nT, w + wellGap);
  const f2End = add(f2Start, u2, run2);
  const gapA = add(f1End, nT, halfW);
  const gapB = add(f1End, nT, halfW + wellGap);
  const openEdges: Array<readonly [Vec2, Vec2]> = [[cB, cC], [cC, cD], [cD, cA]];
  if (wellGap > 20) openEdges.push([gapA, gapB]);
  const landMid1 = add(f1End, u, landingD / 2);
  const landMid2 = add(f2Start, u, landingD / 2);
  return {
    form,
    flights: [
      { start: s.start, end: f1End, u, n: nL, widthMm: w, runMm: run1, z0, z1: zMid, risers: r1, treads: t1, riserMm, treadMm },
      { start: f2Start, end: f2End, u: u2, n: n2, widthMm: w, runMm: run2, z0: zMid, z1, risers: r2, treads: t2, riserMm, treadMm },
    ],
    landings: [{ outline: [cA, cB, cC, cD], zTop: zMid, zBot: zMid - waistMm, openEdges }],
    walkPath: [s.start, f1End, landMid1, landMid2, f2Start, f2End],
  };
}

// ── geometry ────────────────────────────────────────────────────────────────

function hull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A convex polygon clipped to `axis` (x or y) between `lo` and `hi`. */
function clip(poly: readonly Vec2[], axis: "x" | "y", lo: number, hi: number): Vec2[] {
  const half = (pts: readonly Vec2[], keep: (p: Vec2) => number): Vec2[] => {
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as Vec2;
      const b = pts[(i + 1) % pts.length] as Vec2;
      const da = keep(a);
      const db = keep(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  };
  return half(half(poly, (p) => p[axis] - lo), (p) => hi - p[axis]);
}

function area(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

const boxOf = (pts: readonly Vec2[]): Box => ({ x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) });

/** The footprint's hull left in blocks round the voids' boxes: strips across x, each broken in y where a void sits. */
export function roofBlocks(outline: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Vec2[][] {
  const fp = hull(outline);
  if (holes.length === 0) return [fp];
  const boxes = holes.map(boxOf).sort((a, b) => a.x0 - b.x0);
  const cuts = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  const xs = [-Infinity, ...cuts, Infinity];
  const out: Vec2[][] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i] as number;
    const hi = xs[i + 1] as number;
    const strip = clip(fp, "x", lo, hi);
    if (area(strip) < 1e-6) continue;
    const mid = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo + 1 : hi - 1;
    const inside = boxes.filter((b) => b.x0 < mid && b.x1 > mid).sort((a, b) => a.y0 - b.y0);
    let y = -Infinity;
    for (const b of inside) {
      const piece = clip(strip, "y", y, b.y0);
      if (area(piece) > 1e-6) out.push(piece);
      y = Math.max(y, b.y1);
    }
    const last = clip(strip, "y", y, Infinity);
    if (area(last) > 1e-6) out.push(last);
  }
  return out;
}

const centroid = (pts: readonly Vec2[]): Vec2 => ({ x: pts.reduce((s, p) => s + p.x, 0) / Math.max(1, pts.length), y: pts.reduce((s, p) => s + p.y, 0) / Math.max(1, pts.length) });

// ── rows ────────────────────────────────────────────────────────────────────

export const ROOF_KIND_ROW: ElementKindItem = {
  kind: ROOF_KIND,
  label: "Roof",
  nature: "physical",
  newForOlderPeers: true,
  shape: { fields: [{ name: "levelId", form: "id" }, { name: "outline", form: "points" }, { name: "thicknessMm", form: "number" }, { name: "baseOffsetMm", form: "number", optional: true }, { name: "form", form: "string", optional: true }, { name: "slope", form: "architecture.slope", optional: true }], points: (el) => asRoof(el)?.outline ?? [] },
  anchor: (el) => {
    const r = asRoof(el);
    return r ? centroid(r.outline) : null;
  },
  create: {
    placements: ["area"],
    make(input, elements) {
      if (input.placement.kind !== "area") return { refused: "A roof is drawn as an area: click its corners" };
      const thicknessMm = input.size?.thicknessMm ?? DEFAULT_ROOF_THICKNESS_MM;
      const rise = num(input.values?.["architecture.slope_rise"]) ?? num(input.values?.["architecture.roof_slope_rise"]);
      const directionDeg = num(input.values?.["architecture.slope_direction_deg"]) ?? num(input.values?.["architecture.roof_slope_direction_deg"]) ?? 90;
      const baseOffsetMm = num(input.values?.["architecture.base_offset_mm"]) ?? 0;
      const rawForm = typeof input.values?.["architecture.roof_form"] === "string" ? input.values["architecture.roof_form"].toLowerCase() : undefined;
      const form = rawForm && ROOF_FORM_SET.has(rawForm) ? (rawForm as RoofForm) : undefined;
      const effectiveRise = rise !== null && rise !== 0 ? rise : form === "gable" || form === "hip" ? 0.5 : null;
      const roof: RoofRecord = {
        id: input.id,
        kind: ROOF_KIND,
        levelId: input.levelId,
        outline: input.placement.outline,
        thicknessMm,
        baseOffsetMm,
        ...(form ? { form } : {}),
        ...(effectiveRise !== null ? { slope: { directionDeg, rise: effectiveRise } } : {}),
      };
      const lvl = elements[input.levelId];
      const levelName = lvl?.kind === "level" ? lvl.name : input.levelId;
      return { ...roof, ...(input.values ? { values: input.values } : {}), partition: { level: levelName, zone: "*", discipline: "architecture" }, version: 0, authoredRev: {} } as unknown as BimElement;
    },
  },
  planGraphics(el, ctx) {
    const r = asRoof(el);
    if (!r || r.levelId !== ctx.levelId) return null;
    const out: PlanGraphic[] = [{ form: "polyline", points: r.outline, closed: true, pen: "medium" }];
    for (const v of hostVoidsOf(ctx.elements, el.id)) out.push({ form: "polyline", points: v.profile, closed: true, pen: "thin" });
    const form = roofFormOf(r);
    if (form === "gable" && r.slope) {
      const g = gableSpec(r);
      if (g) {
        out.push({ form: "line", a: g.ridgeA, b: g.ridgeB, pen: "medium" });
        const c = centroid(r.outline);
        out.push({ form: "text", at: c, text: `${Math.round(r.slope.rise * 12 * 10) / 10} in 12`, heightMm: 2, rotationDeg: 0, anchor: "middle" });
      }
    } else if (form === "hip" && r.slope) {
      const hp = hipPlanes(r);
      if (hp) {
        for (const edge of hp.ridges) out.push({ form: "line", a: edge[0], b: edge[1], pen: "medium" });
        out.push({ form: "text", at: centroid(r.outline), text: `${Math.round(r.slope.rise * 12 * 10) / 10} in 12`, heightMm: 2, rotationDeg: 0, anchor: "middle" });
      }
    } else if (r.slope) {
      const c = centroid(r.outline);
      const a = (r.slope.directionDeg * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const tip = { x: c.x + dx * 1200, y: c.y + dy * 1200 };
      const nx = -dy;
      const ny = dx;
      // Crisp slope arrow + offset pitch callout text (never colliding with the shaft)
      out.push({ form: "line", a: c, b: tip, pen: "thin" });
      out.push({ form: "line", a: { x: tip.x - dx * 220 + nx * 130, y: tip.y - dy * 220 + ny * 130 }, b: tip, pen: "thin" });
      out.push({ form: "line", a: { x: tip.x - dx * 220 - nx * 130, y: tip.y - dy * 220 - ny * 130 }, b: tip, pen: "thin" });
      out.push({ form: "text", at: { x: c.x - dx * 380, y: c.y - dy * 380 }, text: `${Math.round(r.slope.rise * 12 * 10) / 10} in 12`, heightMm: 2.2, rotationDeg: 0, anchor: "middle" });
    }
    return out;
  },
  solid(el, ctx) {
    const r = asRoof(el);
    if (!r) return null;
    const z0 = (elevationOf(ctx.elements, r.levelId) ?? ctx.floorMm) + r.baseOffsetMm;
    const form = roofFormOf(r);
    if (form === "gable" && r.slope) {
      const g = gableSpec(r);
      if (g) {
        const blocks: { outline: Vec2[]; z0: number; z1: number; tilt0: { at: Vec2; rise: Vec2 }; tilt1: { at: Vec2; rise: Vec2 } }[] = [];
        for (const half of [g.negHalf, g.posHalf]) {
          if (half.poly.length < 3 || area(half.poly) < 1e-3) continue;
          const tilt = { at: half.low, rise: half.rise };
          blocks.push({ outline: half.poly, z0, z1: z0 + r.thicknessMm, tilt0: tilt, tilt1: tilt });
        }
        if (blocks.length > 0) return { form: "prisms", blocks, category: "structure", role: "architecture" };
      }
    }
    if (form === "hip" && r.slope) {
      const hp = hipPlanes(r);
      if (hp) {
        const blocks = hp.faces
          .filter((f) => f.poly.length >= 3 && area(f.poly) > 1e-3)
          .map((f) => {
            const tilt = { at: f.low, rise: f.rise };
            return { outline: f.poly, z0, z1: z0 + r.thicknessMm, tilt0: tilt, tilt1: tilt };
          });
        if (blocks.length > 0) return { form: "prisms", blocks, category: "structure", role: "architecture" };
      }
    }
    // Single-slope shed or flat roof.
    const plane = roofPlane(r);
    const tilt = plane ? { at: plane.low, rise: plane.rise } : undefined;
    const blocks = roofBlocks(
      r.outline,
      hostVoidsOf(ctx.elements, el.id).map((v) => v.profile),
    ).map((outline) => ({ outline, z0, z1: z0 + r.thicknessMm, ...(tilt ? { tilt0: tilt, tilt1: tilt } : {}) }));
    const shape: KindSolidShape = { form: "prisms", blocks, category: "structure", role: "architecture" };
    return shape;
  },
};

function roofFormOf(r: RoofRecord): RoofForm {
  if (r.form) return r.form;
  return r.slope && r.slope.rise !== 0 ? "shed" : "flat";
}

function clipHalfPlane(poly: readonly Vec2[], keep: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const da = keep(a);
    const db = keep(b);
    if (da >= -1e-6) out.push(a);
    if ((da >= 0) !== (db >= 0) && Math.abs(da - db) > 1e-9) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function gableSpec(r: RoofRecord): {
  readonly u: Vec2;
  readonly sMid: number;
  readonly ridgeA: Vec2;
  readonly ridgeB: Vec2;
  readonly negHalf: { readonly poly: Vec2[]; readonly low: Vec2; readonly rise: Vec2 };
  readonly posHalf: { readonly poly: Vec2[]; readonly low: Vec2; readonly rise: Vec2 };
} | null {
  if (!r.slope || r.slope.rise === 0 || r.outline.length < 3) return null;
  const fp = hull(r.outline);
  const a = (r.slope.directionDeg * Math.PI) / 180;
  const u = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -u.y, y: u.x };
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const p of fp) {
    const s = p.x * u.x + p.y * u.y;
    const t = p.x * n.x + p.y * n.y;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (sMax - sMin < 1) return null;
  const sMid = (sMin + sMax) / 2;
  const pt = (s: number, t: number): Vec2 => ({ x: u.x * s + n.x * t, y: u.y * s + n.y * t });
  const negPoly = clipHalfPlane(fp, (p) => sMid - (p.x * u.x + p.y * u.y));
  const posPoly = clipHalfPlane(fp, (p) => (p.x * u.x + p.y * u.y) - sMid);
  return {
    u,
    sMid,
    ridgeA: pt(sMid, tMin),
    ridgeB: pt(sMid, tMax),
    negHalf: { poly: negPoly, low: pt(sMin, (tMin + tMax) / 2), rise: { x: u.x * r.slope.rise, y: u.y * r.slope.rise } },
    posHalf: { poly: posPoly, low: pt(sMax, (tMin + tMax) / 2), rise: { x: -u.x * r.slope.rise, y: -u.y * r.slope.rise } },
  };
}

function hipPlanes(r: RoofRecord): {
  readonly faces: readonly { readonly poly: Vec2[]; readonly low: Vec2; readonly rise: Vec2 }[];
  readonly ridges: readonly (readonly [Vec2, Vec2])[];
  readonly heightAt: (p: Vec2) => number;
} | null {
  if (!r.slope || r.slope.rise === 0 || r.outline.length < 3) return null;
  const b = boxOf(r.outline);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w < 1 || h < 1) return null;
  const inset = Math.min(w, h) / 2;
  const rise = r.slope.rise;
  const bl: Vec2 = { x: b.x0, y: b.y0 };
  const br: Vec2 = { x: b.x1, y: b.y0 };
  const tr: Vec2 = { x: b.x1, y: b.y1 };
  const tl: Vec2 = { x: b.x0, y: b.y1 };
  const faces: { poly: Vec2[]; low: Vec2; rise: Vec2 }[] = [];
  const ridges: [Vec2, Vec2][] = [];
  if (w >= h) {
    const rL: Vec2 = { x: b.x0 + inset, y: (b.y0 + b.y1) / 2 };
    const rR: Vec2 = { x: b.x1 - inset, y: (b.y0 + b.y1) / 2 };
    faces.push(
      { poly: [bl, br, rR, rL], low: bl, rise: { x: 0, y: rise } },
      { poly: [tr, tl, rL, rR], low: tr, rise: { x: 0, y: -rise } },
      { poly: [tl, bl, rL], low: bl, rise: { x: rise, y: 0 } },
      { poly: [br, tr, rR], low: br, rise: { x: -rise, y: 0 } },
    );
    ridges.push([rL, rR], [bl, rL], [tl, rL], [br, rR], [tr, rR]);
  } else {
    const rB: Vec2 = { x: (b.x0 + b.x1) / 2, y: b.y0 + inset };
    const rT: Vec2 = { x: (b.x0 + b.x1) / 2, y: b.y1 - inset };
    faces.push(
      { poly: [tl, bl, rB, rT], low: bl, rise: { x: rise, y: 0 } },
      { poly: [br, tr, rT, rB], low: br, rise: { x: -rise, y: 0 } },
      { poly: [bl, br, rB], low: bl, rise: { x: 0, y: rise } },
      { poly: [tr, tl, rT], low: tr, rise: { x: 0, y: -rise } },
    );
    ridges.push([rB, rT], [bl, rB], [br, rB], [tl, rT], [tr, rT]);
  }
  const heightAt = (p: Vec2): number => {
    const dEdge = Math.min(Math.max(0, p.x - b.x0), Math.max(0, b.x1 - p.x), Math.max(0, p.y - b.y0), Math.max(0, b.y1 - p.y));
    return dEdge * rise;
  };
  return { faces, ridges, heightAt };
}

/**
 * A roof's slope as a plane: its underside is `baseOffsetMm` above its level
 * along its low edge (the footprint's corner furthest down the slope) and
 * rises `rise` per unit run toward `directionDeg`. Null when flat.
 */
export function roofPlane(r: RoofRecord): { readonly low: Vec2; readonly rise: Vec2 } | null {
  if (!r.slope || r.slope.rise === 0 || r.outline.length === 0) return null;
  const a = (r.slope.directionDeg * Math.PI) / 180;
  const u = { x: Math.cos(a), y: Math.sin(a) };
  let low = r.outline[0] as Vec2;
  for (const p of r.outline) if (p.x * u.x + p.y * u.y < low.x * u.x + low.y * u.y) low = p;
  return { low, rise: { x: u.x * r.slope.rise, y: u.y * r.slope.rise } };
}

/** A roof's underside and top at a plan point, mm above project zero (supports flat, shed, gable, and hip). */
export function roofFaceAt(r: RoofRecord, elements: Elements, p: Vec2): FacePair | null {
  const level = elevationOf(elements, r.levelId);
  if (level === null) return null;
  const form = roofFormOf(r);
  if (form === "gable" && r.slope) {
    const g = gableSpec(r);
    if (g) {
      const s = p.x * g.u.x + p.y * g.u.y;
      const half = s <= g.sMid ? g.negHalf : g.posHalf;
      const underside = level + r.baseOffsetMm + half.rise.x * (p.x - half.low.x) + half.rise.y * (p.y - half.low.y);
      return { underside, top: underside + r.thicknessMm };
    }
  }
  if (form === "hip" && r.slope) {
    const hp = hipPlanes(r);
    if (hp) {
      const underside = level + r.baseOffsetMm + hp.heightAt(p);
      return { underside, top: underside + r.thicknessMm };
    }
  }
  const plane = roofPlane(r);
  const underside = level + r.baseOffsetMm + (plane ? plane.rise.x * (p.x - plane.low.x) + plane.rise.y * (p.y - plane.low.y) : 0);
  return { underside, top: underside + r.thicknessMm };
}

/** Roofs offer their faces (`kernel.surface_face`): a wall runs to a roof's underside, sloped or flat; a parapet stands on its top. */
export const ROOF_SURFACE_FACE_ROW: SurfaceFaceRow = {
  kind: ROOF_KIND,
  label: "Roof",
  role: "roof",
  footprint: (el) => {
    const r = asRoof(el);
    return r && r.outline.length >= 3 ? r.outline : null;
  },
  faceAt(el, elements, p) {
    const r = asRoof(el);
    return r ? roofFaceAt(r, elements, p) : null;
  },
};

export const STAIR_KIND_ROW: ElementKindItem = {
  kind: STAIR_KIND,
  label: "Stair",
  nature: "physical",
  newForOlderPeers: true,
  spansLevels: true,
  shape: {
    fields: [
      { name: "levelId", form: "id" },
      { name: "start", form: "point" },
      { name: "end", form: "point" },
      { name: "widthMm", form: "number" },
      { name: "topLevelId", form: "id", optional: true },
      { name: "risers", form: "number", optional: true },
      { name: "form", form: "string", optional: true },
      { name: "turn", form: "string", optional: true },
      { name: "landingDepthMm", form: "number", optional: true },
      { name: "wellGapMm", form: "number", optional: true },
    ],
    points: (el) => { const s = asStair(el); return s ? [s.start, s.end] : []; },
  },
  create: {
    placements: ["line"],
    make(input, elements) {
      if (input.placement.kind !== "line") return { refused: "A stair is drawn as a run: click its foot, then its top" };
      const top = typeof input.values?.["architecture.top_level"] === "string" ? String(input.values["architecture.top_level"]) : undefined;
      const risers = num(input.values?.["architecture.risers"]);
      const rawForm = typeof input.values?.["architecture.stair_form"] === "string" ? String(input.values["architecture.stair_form"]).toLowerCase() : undefined;
      const form = rawForm && STAIR_FORM_SET.has(rawForm) ? (rawForm as StairForm) : undefined;
      const rawTurn = typeof input.values?.["architecture.stair_turn"] === "string" ? String(input.values["architecture.stair_turn"]).toLowerCase() : undefined;
      const turn = rawTurn && STAIR_TURN_SET.has(rawTurn) ? (rawTurn as StairTurn) : undefined;
      const landingDepthMm = num(input.values?.["architecture.landing_depth_mm"]);
      const wellGapMm = num(input.values?.["architecture.well_gap_mm"]);
      const rawStair: StairRecord = {
        id: input.id,
        kind: STAIR_KIND,
        levelId: input.levelId,
        start: input.placement.start,
        end: input.placement.end,
        widthMm: input.size?.widthMm ?? DEFAULT_STAIR_WIDTH_MM,
        ...(top !== undefined ? { topLevelId: top } : {}),
        ...(risers !== null ? { risers: Math.round(risers) } : {}),
        ...(form ? { form } : {}),
        ...(turn ? { turn } : {}),
        ...(landingDepthMm !== null && landingDepthMm > 0 ? { landingDepthMm } : {}),
        ...(wellGapMm !== null && wellGapMm >= 0 ? { wellGapMm } : {}),
      };
      const geom = stairGeometry(rawStair, elements);
      if (!geom) return { refused: "A stair rises to the level above, and this level has none; add a level above or pick the level it rises to" };
      // IBC / IRC code guard: for straight single-flight stairs, extend run if tread < 240 mm (L/U stairs size each flight automatically in stairLayout).
      let end = input.placement.end;
      if ((!form || form === "straight") && !(landingDepthMm && landingDepthMm > 0) && geom.runMm > 1 && geom.treadMm < 240) {
        const minRun = geom.treads * 280;
        const dx = end.x - rawStair.start.x;
        const dy = end.y - rawStair.start.y;
        const s = minRun / geom.runMm;
        end = { x: Math.round(rawStair.start.x + dx * s), y: Math.round(rawStair.start.y + dy * s) };
      }
      const stair: StairRecord = { ...rawStair, end };
      const lvl = elements[input.levelId];
      const levelName = lvl?.kind === "level" ? lvl.name : input.levelId;
      return { ...stair, ...(input.values ? { values: input.values } : {}), partition: { level: levelName, zone: "*", discipline: "architecture" }, version: 0, authoredRev: {} } as unknown as BimElement;
    },
  },
  planGraphics(el, ctx) {
    const s = asStair(el);
    const g = s ? stairGeometry(s, ctx.elements) : null;
    if (!s || !g) return null;
    const isBottom = s.levelId === ctx.levelId;
    const isTop = g.topLevelId === ctx.levelId;
    if (!isBottom && !isTop) return null;
    const z0 = elevationOf(ctx.elements, s.levelId) ?? 0;
    const layout = stairLayout(s, g, z0);
    const out: PlanGraphic[] = [];
    const halfW = s.widthMm / 2;

    const flightAt = (f: StairFlightLayout, d: number, side: number): Vec2 => ({
      x: f.start.x + f.u.x * d + f.n.x * halfW * side,
      y: f.start.y + f.u.y * d + f.n.y * halfW * side,
    });

    // 1. Opaque white masks + outer carriage/stringer outlines for landings and flights
    for (const land of layout.landings) {
      out.push({
        form: "polyline",
        points: [...land.outline],
        closed: true,
        pen: "medium",
        fill: "#ffffff",
        ...(isBottom ? { tone: "halftone" as const } : {}),
      });
    }
    for (let fi = 0; fi < layout.flights.length; fi++) {
      const f = layout.flights[fi]!;
      const halftoneFlight = isBottom && fi > 0;
      out.push({
        form: "polyline",
        points: [flightAt(f, 0, 1), flightAt(f, f.runMm, 1), flightAt(f, f.runMm, -1), flightAt(f, 0, -1)],
        closed: true,
        pen: "medium",
        fill: "#ffffff",
        ...(halftoneFlight ? { tone: "halftone" as const } : {}),
      });
    }

    // 2. Treads (plus AIA angled zigzag cut break on bottom-floor Flight 1)
    const f0 = layout.flights[0]!;
    const fLast = layout.flights[layout.flights.length - 1]!;
    const multiFlight = layout.flights.length > 1;
    const arrowLen = Math.min(240, f0.treadMm * 0.9);
    const arrowSide = Math.min(0.28, 160 / Math.max(1, halfW));

    for (let fi = 0; fi < layout.flights.length; fi++) {
      const f = layout.flights[fi]!;
      if (isTop) {
        for (let i = 1; i < f.treads; i++) {
          const d = i * f.treadMm;
          out.push({ form: "line", a: flightAt(f, d, 1), b: flightAt(f, d, -1), pen: "thin" });
        }
      } else if (fi === 0) {
        const cutRatio = multiFlight ? 0.68 : 0.48;
        const cutD = f.runMm * cutRatio;
        const skew = Math.min(halfW * 0.42, f.treadMm * 1.0);
        for (let i = 1; i < f.treads; i++) {
          const d = i * f.treadMm;
          const aboveCut = d > cutD + skew * 0.5;
          out.push({ form: "line", a: flightAt(f, d, 1), b: flightAt(f, d, -1), pen: "thin", ...(aboveCut ? { tone: "halftone" as const } : {}) });
        }
        const zig = Math.min(90, f.treadMm * 0.35);
        out.push({
          form: "polyline",
          points: [
            flightAt(f, cutD - skew, -1.08),
            flightAt(f, cutD - zig * 0.6, -0.15),
            flightAt(f, cutD + zig * 0.8, 0.05),
            flightAt(f, cutD - zig * 0.8, 0.15),
            flightAt(f, cutD + skew, 1.08),
          ],
          closed: false,
          pen: "medium",
        });
      } else {
        for (let i = 1; i < f.treads; i++) {
          const d = i * f.treadMm;
          out.push({ form: "line", a: flightAt(f, d, 1), b: flightAt(f, d, -1), pen: "thin", tone: "halftone" });
        }
      }
    }

    // 3. Continuous walk centerline + V arrowhead + white-haloed UP / DN label
    if (isTop) {
      // Walk path drawn from top of last flight back down to bottom of first flight
      const rev = [...layout.walkPath].reverse();
      if (rev.length >= 2) {
        const tipD = f0.treadMm * 0.35;
        const startD = fLast.runMm - fLast.treadMm * 0.35;
        rev[0] = flightAt(fLast, startD, 0);
        rev[rev.length - 1] = flightAt(f0, tipD, 0);
        if (rev.length === 2) out.push({ form: "line", a: rev[0]!, b: rev[1]!, pen: "thin" });
        else out.push({ form: "polyline", points: rev, closed: false, pen: "thin" });
        out.push({ form: "line", a: flightAt(f0, tipD + arrowLen, arrowSide), b: flightAt(f0, tipD, 0), pen: "medium" });
        out.push({ form: "line", a: flightAt(f0, tipD + arrowLen, -arrowSide), b: flightAt(f0, tipD, 0), pen: "medium" });
      }
      const lblD = Math.max(fLast.treadMm * 1.4, fLast.runMm - fLast.treadMm * 2.1);
      const hw = Math.min(260, fLast.treadMm * 0.95);
      const hh = Math.min(0.45, 220 / Math.max(1, halfW));
      out.push({ form: "polyline", points: [flightAt(fLast, lblD - hw, -hh), flightAt(fLast, lblD + hw, -hh), flightAt(fLast, lblD + hw, hh), flightAt(fLast, lblD - hw, hh)], closed: true, pen: "none", fill: "#ffffff" });
      out.push({ form: "text", at: flightAt(fLast, lblD, -0.14), text: "DN", heightMm: 2.2, rotationDeg: 0, anchor: "middle" });
      return out;
    }

    const fwd = [...layout.walkPath];
    if (fwd.length >= 2) {
      const startD = f0.treadMm * 0.4;
      const tipD = fLast.runMm - fLast.treadMm * 0.25;
      fwd[0] = flightAt(f0, startD, 0);
      fwd[fwd.length - 1] = flightAt(fLast, tipD, 0);
      if (fwd.length === 2) out.push({ form: "line", a: fwd[0]!, b: fwd[1]!, pen: "thin" });
      else out.push({ form: "polyline", points: fwd, closed: false, pen: "thin" });
      out.push({ form: "line", a: flightAt(fLast, tipD - arrowLen, arrowSide), b: flightAt(fLast, tipD, 0), pen: "medium" });
      out.push({ form: "line", a: flightAt(fLast, tipD - arrowLen, -arrowSide), b: flightAt(fLast, tipD, 0), pen: "medium" });
    }
    const lblD = Math.min(f0.runMm * 0.32, f0.treadMm * 1.8);
    const hw = Math.min(260, f0.treadMm * 0.95);
    const hh = Math.min(0.45, 220 / Math.max(1, halfW));
    out.push({ form: "polyline", points: [flightAt(f0, lblD - hw, -hh), flightAt(f0, lblD + hw, -hh), flightAt(f0, lblD + hw, hh), flightAt(f0, lblD - hw, hh)], closed: true, pen: "none", fill: "#ffffff" });
    out.push({ form: "text", at: flightAt(f0, lblD, -0.14), text: "UP", heightMm: 2.2, rotationDeg: 0, anchor: "middle" });
    return out;
  },
  solid(el, ctx) {
    const s = asStair(el);
    const g = s ? stairGeometry(s, ctx.elements) : null;
    if (!s || !g) return null;
    const z0 = elevationOf(ctx.elements, s.levelId) ?? ctx.floorMm;
    const layout = stairLayout(s, g, z0);
    const halfW = s.widthMm / 2;
    const waistMm = 215;
    const blocks: Array<{ readonly outline: readonly Vec2[]; readonly z0: number; readonly z1: number }> = [];
    for (const f of layout.flights) {
      const at = (d: number, side: number): Vec2 => ({
        x: f.start.x + f.u.x * d + f.n.x * halfW * side,
        y: f.start.y + f.u.y * d + f.n.y * halfW * side,
      });
      for (let i = 0; i < f.treads; i++) {
        const stepTop = f.z0 + (i + 1) * f.riserMm;
        const stepBot = Math.max(f.z0, stepTop - waistMm);
        blocks.push({
          outline: [at(i * f.treadMm, 1), at((i + 1) * f.treadMm, 1), at((i + 1) * f.treadMm, -1), at(i * f.treadMm, -1)],
          z0: stepBot,
          z1: stepTop,
        });
      }
    }
    for (const land of layout.landings) {
      blocks.push({ outline: land.outline, z0: land.zBot, z1: land.zTop });
    }
    const shape: KindSolidShape = { form: "prisms", blocks, category: "structure", role: "architecture" };
    return shape;
  },
  sectionGraphics(el, ctx) {
    const s = asStair(el);
    if (!s) return null;
    const g = stairGeometry(s, ctx.elements);
    if (!g) return null;
    const baseLvl = ctx.elements[s.levelId];
    const z0 = baseLvl?.kind === "level" ? baseLvl.elevationMm : ctx.floorMm;
    const layout = stairLayout(s, g, z0);
    const halfW = s.widthMm / 2;
    const waistMm = 215;
    const addP = (a: Vec2, v: Vec2, k = 1): Vec2 => ({ x: a.x + v.x * k, y: a.y + v.y * k });
    const projU = (q: Vec2): number => (q.x - ctx.cutStart.x) * ctx.axis.x + (q.y - ctx.cutStart.y) * ctx.axis.y;
    const projDepth = (q: Vec2): number => (q.x - ctx.cutStart.x) * ctx.look.x + (q.y - ctx.cutStart.y) * ctx.look.y;
    const out: SectionGraphic[] = [];

    for (const land of layout.landings) {
      const ds = land.outline.map(projDepth);
      if (Math.max(...ds) < -50 || Math.min(...ds) > ctx.depthMm + 50) continue;
      const us = land.outline.map(projU);
      const u0 = Math.min(...us);
      const u1 = Math.max(...us);
      const depthMm = ds.reduce((a, b) => a + b, 0) / ds.length;
      const rect: Vec2[] = [{ x: u0, y: land.zBot }, { x: u1, y: land.zBot }, { x: u1, y: land.zTop }, { x: u0, y: land.zTop }];
      out.push(
        { depthMm, graphic: { form: "polyline", points: rect, closed: true, pen: "thin", fill: "#ffffff" } },
        { depthMm, graphic: { form: "line", a: { x: u0, y: land.zTop + 915 }, b: { x: u1, y: land.zTop + 915 }, pen: "thin" } },
        { depthMm, graphic: { form: "line", a: { x: u0, y: land.zTop }, b: { x: u0, y: land.zTop + 915 }, pen: "thin" } },
        { depthMm, graphic: { form: "line", a: { x: u1, y: land.zTop }, b: { x: u1, y: land.zTop + 915 }, pen: "thin" } },
      );
    }

    for (const f of layout.flights) {
      const fEnd = addP(f.start, f.u, f.runMm);
      const corners = [addP(f.start, f.n, halfW), addP(f.start, f.n, -halfW), addP(fEnd, f.n, halfW), addP(fEnd, f.n, -halfW)];
      const ds = corners.map(projDepth);
      if (Math.max(...ds) < -50 || Math.min(...ds) > ctx.depthMm + 50) continue;
      const depthMm = ds.reduce((a, b) => a + b, 0) / ds.length;
      const parallel = Math.abs(f.u.x * ctx.axis.x + f.u.y * ctx.axis.y) > 0.35;
      if (parallel) {
        const pts: Vec2[] = [];
        const uStart = projU(f.start);
        const uEnd = projU(fEnd);
        const uDir = uEnd >= uStart ? 1 : -1;
        pts.push({ x: uStart, y: f.z0 });
        for (let i = 0; i < f.treads; i++) {
          const uA = projU(addP(f.start, f.u, i * f.treadMm));
          const uB = projU(addP(f.start, f.u, (i + 1) * f.treadMm));
          const zStep = f.z0 + (i + 1) * f.riserMm;
          pts.push({ x: uA, y: zStep }, { x: uB, y: zStep });
        }
        pts.push({ x: uEnd, y: f.z1 }, { x: uEnd, y: Math.max(f.z0, f.z1 - waistMm) });
        const soffitShift = Math.min(Math.abs(uEnd - uStart) * 0.2, waistMm * 0.9) * uDir;
        pts.push({ x: uStart + soffitShift, y: f.z0 });
        out.push(
          { depthMm, graphic: { form: "polyline", points: pts, closed: true, pen: "thin", fill: "#ffffff" } },
          { depthMm, graphic: { form: "line", a: { x: uStart, y: f.z0 + 915 }, b: { x: uEnd, y: f.z1 + 915 }, pen: "thin" } },
          { depthMm, graphic: { form: "line", a: { x: uStart, y: f.z0 }, b: { x: uStart, y: f.z0 + 915 }, pen: "thin" } },
          { depthMm, graphic: { form: "line", a: { x: uEnd, y: f.z1 }, b: { x: uEnd, y: f.z1 + 915 }, pen: "thin" } },
        );
      } else {
        const us = corners.map(projU);
        const u0 = Math.min(...us);
        const u1 = Math.max(...us);
        const rect: Vec2[] = [{ x: u0, y: f.z0 }, { x: u1, y: f.z0 }, { x: u1, y: f.z1 }, { x: u0, y: f.z1 }];
        out.push({ depthMm, graphic: { form: "polyline", points: rect, closed: true, pen: "thin", fill: "#ffffff" } });
        for (let i = 1; i < f.risers; i++) {
          const z = f.z0 + i * f.riserMm;
          out.push({ depthMm, graphic: { form: "line", a: { x: u0, y: z }, b: { x: u1, y: z }, pen: "thin" } });
        }
        out.push(
          { depthMm, graphic: { form: "line", a: { x: u0, y: f.z1 }, b: { x: u0, y: f.z1 + 915 }, pen: "thin" } },
          { depthMm, graphic: { form: "line", a: { x: u1, y: f.z1 }, b: { x: u1, y: f.z1 + 915 }, pen: "thin" } },
          { depthMm, graphic: { form: "line", a: { x: u0, y: f.z1 + 915 }, b: { x: u1, y: f.z1 + 915 }, pen: "thin" } },
        );
      }
    }
    return out;
  },
};

export const ARCHITECTURE_KIND_ROWS: readonly ElementKindItem[] = [ROOF_KIND_ROW, STAIR_KIND_ROW];
