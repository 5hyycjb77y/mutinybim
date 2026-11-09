import { z } from "zod";
// Not re-exported from the kernel's package root yet (k0 owns src/index.ts); the patch is an internal design note.
import { backwaterVerdict, gravityDrainCapacity, gravityLimit, gravityVerdict, pumpAgainstInflow, smallestGravityDrain, type GravityCapacityTable } from "../../drainage";
import { ipcCite, isIpcEdition, type IpcEdition, methodCite, defineCalc, round, ipcTables } from "@permitzip/bim-calc";
import type { CalcIssue, CalcStep, CalcValue, Citation, CodeEdition } from "@permitzip/bim-calc";

const { BUILDING_DRAIN_MIN_WITH_WC_IN, TABLE_704_1, TABLE_710_1_1, TABLE_710_1_1_SLOPES } = ipcTables;

/**
 * Building sewer checks below grade (ROADMAP P4, 6144 review `1c289b72`):
 *
 *   - which floors can drain to the sewer by gravity, given the sewer (or
 *     manhole outlet) invert, the building drain's slope and length (IPC 712.1:
 *     what can't goes to a sump and a sewage pump or ejector);
 *   - which floors sit below the next upstream manhole cover and need a
 *     backwater valve, and which must not discharge through one (IPC 715.1);
 *   - fixture units arriving at the connection against the building drain at its
 *     size and slope (IPC Table 710.1(1)): "394 DFU on a 4 in. drain at 1/8 in/ft;
 *     that size carries 180 at that slope";
 *   - a sewage pump's rating against the engineer's inflow and head. Fixture
 *     units are never converted to gallons per minute (product decision 7):
 *     the check asks for the flow.
 *
 * The arithmetic is the kernel's (`bim-kernel/src/drainage`), so the lint pack
 * and these calcs agree; this file supplies the code tables and the citations.
 */

const GIVEN: Citation = methodCite("Given", "input value");
const FT_MM = 304.8;

type DrainageClause = "subdrain" | "pump_capacity" | "backwater";
const DRAINAGE_CLAUSES: Readonly<Record<DrainageClause, string>> = { subdrain: "712.1", pump_capacity: "712.4.2", backwater: "715.1" };

/** Same shape as `ipcCite`, for the clauses this check adds (sections the plumbing pack's tables don't list). */
export function drainageCite(ed: IpcEdition, clause: DrainageClause, detail?: string): Citation {
  const where = ed.adoption.libraryText ? `${ed.edition} IPC as amended by Virginia` : `${ed.edition} IPC; check local amendments`;
  const at = DRAINAGE_CLAUSES[clause];
  return { source: "code", code: ed.code, edition: ed.edition, clause: at, ...(detail ? { detail } : {}), text: `${ed.code} ${ed.edition} ${at}${detail ? `, ${detail}` : ""} (${where})` };
}

function ipcOf(code: CodeEdition | null): IpcEdition {
  if (!isIpcEdition(code)) throw new Error("This check needs the plumbing code pack; the registry resolves it from the edition, the project's Code Study, or the state.");
  return code;
}

/** IPC Table 710.1(1) in the kernel's table shape: building drains and sewers by size and slope. */
export const IPC_BUILDING_DRAIN_CAPACITY: GravityCapacityTable = { rows: TABLE_710_1_1, slopes: TABLE_710_1_1_SLOPES };

/** IPC Table 704.1: the least slope of horizontal drainage pipe for its size (in/ft). */
export function ipcMinDrainSlope(nominalIn: number): number {
  return TABLE_704_1.find((b) => nominalIn <= b.maxNominalIn + 1e-9)?.inPerFt ?? 0.0625;
}

const slopeText = (s: number) => (s === 0.0625 ? "1/16" : s === 0.125 ? "1/8" : s === 0.25 ? "1/4" : s === 0.5 ? "1/2" : String(round(s, 4)));
const sizeText = (n: number) => (Number.isInteger(n) ? `${n}` : n === 1.25 ? "1-1/4" : n === 1.5 ? "1-1/2" : n === 2.5 ? "2-1/2" : String(n));
const ftText = (ft: number) => {
  const sign = ft < 0 ? "-" : "";
  const inches = Math.round(Math.abs(ft) * 12);
  return `${sign}${Math.floor(inches / 12)}'-${inches % 12}"`;
};

// ------------------------------------------------------------------ building sewer

const protection = z.enum(["none", "sewage_pump", "backwater_valve", "sewage_pump_with_backwater_valve"]);

const sewerInput = z
  .object({
    sewer_invert_ft: z.number().min(-1000).max(1000).describe("Invert of the sewer or manhole outlet the building drain discharges into, ft, on the same datum as the floors."),
    sewer_rim_ft: z.number().min(-1000).max(1000).optional().describe("Cover of the next upstream manhole in the public sewer (or the sewer's overflow level), ft. Gives the backwater valve check."),
    elevation_confidence: z.enum(["verified", "assumed", "field_verify"]).default("assumed").describe("How the invert and rim are known."),
    building_drain_size_in: z.number().positive().max(48).optional().describe("Nominal size of the building drain or sewer; gives the capacity check."),
    building_drain_slope_in_per_ft: z.number().positive().max(1).optional().describe("Its slope; default the Table 704.1 least slope for its size."),
    building_drain_length_ft: z.number().min(0).max(10_000).optional().describe("Developed length from the farthest floor to the connection; adds the fall the drain needs."),
    depth_below_floor_in: z.number().min(0).max(240).default(0).describe("From a floor down to the drain invert under it (trap, fitting and cover)."),
    serves_water_closet: z.boolean().default(true),
    floors: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            floor_ft: z.number().min(-1000).max(10_000),
            dfu: z.number().min(0).max(100_000).default(0),
            drains_to: protection.default("none").describe("What its drains already go through."),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    dfu: z.number().min(0).max(100_000).optional().describe("Fixture units arriving at the connection; default the floors' sum."),
  })
  .strict();

export interface SewerFloorResult {
  readonly name: string;
  readonly floorFt: number;
  readonly dfu: number;
  readonly gravity: "gravity" | "needs_pump";
  readonly backwater: "below_rim" | "above_rim" | "unknown";
  readonly needsPump: boolean;
  readonly needsBackwaterValve: boolean;
  readonly mustNotUseBackwaterValve: boolean;
}

export interface BuildingSewerDetail {
  readonly gravityLimitFt: number;
  readonly floors: readonly SewerFloorResult[];
  readonly dfu: number;
  readonly capacity: { readonly sizeIn: number; readonly slopeInPerFt: number; readonly tableSlope: number | null; readonly maxDfu: number | null; readonly over: boolean; readonly smallestIn: number | null } | null;
}

export const buildingSewerCalc = defineCalc({
  id: "plumbing.building_sewer",
  version: "1.0.0",
  domain: "plumbing",
  title: "Building sewer: gravity, backwater valves and drain capacity",
  summary: "Which floors drain to the sewer by gravity (712.1: the rest need a sewage pump or ejector), which sit below the next upstream manhole cover and need a backwater valve (715.1), and the fixture units at the connection against the building drain's size and slope (Table 710.1(1)).",
  codeFamily: "ipc",
  needsModel: false,
  input: sewerInput,
  example: { sewer_invert_ft: -8.5, sewer_rim_ft: -2, building_drain_size_in: 4, building_drain_slope_in_per_ft: 0.125, building_drain_length_ft: 60, floors: [{ name: "Level 1", floor_ft: 0, dfu: 150 }, { name: "Level 2", floor_ft: 12, dfu: 20 }] },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const steps: CalcStep[] = [];
    const issues: CalcIssue[] = [];
    const values: CalcValue[] = [];
    const size = input.building_drain_size_in ?? null;
    const slope = input.building_drain_slope_in_per_ft ?? (size !== null ? ipcMinDrainSlope(size) : null);
    const slopeCite = [ipcCite(ed, "drain_slope")];
    if (input.building_drain_slope_in_per_ft === undefined && size !== null && slope !== null) steps.push({ label: "Slope", detail: `No slope given: ${slopeText(slope)} in/ft, the least slope for ${sizeText(size)} in.`, cite: slopeCite });
    if (input.building_drain_slope_in_per_ft !== undefined && size !== null && input.building_drain_slope_in_per_ft < ipcMinDrainSlope(size) - 1e-9) {
      issues.push({ severity: "error", message: `${slopeText(input.building_drain_slope_in_per_ft)} in/ft is below the ${slopeText(ipcMinDrainSlope(size))} in/ft least slope for a ${sizeText(size)} in. drain.`, cite: slopeCite });
    }

    const limit = gravityLimit({ sewerInvertMm: input.sewer_invert_ft * FT_MM, slopeInPerFt: slope, lengthMm: input.building_drain_length_ft === undefined ? null : input.building_drain_length_ft * FT_MM });
    const limitFt = limit.limitMm / FT_MM;
    const subdrain = [drainageCite(ed, "subdrain")];
    steps.push({
      label: "Lowest drain that reaches the sewer",
      detail: limit.fallKnown
        ? `Sewer invert ${ftText(input.sewer_invert_ft)} + ${slopeText(slope ?? 0)} in/ft × ${round(input.building_drain_length_ft ?? 0, 1)} ft = ${round(limit.fallMm / 25.4, 1)} in. of fall: ${ftText(limitFt)}`
        : `Sewer invert ${ftText(input.sewer_invert_ft)}; no ${slope === null ? "slope" : "length"} given, so no fall is added`,
      cite: limit.fallKnown ? [...subdrain, ...slopeCite] : subdrain,
    });
    values.push({ key: "gravity_limit_ft", label: "Lowest drain invert that drains by gravity", value: round(limitFt, 2), unit: "ft", cite: subdrain });
    if (input.elevation_confidence !== "verified") {
      issues.push({ severity: "warning", message: `The sewer invert${input.sewer_rim_ft !== undefined ? " and rim are" : " is"} ${input.elevation_confidence === "assumed" ? "assumed" : "to be verified in the field"}: have the contractor verify ${input.sewer_rim_ft !== undefined ? "them" : "it"} before rough-in.`, cite: [GIVEN] });
    }

    const backwaterCite = [drainageCite(ed, "backwater")];
    const floors: SewerFloorResult[] = input.floors.map((f) => {
      const drainInvertFt = f.floor_ft - input.depth_below_floor_in / 12;
      const gravity = gravityVerdict(drainInvertFt * FT_MM, limit.limitMm) === "gravity" ? "gravity" : "needs_pump";
      const backwater = backwaterVerdict(f.floor_ft * FT_MM, input.sewer_rim_ft === undefined ? null : input.sewer_rim_ft * FT_MM);
      const pumped = f.drains_to === "sewage_pump" || f.drains_to === "sewage_pump_with_backwater_valve";
      const valved = f.drains_to === "backwater_valve" || f.drains_to === "sewage_pump_with_backwater_valve";
      const r: SewerFloorResult = {
        name: f.name,
        floorFt: f.floor_ft,
        dfu: f.dfu,
        gravity,
        backwater,
        needsPump: gravity === "needs_pump" && !pumped,
        needsBackwaterValve: backwater === "below_rim" && !valved,
        mustNotUseBackwaterValve: backwater === "above_rim" && valved && !pumped,
      };
      const where = `${f.name} (floor ${ftText(f.floor_ft)}${input.depth_below_floor_in > 0 ? `, drain ${ftText(drainInvertFt)}` : ""})`;
      steps.push({ label: f.name, detail: `${where}: ${gravity === "gravity" ? "drains by gravity" : `below ${ftText(limitFt)}, can't drain by gravity`}${backwater === "below_rim" ? `; below the manhole cover ${ftText(input.sewer_rim_ft ?? 0)}` : ""}`, cite: backwater === "unknown" ? subdrain : [...subdrain, ...backwaterCite] });
      if (r.needsPump) issues.push({ severity: "error", message: `${where} can't drain to the sewer by gravity: it needs a sump and a sewage pump or ejector.`, cite: subdrain });
      if (r.needsBackwaterValve) issues.push({ severity: "error", message: `${where} is below the next upstream manhole cover (${ftText(input.sewer_rim_ft ?? 0)}): it needs a backwater valve.`, cite: backwaterCite });
      if (r.mustNotUseBackwaterValve) issues.push({ severity: "warning", message: `${where} is above the manhole cover, so it must not discharge through the backwater valve.`, cite: backwaterCite });
      return r;
    });

    const dfu = input.dfu ?? floors.reduce((s, f) => s + f.dfu, 0);
    values.push({ key: "dfu", label: "Fixture units at the connection", value: round(dfu, 2), unit: "dfu", cite: input.dfu === undefined && floors.length > 0 ? [methodCite("Sum", "the floors' fixture units")] : [GIVEN] });

    let capacity: BuildingSewerDetail["capacity"] = null;
    if (size !== null && slope !== null) {
      const drainCite = [ipcCite(ed, "building_drain")];
      const c = gravityDrainCapacity(IPC_BUILDING_DRAIN_CAPACITY, size, slope);
      const minIn = input.serves_water_closet ? BUILDING_DRAIN_MIN_WITH_WC_IN : 0;
      const smallest = smallestGravityDrain(IPC_BUILDING_DRAIN_CAPACITY, dfu, slope, minIn);
      const over = c.maxDfu === null || c.maxDfu < dfu - 1e-9;
      capacity = { sizeIn: size, slopeInPerFt: slope, tableSlope: c.tableSlope, maxDfu: c.maxDfu, over, smallestIn: smallest?.nominalIn ?? null };
      values.push({ key: "capacity_dfu", label: `Capacity of a ${sizeText(size)} in. drain at ${slopeText(slope)} in/ft`, value: c.maxDfu, unit: "dfu", cite: drainCite });
      values.push({ key: "over_capacity", label: "Over capacity", value: over, unit: null, cite: drainCite });
      const carries = c.maxDfu === null ? `that size isn't permitted at ${slopeText(slope)} in/ft` : `that size carries ${c.maxDfu} at ${slopeText(c.tableSlope ?? slope)} in/ft`;
      steps.push({ label: "Building drain", detail: `${round(dfu, 2)} DFU on a ${sizeText(size)} in. drain at ${slopeText(slope)} in/ft; ${carries}`, cite: drainCite });
      if (over) issues.push({ severity: "error", message: `${round(dfu, 2)} DFU on a ${sizeText(size)} in. drain at ${slopeText(slope)} in/ft; ${carries}.${smallest ? ` ${sizeText(smallest.nominalIn)} in. carries ${smallest.maxDfu} at that slope.` : ""}`, cite: drainCite });
      if (size < minIn - 1e-9) issues.push({ severity: "error", message: `A building drain serving a water closet is ${minIn} in. at least.`, cite: drainCite });
    }

    return { values, steps, issues, detail: { gravityLimitFt: round(limitFt, 3), floors, dfu, capacity } satisfies BuildingSewerDetail };
  },
});

// ------------------------------------------------------------------ sewage pump

const pumpInput = z
  .object({
    inflow_gpm: z.number().positive().max(100_000).optional().describe("The inflow you design the pump for. Fixture units are not converted to a flow; give the gpm."),
    head_ft: z.number().min(0).max(2000).optional().describe("Total head the pump lifts against (static lift plus friction)."),
    rated_gpm: z.number().positive().max(100_000).optional().describe("The pump's rated flow at its rated head."),
    rated_head_ft: z.number().min(0).max(2000).optional(),
    dfu: z.number().min(0).max(100_000).optional().describe("Fixture units draining to it, shown beside the check (never converted)."),
  })
  .strict();

export type SewagePumpDetail = ReturnType<typeof pumpAgainstInflow>;

export const sewagePumpCalc = defineCalc({
  id: "plumbing.sewage_pump",
  version: "1.0.0",
  domain: "plumbing",
  title: "Sewage pump or ejector against its inflow",
  summary: "The engineer's inflow (gpm) and head against the pump's rating point (712.4.2: capacity and head for the application). Fixture units are shown but not converted to a flow; without a gpm the check asks for one.",
  codeFamily: "ipc",
  needsModel: false,
  input: pumpInput,
  example: { inflow_gpm: 40, head_ft: 22, rated_gpm: 50, rated_head_ft: 25, dfu: 24 },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const cite = [drainageCite(ed, "pump_capacity")];
    const steps: CalcStep[] = [];
    const issues: CalcIssue[] = [];
    const values: CalcValue[] = [];
    if (input.dfu !== undefined) values.push({ key: "dfu", label: "Fixture units draining to it", value: round(input.dfu, 2), unit: "dfu", cite: [GIVEN] });
    const verdict = pumpAgainstInflow({ inflowGpm: input.inflow_gpm ?? null, headFt: input.head_ft ?? null, ratedGpm: input.rated_gpm ?? null, ratedHeadFt: input.rated_head_ft ?? null });
    switch (verdict.kind) {
      case "inflow_unknown":
        issues.push({ severity: "error", message: `Can't be calculated from fixture units${input.dfu !== undefined ? ` (${round(input.dfu, 2)} DFU)` : ""}; enter the inflow in gpm.`, cite });
        break;
      case "head_unknown":
        issues.push({ severity: "error", message: "Enter the total head the pump lifts against, in feet.", cite });
        break;
      case "rating_unknown":
        issues.push({ severity: "error", message: `Enter the pump's rated ${verdict.missing.join(" and ")} (from its curve or cut sheet).`, cite });
        break;
      case "ok":
      case "undersized": {
        const inflow = input.inflow_gpm ?? 0;
        const head = input.head_ft ?? 0;
        steps.push({ label: "Flow", detail: `${round(inflow, 1)} gpm in; the pump is rated ${round(input.rated_gpm ?? 0, 1)} gpm at ${round(input.rated_head_ft ?? 0, 1)} ft`, cite });
        steps.push({ label: "Head", detail: `${round(head, 1)} ft needed; rated ${round(input.rated_head_ft ?? 0, 1)} ft`, cite });
        values.push({ key: "flow_spare_gpm", label: "Spare flow", value: round(verdict.flow.spare, 1), unit: "gpm", cite });
        values.push({ key: "head_spare_ft", label: "Spare head", value: round(verdict.head.spare, 1), unit: "ft", cite });
        values.push({ key: "pump_ok", label: "Pump covers the inflow", value: verdict.kind === "ok", unit: null, cite });
        if (!verdict.flow.ok) issues.push({ severity: "error", message: `${round(inflow, 1)} gpm in, but the pump is rated ${round(input.rated_gpm ?? 0, 1)} gpm: ${round(-verdict.flow.spare, 1)} gpm short.`, cite });
        if (!verdict.head.ok) issues.push({ severity: "error", message: `${round(head, 1)} ft of head needed, but the pump is rated at ${round(input.rated_head_ft ?? 0, 1)} ft.`, cite });
        break;
      }
    }
    return { values, steps, issues, detail: verdict };
  },
});

export const DRAINAGE_CALCS = [buildingSewerCalc, sewagePumpCalc] as const;
