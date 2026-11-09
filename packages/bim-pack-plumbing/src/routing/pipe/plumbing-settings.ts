import { z } from "zod";
import { PIPE_DEMAND_CURVES, PIPE_SIZING_MODES, SYSTEM_KINDS, systemKindSchema, type PipeDemandCurve, type PipeSizingMode, type SystemKind } from "@permitzip/bim-kernel";

export { PIPE_SIZING_MODES, type PipeSizingMode } from "@permitzip/bim-kernel";

/**
 * (Round 12 P12: moved from the kernel; the stored `plumbing_settings` record
 * and its values are frozen.) Where the plumbing design choices the Plumbing tab exposes are kept. The
 * code tables and the curves themselves live in the calc packs
 * (packages/bim-calc plumbing settings); the kernel only stores the choices,
 * with the same values, so the ribbon, a system's properties, lint and the
 * sizing command all read one place:
 *
 * - **Project** (a catalog record, `plumbing_settings`, one per model):
 *   auto-sizing on or off, the building type, the demand curve.
 * - **System** (`design.pipe.sizingMode` / `design.pipe.demandCurve`): an
 *   override for one pipe system; absent, the project's applies.
 *
 * Auto-sizing never turns itself on: absent everywhere, it is "check" (audit
 * and suggest; nothing in the model changes).
 *
 * The project's pipe insulation schedule is kept here too: thickness by
 * system kind and pipe size band. The adopted energy code's table is not in
 * the code library, so the rows are the project's (or the firm's) own; the
 * edit that applies them (`set_pipe_insulation`) is one undo.
 */

/** Stored values the kernel's system design writer checks (`design.ts`); the same lists, under this add-on's names. */
export const PLUMBING_DEMAND_CURVES = PIPE_DEMAND_CURVES;
export type PlumbingDemandCurve = PipeDemandCurve;

export const DEMAND_CURVE_LABEL: Readonly<Record<PlumbingDemandCurve, string>> = {
  ashrae_a: "ASHRAE Curve A (restaurants)",
  ashrae_b: "ASHRAE Curve B (hospitals, hotels, dormitories)",
  ashrae_c: "ASHRAE Curve C (apartments)",
  ashrae_d: "ASHRAE Curve D (offices, schools)",
  ipc_e_tank: "IPC Appendix E, flush tanks",
  ipc_e_valve: "IPC Appendix E, flushometer valves",
  firm: "Firm curve",
  legacy_fit: "Hunter-style power fit (old default)",
};

export const PLUMBING_BUILDING_TYPES = ["restaurant", "hospital", "nursing_home", "dormitory", "hotel", "motel", "apartment", "office", "school", "other"] as const;
export type PlumbingBuildingType = (typeof PLUMBING_BUILDING_TYPES)[number];

export const BUILDING_TYPE_LABEL: Readonly<Record<PlumbingBuildingType, string>> = {
  restaurant: "Restaurant",
  hospital: "Hospital",
  nursing_home: "Nursing home",
  dormitory: "Dormitory",
  hotel: "Hotel",
  motel: "Motel",
  apartment: "Apartment building",
  office: "Office",
  school: "School",
  other: "Other",
};

/** The name the one project record is saved under. */
export const PLUMBING_SETTINGS_NAME = "Project";

/** One row of the pipe insulation schedule: pipes of these system kinds up to this nominal size (inches, inclusive of smaller rows' remainder) take this thickness; 0 means none. */
export const pipeInsulationRowSchema = z
  .object({
    systemKinds: z.array(systemKindSchema).min(1).max(SYSTEM_KINDS.length),
    /** Pipes smaller than this nominal size (inches) take the row; the last row for a kind can be 48 for "and larger". */
    belowNominalIn: z.number().positive().max(48),
    thicknessIn: z.number().min(0).max(6),
    material: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type PipeInsulationRow = z.infer<typeof pipeInsulationRowSchema>;

export const plumbingSettingsEntrySchema = z
  .object({
    type: z.literal("plumbing_settings"),
    name: z.literal(PLUMBING_SETTINGS_NAME).default(PLUMBING_SETTINGS_NAME),
    sizingMode: z.enum(PIPE_SIZING_MODES).default("check"),
    buildingType: z.enum(PLUMBING_BUILDING_TYPES).optional(),
    demandCurve: z.enum(PLUMBING_DEMAND_CURVES).optional(),
    /** Pipe insulation by system kind and size band; absent: no schedule yet. */
    pipeInsulation: z.array(pipeInsulationRowSchema).max(80).optional(),
    /** Where the schedule's values come from, in words ("IECC 2021 Table C403.12.3 via the firm's spec"). */
    pipeInsulationSource: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type PlumbingSettingsEntry = z.infer<typeof plumbingSettingsEntrySchema>;

export const DEFAULT_PLUMBING_SETTINGS_ENTRY: PlumbingSettingsEntry = { type: "plumbing_settings", name: PLUMBING_SETTINGS_NAME, sizingMode: "check" };

/**
 * The project record and a system override in the shape the calc pack's
 * `resolveSizingMode` / `resolveDemandCurve` take (packages/bim-calc
 * plumbing settings), so the kernel never decides the mode on its own.
 */
export function sizingInputs(
  project: PlumbingSettingsEntry | null,
  system: { readonly sizingMode?: PipeSizingMode | null; readonly demandCurve?: PlumbingDemandCurve | null } | null | undefined,
): { readonly project: { readonly sizing_mode: PipeSizingMode; readonly building_type?: PlumbingBuildingType; readonly demand_curve?: PlumbingDemandCurve }; readonly system: { readonly sizing_mode?: PipeSizingMode; readonly demand_curve?: PlumbingDemandCurve } } {
  const p = project ?? DEFAULT_PLUMBING_SETTINGS_ENTRY;
  return {
    project: { sizing_mode: p.sizingMode, ...(p.buildingType ? { building_type: p.buildingType } : {}), ...(p.demandCurve ? { demand_curve: p.demandCurve } : {}) },
    system: { ...(system?.sizingMode ? { sizing_mode: system.sizingMode } : {}), ...(system?.demandCurve ? { demand_curve: system.demandCurve } : {}) },
  };
}

/**
 * The schedule's insulation for one pipe: the first row for its system kind
 * whose band the size is below (rows are read smallest band first). Null:
 * the schedule says nothing for this pipe; `{ thicknessIn: 0 }`: it says none.
 */
export function scheduledPipeInsulation(rows: readonly PipeInsulationRow[] | undefined, kind: SystemKind, nominalIn: number): { readonly thicknessIn: number; readonly material?: string } | null {
  const mine = (rows ?? []).filter((r) => r.systemKinds.includes(kind)).sort((a, b) => a.belowNominalIn - b.belowNominalIn);
  const row = mine.find((r) => nominalIn < r.belowNominalIn - 1e-9) ?? null;
  return row ? { thicknessIn: row.thicknessIn, ...(row.material ? { material: row.material } : {}) } : null;
}
