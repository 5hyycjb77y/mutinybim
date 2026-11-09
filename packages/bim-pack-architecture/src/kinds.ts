import { elementsOfKind, hostVoidsOf, type BimElement, type ElementKindItem, type FacePair, type KindSolidShape, type PlanGraphic, type SurfaceFaceRow, type Vec2 } from "@permitzip/bim-kernel";

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

export interface RoofSlope {
  /** The way the roof rises, degrees counter-clockwise from east. */
  readonly directionDeg: number;
  /** Rise per unit run (0.25 is 3 in 12). */
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
  readonly slope?: RoofSlope;
}

export interface StairRecord {
  readonly id: string;
  readonly kind: typeof STAIR_KIND;
  readonly levelId: string;
  /** The level it rises to. Absent: the next level up. */
  readonly topLevelId?: string;
  /** Foot of the run and the top nosing line's centre, in plan. */
  readonly start: Vec2;
  readonly end: Vec2;
  readonly widthMm: number;
  /** Risers asked for. Absent: the fewest that keep each riser at most `MAX_RISER_MM`. */
  readonly risers?: number;
}

const isVec = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored record as a roof, or null when it isn't one in this shape (kept as stored). */
export function asRoof(el: BimElement): RoofRecord | null {
  const r: Record<string, unknown> = { ...el };
  if (r.kind !== ROOF_KIND || typeof r.levelId !== "string" || !Array.isArray(r.outline) || !r.outline.every(isVec) || num(r.thicknessMm) === null) return null;
  const slope = r.slope;
  const okSlope = typeof slope === "object" && slope !== null && num((slope as { directionDeg?: unknown }).directionDeg) !== null && num((slope as { rise?: unknown }).rise) !== null;
  return { id: el.id, kind: ROOF_KIND, levelId: r.levelId, outline: r.outline, thicknessMm: num(r.thicknessMm) ?? 0, baseOffsetMm: num(r.baseOffsetMm) ?? 0, ...(okSlope ? { slope: slope as RoofSlope } : {}) };
}

/** A stored record as a stair, or null. */
export function asStair(el: BimElement): StairRecord | null {
  const r: Record<string, unknown> = { ...el };
  if (r.kind !== STAIR_KIND || typeof r.levelId !== "string" || !isVec(r.start) || !isVec(r.end) || num(r.widthMm) === null) return null;
  const risers = num(r.risers);
  return { id: el.id, kind: STAIR_KIND, levelId: r.levelId, start: r.start, end: r.end, widthMm: num(r.widthMm) ?? 0, ...(typeof r.topLevelId === "string" ? { topLevelId: r.topLevelId } : {}), ...(risers !== null && risers >= 2 ? { risers: Math.round(risers) } : {}) };
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
  shape: { fields: [{ name: "levelId", form: "id" }, { name: "outline", form: "points" }, { name: "thicknessMm", form: "number" }, { name: "baseOffsetMm", form: "number", optional: true }, { name: "slope", form: "architecture.slope", optional: true }], points: (el) => asRoof(el)?.outline ?? [] },
  anchor: (el) => {
    const r = asRoof(el);
    return r ? centroid(r.outline) : null;
  },
  create: {
    placements: ["area"],
    make(input) {
      if (input.placement.kind !== "area") return { refused: "A roof is drawn as an area: click its corners" };
      const thicknessMm = input.size?.thicknessMm ?? DEFAULT_ROOF_THICKNESS_MM;
      const rise = num(input.values?.["architecture.slope_rise"]);
      const directionDeg = num(input.values?.["architecture.slope_direction_deg"]) ?? 90;
      const roof: RoofRecord = { id: input.id, kind: ROOF_KIND, levelId: input.levelId, outline: input.placement.outline, thicknessMm, baseOffsetMm: 0, ...(rise !== null && rise !== 0 ? { slope: { directionDeg, rise } } : {}) };
      return { ...roof, version: 0, authoredRev: {} } as unknown as BimElement;
    },
  },
  planGraphics(el, ctx) {
    const r = asRoof(el);
    if (!r || r.levelId !== ctx.levelId) return null;
    const out: PlanGraphic[] = [{ form: "polyline", points: r.outline, closed: true, pen: "medium" }];
    for (const v of hostVoidsOf(ctx.elements, el.id)) out.push({ form: "polyline", points: v.profile, closed: true, pen: "thin" });
    if (r.slope) {
      const c = centroid(r.outline);
      const a = (r.slope.directionDeg * Math.PI) / 180;
      out.push({ form: "line", a: c, b: { x: c.x + Math.cos(a) * 1000, y: c.y + Math.sin(a) * 1000 }, pen: "thin" });
      out.push({ form: "text", at: c, text: `${Math.round(r.slope.rise * 12 * 10) / 10} in 12`, heightMm: 2, rotationDeg: 0, anchor: "middle" });
    }
    return out;
  },
  solid(el, ctx) {
    const r = asRoof(el);
    if (!r) return null;
    const z0 = (elevationOf(ctx.elements, r.levelId) ?? ctx.floorMm) + r.baseOffsetMm;
    // A pitched roof is drawn pitched: both faces rise from its low edge (`roofPlane`).
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

/** A roof's underside and top at a plan point, mm above project zero (the plane carried on past its edge). */
export function roofFaceAt(r: RoofRecord, elements: Elements, p: Vec2): FacePair | null {
  const level = elevationOf(elements, r.levelId);
  if (level === null) return null;
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
  shape: { fields: [{ name: "levelId", form: "id" }, { name: "start", form: "point" }, { name: "end", form: "point" }, { name: "widthMm", form: "number" }, { name: "topLevelId", form: "id", optional: true }, { name: "risers", form: "number", optional: true }], points: (el) => { const s = asStair(el); return s ? [s.start, s.end] : []; } },
  create: {
    placements: ["line"],
    make(input, elements) {
      if (input.placement.kind !== "line") return { refused: "A stair is drawn as a run: click its foot, then its top" };
      const top = typeof input.values?.["architecture.top_level"] === "string" ? String(input.values["architecture.top_level"]) : undefined;
      const risers = num(input.values?.["architecture.risers"]);
      const stair: StairRecord = { id: input.id, kind: STAIR_KIND, levelId: input.levelId, start: input.placement.start, end: input.placement.end, widthMm: input.size?.widthMm ?? DEFAULT_STAIR_WIDTH_MM, ...(top !== undefined ? { topLevelId: top } : {}), ...(risers !== null ? { risers: Math.round(risers) } : {}) };
      if (!stairGeometry(stair, elements)) return { refused: "A stair rises to the level above, and this level has none; add a level above or pick the level it rises to" };
      return { ...stair, version: 0, authoredRev: {} } as unknown as BimElement;
    },
  },
  planGraphics(el, ctx) {
    const s = asStair(el);
    const g = s ? stairGeometry(s, ctx.elements) : null;
    if (!s || !g || s.levelId !== ctx.levelId) return null;
    const u = { x: (s.end.x - s.start.x) / g.runMm, y: (s.end.y - s.start.y) / g.runMm };
    const n = { x: -u.y * (s.widthMm / 2), y: u.x * (s.widthMm / 2) };
    const at = (d: number, side: number): Vec2 => ({ x: s.start.x + u.x * d + n.x * side, y: s.start.y + u.y * d + n.y * side });
    const out: PlanGraphic[] = [{ form: "polyline", points: [at(0, 1), at(g.runMm, 1), at(g.runMm, -1), at(0, -1)], closed: true, pen: "medium" }];
    for (let i = 1; i < g.treads; i++) out.push({ form: "line", a: at(i * g.treadMm, 1), b: at(i * g.treadMm, -1), pen: "thin" });
    out.push({ form: "line", a: at(0, 0), b: at(g.runMm, 0), pen: "thin" });
    out.push({ form: "text", at: at(g.treadMm / 2, 0), text: "UP", heightMm: 2, rotationDeg: (Math.atan2(u.y, u.x) * 180) / Math.PI, anchor: "middle" });
    return out;
  },
  solid(el, ctx) {
    const s = asStair(el);
    const g = s ? stairGeometry(s, ctx.elements) : null;
    if (!s || !g) return null;
    const z0 = elevationOf(ctx.elements, s.levelId) ?? ctx.floorMm;
    const u = { x: (s.end.x - s.start.x) / g.runMm, y: (s.end.y - s.start.y) / g.runMm };
    const n = { x: -u.y * (s.widthMm / 2), y: u.x * (s.widthMm / 2) };
    const at = (d: number, side: number): Vec2 => ({ x: s.start.x + u.x * d + n.x * side, y: s.start.y + u.y * d + n.y * side });
    // Step i (1-based) sits on tread i - 1 and reaches riser i's top.
    const blocks = Array.from({ length: g.treads }, (_, i) => ({ outline: [at(i * g.treadMm, 1), at((i + 1) * g.treadMm, 1), at((i + 1) * g.treadMm, -1), at(i * g.treadMm, -1)], z0, z1: z0 + (i + 1) * g.riserMm }));
    const shape: KindSolidShape = { form: "prisms", blocks, category: "structure", role: "architecture" };
    return shape;
  },
};

export const ARCHITECTURE_KIND_ROWS: readonly ElementKindItem[] = [ROOF_KIND_ROW, STAIR_KIND_ROW];
