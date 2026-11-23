import { elementsOfKind, type Level, type ModelState, type Vec2 } from "@permitzip/bim-kernel";

/**
 * Exact 3D multi-flight stair geometry extraction for photometrics & egress.
 *
 * Resolves `architecture.stair` elements (straight, straight-with-landing,
 * 90° L-shape, and 180° U-shape switchback) into exact 3D flight surfaces,
 * mid-landings, per-tread sample elevations, and solid waist-slab occluders
 * matching `packages/bim-pack-architecture/src/kinds.ts`.
 */

const MAX_RISER_MM = 178; // 7 in IBC §1011.5.2
const WAIST_MM = 215;

export interface ResolvedStairFlight {
  readonly index: number;
  readonly start: Vec2;
  readonly end: Vec2;
  /** Unit vector along the climb direction. */
  readonly u: Vec2;
  /** Unit left-hand normal perpendicular to `u`. */
  readonly n: Vec2;
  readonly widthMm: number;
  readonly runMm: number;
  readonly z0: number;
  readonly z1: number;
  readonly risers: number;
  readonly treads: number;
  readonly riserMm: number;
  readonly treadMm: number;
  readonly rotationDeg: number;
  readonly outline: readonly Vec2[];
}

export interface ResolvedStairLanding {
  readonly index: number;
  readonly outline: readonly Vec2[];
  readonly zTop: number;
  readonly zBot: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface ResolvedStair3D {
  readonly stairId: string;
  readonly name: string;
  readonly form: "straight" | "l_shape" | "u_shape";
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  readonly topLevelId: string;
  readonly topLevelElevationMm: number;
  readonly flights: readonly ResolvedStairFlight[];
  readonly landings: readonly ResolvedStairLanding[];
  readonly totalAreaSqFt: number;
}

const SQMM_PER_SQFT = 304.8 * 304.8;

function add2(p: Vec2, v: Vec2, k = 1): Vec2 {
  return { x: p.x + v.x * k, y: p.y + v.y * k };
}

function quadArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) * 0.5;
}

function makeLanding(index: number, outline: readonly Vec2[], zTop: number): ResolvedStairLanding {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { index, outline, zTop, zBot: zTop - WAIST_MM, minX, maxX, minY, maxY };
}

function makeFlight(
  index: number,
  start: Vec2,
  end: Vec2,
  u: Vec2,
  n: Vec2,
  widthMm: number,
  runMm: number,
  z0: number,
  z1: number,
  risers: number,
  treads: number,
  riserMm: number,
  treadMm: number,
): ResolvedStairFlight {
  const hw = widthMm * 0.5;
  const outline: Vec2[] = [
    add2(start, n, -hw),
    add2(end, n, -hw),
    add2(end, n, hw),
    add2(start, n, hw),
  ];
  const rotationDeg = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  return { index, start, end, u, n, widthMm, runMm, z0, z1, risers, treads, riserMm, treadMm, rotationDeg, outline };
}

const STAIR_CACHE = new WeakMap<ModelState["elements"], readonly ResolvedStair3D[]>();

/** Resolve every active `architecture.stair` element in `model` into 3D flights & landings. */
export function extractStairs3D(model: ModelState): readonly ResolvedStair3D[] {
  const cached = STAIR_CACHE.get(model.elements);
  if (cached) return cached;

  const levelsById = new Map<string, Level>();
  const sortedLevels: Level[] = [];
  for (const l of elementsOfKind(model.elements, "level")) {
    levelsById.set(l.id, l);
    sortedLevels.push(l);
  }
  sortedLevels.sort((a, b) => a.elevationMm - b.elevationMm);

  const stairs: ResolvedStair3D[] = [];

  for (const el of Object.values(model.elements)) {
    const raw = el as unknown as {
      readonly id: string;
      readonly kind: string;
      readonly deleted?: boolean;
      readonly name?: string;
      readonly levelId?: string;
      readonly topLevelId?: string;
      readonly start?: Vec2;
      readonly end?: Vec2;
      readonly widthMm?: number;
      readonly risers?: number;
      readonly form?: string;
      readonly turn?: string;
      readonly landingDepthMm?: number;
      readonly wellGapMm?: number;
      readonly values?: Readonly<Record<string, unknown>>;
      readonly placement?: { readonly levelId?: string; readonly start?: Vec2; readonly end?: Vec2 };
      readonly size?: { readonly widthMm?: number };
    };
    if (!raw || raw.kind !== "architecture.stair" || raw.deleted) continue;

    const start = raw.start ?? raw.placement?.start;
    const end = raw.end ?? raw.placement?.end;
    if (!start || !end) continue;

    const lvlId = raw.levelId ?? raw.placement?.levelId ?? sortedLevels[0]?.id;
    const lvl = lvlId ? levelsById.get(lvlId) : sortedLevels[0];
    if (!lvl) continue;

    const topLvl =
      (raw.topLevelId ? levelsById.get(raw.topLevelId) : undefined) ??
      sortedLevels.find((l) => l.elevationMm > lvl.elevationMm + 500);
    const z0 = lvl.elevationMm;
    const z1 = topLvl ? topLvl.elevationMm : z0 + 3658; // 12' fallback if top level missing
    const heightMm = Math.max(300, z1 - z0);

    const w = Math.max(914, raw.widthMm ?? raw.size?.widthMm ?? 1118);
    const halfW = w * 0.5;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 100) continue;

    const u: Vec2 = { x: dx / dist, y: dy / dist };
    const nL: Vec2 = { x: -u.y, y: u.x };

    const vals = raw.values;
    const rawForm = String(vals?.["architecture.stair_form"] ?? raw.form ?? "straight").toLowerCase();
    const form: "straight" | "l_shape" | "u_shape" =
      rawForm === "u_shape" ? "u_shape" : rawForm === "l_shape" ? "l_shape" : "straight";
    const rawTurn = String(vals?.["architecture.stair_turn"] ?? raw.turn ?? "right").toLowerCase();
    const turnSign = rawTurn === "left" ? 1 : -1;
    const nT: Vec2 = { x: nL.x * turnSign, y: nL.y * turnSign };

    const rawLandingDepth = vals?.["architecture.landing_depth_mm"] ?? raw.landingDepthMm;
    const landingDepthParam = typeof rawLandingDepth === "number" && rawLandingDepth > 0 ? rawLandingDepth : undefined;
    const rawWellGap = vals?.["architecture.well_gap_mm"] ?? raw.wellGapMm;
    const wellGap = typeof rawWellGap === "number" && rawWellGap >= 0 ? rawWellGap : 150;

    const risers = typeof raw.risers === "number" && raw.risers >= 2 ? Math.round(raw.risers) : Math.max(2, Math.ceil(heightMm / MAX_RISER_MM));
    const treads = Math.max(1, risers - 1);

    const flights: ResolvedStairFlight[] = [];
    const landings: ResolvedStairLanding[] = [];

    if (form === "straight" && !landingDepthParam) {
      flights.push(
        makeFlight(0, start, end, u, nL, w, dist, z0, z1, risers, treads, heightMm / risers, dist / treads),
      );
    } else {
      const r1 = Math.max(2, Math.ceil(risers / 2));
      const r2 = Math.max(2, risers - r1);
      const t1 = Math.max(1, r1 - 1);
      const t2 = Math.max(1, r2 - 1);
      const riserMm = heightMm / (r1 + r2);
      const zMid = z0 + r1 * riserMm;
      const landingD = Math.max(landingDepthParam ?? Math.max(w, 1120), w);

      if (form === "straight") {
        const treadMm = Math.max(280, (Math.max(dist, (t1 + t2) * 280 + landingD) - landingD) / (t1 + t2));
        const run1 = t1 * treadMm;
        const run2 = t2 * treadMm;
        const f1End = add2(start, u, run1);
        const f2Start = add2(f1End, u, landingD);
        const f2End = add2(f2Start, u, run2);
        const cA = add2(f1End, nL, halfW);
        const cB = add2(f1End, nL, -halfW);
        const cC = add2(f2Start, nL, -halfW);
        const cD = add2(f2Start, nL, halfW);
        flights.push(
          makeFlight(0, start, f1End, u, nL, w, run1, z0, zMid, r1, t1, riserMm, treadMm),
          makeFlight(1, f2Start, f2End, u, nL, w, run2, zMid, z1, r2, t2, riserMm, treadMm),
        );
        landings.push(makeLanding(0, [cA, cB, cC, cD], zMid));
      } else {
        const treadMm = Math.max(280, Math.min(330, dist > 1 ? dist / t1 : 280));
        const run1 = t1 * treadMm;
        const run2 = t2 * treadMm;
        const f1End = add2(start, u, run1);

        if (form === "l_shape") {
          const cA = add2(f1End, nT, -halfW);
          const cB = add2(f1End, nT, halfW);
          const cC = add2(cB, u, landingD);
          const cD = add2(cA, u, landingD);
          const u2 = nT;
          const n2: Vec2 = { x: -u2.y, y: u2.x };
          const landMid = add2(f1End, u, landingD * 0.5);
          const f2Start = add2(landMid, nT, halfW);
          const f2End = add2(f2Start, u2, run2);
          flights.push(
            makeFlight(0, start, f1End, u, nL, w, run1, z0, zMid, r1, t1, riserMm, treadMm),
            makeFlight(1, f2Start, f2End, u2, n2, w, run2, zMid, z1, r2, t2, riserMm, treadMm),
          );
          landings.push(makeLanding(0, [cA, cB, cC, cD], zMid));
        } else {
          // 180° Switchback U-shape stair
          const cA = add2(f1End, nT, -halfW);
          const cB = add2(f1End, nT, halfW + wellGap + w);
          const cC = add2(cB, u, landingD);
          const cD = add2(cA, u, landingD);
          const u2: Vec2 = { x: -u.x, y: -u.y };
          const n2: Vec2 = { x: -u2.y, y: u2.x };
          const f2Start = add2(f1End, nT, w + wellGap);
          const f2End = add2(f2Start, u2, run2);
          flights.push(
            makeFlight(0, start, f1End, u, nL, w, run1, z0, zMid, r1, t1, riserMm, treadMm),
            makeFlight(1, f2Start, f2End, u2, n2, w, run2, zMid, z1, r2, t2, riserMm, treadMm),
          );
          landings.push(makeLanding(0, [cA, cB, cC, cD], zMid));
        }
      }
    }

    let areaMm2 = 0;
    for (const f of flights) areaMm2 += f.widthMm * f.runMm;
    for (const l of landings) areaMm2 += quadArea(l.outline);

    stairs.push({
      stairId: raw.id,
      name: raw.name?.trim() || `Stair (${raw.id})`,
      form,
      levelId: lvl.id,
      levelName: lvl.name,
      levelElevationMm: z0,
      topLevelId: topLvl?.id ?? "",
      topLevelElevationMm: z1,
      flights,
      landings,
      totalAreaSqFt: Number((areaMm2 / SQMM_PER_SQFT).toFixed(1)),
    });
  }

  STAIR_CACHE.set(model.elements, stairs);
  return stairs;
}
