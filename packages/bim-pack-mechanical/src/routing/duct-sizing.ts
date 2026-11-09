import { insulationIssue, type DuctInsulation, type DuctSizingCriteria, type RunSize, type SystemDesign, type SystemKind } from "@permitzip/bim-kernel";
import { ductPerformance, type DuctPerformance } from "./pressure";

/**
 * Duct sizes from airflow: the smallest standard size that meets a friction
 * rate and a velocity limit, and the typical criteria by service. What a
 * size gives (`ductPerformance`) is the kernel pressure engine's own
 * (Darcy-Weisbach with Colebrook or Altshul-Tsal, the system's design air and
 * duct material), through the airway a liner leaves. A suggestion is only
 * ever offered: nothing here resizes a run.
 */

const MM_PER_IN = 25.4;

export type ResolvedSizingCriteria = Required<DuctSizingCriteria>;

/** Typical low-pressure criteria (equal friction at 0.08"/100 ft, a velocity cap per service). General engineering values: verify for the project. */
const SUPPLY_DEFAULTS: ResolvedSizingCriteria = { frictionInPer100Ft: 0.08, maxVelocityFpm: 2000, maxAspectRatio: 4 };
const OTHER_DEFAULTS: ResolvedSizingCriteria = { frictionInPer100Ft: 0.08, maxVelocityFpm: 1500, maxAspectRatio: 4 };

export function typicalSizingCriteria(kind: SystemKind): ResolvedSizingCriteria {
  return kind === "supply_air" ? SUPPLY_DEFAULTS : OTHER_DEFAULTS;
}

/** The system's own criteria over its kind's typical ones, field by field; `typical` lists the fields that fell back. */
export function sizingCriteriaFor(kind: SystemKind, design: SystemDesign | undefined): ResolvedSizingCriteria & { readonly typical: readonly (keyof DuctSizingCriteria)[] } {
  const base = typicalSizingCriteria(kind);
  const own = design?.sizing ?? {};
  const typical = (Object.keys(base) as (keyof DuctSizingCriteria)[]).filter((k) => own[k] === undefined);
  return { ...base, ...own, typical };
}

/** Round sizes: 4"-20" by the inch, 22"-60" by two. Rectangular sides: 4"-96" by two. */
const ROUND_IN: readonly number[] = [...Array.from({ length: 17 }, (_, i) => 4 + i), ...Array.from({ length: 20 }, (_, i) => 22 + 2 * i)];
const RECT_IN: readonly number[] = Array.from({ length: 47 }, (_, i) => 4 + 2 * i);

export interface DuctSizeRequest {
  readonly cfm: number;
  readonly shape: "rect" | "round";
  readonly criteria: ResolvedSizingCriteria;
  readonly insulation?: DuctInsulation;
  readonly design?: SystemDesign;
  /** Rectangular: also find the narrowest width at this height (the depth the ceiling allows), mm. */
  readonly holdHeightMm?: number;
}

export interface DuctSizeOption extends DuctPerformance {
  readonly size: RunSize;
  /** Which criterion set the size: the one with less room left. */
  readonly limitedBy: "friction" | "velocity";
}

export type DuctSizeSuggestion =
  | {
      readonly ok: true;
      /** Least sheet metal that meets both criteria (smallest perimeter; then area; then the squarer one). */
      readonly best: DuctSizeOption;
      /** Rectangular with `holdHeightMm`: the narrowest width at that height within the aspect limit; null when none is. */
      readonly atHeight: DuctSizeOption | null;
      readonly criteria: ResolvedSizingCriteria;
    }
  | { readonly ok: false; readonly reason: string; readonly criteria: ResolvedSizingCriteria };

const EPS = 1e-9;

function option(cfm: number, size: RunSize, req: DuctSizeRequest): DuctSizeOption | null {
  if (req.insulation && insulationIssue(size, req.insulation)) return null;
  const p = ductPerformance(cfm, size, req.insulation, req.design);
  if (!p) return null;
  const { frictionInPer100Ft: f, maxVelocityFpm: v } = req.criteria;
  if (p.frictionInPer100Ft > f + EPS || p.velocityFpm > v + EPS) return null;
  return { ...p, size, limitedBy: p.frictionInPer100Ft / f >= p.velocityFpm / v ? "friction" : "velocity" };
}

const mm = (inches: number) => Math.round(inches * MM_PER_IN * 1000) / 1000;

/** The first width (ascending) that works, when every wider one works too: about six tries instead of up to 47. */
function narrowest(widths: readonly number[], at: (w: number) => DuctSizeOption | null): DuctSizeOption | null {
  let lo = 0;
  let hi = widths.length - 1;
  let found: DuctSizeOption | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = widths[mid];
    const o = w === undefined ? null : at(w);
    if (o) {
      found = o;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}

/** The smallest standard duct that carries `cfm` at or under the friction rate and the velocity limit. */
export function suggestDuctSize(req: DuctSizeRequest): DuctSizeSuggestion {
  const { cfm, criteria } = req;
  if (!(cfm > 0)) return { ok: false, reason: "Enter the airflow in CFM to get a size", criteria };
  const what = `${Math.round(cfm)} CFM at ${criteria.frictionInPer100Ft}" per 100 ft and ${criteria.maxVelocityFpm} fpm`;
  if (req.shape === "round") {
    for (const d of ROUND_IN) {
      const o = option(cfm, { shape: "round", diameter: mm(d) }, req);
      if (o) return { ok: true, best: o, atHeight: null, criteria };
    }
    return { ok: false, reason: `No round duct up to ${ROUND_IN[ROUND_IN.length - 1]}" carries ${what}; use rectangular duct or more than one run`, criteria };
  }
  let best: DuctSizeOption | null = null;
  const rank = (o: DuctSizeOption) => {
    const s = o.size.shape === "rect" ? o.size : null;
    return s ? [s.width + s.height, s.width * s.height, s.width / s.height] : [Infinity, Infinity, Infinity];
  };
  const better = (a: DuctSizeOption, b: DuctSizeOption) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 3; i++) if (Math.abs((ra[i] ?? 0) - (rb[i] ?? 0)) > EPS) return (ra[i] ?? 0) < (rb[i] ?? 0);
    return false;
  };
  for (const h of RECT_IN) {
    // Width is never less than height here, so once two heights exceed the best's perimeter no taller duct can beat it.
    if (best?.size.shape === "rect" && 2 * mm(h) > best.size.width + best.size.height + EPS) break;
    // Wider only adds metal at this height once one width works, and a wider duct only lowers friction and velocity: the narrowest that works, by halving.
    const o = narrowest(RECT_IN.filter((w) => w >= h && w / h <= criteria.maxAspectRatio + EPS), (w) => option(cfm, { shape: "rect", width: mm(w), height: mm(h) }, req));
    if (o && (!best || better(o, best))) best = o;
  }
  if (!best) return { ok: false, reason: `No rectangular duct up to ${RECT_IN[RECT_IN.length - 1]}" within ${criteria.maxAspectRatio}:1 carries ${what}; use more than one run`, criteria };
  let atHeight: DuctSizeOption | null = null;
  const hold = req.holdHeightMm;
  if (hold !== undefined && hold > 0) {
    const h = hold / MM_PER_IN;
    atHeight = narrowest(
      RECT_IN.filter((w) => Math.max(w, h) / Math.min(w, h) <= criteria.maxAspectRatio + EPS),
      (w) => option(cfm, { shape: "rect", width: mm(w), height: hold }, req),
    );
  }
  return { ok: true, best, atHeight, criteria };
}
