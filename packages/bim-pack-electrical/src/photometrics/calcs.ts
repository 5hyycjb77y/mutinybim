import { z } from "zod";
import { defineCalc, round, type CalcIssue, type CalcStep, type CalcValue, type Citation } from "@permitzip/bim-calc";
import {
  evaluateEgressPhotometrics,
  evaluateNormalPhotometrics,
  type PhotometricsEgressResult,
  type PhotometricsNormalResult,
} from "./calc";
import { DEFAULT_BATTERY_90MIN_DERATE } from "./parameters";
import { NFPA101_IBC_EGRESS_THRESHOLDS } from "./standards";

/**
 * First-class photometric calculations registered on `CALC_POINT`:
 * - `electrical.photometrics_normal`: IES LM-63 point-by-point + inter-reflectance room illuminance & ASHRAE 90.1 LPD
 * - `electrical.photometrics_egress`: NFPA 101 §7.9.2.1 & IBC §1008.3.5 emergency egress lighting (initial & 90-min)
 */

const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

const reflectancesSchema = z
  .object({
    ceiling: z.number().finite().min(0).max(0.98).optional(),
    wall: z.number().finite().min(0).max(0.98).optional(),
    floor: z.number().finite().min(0).max(0.98).optional(),
  })
  .strict();

const customZoneSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    levelId: z.string().min(1).max(120).optional(),
    levelName: z.string().min(1).max(120).optional(),
    outline: z.array(vec2Schema).min(3).max(200),
    occupancyType: z.string().min(1).max(80).optional(),
    workplaneHeightIn: z.number().finite().min(0).max(120).optional(),
    ceilingHeightMm: z.number().finite().min(1500).max(20000).optional(),
    reflectances: reflectancesSchema.optional(),
  })
  .strict();

const explicitEgressPathSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    levelId: z.string().min(1).max(120).optional(),
    levelName: z.string().min(1).max(120).optional(),
    outline: z.array(vec2Schema).min(3).max(200).optional(),
    polyline: z.array(vec2Schema).min(2).max(200).optional(),
    widthFt: z.number().finite().min(1).max(30).optional(),
  })
  .strict();

const calculationModeSchema = z.enum(["simplified", "detailed", "surfaces"]);
const radiosityMethodSchema = z.enum(["patch_radiosity", "cavity"]);
const daylightSchema = z
  .object({
    enabled: z.boolean().default(true),
    skyModel: z.enum(["cie_overcast", "cie_clear", "cie_intermediate"]).optional(),
    outdoorHorizontalFc: z.number().finite().min(50).max(20000).optional(),
    sunAzimuthDeg: z.number().finite().min(0).max(360).optional(),
    sunElevationDeg: z.number().finite().min(1).max(89).optional(),
    directSunNormalFc: z.number().finite().min(0).max(15000).optional(),
    includeElectric: z.boolean().optional(),
  })
  .strict();

export const photometricsNormalInput = z
  .object({
    level: z.string().trim().min(1).max(120).optional().describe("Optional level ID or name filter."),
    spaceIds: z.array(z.string().min(1).max(120)).max(500).optional().describe("Optional list of space or room IDs to evaluate."),
    gridSpacingFt: z.number().finite().min(0.5).max(20).default(2).describe("Calculation grid spacing in feet (default 2 ft)."),
    workplaneHeightIn: z.number().finite().min(0).max(120).optional().describe('Workplane height AFF in inches (defaults to 30" for occupied rooms, 0" for corridors/stairs).'),
    calculationMode: calculationModeSchema.optional().describe('Calculation mode: "simplified" (shell-only empty space plane), "detailed" (default — Materials Library reflectances, glazing transmittance, furniture & stair occlusion), or "surfaces" (also evaluates actual kitchen counters, tables, vanities & 3D stair treads).'),
    useMaterialReflectances: z.boolean().optional().describe("Derive room ceiling/wall/floor reflectances from Materials Library assignments."),
    includeFurnitureOcclusion: z.boolean().optional().describe("Include furniture, casework, kitchen counters & equipment in 3D ray occlusion."),
    includeTaskSurfaces: z.boolean().optional().describe("Evaluate fine-grid illuminance directly on kitchen counters, islands, worktables, vanities & 3D stair treads."),
    interReflectance: z.boolean().default(true).describe("Include diffuse inter-reflectance (default true)."),
    radiosityMethod: radiosityMethodSchema.optional().describe('Inter-reflectance solver: "patch_radiosity" (default in detailed/surfaces — 4-bounce spatially-resolved patch radiosity) or "cavity" (uniform room-average cavity method).'),
    daylight: daylightSchema.optional().describe("Optional CIE sky dome + direct solar daylight contribution through windows, glazed curtain walls, and skylights."),
    reflectances: reflectancesSchema.optional().describe("Explicit ceiling/wall/floor reflectances overriding Materials Library & defaults."),
    zones: z.array(customZoneSchema).max(100).optional().describe("Optional custom calculation zones."),
    zonesOnly: z.boolean().optional().describe("Evaluate only `zones`, skipping auto-discovered model spaces."),
  })
  .strict();

export const photometricsEgressInput = z
  .object({
    level: z.string().trim().min(1).max(120).optional().describe("Optional level ID or name filter."),
    gridSpacingFt: z.number().finite().min(0.5).max(20).default(2).describe("Floor calculation grid spacing in feet (default 2 ft)."),
    workplaneHeightIn: z.number().finite().min(0).max(120).default(0).describe('Evaluation height AFF in inches (default 0" floor plane per NFPA 101 §7.9.2.1).'),
    calculationMode: calculationModeSchema.optional().describe('Calculation mode: "simplified" (empty egress plane) or "detailed" (default — includes furniture & 3D multi-flight stair treads).'),
    includeFurnitureOcclusion: z.boolean().optional().describe("Include furniture/casework occlusion along egress paths."),
    interReflectance: z.boolean().default(false).describe("Include diffuse inter-reflectance (default false — conservative direct-only per NFPA 101 practice)."),
    reflectances: reflectancesSchema.optional().describe("Optional room surface reflectances when interReflectance is enabled."),
    battery90MinDerate: z.number().finite().min(0.1).max(1).default(DEFAULT_BATTERY_90MIN_DERATE).describe("90-minute battery end-of-discharge derate factor (default 0.60)."),
    egressPaths: z.array(explicitEgressPathSchema).max(100).optional().describe("Optional explicit egress path polygons or polylines."),
    explicitOnly: z.boolean().optional().describe("Evaluate only explicit `egressPaths`, skipping auto-derived corridor/stair/exit-discharge zones."),
  })
  .strict();

const CITE_IES_LM63: Citation = {
  source: "method",
  code: "ANSI/IES LM-63-19",
  edition: "2019",
  clause: "§5",
  text: "ANSI/IES LM-63-19 §5, photometric web format and Type C interpolation",
};

const CITE_IES_HB: Citation = {
  source: "design_criteria",
  code: "IES Lighting Handbook",
  edition: "10th Ed.",
  clause: "Ch. 9 & 22",
  text: "IES Lighting Handbook (10th Ed.) Ch. 9 & 22, point-by-point illuminance and space targets",
};

const CITE_ASHRAE_901: Citation = {
  source: "code",
  code: "ASHRAE 90.1",
  edition: "2019",
  clause: "Table 9.6.1",
  text: "ASHRAE 90.1-2019 Table 9.6.1, Space-by-Space Interior Lighting Power Density",
};

const CITE_NFPA_101: Citation = {
  source: "code",
  code: "NFPA 101",
  edition: "2021",
  clause: "7.9.2.1",
  text: "NFPA 101 (2021) §7.9.2.1, initial and 90-minute emergency illumination",
};

const CITE_IBC_1008: Citation = {
  source: "code",
  code: "IBC",
  edition: "2021",
  clause: "1008.3.5",
  text: "IBC (2021) §1008.3.5, illumination level under emergency power",
};

export const photometricsNormalCalc = defineCalc({
  id: "electrical.photometrics_normal",
  version: "1.0.0",
  domain: "electrical",
  title: "Normal room illuminance & LPD photometrics (IES LM-63 / ASHRAE 90.1)",
  summary:
    "Point-by-point IES LM-63 photometric illuminance calculation across active spaces/rooms (or custom zones) on a configurable grid with luminaire rotation/aim, 3D wall/slab/column occlusion ray-casting, optional 80/50/20 zonal-cavity diffuse inter-reflectance, uniformity checks, and ASHRAE 90.1 Space-by-Space LPD verification.",
  codeFamily: null,
  needsModel: true,
  input: photometricsNormalInput,
  example: { gridSpacingFt: 2, workplaneHeightIn: 30, interReflectance: true },
  run: (input, ctx) => {
    if (!ctx.model) {
      throw new Error("electrical.photometrics_normal requires an open model");
    }
    const detail: PhotometricsNormalResult = evaluateNormalPhotometrics(ctx.model, {
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.spaceIds !== undefined ? { spaceIds: input.spaceIds } : {}),
      gridSpacingFt: input.gridSpacingFt,
      ...(input.workplaneHeightIn !== undefined ? { workplaneHeightIn: input.workplaneHeightIn } : {}),
      ...(input.calculationMode !== undefined ? { calculationMode: input.calculationMode } : {}),
      ...(input.useMaterialReflectances !== undefined ? { useMaterialReflectances: input.useMaterialReflectances } : {}),
      ...(input.includeFurnitureOcclusion !== undefined ? { includeFurnitureOcclusion: input.includeFurnitureOcclusion } : {}),
      ...(input.includeTaskSurfaces !== undefined ? { includeTaskSurfaces: input.includeTaskSurfaces } : {}),
      interReflectance: input.interReflectance,
      ...(input.radiosityMethod !== undefined ? { radiosityMethod: input.radiosityMethod } : {}),
      ...(input.daylight !== undefined ? { daylight: input.daylight } : {}),
      ...(input.reflectances !== undefined ? { reflectances: input.reflectances } : {}),
      ...(input.zones !== undefined ? { zones: input.zones } : {}),
      ...(input.zonesOnly !== undefined ? { zonesOnly: input.zonesOnly } : {}),
    });

    const issues: CalcIssue[] = [];
    if (detail.spaces.length === 0) {
      issues.push({
        severity: "warning",
        message: "No active spaces or rooms matched the requested filter.",
        cite: [CITE_IES_HB],
      });
    }
    for (const sp of detail.spaces) {
      if (!sp.pass) {
        issues.push({
          severity: "warning",
          message: `${sp.name} (${sp.levelName}): ${sp.failReasons.join("; ")}`,
          cite: sp.passLpd ? [CITE_IES_HB] : [CITE_ASHRAE_901],
        });
      }
    }

    const r = detail.reflectances;
    const steps: CalcStep[] = [
      {
        label: "Calculation setup",
        detail: `Grid ${detail.gridSpacingFt} ft × ${detail.gridSpacingFt} ft, workplane ${detail.workplaneHeightIn}" AFF, inter-reflectance ${detail.interReflectance ? `ON (${Math.round(r.ceiling * 100)}/${Math.round(r.wall * 100)}/${Math.round(r.floor * 100)})` : "OFF"} — ${detail.spaces.length} space(s), ${detail.totalFixtures} luminaire(s), ${detail.gridPoints.length} grid point(s) in ${detail.elapsedMs} ms.`,
        cite: [CITE_IES_LM63],
      },
      ...detail.spaces.map((sp) => ({
        label: `${sp.name} (${sp.levelName})`,
        detail: `Avg ${sp.avgFc} fc (target ≥ ${sp.target.targetAvgFc} fc), Min ${sp.minFc} fc (target ≥ ${sp.target.targetMinFc} fc), Max ${sp.maxFc} fc (Max:Min ${sp.maxMinRatio}:1 ≤ ${sp.target.maxToMinRatio}:1), LPD ${sp.lpdWPerSqFt} W/ft² (limit ${sp.target.maxLpdWPerSqFt} W/ft²) — ${sp.pass ? "PASS" : "FAIL"}.`,
        cite: sp.passLpd ? [CITE_IES_HB] : [CITE_ASHRAE_901],
      })),
    ];

    const values: CalcValue[] = [
      { key: "overall_avg_fc", label: "Area-weighted average illuminance", value: round(detail.overallAvgFc, 2), unit: "fc", cite: [CITE_IES_HB] },
      { key: "overall_min_fc", label: "Minimum point illuminance", value: round(detail.overallMinFc, 2), unit: "fc", cite: [CITE_IES_HB] },
      { key: "overall_max_fc", label: "Maximum point illuminance", value: round(detail.overallMaxFc, 2), unit: "fc", cite: [CITE_IES_HB] },
      ...(detail.daylight
        ? [{ key: "overall_daylight_factor_pct", label: "Area-weighted Daylight Factor", value: round(detail.daylight.overallDaylightFactorPct, 2), unit: "%" as const, cite: [CITE_IES_HB] }]
        : []),
      { key: "overall_lpd", label: "Overall Lighting Power Density", value: round(detail.overallLpdWPerSqFt, 3), unit: "W/ft2", cite: [CITE_ASHRAE_901] },
      { key: "total_watts", label: "Total connected luminaire power", value: round(detail.totalWatts, 1), unit: "W", cite: [CITE_ASHRAE_901] },
      { key: "total_area", label: "Total evaluated area", value: round(detail.totalAreaSqFt, 1), unit: "ft2", cite: [CITE_IES_HB] },
      { key: "passing_spaces", label: "Passing spaces", value: detail.passingSpaces, unit: "ea", cite: [CITE_IES_HB] },
      { key: "failing_spaces", label: "Failing spaces", value: detail.failingSpaces, unit: "ea", cite: [CITE_IES_HB] },
      { key: "status", label: "Overall normal lighting status", value: detail.pass ? "PASS" : "FAIL", unit: null, cite: [CITE_IES_HB, CITE_ASHRAE_901] },
    ];

    return { values, steps, issues, detail };
  },
});

export const photometricsEgressCalc = defineCalc({
  id: "electrical.photometrics_egress",
  version: "1.0.0",
  domain: "electrical",
  title: "Emergency / egress lighting compliance (NFPA 101 §7.9.2.1 / IBC §1008.3.5)",
  summary:
    'Evaluates emergency/egress floor-plane (Z = 0" AFF) illuminance using strictly emergency-backed luminaires (battery pack, generator circuit, inverter, or emergency circuit) along corridors, stairs, exit discharge pads, and explicit egress paths against NFPA 101 §7.9.2.1 & IBC §1008.3.5 initial (≥1.0 fc avg, ≥0.1 fc min, ≤40:1) and 90-minute end-of-discharge (≥0.6 fc avg, ≥0.06 fc min, ≤40:1) criteria.',
  codeFamily: null,
  needsModel: true,
  input: photometricsEgressInput,
  example: { gridSpacingFt: 2, workplaneHeightIn: 0, battery90MinDerate: 0.6 },
  run: (input, ctx) => {
    if (!ctx.model) {
      throw new Error("electrical.photometrics_egress requires an open model");
    }
    const detail: PhotometricsEgressResult = evaluateEgressPhotometrics(ctx.model, {
      ...(input.level !== undefined ? { level: input.level } : {}),
      gridSpacingFt: input.gridSpacingFt,
      workplaneHeightIn: input.workplaneHeightIn,
      ...(input.calculationMode !== undefined ? { calculationMode: input.calculationMode } : {}),
      ...(input.includeFurnitureOcclusion !== undefined ? { includeFurnitureOcclusion: input.includeFurnitureOcclusion } : {}),
      interReflectance: input.interReflectance,
      ...(input.reflectances !== undefined ? { reflectances: input.reflectances } : {}),
      battery90MinDerate: input.battery90MinDerate,
      ...(input.egressPaths !== undefined ? { egressPaths: input.egressPaths } : {}),
      ...(input.explicitOnly !== undefined ? { explicitOnly: input.explicitOnly } : {}),
    });

    const T = NFPA101_IBC_EGRESS_THRESHOLDS;
    const issues: CalcIssue[] = [];
    if (detail.paths.length === 0) {
      issues.push({
        severity: "warning",
        message: "No corridor, stair, exit-discharge, or explicit egress paths found to evaluate.",
        cite: [CITE_NFPA_101],
      });
    }
    if (detail.emergencyFixtureCount === 0 && detail.paths.length > 0) {
      issues.push({
        severity: "error",
        message: "Zero luminaires have emergency power (electrical.emergency_mode !== 'none' or emergency circuit).",
        cite: [CITE_NFPA_101],
      });
    }
    for (const path of detail.paths) {
      if (!path.pass) {
        issues.push({
          severity: "error",
          message: `${path.name} (${path.levelName}): ${path.failReasons.join("; ")}`,
          cite: [CITE_NFPA_101, CITE_IBC_1008],
        });
      }
    }

    const steps: CalcStep[] = [
      {
        label: "NFPA 101 §7.9.2.1 / IBC §1008.3.5 criteria",
        detail: `Initial ≥ ${T.initialAvgFc} avg / ≥ ${T.initialMinFc} min fc; 90-min ≥ ${T.end90MinAvgFc} avg / ≥ ${T.end90MinMinFc} min fc; max:min ≤ ${T.maxToMinRatio}:1 — ${detail.paths.length} path(s), ${detail.emergencyFixtureCount} emergency luminaire(s), ${detail.gridPoints.length} grid point(s) in ${detail.elapsedMs} ms.`,
        cite: [CITE_NFPA_101, CITE_IBC_1008, CITE_IES_LM63],
      },
      ...detail.paths.map((path) => ({
        label: `${path.name} (${path.levelName})`,
        detail: `EM fixtures: ${path.emergencyFixtureCount} | Z = ${path.workplaneHeightIn}" AFF | Initial ${path.avgFc} avg / ${path.minFc} min (${path.maxMinRatio}:1) | 90-min ${path.avgFc90Min} avg / ${path.minFc90Min} min (${path.maxMinRatio90Min}:1) — ${path.pass ? "PASS" : "FAIL"}.`,
        cite: [CITE_NFPA_101, CITE_IBC_1008],
      })),
    ];

    const values: CalcValue[] = [
      { key: "initial_avg_fc", label: "Initial average egress illuminance", value: round(detail.overallAvgFc, 2), unit: "fc", cite: [CITE_NFPA_101] },
      { key: "initial_min_fc", label: "Initial minimum egress illuminance", value: round(detail.overallMinFc, 2), unit: "fc", cite: [CITE_NFPA_101] },
      { key: "initial_max_min_ratio", label: "Initial max:min uniformity ratio", value: round(detail.overallMaxMinRatio, 2), unit: "ratio", cite: [CITE_NFPA_101] },
      { key: "end_90min_avg_fc", label: "90-min average egress illuminance", value: round(detail.overallAvgFc90Min, 2), unit: "fc", cite: [CITE_NFPA_101] },
      { key: "end_90min_min_fc", label: "90-min minimum egress illuminance", value: round(detail.overallMinFc90Min, 2), unit: "fc", cite: [CITE_NFPA_101] },
      { key: "end_90min_max_min_ratio", label: "90-min max:min uniformity ratio", value: round(detail.overallMaxMinRatio90Min, 2), unit: "ratio", cite: [CITE_NFPA_101] },
      { key: "emergency_fixtures", label: "Emergency-backed luminaires", value: detail.emergencyFixtureCount, unit: "ea", cite: [CITE_NFPA_101] },
      { key: "passing_paths", label: "Passing egress paths", value: detail.passingPaths, unit: "ea", cite: [CITE_IBC_1008] },
      { key: "failing_paths", label: "Failing egress paths", value: detail.failingPaths, unit: "ea", cite: [CITE_IBC_1008] },
      { key: "status", label: "NFPA 101 / IBC egress status", value: detail.pass ? "PASS" : "FAIL", unit: null, cite: [CITE_NFPA_101, CITE_IBC_1008] },
    ];

    return { values, steps, issues, detail };
  },
});

export const PHOTOMETRIC_CALCS = [photometricsNormalCalc, photometricsEgressCalc] as const;
