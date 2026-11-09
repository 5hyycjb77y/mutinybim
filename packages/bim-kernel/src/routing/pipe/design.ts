import { z } from "zod";
import type { SystemKind } from "../../parts";
import type { PipeService } from "./specs";
import { pipeFamilyOf } from "../../services/registry";

/** A system's auto-sizing: check (audit and suggest, never edit) or auto. Stored on `design.pipe.sizingMode`; frozen values. */
export const PIPE_SIZING_MODES = ["check", "auto"] as const;
export type PipeSizingMode = (typeof PIPE_SIZING_MODES)[number];

/** Demand curve ids a system may store on `design.pipe.demandCurve` (the add-on names and computes them). Frozen values; add new ones, never rename. */
export const PIPE_DEMAND_CURVES = ["ashrae_a", "ashrae_b", "ashrae_c", "ashrae_d", "ipc_e_tank", "ipc_e_valve", "firm", "legacy_fit"] as const;
export type PipeDemandCurve = (typeof PIPE_DEMAND_CURVES)[number];

/** A system's sizing override, as `set_system_design` merges it into `design.pipe`. Null: back to the project's. */
const pipeSizingOverrideSchema = {
  sizingMode: z.enum(PIPE_SIZING_MODES).nullable().optional(),
  demandCurve: z.enum(PIPE_DEMAND_CURVES).nullable().optional(),
};

/**
 * Design inputs for pipe systems, on the system (project) or from the host
 * (firm). No plumbing or gas code table is bundled: the tables below start
 * empty and hold the firm's or project's own values; every built-in default
 * is a general engineering value labelled "verify for permit work".
 */

/** Allowed / not allowed, or allowed only within a size range (inches). */
export type DirectionAllowance = boolean | { readonly minIn?: number; readonly maxIn?: number };

/** How a drainage fitting may change the flow's direction: horizontal to vertical, vertical to horizontal, horizontal to horizontal. */
export interface DirectionRule {
  readonly hv: DirectionAllowance;
  readonly vh: DirectionAllowance;
  readonly hh: DirectionAllowance;
}

export interface DirectionRuleOverride extends Partial<DirectionRule> {
  readonly family: string;
}

export interface PipeDesign {
  // ---------------------------------------------------------------- water
  readonly frictionMethod?: "hazen_williams" | "darcy";
  /** Fitting losses as K x velocity head, or as an equivalent length of pipe at its friction rate. */
  readonly fittingMethod?: "k" | "equivalent_length";
  /** Hazen-Williams C for every pipe in the system, overriding the material's value. */
  readonly hazenC?: number;
  readonly waterTempF?: number;
  /** Pressure where the system starts (street main or booster discharge), psi. */
  readonly supplyPressurePsi?: number;
  /** Losses before the first pipe the model draws (meter, backflow preventer, strainer), psi. */
  readonly fixedLossesPsi?: number;
  /** Pressure the critical fixture needs, psi. */
  readonly minFixturePressurePsi?: number;
  readonly maxVelocityFps?: number;
  /** How fixture units become design flow: the firm/project table, a Hunter-curve-style formula, or loads already in gpm. */
  readonly demandMethod?: "table" | "hunter_formula" | "flow_is_gpm";
  readonly demandTable?: ReadonlyArray<{ readonly fu: number; readonly gpm: number }>;
  /** Fixture values by fixture family name (as the part type names it): water supply FU, drainage FU, gas input. */
  readonly fixtureTable?: ReadonlyArray<{ readonly fixture: string; readonly wsfu?: number; readonly dfu?: number; readonly mbh?: number }>;
  // ---------------------------------------------------------------- drainage
  /** Minimum slope by size, smallest size band first. */
  readonly slopes?: ReadonlyArray<{ readonly maxNominalIn: number; readonly inPerFt: number }>;
  /** Depth of flow / diameter that capacity is figured at. */
  readonly fillRatio?: number;
  readonly manningN?: number;
  /** Drainage fixture units to peak flow (gpm). Empty: the Hunter-curve-style formula, labelled verify. */
  readonly drainFlowTable?: ReadonlyArray<{ readonly dfu: number; readonly gpm: number }>;
  /** The adopted code's capacities as the firm enters them: DFU a size carries at a slope (no slope: a stack). */
  readonly capacityTable?: ReadonlyArray<{ readonly nominalIn: number; readonly inPerFt?: number; readonly maxDfu: number }>;
  /** Overrides of the library's direction-change rules, per family. */
  readonly directionRules?: readonly DirectionRuleOverride[];
  /** Storm: design rainfall rate, in/hr (roof drains give their area as the load). */
  readonly rainfallInPerHr?: number;
  // ---------------------------------------------------------------- gas
  readonly gasEquation?: "spitzglass" | "mueller";
  readonly specificGravity?: number;
  readonly heatingValueBtuPerCf?: number;
  readonly inletPressureInWc?: number;
  readonly allowableDropInWc?: number;
  /** Size every piece on the longest run's length (the longest-run method), on its own path length, or on the length to its own most remote outlet (the branch length method). */
  readonly gasSizing?: "longest_run" | "actual_length" | "branch_length";
  /** Which gas the system carries: picks the code tables and, unless given, specific gravity and heating value. */
  readonly gasType?: "natural" | "propane";
  // ---------------------------------------------------------------- sizing (the project record is the add-on's plumbing settings)
  /** This system's auto-sizing: check (audit and suggest, never edit) or auto (suggested sizes may be applied as the model changes). Absent or null: the project's. */
  readonly sizingMode?: PipeSizingMode | null;
  /** This system's demand curve. Absent or null: the project's. */
  readonly demandCurve?: PipeDemandCurve | null;
}

const allowance = z.union([z.boolean(), z.object({ minIn: z.number().positive().max(48).optional(), maxIn: z.number().positive().max(48).optional() })]);
const fu = z.number().finite().min(0).max(100_000);

export const pipeDesignSchema = z.object({
  frictionMethod: z.enum(["hazen_williams", "darcy"]).optional(),
  fittingMethod: z.enum(["k", "equivalent_length"]).optional(),
  hazenC: z.number().finite().min(40).max(160).optional(),
  waterTempF: z.number().finite().min(33).max(210).optional(),
  supplyPressurePsi: z.number().finite().min(0).max(500).optional(),
  fixedLossesPsi: z.number().finite().min(0).max(200).optional(),
  minFixturePressurePsi: z.number().finite().min(0).max(200).optional(),
  maxVelocityFps: z.number().finite().positive().max(30).optional(),
  demandMethod: z.enum(["table", "hunter_formula", "flow_is_gpm"]).optional(),
  demandTable: z.array(z.object({ fu, gpm: z.number().finite().min(0).max(100_000) })).max(200).optional(),
  fixtureTable: z
    .array(z.object({ fixture: z.string().trim().min(1).max(120), wsfu: fu.optional(), dfu: fu.optional(), mbh: z.number().finite().min(0).max(100_000).optional() }))
    .max(500)
    .optional(),
  slopes: z.array(z.object({ maxNominalIn: z.number().positive().max(1000), inPerFt: z.number().finite().min(0).max(1) })).min(1).max(20).optional(),
  fillRatio: z.number().finite().min(0.1).max(1).optional(),
  manningN: z.number().finite().min(0.005).max(0.03).optional(),
  drainFlowTable: z.array(z.object({ dfu: fu, gpm: z.number().finite().min(0).max(100_000) })).max(200).optional(),
  capacityTable: z.array(z.object({ nominalIn: z.number().positive().max(48), inPerFt: z.number().finite().min(0).max(1).optional(), maxDfu: fu })).max(500).optional(),
  directionRules: z.array(z.object({ family: z.string().min(1).max(80), hv: allowance.optional(), vh: allowance.optional(), hh: allowance.optional() })).max(100).optional(),
  rainfallInPerHr: z.number().finite().positive().max(20).optional(),
  gasEquation: z.enum(["spitzglass", "mueller"]).optional(),
  specificGravity: z.number().finite().min(0.3).max(3).optional(),
  heatingValueBtuPerCf: z.number().finite().min(100).max(4000).optional(),
  inletPressureInWc: z.number().finite().positive().max(300).optional(),
  allowableDropInWc: z.number().finite().positive().max(100).optional(),
  gasSizing: z.enum(["longest_run", "actual_length", "branch_length"]).optional(),
  gasType: z.enum(["natural", "propane"]).optional(),
  ...pipeSizingOverrideSchema,
});

/** Built-in values used when neither the project nor the firm gives one. General engineering values: verify for permit work. */
export const PIPE_DESIGN_DEFAULTS = {
  frictionMethod: "hazen_williams",
  fittingMethod: "k",
  waterTempF: 60,
  hotWaterTempF: 140,
  maxVelocityFps: 8,
  hotMaxVelocityFps: 5,
  demandMethod: "hunter_formula",
  slopes: [
    { maxNominalIn: 3, inPerFt: 0.25 },
    { maxNominalIn: 1000, inPerFt: 0.125 },
  ],
  fillRatio: 0.5,
  rainfallInPerHr: 2,
  gasEquation: "spitzglass",
  specificGravity: 0.6,
  heatingValueBtuPerCf: 1000,
  inletPressureInWc: 7,
  allowableDropInWc: 0.5,
  gasSizing: "longest_run",
  sizingMode: "check",
} as const;

/** Pitched legs steeper than this (1"/ft) are not "horizontal": drop them with a 1/8 bend instead. */
export const MAX_PITCH_IN_PER_FT = 1;

export type PipeServiceOf = PipeService | "vent";

/** What a system carries, for fitting choice, rules and hydraulics. */
export function serviceOf(kind: SystemKind): PipeServiceOf | null {
  return pipeFamilyOf(kind);
}

/** Gravity systems: horizontal pipe slopes, and the direction rules apply. */
export function isGravity(kind: SystemKind): boolean {
  return serviceOf(kind) === "drainage";
}

/** Firm values under the project's own: the project wins field by field. */
export function mergePipeDesign(firm: PipeDesign | undefined, project: PipeDesign | undefined): PipeDesign {
  return { ...(firm ?? {}), ...(project ?? {}) };
}

/** Minimum slope (in/ft) for a drain of this nominal size. */
export function minSlopeFor(nominalIn: number, design: PipeDesign | undefined): number {
  const bands = [...(design?.slopes ?? PIPE_DESIGN_DEFAULTS.slopes)].sort((a, b) => a.maxNominalIn - b.maxNominalIn);
  for (const b of bands) if (nominalIn <= b.maxNominalIn + 1e-6) return b.inPerFt;
  return bands[bands.length - 1]?.inPerFt ?? 0.125;
}

export function inPerFtLabel(v: number): string {
  const eighths = Math.round(v * 8 * 1000) / 1000;
  const named: Readonly<Record<string, string>> = { "1": "1/8", "2": "1/4", "4": "1/2", "8": "1", "0.5": "1/16", "3": "3/8" };
  return `${named[String(eighths)] ?? String(Math.round(v * 1000) / 1000)}" per ft`;
}

export type GasKind = "natural" | "propane";

/** Specific gravity and heating value: the system's, else the gas type's usual values (supplier values win when entered). */
export function gasProperties(design: PipeDesign): { gas: GasKind; specificGravity: number; heatingValueBtuPerCf: number } {
  const gas: GasKind = design.gasType ?? "natural";
  return {
    gas,
    specificGravity: design.specificGravity ?? (gas === "propane" ? 1.5 : PIPE_DESIGN_DEFAULTS.specificGravity),
    heatingValueBtuPerCf: design.heatingValueBtuPerCf ?? (gas === "propane" ? 2516 : PIPE_DESIGN_DEFAULTS.heatingValueBtuPerCf),
  };
}
