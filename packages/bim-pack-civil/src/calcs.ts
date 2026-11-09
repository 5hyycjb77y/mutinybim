import { qty, to } from "@permitzip/bim-units";
import { z } from "zod";
import { MANNING_EQUATION, MANNING_N_TABLE, MIN_SLOPE_CRITERION, RATIONAL_METHOD, RUNOFF_COEFFICIENT_TABLE, type CivilCitation } from "./citations";
import { manningFullFlow, manningNFor, MANNING_N } from "./manning";
import { rationalRunoff, runoffCoefficientRow, RUNOFF_COEFFICIENTS } from "./runoff";

/**
 * The civil calcs, as the calc contract runs them: inputs are plain numbers
 * with the unit in the field name (the bim-calc convention), outputs are
 * values with a bim-units unit code (cfs, acre, ft/s), the steps in plain
 * words, and citations. `pack.ts` wraps each with `defineCalc` for the calc
 * point.
 */

export interface CivilCalcValue {
  readonly key: string;
  readonly label: string;
  readonly value: number | string | null;
  /** A bim-units unit code, or null for a plain number (C, Manning's n). */
  readonly unit: "cfs" | "acre" | "ft/s" | "1" | null;
  readonly cite: readonly CivilCitation[];
}

export interface CivilCalcOutput<D> {
  readonly values: readonly CivilCalcValue[];
  readonly steps: readonly { readonly label: string; readonly detail: string; readonly cite: readonly CivilCitation[] }[];
  readonly issues: readonly { readonly severity: "error" | "warning" | "info"; readonly message: string; readonly cite: readonly CivilCitation[] }[];
  readonly detail: D;
}

// z.enum needs a non-empty tuple; the table is a non-empty constant.
const surfaceIds = RUNOFF_COEFFICIENTS.map((r) => r.id) as [string, ...string[]];

export const rationalRunoffInput = z
  .object({
    /** Area in acres or square feet (give one). */
    area_acres: z.number().positive().optional(),
    area_ft2: z.number().positive().optional(),
    /** C typed; wins over `surface`. */
    runoff_coefficient: z.number().min(0).max(1).optional(),
    surface: z.enum(surfaceIds).optional(),
    intensity_in_per_h: z.number().positive(),
  })
  .strict()
  .refine((v) => (v.area_acres === undefined) !== (v.area_ft2 === undefined), { message: "give the area in acres or in square feet, not both or neither" })
  .refine((v) => v.runoff_coefficient !== undefined || v.surface !== undefined, { message: "give a runoff coefficient or a surface type" });

export type RationalRunoffInput = z.output<typeof rationalRunoffInput>;

export interface RationalRunoffDetail {
  readonly c: number;
  readonly areaAcres: number;
  readonly intensityInPerH: number;
  readonly peakCfs: number;
  /** C·i·A read straight as cfs, the US shortcut (1 ac·in/h is 1.0083 cfs). */
  readonly shortcutCfs: number;
}

export function runRationalRunoff(input: RationalRunoffInput): CivilCalcOutput<RationalRunoffDetail> {
  const row = input.surface ? runoffCoefficientRow(input.surface) : null;
  const c = input.runoff_coefficient ?? row?.design ?? 0;
  const area = input.area_acres !== undefined ? qty("area", input.area_acres, "acre") : qty("area", input.area_ft2 ?? 0, "ft2");
  const intensity = qty("rainfall_intensity", input.intensity_in_per_h, "in/h");
  const q = rationalRunoff(c, intensity, area);
  const acres = to(area, "acre");
  const peakCfs = to(q, "cfs");
  const shortcut = c * input.intensity_in_per_h * acres;
  const cCite = input.runoff_coefficient !== undefined ? [] : [RUNOFF_COEFFICIENT_TABLE];
  return {
    values: [
      { key: "peak_runoff", label: "Peak runoff", value: peakCfs, unit: "cfs", cite: [RATIONAL_METHOD] },
      { key: "runoff_coefficient", label: "Runoff coefficient C", value: c, unit: "1", cite: cCite },
      { key: "area", label: "Area", value: acres, unit: "acre", cite: [] },
    ],
    steps: [
      { label: "Runoff coefficient", detail: input.runoff_coefficient !== undefined ? `C = ${c} as given` : `C = ${c}, the design value for ${row?.label ?? input.surface} (range ${row?.low}–${row?.high})`, cite: cCite },
      { label: "Peak runoff", detail: `Q = C·i·A = ${c} × ${input.intensity_in_per_h} in/h × ${acres.toFixed(4)} ac = ${peakCfs.toFixed(3)} cfs (the shortcut that reads ac·in/h as cfs gives ${shortcut.toFixed(3)})`, cite: [RATIONAL_METHOD] },
    ],
    issues: acres > 200 ? [{ severity: "warning", message: `${acres.toFixed(0)} acres is large for the rational method; a hydrograph method is usual above about 200 acres`, cite: [RATIONAL_METHOD] }] : [],
    detail: { c, areaAcres: acres, intensityInPerH: input.intensity_in_per_h, peakCfs, shortcutCfs: shortcut },
  };
}

export const RATIONAL_RUNOFF_EXAMPLE: z.input<typeof rationalRunoffInput> = { area_ft2: 30000, surface: "paved", intensity_in_per_h: 4 };

// z.enum needs a non-empty tuple; the table is a non-empty constant.
const materials = Object.keys(MANNING_N) as [string, ...string[]];

export const manningCapacityInput = z
  .object({
    diameter_in: z.number().positive(),
    slope_pct: z.number().nonnegative(),
    manning_n: z.number().positive().optional(),
    material: z.enum(materials).optional(),
    /** Flow to compare against, when checking a pipe. */
    flow_cfs: z.number().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.manning_n !== undefined || v.material !== undefined, { message: "give Manning's n or the pipe material" });

export type ManningCapacityInput = z.output<typeof manningCapacityInput>;

export interface ManningCapacityDetail {
  readonly n: number;
  readonly capacityCfs: number;
  readonly velocityFps: number;
}

export function runManningCapacity(input: ManningCapacityInput): CivilCalcOutput<ManningCapacityDetail> {
  const n = input.manning_n ?? manningNFor(input.material ?? null);
  const flow = manningFullFlow(qty("length", input.diameter_in, "in"), qty("slope", input.slope_pct, "%"), n);
  const capacityCfs = to(flow.capacity, "cfs");
  const velocityFps = to(flow.velocity, "ft/s");
  const nCite = input.manning_n !== undefined ? [] : [MANNING_N_TABLE];
  const issues: CivilCalcOutput<ManningCapacityDetail>["issues"][number][] = [];
  if (input.flow_cfs !== undefined && input.flow_cfs > capacityCfs) issues.push({ severity: "warning", message: `The pipe carries ${input.flow_cfs.toFixed(2)} cfs but holds ${capacityCfs.toFixed(2)} cfs flowing full; it surcharges`, cite: [MANNING_EQUATION] });
  if (input.slope_pct < 0.5) issues.push({ severity: "warning", message: `${input.slope_pct} % is flatter than the 0.5 % minimum`, cite: [MIN_SLOPE_CRITERION] });
  return {
    values: [
      { key: "full_capacity", label: "Capacity flowing full", value: capacityCfs, unit: "cfs", cite: [MANNING_EQUATION, ...nCite] },
      { key: "full_velocity", label: "Velocity flowing full", value: velocityFps, unit: "ft/s", cite: [MANNING_EQUATION] },
      { key: "manning_n", label: "Manning's n", value: n, unit: null, cite: nCite },
    ],
    steps: [{ label: "Manning, flowing full", detail: `Q = (1.486/n)·A·R^(2/3)·S^(1/2) with n = ${n}, D = ${input.diameter_in} in, S = ${input.slope_pct} %: ${capacityCfs.toFixed(3)} cfs at ${velocityFps.toFixed(2)} ft/s`, cite: [MANNING_EQUATION, ...nCite] }],
    issues,
    detail: { n, capacityCfs, velocityFps },
  };
}

export const MANNING_CAPACITY_EXAMPLE: z.input<typeof manningCapacityInput> = { diameter_in: 12, slope_pct: 0.5, manning_n: 0.013 };
