import type { PipeDesign } from "@permitzip/bim-kernel";
import { z } from "zod";
import { ipcCite, type IpcEdition, ifgcCite, type IfgcEdition, GAS_PROPERTIES, ipcTables } from "@permitzip/bim-calc";
import { ASHRAE_CURVES, BUILDING_TYPES, defaultDemandCurve, firmCurve, LEGACY_FIT, type BuildingType, type CurvePoint, type DemandCurve, type DemandCurveId } from "../packs/hunter/curves";
import type { GasKind, Citation } from "@permitzip/bim-calc";

const { TABLE_704_1, TABLE_709_1, TABLE_710_1_1, TABLE_710_1_1_SLOPES, TABLE_710_1_2 } = ipcTables;

/**
 * Plumbing design settings and the pack → kernel adapter.
 *
 * Sizing mode: "check" (the default) audits every pipe and suggests sizes;
 * nothing in the model changes. "auto" lets the sizing command apply the
 * suggestions as the model changes. The project sets a default; each pipe
 * system can override it. The Plumbing tab's on/off toggle (ribbon and the
 * system's properties) reads and writes exactly these fields.
 */

export const SIZING_MODES = ["check", "auto"] as const;
export type SizingMode = (typeof SIZING_MODES)[number];

export const DEMAND_CURVE_IDS = ["ashrae_a", "ashrae_b", "ashrae_c", "ashrae_d", "ipc_e_tank", "ipc_e_valve", "firm", "legacy_fit"] as const;

const curvePoint = z.object({ wsfu: z.number().finite().min(0).max(100_000), gpm: z.number().finite().min(0).max(100_000) }).strict();

export const plumbingSettingsSchema = z
  .object({
    sizing_mode: z.enum(SIZING_MODES).default("check").describe("check: audit and suggest sizes (default). auto: apply suggested sizes as the model changes."),
    building_type: z.enum(BUILDING_TYPES).optional().describe("Picks the default demand curve: restaurant → ASHRAE Curve A, hospital / hotel / dormitory → B, apartment → C, office / school → D."),
    demand_curve: z.enum(DEMAND_CURVE_IDS).optional().describe("Overrides the building type's curve."),
    firm_curve_points: z.array(curvePoint).min(2).max(200).optional().describe("Points for demand_curve firm / ipc_e_tank / ipc_e_valve."),
    firm_curve_note: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const systemSizingOverrideSchema = z.object({ sizing_mode: z.enum(SIZING_MODES).optional(), demand_curve: z.enum(DEMAND_CURVE_IDS).optional() }).strict();

export type PlumbingSettings = z.output<typeof plumbingSettingsSchema>;
export type SystemSizingOverride = z.output<typeof systemSizingOverrideSchema>;

export const DEFAULT_PLUMBING_SETTINGS: PlumbingSettings = { sizing_mode: "check" };

/** The system's own mode if it set one, else the project's, else "check". Auto-sizing never turns itself on. */
export function resolveSizingMode(project: Pick<PlumbingSettings, "sizing_mode"> | null | undefined, system: SystemSizingOverride | null | undefined): { readonly mode: SizingMode; readonly from: "system" | "project" | "default" } {
  if (system?.sizing_mode) return { mode: system.sizing_mode, from: "system" };
  if (project?.sizing_mode) return { mode: project.sizing_mode, from: "project" };
  return { mode: "check", from: "default" };
}

/**
 * The demand curve a system uses: the system's choice, else the project's,
 * else the building type's default. Null with a reason when nothing decides
 * (the caller asks the engineer rather than falling back to the old fit).
 */
export function resolveDemandCurve(project: PlumbingSettings | null | undefined, system?: SystemSizingOverride | null): { readonly curve: DemandCurve; readonly from: "system" | "project" | "building_type" } | { readonly reason: string } {
  const id: DemandCurveId | undefined = system?.demand_curve ?? project?.demand_curve;
  const from = system?.demand_curve ? "system" : "project";
  if (id) {
    const curve = curveById(id, project?.firm_curve_points, project?.firm_curve_note);
    return "reason" in curve ? curve : { curve, from };
  }
  if (project?.building_type) {
    const d = defaultDemandCurve(project.building_type);
    if (d) return { curve: ASHRAE_CURVES[d], from: "building_type" };
    return { reason: `No default demand curve for building type "${project.building_type}". Choose one: ASHRAE Curve A (restaurants), B (hospitals, hotels, dormitories), C (apartments), D (offices, schools), or import the IPC Appendix E table.` };
  }
  return { reason: "Choose a demand curve or give the building type (restaurant, hospital, hotel, apartment, office, school…)." };
}

export function curveById(id: DemandCurveId, firmPoints?: readonly CurvePoint[], firmNote?: string): DemandCurve | { readonly reason: string } {
  switch (id) {
    case "ashrae_a":
    case "ashrae_b":
    case "ashrae_c":
    case "ashrae_d":
      return ASHRAE_CURVES[id];
    case "legacy_fit":
      return LEGACY_FIT;
    case "firm":
    case "ipc_e_tank":
    case "ipc_e_valve":
      if (!firmPoints || firmPoints.length < 2) return { reason: id === "firm" ? "The firm demand curve needs its points (fixture units and gpm)." : "IPC Appendix E (Table E103.3(3)) is not in the code library. Import it once as points (fixture units, gpm) from the firm's adopted copy." };
      return firmCurve(id, firmPoints, firmNote ?? "firm-entered points");
  }
}

export interface PlumbingDesignRequest {
  readonly ipc: IpcEdition;
  readonly ifgc?: IfgcEdition | null;
  readonly settings?: PlumbingSettings | null;
  /** Gas for the system's gas inputs. */
  readonly gas?: { readonly kind: GasKind; readonly inletPressureInWc: number; readonly allowableDropInWc: number; readonly heatingValueBtuPerCf?: number } | null;
  /** Firm fixture values (water supply fixture units are not in the code library). */
  readonly fixtures?: ReadonlyArray<{ readonly fixture: string; readonly wsfu?: number; readonly dfu?: number; readonly mbh?: number }>;
}

export interface PlumbingDesignResult {
  /** What the kernel's pipe reports accept. */
  readonly design: PipeDesign;
  readonly demandCurve: DemandCurve | null;
  readonly demandCurveNote: string | null;
  readonly sizingMode: SizingMode;
  readonly citations: readonly Citation[];
}

/**
 * The pack as the kernel's `PipeDesign`: demand table from the chosen curve,
 * fixture table (DFU from Table 709.1 under the firm's names, the firm's
 * WSFU), minimum slopes from Table 704.1, DFU capacities from Tables
 * 710.1(1) (building drain, by slope) and 710.1(2) (stacks), gas inputs. The
 * kernel stays table-free: this is the only place those values enter it.
 */
export function plumbingDesignFromPack(req: PlumbingDesignRequest): PlumbingDesignResult {
  const citations: Citation[] = [ipcCite(req.ipc, "drain_slope"), ipcCite(req.ipc, "building_drain"), ipcCite(req.ipc, "branch_stack")];
  const resolved = resolveDemandCurve(req.settings ?? null);
  const curve = "curve" in resolved ? resolved.curve : null;
  if (curve) citations.push(curve.cite);
  const capacityTable: Array<{ nominalIn: number; inPerFt?: number; maxDfu: number }> = [];
  for (const row of TABLE_710_1_1) {
    row.maxDfu.forEach((max, i) => {
      const slope = TABLE_710_1_1_SLOPES[i];
      if (max !== null && slope !== undefined) capacityTable.push({ nominalIn: row.nominalIn, inPerFt: slope, maxDfu: max });
    });
  }
  for (const row of TABLE_710_1_2) if (row.stackOver3 !== null) capacityTable.push({ nominalIn: row.nominalIn, maxDfu: row.stackOver3 });
  const fixtureTable = (req.fixtures ?? []).map((f) => {
    const dfu = f.dfu ?? TABLE_709_1.find((r) => r.fixture.toLowerCase() === f.fixture.toLowerCase())?.dfu ?? undefined;
    return { fixture: f.fixture, ...(f.wsfu !== undefined ? { wsfu: f.wsfu } : {}), ...(dfu !== undefined && dfu !== null ? { dfu } : {}), ...(f.mbh !== undefined ? { mbh: f.mbh } : {}) };
  });
  const design: PipeDesign = {
    slopes: TABLE_704_1.map((s) => ({ maxNominalIn: s.maxNominalIn, inPerFt: s.inPerFt })),
    capacityTable,
    ...(fixtureTable.length > 0 ? { fixtureTable } : {}),
    ...(curve && curve.id !== "legacy_fit" ? { demandMethod: "table" as const, demandTable: curve.points.map((p) => ({ fu: p.wsfu, gpm: p.gpm })) } : {}),
    ...(req.gas
      ? {
          specificGravity: GAS_PROPERTIES[req.gas.kind].specificGravity,
          heatingValueBtuPerCf: req.gas.heatingValueBtuPerCf ?? GAS_PROPERTIES[req.gas.kind].heatingValueBtuPerCf,
          inletPressureInWc: req.gas.inletPressureInWc,
          allowableDropInWc: req.gas.allowableDropInWc,
          gasSizing: "longest_run" as const,
        }
      : {}),
  };
  if (req.gas && req.ifgc) citations.push(ifgcCite(req.ifgc, "longest_length"));
  return { design, demandCurve: curve, demandCurveNote: "reason" in resolved ? resolved.reason : null, sizingMode: resolveSizingMode(req.settings ?? null, null).mode, citations };
}

export type { BuildingType };
