import { PIPE_DESIGN_DEFAULTS, PIPE_MATERIALS, PIPE_SPEC_IDS, pipeSpec } from "@permitzip/bim-kernel";
import { hazenWilliamsPsiPer100Ft, hunterStyleGpm, interpolateTable } from "../../routing/pipe/hydraulics";
import { z } from "zod";
import { nominalLabel, parseGasCapacityTable, lookupGasSize, pressureInWc, type GasCapacityTable, type GasTableSize, type Pressure, methodCite, findGasTable, gasTableCite, GAS_PROPERTIES, highPressureCfh, highPressureDiameter, ifgcCite, isIfgcEdition, lowPressureCfh, lowPressureDiameter, usesHighPressure, type IfgcEdition, ipcCite, isIpcEdition, type IpcEdition, defineCalc, round, ipcTables } from "@permitzip/bim-calc";
import { ASHRAE_CURVES, BUILDING_TYPES, LEGACY_FIT_CITE, readCurve, type DemandCurve } from "../packs/hunter/curves";
import type { CalcIssue, CalcStep, CalcValue, Citation, CodeEdition } from "@permitzip/bim-calc";
import { greaseFixturesPipedTo, type PipedGreaseFixture } from "./grease-fixtures";
import { curveById, DEMAND_CURVE_IDS } from "./settings";

const { BUILDING_DRAIN_MIN_WITH_WC_IN, DRAIN_MIN_WITH_WC_IN, findFixtureRow, TABLE_1003_3_5_1, TABLE_604_3, TABLE_604_5, TABLE_704_1, TABLE_709_1, TABLE_710_1_1, TABLE_710_1_1_SLOPES, TABLE_710_1_2 } = ipcTables;

/**
 * Plumbing and gas sizing calcs on the code packs: Hunter demand by a chosen
 * curve, the domestic water pressure report, water sizing by allowable
 * friction, drain sizing by DFU, gas sizing by the IFGC methods, water
 * heater, grease interceptor and meter checks. Each reports required
 * capacities and pass/fail; none of them picks a product, and none of them
 * proposes a different layout: they size the topology the engineer drew.
 */

const WATER_PSI_PER_FT = 62.4 / 144;
const GIVEN: Citation = methodCite("Given", "input value");
const LB_PER_GAL = 8.33;

function ipcOf(code: CodeEdition | null): IpcEdition {
  if (!isIpcEdition(code)) throw new Error("This calc needs the plumbing code pack; the registry resolves it from the edition, the project's Code Study, or the state.");
  return code;
}

function ifgcOf(code: CodeEdition | null): IfgcEdition {
  if (!isIfgcEdition(code)) throw new Error("This calc needs the fuel gas code pack; the registry resolves it from the edition, the project's Code Study, or the state.");
  return code;
}

const curveInput = {
  curve: z.enum(DEMAND_CURVE_IDS).optional().describe("ashrae_a restaurants, ashrae_b hospitals / nursing homes / dormitories / hotels, ashrae_c apartments, ashrae_d offices / schools, ipc_e_tank / ipc_e_valve or firm (give firm_curve_points), legacy_fit (old default, comparison only)."),
  building_type: z.enum(BUILDING_TYPES).optional().describe("Picks the curve when curve is not given."),
  firm_curve_points: z.array(z.object({ wsfu: z.number().min(0).max(100_000), gpm: z.number().min(0).max(100_000) }).strict()).min(2).max(200).optional(),
  firm_curve_note: z.string().trim().min(1).max(300).optional(),
};

function pickCurve(input: { curve?: (typeof DEMAND_CURVE_IDS)[number]; building_type?: (typeof BUILDING_TYPES)[number]; firm_curve_points?: ReadonlyArray<{ wsfu: number; gpm: number }>; firm_curve_note?: string }): { curve: DemandCurve; why: string } | { reason: string } {
  if (input.curve) {
    const c = curveById(input.curve, input.firm_curve_points, input.firm_curve_note);
    return "reason" in c ? c : { curve: c, why: "chosen for this system" };
  }
  if (input.building_type) {
    const found = Object.values(ASHRAE_CURVES).find((c) => c.appliesTo.includes(input.building_type ?? ""));
    if (found) return { curve: found, why: `the default for a ${input.building_type.replace(/_/g, " ")}` };
    return { reason: `No default curve for building type "${input.building_type}"; give curve.` };
  }
  return { reason: "Give curve, or building_type so its default curve is used (restaurant → Curve A, hospital / hotel / dormitory → B, apartment → C, office / school → D)." };
}

// ------------------------------------------------------------------ Hunter demand

const hunterInput = z
  .object({
    wsfu: z.number().min(0).max(100_000).describe("Total water supply fixture units (cold and hot combined) at the point being sized."),
    wsfu_cold: z.number().min(0).max(100_000).optional(),
    wsfu_hot: z.number().min(0).max(100_000).optional(),
    ...curveInput,
    chart: z.boolean().default(true).describe("Return the chart (all four ASHRAE curves and the operating point) for a printed graph."),
  })
  .strict();

export const hunterDemandCalc = defineCalc({
  id: "plumbing.hunter_demand",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water demand from fixture units (Hunter curve)",
  summary: "Design flow (gpm) from water supply fixture units on a chosen curve: ASHRAE modified Curves A–D (default by building type) or the firm's IPC Appendix E import. Returns the chart points and operating point for the printed curve, and how far the old built-in fit was off.",
  codeFamily: null,
  needsModel: false,
  input: hunterInput,
  example: { wsfu: 43.25, wsfu_cold: 37, wsfu_hot: 15.75, building_type: "restaurant" },
  run: (input) => {
    const picked = pickCurve(input);
    if ("reason" in picked) return { values: [], steps: [], issues: [{ severity: "error", message: picked.reason, cite: [] }], detail: null };
    const { curve, why } = picked;
    const total = readCurve(curve, input.wsfu);
    const issues: CalcIssue[] = [];
    if (total.beyondRange) issues.push({ severity: "warning", message: `${input.wsfu} WSFU is past ${curve.label}'s last point (${total.maxWsfu} WSFU); the flow is held at the curve's end. Use a curve that covers the load.`, cite: [curve.cite] });
    const legacy = hunterStyleGpm(input.wsfu);
    const values: CalcValue[] = [
      { key: "design_gpm", label: "Design flow", value: round(total.gpm, 1), unit: "gpm", cite: [curve.cite] },
      { key: "curve", label: "Curve", value: curve.label, unit: null, cite: [curve.cite] },
      { key: "wsfu", label: "Water supply fixture units", value: input.wsfu, unit: "wsfu", cite: [GIVEN] },
    ];
    const steps: CalcStep[] = [{ label: "Curve", detail: `${curve.label}, ${why}`, cite: [curve.cite] }, { label: "Total", detail: `${input.wsfu} WSFU on ${curve.label}: ${round(total.gpm, 1)} gpm`, cite: [curve.cite] }];
    for (const [key, fu, label] of [["cold_gpm", input.wsfu_cold, "Cold water"], ["hot_gpm", input.wsfu_hot, "Hot water"]] as const) {
      if (fu === undefined) continue;
      const r = readCurve(curve, fu);
      values.push({ key, label: `${label} flow`, value: round(r.gpm, 1), unit: "gpm", cite: [curve.cite] });
      steps.push({ label, detail: `${fu} WSFU: ${round(r.gpm, 1)} gpm`, cite: [curve.cite] });
    }
    if (curve.id !== "legacy_fit") {
      values.push({ key: "legacy_fit_gpm", label: "Old built-in fit (for comparison)", value: round(legacy, 1), unit: "gpm", cite: [LEGACY_FIT_CITE] });
      steps.push({ label: "Compared with the old fit", detail: `The model's old default (1.47 FU^0.735, a tank-type approximation) reads ${round(legacy, 1)} gpm here, ${round(total.gpm - legacy, 1)} gpm ${total.gpm >= legacy ? "under" : "over"} ${curve.label}; ASHRAE's modified curves are drawn per building type from measured demand.`, cite: [curve.cite] });
    }
    const chart = input.chart
      ? { curves: Object.values(ASHRAE_CURVES).map((c) => ({ id: c.id, label: c.label, points: c.points })), selected: curve.id, ...(curve.id.startsWith("ashrae") ? {} : { selectedPoints: curve.points }), operatingPoint: { wsfu: input.wsfu, gpm: round(total.gpm, 1) }, axes: { x: "Fixture units", y: "Gallons per minute", xMax: 400, yMax: 100 } }
      : null;
    return { values, steps, issues, detail: { curve: curve.id, gpm: total.gpm, legacyFitGpm: legacy, chart } };
  },
});

// ------------------------------------------------------------------ pressure report

const loss = z.number().min(0).max(200);

const pressureInput = z
  .object({
    supply: z
      .object({
        kind: z.enum(["design_minimum", "flow_test"]).describe("design_minimum: a basis-of-design pressure in lieu of flow test data. flow_test: residual pressure at the design flow."),
        psi: z.number().positive().max(300),
      })
      .strict(),
    meter_loss_psi: loss.optional(),
    backflow_loss_psi: loss.optional(),
    backflow_device: z.string().trim().min(1).max(60).optional().describe("RPZ, DCVA, …"),
    tap_loss_psi: loss.optional().describe("Tap in the main."),
    prv_loss_psi: loss.optional(),
    other_losses: z.array(z.object({ label: z.string().trim().min(1).max(80), psi: loss }).strict()).max(20).default([]),
    highest_fixture_height_ft: z.number().min(0).max(1000).describe("Height of the highest fixture above the supply point."),
    static_head_psi_per_ft: z.number().min(0.4).max(0.45).optional().describe("Default 0.433 (62.4 lb/ft³ / 144)."),
    critical_fixture: z.string().trim().min(1).max(120).optional().describe("Fixture needing the most pressure, by its Table 604.3 name, e.g. \"Urinal, valve\"."),
    critical_fixture_psi: z.number().min(0).max(200).optional().describe("Or the pressure it needs directly (a manufacturer's figure)."),
    developed_length_ft: z.number().positive().max(100_000).optional().describe("Developed length to the critical fixture; gives the allowable friction per 100 ft."),
    total_wsfu: z.number().min(0).optional(),
    design_gpm: z.number().min(0).optional(),
  })
  .strict();

export const pressureReportCalc = defineCalc({
  id: "plumbing.pressure_report",
  version: "1.0.0",
  domain: "plumbing",
  title: "Domestic water pressure loss report",
  summary: "Starts at the design minimum (or flow test) pressure and deducts meter, backflow preventer, tap, PRV, static head (height × 0.433) and the highest fixture pressure from Table 604.3, giving the pressure left to overcome pipe friction (and the allowable loss per 100 ft when the developed length is given).",
  codeFamily: "ipc",
  needsModel: false,
  input: pressureInput,
  example: { supply: { kind: "design_minimum", psi: 50 }, meter_loss_psi: 4.5, backflow_loss_psi: 9.8, backflow_device: "RPZ", tap_loss_psi: 0.28, highest_fixture_height_ft: 7, static_head_psi_per_ft: 0.43, critical_fixture_psi: 25, total_wsfu: 43.25, design_gpm: 48 },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const steps: CalcStep[] = [];
    const issues: CalcIssue[] = [];
    const lines: Array<{ key: string; label: string; psi: number; cite: Citation[] }> = [];
    const supplyCite = input.supply.kind === "design_minimum" ? methodCite("Basis of design", "minimum design pressure in lieu of flow test data") : methodCite("Hydrant flow test", "residual pressure at the design flow");
    steps.push({ label: "Supply", detail: `${input.supply.psi} psi ${input.supply.kind === "design_minimum" ? "minimum design pressure (basis of design in lieu of flow test data)" : "residual pressure from the flow test"}`, cite: [supplyCite] });
    if (input.supply.kind === "design_minimum") issues.push({ severity: "info", message: "A flow test is required to confirm the design pressure; this report uses the basis-of-design value.", cite: [supplyCite] });
    const add = (key: string, label: string, psi: number | undefined, cite: Citation[]) => {
      if (psi === undefined) return;
      lines.push({ key, label, psi, cite });
      steps.push({ label, detail: `− ${round(psi, 2)} psi`, cite });
    };
    add("meter_loss_psi", "Water meter loss", input.meter_loss_psi, [methodCite("Water meter", "loss at the design flow", "manufacturer / AWWA meter loss data")]);
    add("tap_loss_psi", "Tap in main", input.tap_loss_psi, [methodCite("Tap loss", "loss through the tap at the design flow")]);
    add("backflow_loss_psi", `Backflow preventer${input.backflow_device ? ` (${input.backflow_device})` : ""}`, input.backflow_loss_psi, [ipcCite(ed, "backflow"), methodCite("Backflow preventer", "loss at the design flow", "manufacturer data")]);
    add("prv_loss_psi", "Pressure-reducing valve", input.prv_loss_psi, [methodCite("Pressure-reducing valve", "fall-off at the design flow", "manufacturer data")]);
    for (const o of input.other_losses) add(`other:${o.label}`, o.label, o.psi, [methodCite("Other loss", o.label)]);
    const perFt = input.static_head_psi_per_ft ?? WATER_PSI_PER_FT;
    const staticCite = methodCite("Static head", `${round(perFt, 3)} psi per ft of rise`, "water at 62.4 lb/ft³");
    const staticPsi = round(input.highest_fixture_height_ft * perFt, 2);
    add("static_head_psi", `Static head (${input.highest_fixture_height_ft} ft × ${round(perFt, 3)})`, staticPsi, [staticCite]);
    let fixturePsi = input.critical_fixture_psi;
    let fixtureCite: Citation[] = [methodCite("Fixture pressure", "required flow pressure", "as given")];
    if (input.critical_fixture) {
      const row = findFixtureRow(TABLE_604_3, input.critical_fixture);
      if (!row) issues.push({ severity: input.critical_fixture_psi === undefined ? "error" : "warning", message: `"${input.critical_fixture}" is not a Table 604.3 fixture. Names: ${TABLE_604_3.map((r) => r.fixture).join("; ")}.`, cite: [ipcCite(ed, "fixture_flow_pressure")] });
      else {
        if (fixturePsi === undefined || fixturePsi < row.psi) fixturePsi = row.psi;
        fixtureCite = [ipcCite(ed, "fixture_flow_pressure", `${row.fixture}: ${row.psi} psi at ${row.gpm} gpm`)];
      }
    } else if (fixturePsi !== undefined) {
      fixtureCite = [ipcCite(ed, "fixture_flow_pressure", "highest pressure required at a fixture")];
    }
    if (fixturePsi === undefined) issues.push({ severity: "error", message: "Give the critical fixture (its Table 604.3 name) or the pressure it needs.", cite: [ipcCite(ed, "fixture_flow_pressure")] });
    add("fixture_psi", "Highest pressure required at a fixture", fixturePsi, fixtureCite);
    const deducted = lines.reduce((s, l) => s + l.psi, 0);
    const available = round(input.supply.psi - deducted, 2);
    const allCite = [supplyCite, ...lines.flatMap((l) => l.cite)];
    const values: CalcValue[] = [
      { key: "supply_psi", label: input.supply.kind === "design_minimum" ? "Minimum design pressure" : "Flow test residual pressure", value: input.supply.psi, unit: "psi", cite: [supplyCite] },
      ...lines.map((l): CalcValue => ({ key: l.key, label: l.label, value: round(l.psi, 2), unit: "psi", cite: l.cite })),
      { key: "available_psi", label: "Available to overcome pipe friction", value: available, unit: "psi", cite: allCite },
    ];
    if (input.total_wsfu !== undefined) values.unshift({ key: "total_wsfu", label: "Total fixture units at the service", value: input.total_wsfu, unit: "wsfu", cite: [GIVEN] });
    if (input.design_gpm !== undefined) values.unshift({ key: "design_gpm", label: "Total gpm at the service", value: input.design_gpm, unit: "gpm", cite: [GIVEN] });
    steps.push({ label: "Available for friction", detail: `${input.supply.psi} − ${lines.map((l) => round(l.psi, 2)).join(" − ")} = ${available} psi`, cite: allCite });
    let allowable: number | null = null;
    if (input.developed_length_ft !== undefined && available > 0) {
      allowable = round((available / input.developed_length_ft) * 100, 3);
      values.push({ key: "allowable_psi_per_100ft", label: "Allowable friction", value: allowable, unit: "psi_per_100ft", cite: [ipcCite(ed, "water_sizing")] });
      steps.push({ label: "Allowable friction", detail: `${available} psi over ${input.developed_length_ft} ft developed length: ${allowable} psi per 100 ft`, cite: [ipcCite(ed, "water_sizing")] });
    }
    if (available <= 0) issues.push({ severity: "error", message: `Nothing is left for pipe friction (${available} psi). Raise the supply pressure (booster), or cut a loss.`, cite: allCite });
    return { values, steps, issues, detail: { lines, availablePsi: available, allowablePsiPer100Ft: allowable } };
  },
});

// ------------------------------------------------------------------ water sizing

const waterSizeInput = z
  .object({
    available_psi: z.number().positive().max(300).describe("From plumbing.pressure_report."),
    developed_length_ft: z.number().positive().max(100_000),
    fitting_allowance_pct: z.number().min(0).max(200).default(0).describe("Fittings as a percentage of the developed length (a design allowance)."),
    service: z.enum(["cold", "hot"]).default("cold"),
    material: z.enum(PIPE_MATERIALS).default("copper"),
    spec: z.enum(PIPE_SPEC_IDS).optional(),
    hazen_c: z.number().min(60).max(160).optional(),
    max_velocity_fps: z.number().positive().max(20).optional().describe("Default 8 ft/s cold, 5 ft/s hot."),
    segments: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            gpm: z.number().min(0).max(100_000).optional(),
            wsfu: z.number().min(0).max(100_000).optional(),
            fixture: z.string().trim().min(1).max(120).optional().describe("A single fixture's branch: Table 604.5's minimum applies."),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    ...curveInput,
  })
  .strict();

export const sizeWaterCalc = defineCalc({
  id: "plumbing.size_water",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water pipe sizing (allowable friction)",
  summary: "Sizes each water segment as the smallest pipe whose Hazen–Williams friction stays within the allowable loss per 100 ft (available pressure over developed length plus fittings) and whose velocity stays within the limit, with Table 604.5 minimum fixture branch sizes. Fixture units become gpm on the chosen Hunter curve.",
  codeFamily: "ipc",
  needsModel: false,
  input: waterSizeInput,
  example: { available_psi: 7.41, developed_length_ft: 120, fitting_allowance_pct: 30, service: "cold", material: "copper", building_type: "restaurant", segments: [{ id: "service", wsfu: 43.25 }, { id: "kitchen", wsfu: 20 }, { id: "lav", fixture: "Lavatory", gpm: 0.5 }] },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const spec = pipeSpec(input.material, input.spec);
    if (!spec || !spec.services.includes("water")) return { values: [], steps: [], issues: [{ severity: "error", message: `${input.material}${input.spec ? ` ${input.spec}` : ""} is not a water pipe product in the pipe catalog.`, cite: [] }], detail: null };
    const c = input.hazen_c ?? spec.hazenWilliamsC;
    const vmax = input.max_velocity_fps ?? (input.service === "hot" ? PIPE_DESIGN_DEFAULTS.hotMaxVelocityFps : PIPE_DESIGN_DEFAULTS.maxVelocityFps);
    const equivalent = input.developed_length_ft * (1 + input.fitting_allowance_pct / 100);
    const allowable = (input.available_psi / equivalent) * 100;
    const hazen = methodCite("Hazen–Williams", "psi per 100 ft = 4.52 Q^1.852 / (C^1.852 d^4.8704) x 100", `C ${c}`);
    const velCite = methodCite("Velocity limit", `${vmax} ft/s ${input.service}`, input.max_velocity_fps ? "as given" : "PermitZIP design default (verify for permit work)");
    const needsCurve = input.segments.some((s) => s.gpm === undefined);
    const picked = needsCurve ? pickCurve(input) : null;
    if (picked && "reason" in picked) return { values: [], steps: [], issues: [{ severity: "error", message: picked.reason, cite: [] }], detail: null };
    const curve = picked && "curve" in picked ? picked.curve : null;
    const issues: CalcIssue[] = [];
    const sizes = [...spec.sizes].sort((a, b) => a.nominalIn - b.nominalIn);
    const rows = input.segments.map((seg) => {
      const gpm = seg.gpm ?? (curve ? readCurve(curve, seg.wsfu ?? 0).gpm : 0);
      if (seg.gpm === undefined && seg.wsfu === undefined) issues.push({ severity: "error", message: `Segment ${seg.id} has neither gpm nor wsfu.`, cite: [] });
      const minRow = seg.fixture ? findFixtureRow(TABLE_604_5, seg.fixture) : null;
      if (seg.fixture && !minRow) issues.push({ severity: "warning", message: `"${seg.fixture}" is not a Table 604.5 fixture; no minimum size applied to ${seg.id}.`, cite: [ipcCite(ed, "fixture_min_size")] });
      let chosen: { nominalIn: number; idIn: number; psi: number; fps: number; governs: string } | null = null;
      for (const s of sizes) {
        const idIn = s.idMm / 25.4;
        const psi = gpm > 0 ? hazenWilliamsPsiPer100Ft(gpm, c, idIn) : 0;
        const fps = gpm / 448.831 / ((Math.PI * (idIn / 12) ** 2) / 4);
        if (minRow && s.nominalIn < minRow.minIn - 1e-9) continue;
        if (psi <= allowable + 1e-9 && fps <= vmax + 1e-9) {
          const smallest = sizes.find((x) => {
            const d = x.idMm / 25.4;
            return gpm <= 0 || hazenWilliamsPsiPer100Ft(gpm, c, d) <= allowable + 1e-9;
          });
          const governs = minRow && s.nominalIn <= minRow.minIn + 1e-9 && (smallest?.nominalIn ?? 0) < s.nominalIn ? "minimum size (Table 604.5)" : smallest && smallest.nominalIn < s.nominalIn ? "velocity" : "friction";
          chosen = { nominalIn: s.nominalIn, idIn, psi, fps, governs };
          break;
        }
      }
      if (!chosen) issues.push({ severity: "error", message: `${seg.id}: no ${spec.name} size carries ${round(gpm, 1)} gpm within ${round(allowable, 2)} psi/100 ft and ${vmax} ft/s.`, cite: [hazen, velCite] });
      return { id: seg.id, gpm: round(gpm, 2), size: chosen ? nominalLabel(chosen.nominalIn) : null, nominalIn: chosen?.nominalIn ?? null, idIn: chosen ? round(chosen.idIn, 3) : null, frictionPsiPer100Ft: chosen ? round(chosen.psi, 3) : null, velocityFps: chosen ? round(chosen.fps, 2) : null, governs: chosen?.governs ?? null, minimumIn: minRow?.minIn ?? null };
    });
    const allowCite = [ipcCite(ed, "water_sizing"), methodCite("Allowable friction", "available pressure / (developed length + fittings) x 100")];
    const values: CalcValue[] = [
      { key: "allowable_psi_per_100ft", label: "Allowable friction", value: round(allowable, 3), unit: "psi_per_100ft", cite: allowCite },
      { key: "max_velocity_fps", label: "Velocity limit", value: vmax, unit: "fps", cite: [velCite] },
      ...rows.map((r): CalcValue => ({ key: `size:${r.id}`, label: `${r.id} (${r.gpm} gpm)`, value: r.size, unit: "in", cite: [hazen, ...(r.minimumIn !== null ? [ipcCite(ed, "fixture_min_size")] : []), ...(curve ? [curve.cite] : [])] })),
      ...rows.map((r): CalcValue => ({ key: `size_nominal_in:${r.id}`, label: `${r.id}, nominal inches`, value: r.nominalIn, unit: "in", cite: [hazen, ...(r.minimumIn !== null ? [ipcCite(ed, "fixture_min_size")] : []), ...(curve ? [curve.cite] : [])] })),
    ];
    const steps: CalcStep[] = [
      { label: "Allowable friction", detail: `${input.available_psi} psi over ${input.developed_length_ft} ft${input.fitting_allowance_pct > 0 ? ` + ${input.fitting_allowance_pct}% fittings (${round(equivalent, 0)} ft)` : ""}: ${round(allowable, 3)} psi per 100 ft`, cite: allowCite },
      ...(curve ? [{ label: "Demand", detail: `Fixture units to gpm on ${curve.label}`, cite: [curve.cite] }] : []),
      ...rows.map((r): CalcStep => ({ label: r.id, detail: r.size ? `${r.gpm} gpm: ${r.size}" ${spec.name} (${r.frictionPsiPer100Ft} psi/100 ft, ${r.velocityFps} ft/s; ${r.governs} governs)` : `${r.gpm} gpm: no size fits`, cite: [hazen] })),
    ];
    return { values, steps, issues, detail: { allowablePsiPer100Ft: allowable, spec: spec.name, segments: rows } };
  },
});

// ------------------------------------------------------------------ drain sizing

const drainInput = z
  .object({
    role: z.enum(["building_drain", "horizontal_branch", "stack"]).describe("building_drain: building drain or sewer, Table 710.1(1) by slope. horizontal_branch and stack: Table 710.1(2)."),
    dfu: z.number().min(0).max(100_000).optional().describe("Total DFU; or give fixtures."),
    fixtures: z.array(z.object({ fixture: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(10_000).default(1), dfu: z.number().min(0).max(1000).optional() }).strict()).max(500).optional(),
    slope_in_per_ft: z.number().positive().max(1).optional().describe("Building drain slope; default the Table 704.1 minimum for each size."),
    branch_intervals: z.number().int().min(1).max(200).optional().describe("Stack: number of branch intervals."),
    max_interval_dfu: z.number().min(0).max(100_000).optional().describe("Stack: the most DFU discharging into one branch interval."),
    serves_water_closet: z.boolean().default(false),
    actual_in: z.number().positive().max(48).optional().describe("The size drawn, to check."),
  })
  .strict();

function minSlope(nominalIn: number): number {
  return TABLE_704_1.find((b) => nominalIn <= b.maxNominalIn + 1e-9)?.inPerFt ?? 0.0625;
}

export const sizeDrainCalc = defineCalc({
  id: "plumbing.size_drain",
  version: "1.0.0",
  domain: "plumbing",
  title: "Drain sizing by drainage fixture units",
  summary: "DFU from Table 709.1 (or given), then the smallest building drain at its slope by Table 710.1(1), or horizontal branch / stack by Table 710.1(2), never under 3 in. when it serves a water closet (Table 710.1(1) note a; 704.2), with the Table 704.1 minimum slope for the size. Answers the size as a number (size_nominal_in) and as printed (size_in). Checks a drawn size.",
  codeFamily: "ipc",
  needsModel: false,
  input: drainInput,
  example: { role: "building_drain", dfu: 88, slope_in_per_ft: 0.125, serves_water_closet: true },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const issues: CalcIssue[] = [];
    const steps: CalcStep[] = [];
    let dfu = input.dfu ?? 0;
    if (input.fixtures) {
      let sum = 0;
      for (const f of input.fixtures) {
        const row = f.dfu === undefined ? findFixtureRow(TABLE_709_1, f.fixture) : null;
        const each = f.dfu ?? row?.dfu ?? null;
        if (each === null) {
          issues.push({ severity: "error", message: row ? `${row.fixture}: Table 709.1 gives no unit value (709.4: rate it by its flow); give dfu.` : `"${f.fixture}" is not a Table 709.1 fixture; give its dfu.`, cite: [ipcCite(ed, row ? "dfu_unlisted" : "dfu_fixtures")] });
          continue;
        }
        sum += each * f.quantity;
        steps.push({ label: f.fixture, detail: `${f.quantity} × ${each} DFU`, cite: f.dfu === undefined ? [ipcCite(ed, "dfu_fixtures")] : [] });
      }
      dfu = input.dfu ?? sum;
    }
    let size: number | null = null;
    let cite: Citation[] = [];
    let atSlope: number | null = null;
    if (input.role === "building_drain") {
      cite = [ipcCite(ed, "building_drain"), ipcCite(ed, "drain_slope")];
      for (const row of TABLE_710_1_1) {
        if (input.serves_water_closet && row.nominalIn < BUILDING_DRAIN_MIN_WITH_WC_IN) continue;
        const slope = Math.max(input.slope_in_per_ft ?? 0, minSlope(row.nominalIn));
        const idx = [...TABLE_710_1_1_SLOPES].map((s, i) => [s, i] as const).filter(([s]) => s <= slope + 1e-9).pop()?.[1];
        const max = idx === undefined ? null : row.maxDfu[idx];
        if (max !== null && max !== undefined && max >= dfu) {
          size = row.nominalIn;
          atSlope = TABLE_710_1_1_SLOPES[idx ?? 0] ?? slope;
          steps.push({ label: "Building drain", detail: `${dfu} DFU at ${atSlope} in/ft: ${nominalLabel(row.nominalIn)} in. carries ${max} DFU${input.serves_water_closet ? " (3 in. minimum with a water closet)" : ""}`, cite });
          break;
        }
      }
      if (input.slope_in_per_ft !== undefined && size !== null && input.slope_in_per_ft < minSlope(size) - 1e-9) issues.push({ severity: "error", message: `${input.slope_in_per_ft} in/ft is below Table 704.1's ${minSlope(size)} in/ft for ${nominalLabel(size)} in.`, cite: [ipcCite(ed, "drain_slope")] });
    } else if (input.role === "horizontal_branch") {
      cite = [ipcCite(ed, "branch_stack")];
      const row = TABLE_710_1_2.find((r) => r.branch >= dfu);
      size = row?.nominalIn ?? null;
      if (row) steps.push({ label: "Horizontal branch", detail: `${dfu} DFU: ${nominalLabel(row.nominalIn)} in. carries ${row.branch} DFU`, cite });
    } else {
      cite = [ipcCite(ed, "branch_stack"), ipcCite(ed, "stack_reduction")];
      const intervals = input.branch_intervals ?? 1;
      const row = TABLE_710_1_2.find((r) => {
        const total = intervals <= 3 ? r.stackUpTo3 : r.stackOver3;
        return total !== null && total >= dfu && (input.max_interval_dfu === undefined || (r.oneInterval !== null && r.oneInterval >= input.max_interval_dfu));
      });
      size = row?.nominalIn ?? null;
      if (row) steps.push({ label: "Stack", detail: `${dfu} DFU over ${intervals} branch interval${intervals === 1 ? "" : "s"}${input.max_interval_dfu !== undefined ? `, ${input.max_interval_dfu} DFU into one interval` : ""}: ${nominalLabel(row.nominalIn)} in.`, cite });
      if (input.branch_intervals === undefined) issues.push({ severity: "info", message: "Sized as three branch intervals or fewer; give branch_intervals for a taller stack.", cite });
    }
    if (input.serves_water_closet) {
      // The building drain's own table already starts at 3 in. with a water closet (note a); a branch or stack is held to 3 in. by 704.2.
      const wcCite = input.role === "building_drain" ? ipcCite(ed, "building_drain_wc_min") : ipcCite(ed, "drain_no_reduction", "a water closet's 3 in. connection is not reduced downstream");
      cite = [...cite, wcCite];
      const minimum = input.role === "building_drain" ? BUILDING_DRAIN_MIN_WITH_WC_IN : DRAIN_MIN_WITH_WC_IN;
      if (size !== null && size < minimum) {
        steps.push({ label: "Water closet", detail: `${nominalLabel(size)} in. carries ${dfu} DFU, but it serves a water closet: ${nominalLabel(minimum)} in. minimum`, cite: [wcCite] });
        size = minimum;
      }
    }
    if (size === null) issues.push({ severity: "error", message: `${dfu} DFU is beyond the table for a ${input.role.replace(/_/g, " ")}${input.role === "building_drain" ? " at that slope" : ""}.`, cite });
    if (input.actual_in !== undefined && size !== null && input.actual_in < size - 1e-9) issues.push({ severity: "error", message: `The drawn ${nominalLabel(input.actual_in)} in. is smaller than the required ${nominalLabel(size)} in.`, cite });
    const values: CalcValue[] = [
      { key: "dfu", label: "Drainage fixture units", value: dfu, unit: "dfu", cite: input.fixtures ? [ipcCite(ed, "dfu_fixtures")] : [GIVEN] },
      { key: "size_in", label: "Required size", value: size === null ? null : nominalLabel(size), unit: "in", cite },
      { key: "size_nominal_in", label: "Required size (nominal inches)", value: size, unit: "in", cite },
      ...(size !== null ? [{ key: "min_slope_in_per_ft", label: "Minimum slope", value: minSlope(size), unit: "in_per_ft" as const, cite: [ipcCite(ed, "drain_slope")] }] : []),
      ...(input.actual_in !== undefined ? [{ key: "pass", label: "Drawn size is adequate", value: size !== null && input.actual_in >= size - 1e-9, unit: null, cite }] : []),
    ];
    return { values, steps, issues, detail: { dfu, sizeIn: size, slopeUsed: atSlope } };
  },
});

// ------------------------------------------------------------------ gas sizing

const pressureSchema = z.object({ value: z.number().positive().max(300), unit: z.enum(["in_wc", "psi"]) }).strict();

const gasInput = z
  .object({
    gas: z.enum(["natural", "propane"]),
    material: z.enum(["sch40", "copper", "csst", "pe_pipe", "pe_tubing"]).default("sch40"),
    inlet: pressureSchema.describe("Pressure at the point of delivery (or the regulator outlet for this zone)."),
    drop: pressureSchema.describe("Allowable pressure drop for this zone."),
    method: z.enum(["longest_length", "branch_length"]).default("longest_length").describe("402.4.1 longest length or 402.4.2 branch length. For a 2 psi system with line regulators (402.4.3 hybrid), run each pressure zone separately."),
    basis: z.enum(["table", "equation", "both"]).default("both"),
    heating_value_btu_per_cf: z.number().min(500).max(3500).optional(),
    segments: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            parent: z.string().trim().min(1).max(80).nullable().describe("Upstream segment id; null for the first segment from the point of delivery."),
            length_ft: z.number().positive().max(10_000),
            equivalent_length_ft: z.number().min(0).max(10_000).default(0).describe("Fittings as equivalent length (Table A102.2), added to this segment."),
            load_mbh: z.number().min(0).max(100_000).default(0).describe("Appliance input at the end of this segment (thousands of Btu/h)."),
            label: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    extra_tables: z.array(z.object({ citation: z.string().min(1).max(40), heading: z.string().min(1).max(120), text: z.string().min(1).max(20_000), code: z.string().min(1).max(20).default("VFGC"), edition: z.string().min(1).max(10).default("2021") }).strict()).max(10).optional().describe("402.4(n) tables loaded from the code library or a firm import, in the library's row text."),
  })
  .strict();

interface GasSegmentResult {
  readonly id: string;
  readonly label: string | null;
  readonly loadMbh: number;
  readonly loadCfh: number;
  readonly pathFt: number;
  readonly sizingLengthFt: number;
  readonly onLongestRun: boolean;
  readonly table: { readonly size: string; readonly rowLengthFt: number; readonly capacity: number; readonly unit: "cfh" | "mbh" } | null;
  readonly equation: { readonly requiredIdIn: number; readonly size: string | null; readonly capacityAtSize: number | null } | null;
  readonly size: string | null;
  /** The size in nominal inches; null for CSST (sized by EHD) or no size. */
  readonly nominalIn: number | null;
  /** Equation capacity at the table's size and row length vs the table cell, percent. */
  readonly equationVsTablePct: number | null;
}

function equationCfh(d: number, lengthFt: number, inlet: Pressure, drop: Pressure, gas: "natural" | "propane"): number {
  if (usesHighPressure(inlet)) {
    const p1 = inlet.unit === "psi" ? inlet.value : inlet.value / 27.7;
    const dp = drop.unit === "psi" ? drop.value : drop.value / 27.7;
    return highPressureCfh(d, lengthFt, p1, p1 - dp, gas);
  }
  return lowPressureCfh(d, lengthFt, pressureInWc(drop), gas);
}

function equationDiameter(cfh: number, lengthFt: number, inlet: Pressure, drop: Pressure, gas: "natural" | "propane"): number {
  if (usesHighPressure(inlet)) {
    const p1 = inlet.unit === "psi" ? inlet.value : inlet.value / 27.7;
    const dp = drop.unit === "psi" ? drop.value : drop.value / 27.7;
    return highPressureDiameter(cfh, lengthFt, p1, p1 - dp, gas);
  }
  return lowPressureDiameter(cfh, lengthFt, pressureInWc(drop), gas);
}

export const sizeGasCalc = defineCalc({
  id: "plumbing.size_gas",
  version: "1.0.0",
  domain: "plumbing",
  title: "Gas pipe sizing (IFGC 402.4)",
  summary: "Sizes each gas segment for the load it carries by the longest length method (402.4.1) or the branch length method (402.4.2): from the matching Table 402.4(n) capacity table (code library or firm import) and from the 402.4 sizing equation, with their agreement. Natural gas or undiluted propane; Schedule 40, copper, CSST, PE.",
  codeFamily: "ifgc",
  needsModel: false,
  input: gasInput,
  example: {
    gas: "propane",
    material: "sch40",
    inlet: { value: 11, unit: "in_wc" },
    drop: { value: 0.5, unit: "in_wc" },
    method: "longest_length",
    segments: [
      { id: "main", parent: null, length_ft: 60 },
      { id: "K08", parent: "main", length_ft: 40, load_mbh: 220 },
      { id: "K07", parent: "main", length_ft: 10, load_mbh: 90 },
    ],
  },
  run: (input, ctx) => {
    const ed = ifgcOf(ctx.code);
    const issues: CalcIssue[] = [];
    const gasLabel = GAS_PROPERTIES[input.gas].label;
    const hv = input.heating_value_btu_per_cf ?? GAS_PROPERTIES[input.gas].heatingValueBtuPerCf;
    const hvCite = methodCite("Heating value", `${hv} Btu/cf ${gasLabel}`, input.heating_value_btu_per_cf ? "as given" : "usual design value; use the supplier's");
    const inlet: Pressure = { ...input.inlet, lessThan: false };
    const drop: Pressure = { ...input.drop, lessThan: false };
    const extra: GasCapacityTable[] = [];
    for (const t of input.extra_tables ?? []) {
      const r = parseGasCapacityTable({ instrument: { slug: "extra", shortName: t.code, jurisdiction: "", edition: t.edition, baseModelCode: "" }, citation: t.citation, heading: t.heading, text: t.text, source: "firm_import" });
      if (r.ok) extra.push(r.table);
      else issues.push({ severity: "warning", message: r.reason, cite: [] });
    }
    const table = input.basis === "equation" ? null : findGasTable([...extra, ...ed.tables.gasTables], input.gas, input.material, inlet, drop);
    if (input.basis !== "equation" && !table) issues.push({ severity: input.basis === "table" ? "error" : "warning", message: `No Table 402.4(n) for ${gasLabel}, ${input.material}, inlet ${input.inlet.value} ${input.inlet.unit === "psi" ? "psi" : "in. w.c."}, drop ${input.drop.value} ${input.drop.unit === "psi" ? "psi" : "in. w.c."} is loaded; sized by the equation only. Load it from the code library or import it (extra_tables).`, cite: [ifgcCite(ed, "capacity_tables")] });
    for (const i of table?.issues ?? []) issues.push({ severity: "warning", message: `${table?.tableId}: ${i.message} (as the code library has it; check the source).`, cite: table ? [gasTableCite(table)] : [] });
    // topology
    const byId = new Map(input.segments.map((s) => [s.id, s]));
    const roots = input.segments.filter((s) => s.parent === null);
    if (roots.length !== 1) return { values: [], steps: [], issues: [...issues, { severity: "error", message: `Give exactly one segment with parent null (the point of delivery); found ${roots.length}.`, cite: [] }], detail: null };
    for (const s of input.segments) if (s.parent !== null && !byId.has(s.parent)) return { values: [], steps: [], issues: [...issues, { severity: "error", message: `Segment ${s.id} names parent ${s.parent}, which isn't in the list.`, cite: [] }], detail: null };
    const children = new Map<string, string[]>();
    for (const s of input.segments) if (s.parent !== null) pushTo(children, s.parent, s.id);
    const path = new Map<string, number>();
    const visit = (id: string, upstream: number, seen: Set<string>): void => {
      if (seen.has(id)) throw new Error(`Segment ${id} is in a loop`);
      seen.add(id);
      const s = byId.get(id);
      if (!s) return;
      const here = upstream + s.length_ft + s.equivalent_length_ft;
      path.set(id, here);
      for (const c of children.get(id) ?? []) visit(c, here, seen);
    };
    const root = roots[0];
    if (!root) return { values: [], steps: [], issues, detail: null };
    visit(root.id, 0, new Set());
    const load = new Map<string, number>();
    const farthest = new Map<string, number>();
    const sum = (id: string): { load: number; far: number } => {
      const s = byId.get(id);
      let l = s?.load_mbh ?? 0;
      let far = (children.get(id) ?? []).length === 0 || l > 0 ? (path.get(id) ?? 0) : 0;
      for (const c of children.get(id) ?? []) {
        const r = sum(c);
        l += r.load;
        far = Math.max(far, r.far);
      }
      load.set(id, l);
      farthest.set(id, far);
      return { load: l, far };
    };
    const totals = sum(root.id);
    const longest = totals.far;
    const onLongest = new Set<string>();
    {
      let cur: string | undefined = root.id;
      while (cur) {
        onLongest.add(cur);
        const next: string | undefined = (children.get(cur) ?? []).find((c) => Math.abs((farthest.get(c) ?? 0) - longest) < 1e-9);
        cur = next;
      }
    }
    const methodClause = input.method === "longest_length" ? "longest_length" : "branch_length";
    const methodCiteRef = ifgcCite(ed, methodClause);
    const eqCite = ifgcCite(ed, usesHighPressure(inlet) ? "high_pressure_eq" : "low_pressure_eq");
    const crCite = ifgcCite(ed, "cr_y", input.gas === "natural" ? "natural gas Cr 0.6094, Y 0.9992" : "undiluted propane Cr 1.2462, Y 0.9910");
    const tableCite = table ? gasTableCite(table) : null;
    const sizeList: readonly GasTableSize[] = table?.sizes ?? [];
    const results: GasSegmentResult[] = input.segments.map((s) => {
      const mbh = load.get(s.id) ?? 0;
      const cfh = (mbh * 1000) / hv;
      const sizingLength = input.method === "longest_length" || onLongest.has(s.id) ? longest : (farthest.get(s.id) ?? longest);
      let tableResult: GasSegmentResult["table"] = null;
      let tableSize: GasTableSize | null = null;
      if (table && mbh > 0) {
        const want = table.capacityUnit === "mbh" ? mbh : cfh;
        const hit = lookupGasSize(table, sizingLength, want);
        if ("none" in hit) issues.push({ severity: "error", message: hit.none === "length_beyond_table" ? `${s.id}: ${round(sizingLength, 0)} ft is longer than ${table.tableId} goes; use the equation or a table that covers it.` : `${s.id}: ${round(want, 0)} ${table.capacityUnit === "mbh" ? "MBH" : "cfh"} at ${hit.rowLengthFt} ft is more than the largest size in ${table.tableId} carries.`, cite: tableCite ? [tableCite] : [] });
        else {
          tableSize = hit.size;
          tableResult = { size: hit.size.label, rowLengthFt: hit.rowLengthFt, capacity: hit.capacity, unit: table.capacityUnit };
        }
      }
      let eq: GasSegmentResult["equation"] = null;
      let eqFit: GasTableSize | null = null;
      if (input.basis !== "table" && mbh > 0) {
        const d = equationDiameter(cfh, sizingLength, inlet, drop, input.gas);
        const fit = sizeList.find((z2) => z2.idIn !== null && z2.idIn >= d - 1e-9) ?? null;
        eqFit = fit;
        const cap = fit?.idIn ? equationCfh(fit.idIn, sizingLength, inlet, drop, input.gas) : null;
        eq = { requiredIdIn: round(d, 3), size: fit?.label ?? null, capacityAtSize: cap === null ? null : round(table?.capacityUnit === "cfh" ? cap : (cap * hv) / 1000, 1) };
        if (!fit && sizeList.length > 0 && input.material !== "csst") issues.push({ severity: "warning", message: `${s.id}: the equation needs ${round(d, 3)} in. inside diameter, more than the largest size listed.`, cite: [eqCite] });
      }
      let agreement: number | null = null;
      if (table && tableResult && tableSize?.idIn) {
        const capEq = equationCfh(tableSize.idIn, tableResult.rowLengthFt, inlet, drop, input.gas);
        const capEqUnit = table.capacityUnit === "cfh" ? capEq : (capEq * hv) / 1000;
        agreement = round(((capEqUnit - tableResult.capacity) / tableResult.capacity) * 100, 2);
      }
      const size = tableResult?.size ?? eq?.size ?? (eq ? `${eq.requiredIdIn} in. ID` : null);
      const nominalIn = tableResult ? (tableSize?.nominalIn ?? null) : eq?.size ? (eqFit?.nominalIn ?? null) : null;
      return { id: s.id, label: s.label ?? null, loadMbh: round(mbh, 3), loadCfh: round(cfh, 1), pathFt: round(path.get(s.id) ?? 0, 1), sizingLengthFt: round(sizingLength, 1), onLongestRun: onLongest.has(s.id), table: tableResult, equation: eq, size, nominalIn, equationVsTablePct: agreement };
    });
    const cites = [methodCiteRef, ...(tableCite ? [tableCite] : []), ...(input.basis !== "table" ? [eqCite, crCite] : []), hvCite];
    const values: CalcValue[] = [
      { key: "total_mbh", label: "Connected load", value: round(totals.load, 3), unit: "mbh", cite: [GIVEN] },
      { key: "longest_length_ft", label: "Longest length (point of delivery to the most remote outlet)", value: round(longest, 1), unit: "ft", cite: [ifgcCite(ed, "longest_length")] },
      { key: "table", label: "Capacity table", value: table ? `${table.code} ${table.edition} ${table.tableId}` : null, unit: null, cite: tableCite ? [tableCite] : [ifgcCite(ed, "equations")] },
      ...results.map((r): CalcValue => ({ key: `size:${r.id}`, label: `${r.label ?? r.id} (${r.loadMbh} MBH at ${r.sizingLengthFt} ft)`, value: r.size, unit: "in", cite: cites })),
      ...results.filter((r) => r.nominalIn !== null).map((r): CalcValue => ({ key: `size_nominal_in:${r.id}`, label: `${r.label ?? r.id}, nominal inches`, value: r.nominalIn, unit: "in", cite: cites })),
    ];
    const steps: CalcStep[] = [
      { label: "Method", detail: input.method === "longest_length" ? `Longest length: every section is sized on the ${round(longest, 1)} ft from the point of delivery to the most remote outlet, with the load it carries` : `Branch length: sections on the longest run use ${round(longest, 1)} ft; each branch uses the length from the point of delivery to its own most remote outlet`, cite: [methodCiteRef] },
      ...(table ? [{ label: "Table", detail: `${table.tableId}: ${gasLabel}, ${table.title.toLowerCase()}, inlet ${table.meta.inlet}, drop ${table.meta.drop}; read at the first length equal to or longer than the sizing length`, cite: [tableCite as Citation] }] : []),
      ...(input.basis !== "table" ? [{ label: "Equation", detail: `${usesHighPressure(inlet) ? "High-pressure" : "Low-pressure"} sizing equation with ${gasLabel} Cr and Y`, cite: [eqCite, crCite] }] : []),
      ...results.filter((r) => r.loadMbh > 0).map((r): CalcStep => ({
        label: r.label ?? r.id,
        detail: `${r.loadMbh} MBH (${r.loadCfh} cfh) at ${r.sizingLengthFt} ft${r.table ? `: table ${r.table.size}" (${r.table.capacity} ${r.table.unit === "mbh" ? "MBH" : "cfh"} at ${r.table.rowLengthFt} ft)` : ""}${r.equation ? `; equation needs ${r.equation.requiredIdIn} in. ID${r.equation.size ? ` → ${r.equation.size}"` : ""}` : ""}${r.equationVsTablePct !== null ? `; equation vs table ${r.equationVsTablePct > 0 ? "+" : ""}${r.equationVsTablePct}%` : ""}`,
        cite: cites,
      })),
    ];
    if (input.material === "csst" && table?.extraFittingFt) issues.push({ severity: "info", message: `${table.tableId} includes 4 bends and 2 end fittings; add ${table.extraFittingFt} ft per extra fitting or bend as equivalent_length_ft.`, cite: [gasTableCite(table)] });
    return { values, steps, issues, detail: { longestFt: longest, table: table ? { tableId: table.tableId, code: table.code, edition: table.edition } : null, segments: results } };
  },
});

// ------------------------------------------------------------------ water heater

const heaterInput = z
  .object({
    fixtures: z.array(z.object({ label: z.string().trim().min(1).max(80), quantity: z.number().int().min(1).max(10_000).default(1), gph_each: z.number().min(0).max(10_000) }).strict()).max(500).optional().describe("Hot water demand per fixture (gal/h), the firm's values by building type."),
    demand_gph: z.number().min(0).max(100_000).optional().describe("Or the total demand directly."),
    demand_factor: z.number().min(0.05).max(1).default(1),
    rise_f: z.number().positive().max(150).default(90),
    peak_hot_gpm: z.number().min(0).max(1000).optional().describe("Peak hot water flow (tankless sizing), e.g. from plumbing.hunter_demand hot."),
    heater: z
      .object({
        kind: z.enum(["tank", "tankless_gas", "tankless_electric"]),
        storage_gal: z.number().min(0).max(100_000).optional(),
        recovery_gph: z.number().min(0).max(100_000).optional().describe("Recovery at rise_f, from the heater's data."),
        input_btuh: z.number().min(0).max(100_000_000).optional(),
        input_kw: z.number().min(0).max(10_000).optional(),
        efficiency: z.number().min(0.3).max(1).optional(),
      })
      .strict(),
  })
  .strict();

export const waterHeaterCalc = defineCalc({
  id: "plumbing.water_heater",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water heater capacity check",
  summary: "Hot water demand (gal/h, from fixtures × the firm's per-fixture gph × demand factor) against a tank heater's recovery at the rise, or peak hot gpm against a gas or electric tankless heater's flow at the rise. Reports required capacity and pass/fail; never names a product.",
  codeFamily: null,
  needsModel: false,
  input: heaterInput,
  example: { demand_gph: 198, rise_f: 90, heater: { kind: "tank", storage_gal: 100, recovery_gph: 323, input_btuh: 250_000 } },
  run: (input) => {
    const issues: CalcIssue[] = [];
    const steps: CalcStep[] = [];
    const ashrae = methodCite("ASHRAE service water heating", "fixture demand method", "per-fixture gph by building type, demand factor (firm values)");
    const heat = methodCite("Heat balance", `gal/h = Btu/h × efficiency / (${LB_PER_GAL} lb/gal × rise °F); gpm = Btu/h × efficiency / (500 × rise °F)`);
    let raw = input.demand_gph ?? 0;
    if (input.fixtures && input.demand_gph === undefined) {
      raw = input.fixtures.reduce((s, f) => s + f.quantity * f.gph_each, 0);
      steps.push({ label: "Fixture demand", detail: input.fixtures.map((f) => `${f.quantity} × ${f.gph_each} (${f.label})`).join(" + ") + ` = ${round(raw, 1)} gal/h`, cite: [ashrae] });
    }
    const demand = raw * input.demand_factor;
    if (input.demand_factor !== 1) steps.push({ label: "Demand factor", detail: `${round(raw, 1)} × ${input.demand_factor} = ${round(demand, 1)} gal/h`, cite: [ashrae] });
    const h = input.heater;
    const eff = h.efficiency ?? null;
    const values: CalcValue[] = [{ key: "demand_gph", label: "Hot water demand", value: round(demand, 1), unit: "gph", cite: [ashrae] }];
    let pass: boolean | null = null;
    if (h.kind === "tank") {
      let recovery = h.recovery_gph ?? null;
      if (recovery === null && h.input_btuh !== undefined && eff !== null) recovery = (h.input_btuh * eff) / (LB_PER_GAL * input.rise_f);
      if (recovery === null && h.input_kw !== undefined) recovery = (h.input_kw * 3412 * (eff ?? 0.98)) / (LB_PER_GAL * input.rise_f);
      if (recovery === null) issues.push({ severity: "error", message: "Give the tank's recovery at the rise, or its input and efficiency.", cite: [heat] });
      else {
        pass = recovery >= demand - 1e-9;
        values.push({ key: "recovery_gph", label: `Recovery at ${input.rise_f} °F rise`, value: round(recovery, 1), unit: "gph", cite: h.recovery_gph !== undefined ? [methodCite("Heater data", "recovery at the rise", "as given")] : [heat] });
        steps.push({ label: "Recovery", detail: `${round(recovery, 1)} gal/h at ${input.rise_f} °F rise${h.storage_gal !== undefined ? `, ${h.storage_gal} gal storage` : ""} vs ${round(demand, 1)} gal/h demand: ${pass ? "enough" : "short"}`, cite: [heat, ashrae] });
        if (h.input_btuh !== undefined && h.recovery_gph !== undefined) {
          const implied = (h.recovery_gph * LB_PER_GAL * input.rise_f) / h.input_btuh;
          steps.push({ label: "Implied efficiency", detail: `${h.recovery_gph} gal/h × ${LB_PER_GAL} × ${input.rise_f} °F / ${h.input_btuh} Btu/h = ${round(implied * 100, 1)}%`, cite: [heat] });
          if (implied > 1.0) issues.push({ severity: "warning", message: `The stated recovery implies ${round(implied * 100, 1)}% efficiency; check the rise it is rated at.`, cite: [heat] });
        }
      }
    } else {
      if (input.peak_hot_gpm === undefined) issues.push({ severity: "error", message: "A tankless heater is sized on peak hot water flow: give peak_hot_gpm (plumbing.hunter_demand's hot flow).", cite: [heat] });
      const btuh = h.kind === "tankless_gas" ? h.input_btuh : h.input_kw !== undefined ? h.input_kw * 3412 : undefined;
      const e = eff ?? (h.kind === "tankless_electric" ? 0.98 : null);
      if (btuh === undefined || e === null) issues.push({ severity: "error", message: h.kind === "tankless_gas" ? "Give the tankless heater's input (Btu/h) and efficiency." : "Give the tankless heater's input (kW).", cite: [heat] });
      else {
        const gpm = (btuh * e) / (500 * input.rise_f);
        values.push({ key: "capacity_gpm", label: `Flow at ${input.rise_f} °F rise`, value: round(gpm, 2), unit: "gpm", cite: [heat] });
        if (input.peak_hot_gpm !== undefined) {
          pass = gpm >= input.peak_hot_gpm - 1e-9;
          values.push({ key: "peak_hot_gpm", label: "Peak hot water flow", value: input.peak_hot_gpm, unit: "gpm", cite: [GIVEN] });
          steps.push({ label: "Tankless flow", detail: `${round(btuh, 0)} Btu/h × ${e} / (500 × ${input.rise_f}) = ${round(gpm, 2)} gpm vs ${input.peak_hot_gpm} gpm peak: ${pass ? "enough" : "short"}`, cite: [heat] });
        }
      }
    }
    if (pass !== null) values.push({ key: "pass", label: "Heater meets the demand", value: pass, unit: null, cite: [heat, ashrae] });
    if (pass === false) issues.push({ severity: "error", message: "The heater does not meet the demand at this rise.", cite: [heat] });
    return { values, steps, issues, detail: { demandGph: demand, pass } };
  },
});

// ------------------------------------------------------------------ grease interceptor

const greaseInput = z
  .object({
    fixtures: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            quantity: z.number().int().min(1).max(1000).default(1),
            volume_gal: z.number().positive().max(10_000).optional().describe("Compartment volume, or give length/width/depth."),
            length_in: z.number().positive().max(500).optional(),
            width_in: z.number().positive().max(500).optional(),
            depth_in: z.number().positive().max(200).optional(),
            compartments: z.number().int().min(1).max(10).default(1),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .optional()
      .describe("Fixtures to size from. Leave out and give interceptor_id to size from what the model pipes to the interceptor."),
    interceptor_id: z.string().trim().min(1).max(200).optional().describe("The grease interceptor in the model: sizes from every fixture piped to its inlet or naming it as source."),
    fill_factor: z.number().min(0.1).max(1).default(0.75),
    drain_down_min: z.union([z.literal(1), z.literal(2)]).default(1),
    rated_gpm: z.number().positive().max(10_000).optional().describe("The selected interceptor's flow rating, to check."),
    rated_lb: z.number().positive().max(100_000).optional(),
  })
  .strict()
  .refine((i) => i.fixtures !== undefined || i.interceptor_id !== undefined, { message: "give the fixtures, or the grease interceptor (interceptor_id) to size from what is piped to it", path: ["fixtures"] });

export const greaseInterceptorCalc = defineCalc({
  id: "plumbing.grease_interceptor",
  version: "1.1.0",
  domain: "plumbing",
  title: "Grease interceptor flow and retention",
  summary: "Required flow rating by the PDI G101 fixture-volume method (volume × fill factor / drain-down time) and the grease retention capacity from Table 1003.3.5.1 (twice the rating over 100 gpm); checks a rated unit. Given an interceptor in the model, sizes from the fixtures piped to it. Never names a product.",
  codeFamily: "ipc",
  needsModel: false,
  input: greaseInput,
  example: { fixtures: [{ label: "Three-compartment sink", length_in: 18, width_in: 18, depth_in: 12, compartments: 3 }], drain_down_min: 1, rated_gpm: 100 },
  run: (input, ctx) => {
    const ed = ipcOf(ctx.code);
    const pdi = methodCite("PDI G101", "flow = fixture volume × fill factor / drain-down time", `fill ${input.fill_factor}, ${input.drain_down_min} min drain-down`);
    const issues: CalcIssue[] = [];
    const steps: CalcStep[] = [];
    let volume = 0;
    let fixtures: readonly PipedGreaseFixture[] = input.fixtures ?? [];
    if (input.fixtures === undefined && input.interceptor_id !== undefined) {
      const piped = ctx.model ? greaseFixturesPipedTo(ctx.model, input.interceptor_id) : null;
      if (!piped) return { values: [], steps: [], issues: [{ severity: "error", message: ctx.model ? `No grease interceptor ${input.interceptor_id} in this model.` : "Give the model to size from what is piped to the interceptor, or list the fixtures.", cite: [pdi] }], detail: null };
      fixtures = piped.fixtures;
      steps.push({ label: "Fixtures", detail: `${piped.loadIds.length} fixture${piped.loadIds.length === 1 ? " drains" : "s drain"} through ${piped.interceptorName}`, cite: [pdi] });
      for (const m of piped.missing) issues.push({ severity: "warning", message: `${m} drains through ${piped.interceptorName} but has no bowl size; give its compartment length, width and depth (or volume) to count it.`, cite: [pdi] });
      if (fixtures.length === 0) return { values: [], steps, issues: [...issues, { severity: "error", message: `Nothing with a bowl size drains through ${piped.interceptorName} yet: pipe the kitchen fixtures to its inlet, or name it as their source.`, cite: [pdi] }], detail: null };
    }
    for (const f of fixtures) {
      const each = f.volume_gal ?? (f.length_in && f.width_in && f.depth_in ? (f.length_in * f.width_in * f.depth_in) / 231 : null);
      if (each === null) {
        issues.push({ severity: "error", message: `${f.label}: give volume_gal or length, width and depth.`, cite: [pdi] });
        continue;
      }
      const v = each * f.compartments * f.quantity;
      volume += v;
      steps.push({ label: f.label, detail: `${f.quantity} × ${f.compartments} compartment${f.compartments === 1 ? "" : "s"} × ${round(each, 2)} gal = ${round(v, 1)} gal`, cite: [pdi] });
    }
    const gpm = (volume * input.fill_factor) / input.drain_down_min;
    const row = TABLE_1003_3_5_1.find((r) => r.gpm >= gpm - 1e-9);
    const lb = gpm > 100 ? 2 * gpm : (row?.lb ?? 2 * gpm);
    const tableCite = ipcCite(ed, "grease_capacity", gpm > 100 ? "over 100 gpm: twice the rating (note a)" : `${row?.gpm ?? gpm} gpm row`);
    steps.push({ label: "Flow", detail: `${round(volume, 1)} gal × ${input.fill_factor} / ${input.drain_down_min} min = ${round(gpm, 1)} gpm`, cite: [pdi] });
    steps.push({ label: "Retention", detail: `${round(gpm, 1)} gpm: ${round(lb, 0)} lb grease retention`, cite: [tableCite] });
    const values: CalcValue[] = [
      { key: "required_gpm", label: "Required flow rating", value: round(gpm, 1), unit: "gpm", cite: [pdi] },
      { key: "required_lb", label: "Required grease retention", value: round(lb, 0), unit: "lb", cite: [tableCite] },
    ];
    if (input.rated_gpm !== undefined) {
      const pass = input.rated_gpm >= gpm - 1e-9 && (input.rated_lb === undefined || input.rated_lb >= lb - 1e-9);
      values.push({ key: "pass", label: "Rated interceptor meets it", value: pass, unit: null, cite: [pdi, tableCite, ipcCite(ed, "grease_interceptor")] });
      if (!pass) issues.push({ severity: "error", message: `The rated ${input.rated_gpm} gpm${input.rated_lb !== undefined ? ` / ${input.rated_lb} lb` : ""} is below the required ${round(gpm, 1)} gpm / ${round(lb, 0)} lb.`, cite: [tableCite] });
    }
    return { values, steps, issues, detail: { volumeGal: volume, requiredGpm: gpm, requiredLb: lb } };
  },
});

// ------------------------------------------------------------------ water meter

const meterInput = z
  .object({
    demand_gpm: z.number().min(0).max(100_000),
    meter: z
      .object({
        size_in: z.number().positive().max(24).optional(),
        max_flow_gpm: z.number().positive().max(100_000).optional().describe("The meter's maximum rated flow."),
        loss_at_max_psi: z.number().positive().max(50).optional().describe("Its pressure loss at that flow (manufacturer or AWWA data)."),
        loss_curve: z.array(z.object({ gpm: z.number().min(0), psi: z.number().min(0) }).strict()).min(2).max(50).optional().describe("Or its loss curve as points."),
      })
      .strict(),
  })
  .strict();

export const waterMeterCalc = defineCalc({
  id: "plumbing.water_meter",
  version: "1.0.0",
  domain: "plumbing",
  title: "Water meter pressure loss",
  summary: "Pressure loss through a water meter at the design flow, from its loss curve or by the square law from its rated maximum flow and loss there (manufacturer / AWWA data the engineer gives). Feeds plumbing.pressure_report.",
  codeFamily: null,
  needsModel: false,
  input: meterInput,
  example: { demand_gpm: 48, meter: { size_in: 1.5, max_flow_gpm: 100, loss_at_max_psi: 19.5 } },
  run: (input) => {
    const m = input.meter;
    const issues: CalcIssue[] = [];
    let psi: number | null = null;
    let cite: Citation;
    if (m.loss_curve) {
      cite = methodCite("Meter loss curve", "interpolated at the design flow", "manufacturer / AWWA data as given");
      psi = interpolateTable(m.loss_curve.map((p) => ({ x: p.gpm, y: p.psi })), input.demand_gpm);
      const top = Math.max(...m.loss_curve.map((p) => p.gpm));
      if (input.demand_gpm > top) issues.push({ severity: "warning", message: `${input.demand_gpm} gpm is past the curve's last point (${top} gpm).`, cite: [cite] });
    } else if (m.max_flow_gpm !== undefined && m.loss_at_max_psi !== undefined) {
      cite = methodCite("Square law", "loss = loss at max × (Q / Q max)²", "from the meter's rated maximum");
      psi = m.loss_at_max_psi * (input.demand_gpm / m.max_flow_gpm) ** 2;
      if (input.demand_gpm > m.max_flow_gpm) issues.push({ severity: "error", message: `${input.demand_gpm} gpm is over the meter's ${m.max_flow_gpm} gpm maximum: a larger meter is required.`, cite: [cite] });
    } else {
      cite = methodCite("Meter loss", "needs data");
      issues.push({ severity: "error", message: "Give the meter's loss curve, or its maximum flow and the loss at that flow.", cite: [] });
    }
    const values: CalcValue[] = psi === null ? [] : [{ key: "meter_loss_psi", label: "Meter loss at the design flow", value: round(psi, 2), unit: "psi", cite: [cite] }];
    if (psi !== null && m.max_flow_gpm) values.push({ key: "utilization_pct", label: "Share of the meter's maximum", value: round((input.demand_gpm / m.max_flow_gpm) * 100, 1), unit: "pct", cite: [cite] });
    return { values, steps: psi === null ? [] : [{ label: "Meter loss", detail: `${input.demand_gpm} gpm${m.size_in ? ` through a ${nominalLabel(m.size_in)} in. meter` : ""}: ${round(psi, 2)} psi`, cite: [cite] }], issues, detail: { psi } };
  },
});

export const PLUMBING_CODE_CALCS = [hunterDemandCalc, pressureReportCalc, sizeWaterCalc, sizeDrainCalc, sizeGasCalc, waterHeaterCalc, greaseInterceptorCalc, waterMeterCalc] as const;

/** Appends to the list under `key` (copying the list per add is quadratic in its size). */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
