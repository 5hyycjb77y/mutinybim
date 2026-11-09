import { fromCanonical, type Quantity } from "@permitzip/bim-units";
import { RATIONAL_METHOD, RUNOFF_COEFFICIENT_TABLE, type CivilCitation } from "./citations";

/**
 * Peak runoff by the rational method, Q = C·i·A.
 *
 * Assumptions, stated once: one design intensity `i` for the whole network
 * (the intensity for the design storm, read off a curve by the engineer);
 * no time of concentration is computed, so the same `i` applies at every
 * point downstream. Peaks then add (Q at a node = i·ΣC·A), which is
 * conservative: a longer time of concentration downstream would lower `i`.
 * Valid for small catchments (HEC-22 suggests under about 80 ha / 200 ac).
 *
 * The arithmetic is exact in SI. The US custom of reading C·i·A in acres and
 * in/h straight as cfs drops a factor of 1.0083 (1 ac·in/h = 1.0083 cfs);
 * this pack does not drop it.
 */

export interface RunoffCoefficientRow {
  /** Stored in `civil.surface`. */
  readonly id: string;
  readonly label: string;
  /** The published range. */
  readonly low: number;
  readonly high: number;
  /** The value this pack uses when the catchment gives no C of its own. */
  readonly design: number;
}

/** Design values: the top of the range for impervious surfaces, mid-range for lawns. */
export const RUNOFF_COEFFICIENTS: readonly RunoffCoefficientRow[] = [
  { id: "paved", label: "Paved (asphalt or concrete)", low: 0.7, high: 0.95, design: 0.95 },
  { id: "roof", label: "Roof", low: 0.75, high: 0.95, design: 0.95 },
  { id: "lawn_sandy_flat", label: "Lawn, sandy soil, flat (under 2 %)", low: 0.05, high: 0.1, design: 0.08 },
  { id: "lawn_sandy_average", label: "Lawn, sandy soil, average (2–7 %)", low: 0.1, high: 0.15, design: 0.13 },
  { id: "lawn_heavy_flat", label: "Lawn, heavy soil, flat (under 2 %)", low: 0.13, high: 0.17, design: 0.15 },
  { id: "lawn_heavy_average", label: "Lawn, heavy soil, average (2–7 %)", low: 0.18, high: 0.22, design: 0.2 },
  { id: "lawn_heavy_steep", label: "Lawn, heavy soil, steep (over 7 %)", low: 0.25, high: 0.35, design: 0.3 },
];

export const RUNOFF_COEFFICIENT_CITES: readonly CivilCitation[] = [RUNOFF_COEFFICIENT_TABLE];

export function runoffCoefficientRow(surface: string): RunoffCoefficientRow | null {
  return RUNOFF_COEFFICIENTS.find((r) => r.id === surface) ?? null;
}

/** Why a runoff coefficient can't be used, in plain words; null when it can. */
export function runoffCoefficientProblem(c: number): string | null {
  if (!Number.isFinite(c)) return "the runoff coefficient isn't a number";
  if (c < 0 || c > 1) return `a runoff coefficient is between 0 and 1, not ${c}`;
  return null;
}

/** Q = C·i·A, in coherent SI (m/s × m² = m³/s). Throws on a C outside 0–1 or a negative intensity or area. */
export function rationalRunoff(c: number, intensity: Quantity<"rainfall_intensity">, area: Quantity<"area">): Quantity<"flow_liquid"> {
  const problem = runoffCoefficientProblem(c);
  if (problem) throw new RangeError(`[civil/runoff] ${problem}`);
  if (intensity < 0) throw new RangeError("[civil/runoff] rainfall intensity can't be negative");
  if (area < 0) throw new RangeError("[civil/runoff] catchment area can't be negative");
  return fromCanonical("flow_liquid", c * intensity * area);
}

/** Area-weighted C of several surfaces: ΣCᵢAᵢ / ΣAᵢ. Null when the total area is zero. */
export function compositeCoefficient(parts: readonly { readonly c: number; readonly area: Quantity<"area"> }[]): number | null {
  let ca = 0;
  let a = 0;
  for (const p of parts) {
    const problem = runoffCoefficientProblem(p.c);
    if (problem) throw new RangeError(`[civil/runoff] ${problem}`);
    ca += p.c * p.area;
    a += p.area;
  }
  return a > 0 ? ca / a : null;
}

export const RATIONAL_METHOD_CITES: readonly CivilCitation[] = [RATIONAL_METHOD];
