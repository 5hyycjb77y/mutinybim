import { z } from "zod";
import { isNecEdition, necCite, type NecEdition, CONDUCTOR_SIZES, parseConductorSize, sizeLabel, type ConductorSize, CONDUIT_TABLE9_RACEWAY, defineCalc, type CalcContext, type CalcIssue, type CalcValue, q, round } from "@permitzip/bim-calc";
import { demandInput, demandLoad } from "./demand";
import { conductorAmpacity, conduitFill, conduitLabel, effectiveImpedance, equipmentGround, voltageDrop } from "./nec";
import { motorCircuit, motorCircuitInput } from "./motor";
import { CIRCUIT_SYSTEMS, sizeCircuit, sizeCircuitInput } from "./size-circuit";
import { serviceSize, serviceSizeInput } from "./service-size";
import { faultCurrent, faultCurrentInput } from "./fault-current";

function nec(ctx: CalcContext): NecEdition {
  if (!isNecEdition(ctx.code)) throw new Error("This calc needs the NEC pack; the registry resolves it before running");
  return ctx.code;
}

const size = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((text, check): ConductorSize => {
    const parsed = parseConductorSize(text);
    if (parsed) return parsed;
    check.addIssue({ code: "custom", message: `"${text}" isn't a conductor size; use AWG or kcmil as NEC tables do (${CONDUCTOR_SIZES.slice(0, 4).join(", ")}, …, 1/0, 250, 500)` });
    return z.NEVER;
  })
  .describe('Conductor size: "12", "#12", "1/0", "250 kcmil".');

const temp = z.union([z.literal(60), z.literal(75), z.literal(90)]);

export const sizeCircuitCalc = defineCalc({
  id: "nec.size_circuit",
  version: "1.1.0",
  domain: "electrical",
  title: "Size a branch circuit or feeder (NEC)",
  summary:
    "From the load (continuous at 125%), length and voltage: overcurrent device (240.6(A)), smallest conductor with the ampacity at the terminations' temperature and the installation's ambient and conductor count (310.16, 310.15, 110.14(C)) and protected by the device (240.4(B)/(D)), voltage drop by Chapter 9 Table 9 upsized to the design target, the EGC from 250.122 grown in proportion when the phase conductors grow, and the conduit (Chapter 9 Tables 1, 4, 5). Every value cites its clause.",
  codeFamily: "nec",
  needsModel: false,
  input: sizeCircuitInput,
  example: { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250, conduit: "emt" },
  run: (input, ctx) => sizeCircuit(nec(ctx), ctx.criteria, input),
});

export const demandLoadCalc = defineCalc({
  id: "nec.demand_load",
  version: "1.0.0",
  domain: "electrical",
  title: "Calculated (demand) load at a panel or service (NEC Article 220)",
  summary:
    "Connected load by class and the demand factor each class gets: general lighting (2020 Table 220.42 / 2023 Table 220.45), non-dwelling receptacles over 10 kVA at 50% (220.44 / 220.47), kitchen equipment by the count at this node (Table 220.56, not less than the two largest), motors and HVAC at 100% plus 25% of the largest (220.50, 430.24), the larger of heating and cooling (220.60). Gives the calculated load, the load conductors and the device are sized for (continuous at 125%), and the smallest standard device. Give the raw inventory below the node, not child panels' demand.",
  codeFamily: "nec",
  needsModel: false,
  input: demandInput,
  example: {
    node: "MDP",
    voltage_v: 480,
    phases: 3,
    loads: [
      { class: "lighting", va: 1600, quantity: 2, label: "277 V lighting circuits" },
      { class: "receptacle", va: 180, quantity: 80 },
      { class: "kitchen", va: 1320, quantity: 6, label: "reach-in freezer" },
      { class: "hvac", va: 26600, label: "RTU-1" },
    ],
  },
  run: (input, ctx) => demandLoad(nec(ctx), input),
});

const ampacityInput = z
  .object({
    size,
    material: z.enum(["copper", "aluminum"]).default("copper"),
    insulation_temp_c: temp.default(90).describe("Conductor insulation rating: 90 for THHN/THWN-2/XHHW-2."),
    terminal_temp_c: temp.default(75).describe("Termination rating (110.14(C)): 60 or 75 for most equipment."),
    ambient_c: z.number().min(-40).max(85).default(30),
    current_carrying_conductors: z.number().int().min(1).max(100).default(3),
  })
  .strict();

export const conductorAmpacityCalc = defineCalc({
  id: "nec.conductor_ampacity",
  version: "1.0.0",
  domain: "electrical",
  title: "Conductor ampacity (NEC 310.16 with corrections)",
  summary: "Table 310.16 at the insulation's column, corrected for ambient (Table 310.15(B)(1) / 2023 (B)(1)(1)) and more than three current-carrying conductors (Table 310.15(C)(1)), then limited to the terminations' column (110.14(C)).",
  codeFamily: "nec",
  needsModel: false,
  input: ampacityInput,
  example: { size: "1", material: "copper", insulation_temp_c: 90, terminal_temp_c: 75, ambient_c: 40, current_carrying_conductors: 6 },
  run: (input, ctx) => {
    const n = nec(ctx);
    const a = conductorAmpacity(n, { size: input.size, material: input.material, insulationTempC: input.insulation_temp_c, terminalTempC: input.terminal_temp_c, ambientC: input.ambient_c, currentCarrying: input.current_carrying_conductors });
    const issues: CalcIssue[] = a.allowable === null ? [{ severity: "error", message: `Table 310.16 has no ${input.insulation_temp_c}°C ${input.material} value for ${sizeLabel(input.size)} at ${input.ambient_c}°C.`, cite: a.cite }] : [];
    const values: CalcValue[] = [
      { key: "base_a", label: `Table 310.16, ${input.insulation_temp_c}°C`, value: a.base, unit: "A", cite: [a.cite[0] ?? necCite(n, "ampacity_table")] },
      { key: "ambient_factor", label: "Ambient correction", value: a.ambientFactor, unit: "ratio", cite: [necCite(n, "ambient_correction")] },
      { key: "adjustment_factor", label: "More than three conductors", value: a.adjustmentFactor, unit: "ratio", cite: [necCite(n, "ccc_adjustment")] },
      { key: "corrected_a", label: "Corrected", value: a.corrected === null ? null : round(a.corrected, 2), unit: "A", cite: a.cite },
      { key: "terminal_limit_a", label: `Terminations, ${a.terminalColumnTempC}°C column`, value: a.terminalLimit, unit: "A", cite: [necCite(n, "terminal_rating")] },
      { key: "allowable_a", label: "Allowable ampacity", value: a.allowable === null ? null : round(a.allowable, 2), unit: "A", cite: a.cite },
    ];
    return { values, steps: [{ label: "Ampacity", detail: `${a.base} A x ${a.ambientFactor} x ${a.adjustmentFactor} = ${a.corrected === null ? "—" : round(a.corrected, 2)} A; terminations allow ${a.terminalLimit} A → ${a.allowable === null ? "—" : round(a.allowable, 2)} A`, cite: a.cite }], issues, detail: a };
  },
});

const vdInput = z
  .object({
    size,
    material: z.enum(["copper", "aluminum"]).default("copper"),
    conduit: z.enum(["emt", "pvc40", "pvc80"]).default("emt"),
    system: z.enum(CIRCUIT_SYSTEMS),
    voltage_v: z.number().positive().max(1000),
    load_a: z.number().positive().max(6000),
    length_ft: z.number().positive().max(10000),
    power_factor: z.number().min(0.5).max(1).optional(),
    parallel_sets: z.number().int().min(1).max(12).default(1),
  })
  .strict();

export const voltageDropCalc = defineCalc({
  id: "nec.voltage_drop",
  version: "1.0.0",
  domain: "electrical",
  title: "Voltage drop (NEC Chapter 9 Table 9)",
  summary: "Effective impedance Ze = R x PF + XL x sin(arccos PF) from Chapter 9 Table 9 (75°C, by raceway), then 2 x I x Ze x L single-phase or √3 x I x Ze x L three-phase; percent of the nominal voltage, against the design target.",
  codeFamily: "nec",
  needsModel: false,
  input: vdInput,
  example: { size: "10", material: "copper", conduit: "emt", system: "1ph_2w", voltage_v: 277, load_a: 16, length_ft: 300 },
  run: (input, ctx) => {
    const n = nec(ctx);
    const pf = input.power_factor ?? ctx.criteria.electrical.powerFactor;
    const raceway = CONDUIT_TABLE9_RACEWAY[input.conduit];
    const z9 = effectiveImpedance(n, input.size, input.material, raceway, pf);
    const cite = [necCite(n, "ac_impedance", `${sizeLabel(input.size)} ${input.material}, ${raceway} raceway, PF ${pf}`)];
    if (!z9) return { values: [], steps: [], issues: [{ severity: "error", message: `Chapter 9 Table 9 doesn't list ${sizeLabel(input.size)} ${input.material}.`, cite }], detail: null };
    const phases = input.system.startsWith("3ph") ? 3 : 1;
    const vd = voltageDrop(z9.ze, q(input.load_a, "A"), q(input.length_ft, "ft"), q(input.voltage_v, "V"), phases, input.parallel_sets);
    const target = ctx.criteria.electrical.branchVoltageDropPct;
    return {
      values: [
        { key: "r_ohm_per_kft", label: "AC resistance", value: z9.r, unit: "ohm_per_kft", cite },
        { key: "xl_ohm_per_kft", label: "Reactance", value: z9.xl, unit: "ohm_per_kft", cite },
        { key: "ze_ohm_per_kft", label: "Effective impedance", value: round(z9.ze, 5), unit: "ohm_per_kft", cite },
        { key: "voltage_drop_v", label: "Voltage drop", value: round(vd.volts, 2), unit: "V", cite },
        { key: "voltage_drop_pct", label: "Voltage drop", value: round(vd.pct, 2), unit: "pct", cite },
      ],
      steps: [{ label: "Voltage drop", detail: `${phases === 3 ? "√3" : "2"} x ${input.load_a} A x ${round(z9.ze, 4)} Ω/kft x ${input.length_ft} ft${input.parallel_sets > 1 ? ` / ${input.parallel_sets} sets` : ""} = ${round(vd.volts, 2)} V = ${round(vd.pct, 2)}% of ${input.voltage_v} V`, cite }],
      issues: vd.pct > target + 1e-9 ? [{ severity: "warning", message: `${round(vd.pct, 2)}% is over the ${target}% design target.`, cite: [] }] : [],
      detail: { ...z9, ...vd },
    };
  },
});

const egcInput = z
  .object({
    ocpd_a: z.number().positive().max(6000).describe("Rating or setting of the overcurrent device ahead of the circuit."),
    material: z.enum(["copper", "aluminum"]).default("copper").describe("EGC material."),
    minimum_phase_size: size.optional().describe("The smallest phase conductor that had the ampacity (before any voltage-drop upsizing)."),
    phase_size: size.optional().describe("The phase conductor actually installed."),
  })
  .strict();

export const egcCalc = defineCalc({
  id: "nec.egc",
  version: "1.0.0",
  domain: "electrical",
  title: "Equipment grounding conductor (NEC 250.122)",
  summary: "Table 250.122 by the overcurrent device; when the phase conductors were upsized from the minimum that had the ampacity, the EGC grows by the same ratio of circular mils (250.122(B), Chapter 9 Table 8), and is never larger than the phase conductors (250.122(A)).",
  codeFamily: "nec",
  needsModel: false,
  input: egcInput,
  example: { ocpd_a: 20, material: "copper", minimum_phase_size: "12", phase_size: "8" },
  run: (input, ctx) => {
    const n = nec(ctx);
    const min = input.minimum_phase_size ?? input.phase_size ?? "2000";
    const phase = input.phase_size ?? min;
    const egc = equipmentGround(n, input.ocpd_a, input.material, min, phase);
    if (!egc) return { values: [], steps: [], issues: [{ severity: "error", message: `Table 250.122 stops at 6000 A.`, cite: [necCite(n, "egc_table")] }], detail: null };
    return {
      values: [
        { key: "table_size", label: "Table 250.122", value: sizeLabel(egc.tableSize), unit: null, cite: [necCite(n, "egc_table")] },
        { key: "egc", label: "Equipment grounding conductor", value: sizeLabel(egc.size), unit: null, cite: egc.cite },
      ],
      steps: [{ label: "EGC", detail: egc.upsized ? `${sizeLabel(egc.tableSize)} grown x${egc.ratio.toFixed(3)} → ${sizeLabel(egc.size)}` : `${sizeLabel(egc.size)}`, cite: egc.cite }],
      issues: [],
      detail: egc,
    };
  },
});

const fillInput = z
  .object({
    conduit: z.enum(["emt", "pvc40", "pvc80"]),
    conductors: z.array(z.object({ size, insulation: z.enum(["THHN", "XHHW-2"]).default("THHN"), count: z.number().int().min(1).max(200) }).strict()).min(1).max(50),
  })
  .strict();

export const conduitFillCalc = defineCalc({
  id: "nec.conduit_fill",
  version: "1.0.0",
  domain: "electrical",
  title: "Conduit size by fill (NEC Chapter 9)",
  summary: "Sum of conductor areas (Chapter 9 Table 5) against the allowed fill (Table 1: 53% one conductor, 31% two, 40% over two) of each trade size (Table 4) for EMT, PVC Schedule 40 or 80; the smallest that fits.",
  codeFamily: "nec",
  needsModel: false,
  input: fillInput,
  example: { conduit: "emt", conductors: [{ size: "1", count: 4 }, { size: "6", count: 1 }] },
  run: (input, ctx) => {
    const n = nec(ctx);
    const fill = conduitFill(n, input.conduit, input.conductors.map((c) => ({ ...c, role: "conductor" })));
    const issues: CalcIssue[] = fill.missing.length > 0 ? [{ severity: "error", message: `Chapter 9 Table 5 has no area for ${fill.missing.join(", ")}.`, cite: [necCite(n, "conductor_areas")] }] : !fill.conduit ? [{ severity: "error", message: `Too much for one ${conduitLabel(input.conduit)}; split into two raceways.`, cite: fill.cite }] : [];
    return {
      values: [
        { key: "area_in2", label: "Conductor area", value: round(fill.areaIn2, 4), unit: "in2", cite: [necCite(n, "conductor_areas")] },
        { key: "conduit", label: "Conduit", value: fill.conduit ? `${fill.conduit.tradeSize} in ${conduitLabel(input.conduit)}` : null, unit: null, cite: fill.cite },
        { key: "fill_pct", label: "Fill", value: fill.usedPct === null ? null : round(fill.usedPct, 1), unit: "pct", cite: fill.cite },
      ],
      steps: [{ label: "Conduit fill", detail: `${fill.conductors} conductors, ${round(fill.areaIn2, 4)} in², ${fill.fillPercent}% allowed${fill.conduit ? ` → ${fill.conduit.tradeSize} in` : ""}`, cite: fill.cite }],
      issues,
      detail: fill,
    };
  },
});

export const motorCircuitCalc = defineCalc({
  id: "nec.motor_circuit",
  version: "1.0.0",
  domain: "electrical",
  title: "Size a motor branch circuit (NEC Article 430)",
  summary:
    "From horsepower, voltage and phases: the table full-load current (Table 430.248 / 430.250, read by 430.6(A)(1), not the nameplate), conductors at 125% (430.22), the largest short-circuit and ground-fault device Table 430.52 allows for the device type (next standard rating up), then conductor, voltage drop, EGC and conduit as for any branch circuit, with the device protecting the conductors against faults only (240.4(G)).",
  codeFamily: "nec",
  needsModel: false,
  input: motorCircuitInput,
  example: { hp: 10, voltage_v: 460, phases: 3, device: "inverse_time_breaker", length_ft: 120 },
  run: (input, ctx) => motorCircuit(nec(ctx), ctx.criteria, input),
});

export const serviceSizeCalc = defineCalc({
  id: "nec.service_size",
  version: "1.0.0",
  domain: "electrical",
  title: "Early service size from an equipment list (NEC 220, 230.42, 230.79)",
  summary:
    "Before layout: the kitchen and mechanical equipment (one row per item, VA per unit, the load class the engineer confirmed) through the Article 220 demand calc (220.56 kitchen count, 25% of the largest motor, larger of heating and cooling), then the smallest standard service at or above the load with continuous loads at 125% and any spare the engineer adds. Read a pasted list into rows first with bim_service_from_equipment_list.",
  codeFamily: "nec",
  needsModel: false,
  input: serviceSizeInput,
  example: {
    voltage_v: 208,
    phases: 3,
    items: [
      { label: "K-10 Sandwich prep refrigerator", class: "kitchen", va: 600 },
      { label: "K-14 Fryer", class: "kitchen", va: 14000, quantity: 2 },
      { label: "RTU-1", class: "hvac", va: 16400 },
    ],
  },
  run: (input, ctx) => serviceSize(nec(ctx), input),
});

export const faultCurrentCalc = defineCalc({
  id: "elec.fault_current_p2p",
  version: "0.1.0",
  domain: "electrical",
  title: "Available fault current, point-to-point (preview)",
  summary:
    "Preview. From the utility's available fault current or a transformer (kVA, %Z, infinite bus unless the primary is given) through each feeder (size, material, parallel sets, steel or non-magnetic raceway, length) by the Eaton Bussmann point-to-point method, to the fault current at every panel, checked against its kA rating. Motor contribution and X/R are not included.",
  codeFamily: null,
  needsModel: false,
  input: faultCurrentInput,
  example: {
    source: { kind: "transformer", kva: 500, voltage_v: 208, phases: 3, impedance_pct: 5 },
    nodes: [
      { name: "MDP", fed_from: "source", size: "500", sets: 4, length_ft: 25, aic_ka: 65 },
      { name: "L1", fed_from: "MDP", size: "3/0", length_ft: 80, aic_ka: 22 },
    ],
  },
  run: (input) => faultCurrent(input),
});

export const ELECTRICAL_CALCS = [sizeCircuitCalc, demandLoadCalc, conductorAmpacityCalc, voltageDropCalc, egcCalc, conduitFillCalc, motorCircuitCalc, serviceSizeCalc] as const;

/** Calcs that run only where the preview flag is on (bim_run_calc reads it). */
export const PREVIEW_ELECTRICAL_CALCS = [faultCurrentCalc] as const;
