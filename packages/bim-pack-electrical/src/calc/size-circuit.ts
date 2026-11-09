import { z } from "zod";
import { criteriaCite, necCite, type NecEdition, CONDUCTOR_SIZES, materialLabel, sizeIndex, sizeLabel, type ConductorSize, CONDUIT_TABLE9_RACEWAY, INSULATION_TEMP_C, type CalcIssue, type CalcOutput, type CalcStep, type CalcValue, type Citation, type DesignCriteria, q, round } from "@permitzip/bim-calc";
import { conductorAmpacity, conduitFill, conduitLabel, defaultTerminalTemp, effectiveImpedance, equipmentGround, isStandardRating, nextStandardRating, protection, voltageDrop, type AmpacityResult, type FillResult, type TempRating } from "./nec";

/**
 * Size one branch circuit or feeder: the load at 125% continuous, the
 * overcurrent device, the smallest conductor with the ampacity under the
 * installation's conditions and protected by that device, voltage drop over
 * the run (upsizing until it meets the design target), the equipment
 * grounding conductor (grown in proportion when the phase conductors grew),
 * and the conduit. Every step cites the clause or table it used.
 */

export const CIRCUIT_SYSTEMS = ["1ph_2w", "1ph_2pole", "3ph_3w", "3ph_4w"] as const;

/** When parallel sets are chosen automatically, each conductor stays at or below this size if any number of sets allows it (pulling and terminating larger conductors is impractical): a design preference. */
export const PARALLEL_PREFERRED_MAX: ConductorSize = "600";
export type CircuitSystem = (typeof CIRCUIT_SYSTEMS)[number];

const SYSTEM: Readonly<Record<CircuitSystem, { readonly phases: 1 | 3; readonly hots: number; readonly neutral: boolean; readonly ccc: number; readonly label: string }>> = {
  "1ph_2w": { phases: 1, hots: 1, neutral: true, ccc: 2, label: "single-phase, line to neutral (2 wire)" },
  "1ph_2pole": { phases: 1, hots: 2, neutral: false, ccc: 2, label: "single-phase, line to line (2 pole, no neutral)" },
  "3ph_3w": { phases: 3, hots: 3, neutral: false, ccc: 3, label: "three-phase, 3 wire" },
  "3ph_4w": { phases: 3, hots: 3, neutral: true, ccc: 3, label: "three-phase, 4 wire (balanced neutral not counted)" },
};

export const sizeCircuitInput = z
  .object({
    circuit: z.enum(["branch", "feeder"]).describe("A branch circuit (210.19 / 210.20) or a feeder (215.2 / 215.3)."),
    system: z.enum(CIRCUIT_SYSTEMS).describe("1ph_2w: one hot and a neutral (120 V, 277 V). 1ph_2pole: two hots, no neutral (208 V, 240 V, 480 V single-phase). 3ph_3w / 3ph_4w: three-phase without / with a neutral."),
    voltage_v: z.number().positive().max(1000).describe("Nominal voltage the drop is a percent of: line to neutral for 1ph_2w (277), line to line otherwise (208, 480)."),
    continuous_load_a: z.number().min(0).max(6000).default(0).describe("Load expected to run 3 hours or more, amps (counted at 125%)."),
    noncontinuous_load_a: z.number().min(0).max(6000).default(0).describe("The rest of the load, amps."),
    length_ft: z.number().positive().max(10000).optional().describe("One-way length of the run, feet. Without it, voltage drop is not checked."),
    material: z.enum(["copper", "aluminum"]).default("copper"),
    insulation: z.enum(["THHN", "XHHW-2"]).default("THHN").describe("THHN covers THHN/THWN-2 (90°C)."),
    terminal_temp_c: z.union([z.literal(60), z.literal(75)]).optional().describe("Termination rating. Omit to use 110.14(C)(1): 60°C at 100 A or less, 75°C above. Give 75 when the equipment is listed and marked for 75°C."),
    ocpd_a: z.number().int().positive().max(6000).optional().describe("Keep this breaker or fuse rating (e.g. a 20 A branch breaker) instead of the minimum."),
    ambient_c: z.number().min(-40).max(85).optional().describe("Ambient temperature, °C (default from the design criteria, 30°C)."),
    current_carrying_conductors: z.number().int().min(1).max(100).optional().describe("Current-carrying conductors in the raceway (default from the system: 2 for single-phase, 3 for three-phase)."),
    conduit: z.enum(["emt", "pvc40", "pvc80"]).default("emt").describe("Raceway: EMT counts as steel for Table 9."),
    power_factor: z.number().min(0.5).max(1).optional().describe("Load power factor for voltage drop (default from the design criteria)."),
    max_voltage_drop_pct: z.number().positive().max(20).optional().describe("Voltage drop target for this run (default: design criteria, 3% branch / 3% feeder)."),
    upstream_voltage_drop_pct: z.number().min(0).max(20).optional().describe("Drop already taken upstream (feeder), to check the combined target (5% by default)."),
    supplies_receptacles: z.boolean().default(false).describe("A branch circuit with more than one receptacle for cord-and-plug loads (no 240.4(B) next-size-up)."),
    egc_material: z.enum(["copper", "aluminum"]).optional().describe("EGC material (default: same as the phase conductors)."),
    parallel_sets: z.number().int().min(1).max(10).optional().describe("Run the conductors in this many parallel sets (310.10(G): 1/0 and larger, each set in its own raceway). Omit: one set, or the fewest sets that work when no single conductor carries the load."),
    motor_branch: z.boolean().default(false).describe("A motor branch circuit: the device protects against short circuit and ground fault only (240.4(G), Article 430), so it may be larger than the conductor ampacity. Size the load as 125% of the motor's table full-load current."),
  })
  .strict()
  .refine((v) => v.continuous_load_a + v.noncontinuous_load_a > 0, { message: "Give a load: continuous_load_a and/or noncontinuous_load_a." });

export type SizeCircuitInput = z.infer<typeof sizeCircuitInput>;

export interface SizeRow {
  readonly size: ConductorSize;
  readonly label: string;
  readonly allowableA: number | null;
  /** Has the ampacity and is protected by the device (240.4). */
  readonly meetsAmpacity: boolean;
  readonly voltageDropPct: number | null;
}

export interface SizeCircuitDetail {
  readonly requiredA: number;
  readonly ocpdA: number;
  readonly terminalTempC: TempRating;
  readonly minimum: { readonly size: ConductorSize; readonly ampacity: AmpacityResult } | null;
  readonly chosen: { readonly size: ConductorSize; readonly ampacity: AmpacityResult; readonly voltageDropPct: number | null; readonly voltageDropV: number | null } | null;
  readonly upsizedForVoltageDrop: boolean;
  /** Parallel sets the phase conductors run in (1: a single set). */
  readonly sets: number;
  readonly egc: { readonly size: ConductorSize; readonly tableSize: ConductorSize; readonly material: string } | null;
  readonly fill: FillResult | null;
  readonly sizes: readonly SizeRow[];
  readonly description: string | null;
}

export function sizeCircuit(nec: NecEdition, criteria: DesignCriteria, input: SizeCircuitInput): CalcOutput<SizeCircuitDetail> {
  const sys = SYSTEM[input.system];
  const steps: CalcStep[] = [];
  const issues: CalcIssue[] = [];
  const values: CalcValue[] = [];
  const isBranch = input.circuit === "branch";
  const conductorClause = isBranch ? "branch_conductor" : "feeder_conductor";
  const ocpdClause = isBranch ? "branch_ocpd" : "feeder_ocpd";
  const insulationTemp: TempRating = INSULATION_TEMP_C[input.insulation];
  const ambient = input.ambient_c ?? criteria.electrical.ambientC;
  const ccc = input.current_carrying_conductors ?? sys.ccc;
  const pf = input.power_factor ?? criteria.electrical.powerFactor;
  const egcMaterial = input.egc_material ?? input.material;

  // 1. Load.
  const requiredA = input.continuous_load_a * 1.25 + input.noncontinuous_load_a;
  const loadCite = [necCite(nec, conductorClause, "125% of the continuous load plus the noncontinuous load")];
  steps.push({ label: "Load", detail: `${input.continuous_load_a} A continuous x 125% + ${input.noncontinuous_load_a} A noncontinuous = ${round(requiredA, 2)} A`, cite: loadCite });
  values.push({ key: "required_ampacity_a", label: "Conductor ampacity needed", value: round(requiredA, 2), unit: "A", cite: loadCite });

  // 2. Overcurrent device.
  const minOcpd = nextStandardRating(nec, requiredA);
  if (minOcpd === null) return refuse(`${round(requiredA, 1)} A is above the largest standard rating (6000 A); split the load across parallel feeders.`, steps, values);
  let ocpdA = minOcpd;
  const ocpdCite = [necCite(nec, ocpdClause, "not less than 125% of the continuous load plus the noncontinuous load"), necCite(nec, "standard_ratings", `${minOcpd} A`)];
  if (input.ocpd_a !== undefined) {
    if (input.ocpd_a + 1e-9 < requiredA) {
      issues.push({ severity: "error", message: `A ${input.ocpd_a} A device is smaller than the ${round(requiredA, 1)} A this load needs; use at least ${minOcpd} A.`, cite: ocpdCite });
      return { values, steps, issues, detail: emptyDetail(requiredA, minOcpd) };
    }
    if (!isStandardRating(nec, input.ocpd_a)) issues.push({ severity: "warning", message: `${input.ocpd_a} A is not a standard rating in 240.6(A); an adjustable-trip device needs its setting stated.`, cite: [necCite(nec, "standard_ratings")] });
    ocpdA = input.ocpd_a;
  }
  steps.push({ label: "Overcurrent device", detail: input.ocpd_a !== undefined ? `${ocpdA} A as given (minimum ${minOcpd} A)` : `${ocpdA} A: the smallest standard rating at or above ${round(requiredA, 1)} A`, cite: ocpdCite });
  values.push({ key: "ocpd_a", label: "Overcurrent device", value: ocpdA, unit: "A", cite: ocpdCite });

  // 3. Termination temperature.
  const terminal = input.terminal_temp_c !== undefined
    ? { tempC: input.terminal_temp_c, cite: input.terminal_temp_c === 75 && ocpdA <= 100 ? necCite(nec, "terminal_listed_75", "equipment listed and identified for 75°C conductors") : necCite(nec, "terminal_rating", `${input.terminal_temp_c}°C terminations as given`) }
    : defaultTerminalTemp(nec, ocpdA);
  steps.push({ label: "Terminations", detail: `${terminal.tempC}°C column for terminations`, cite: [terminal.cite] });

  // 4. Smallest conductor with the ampacity, protected by the device.
  const ampacityOf = (size: ConductorSize) => conductorAmpacity(nec, { size, material: input.material, insulationTempC: insulationTemp, terminalTempC: terminal.tempC, ambientC: ambient, currentCarrying: ccc });
  const smallest = CONDUCTOR_SIZES.filter((s) => sizeIndex(s) >= sizeIndex(input.material === "aluminum" ? "12" : "14"));
  const parallelOk = (s: ConductorSize) => sizeIndex(s) >= sizeIndex(nec.tables.PARALLEL_MIN_SIZE as ConductorSize);
  // 240.4(G): a motor branch circuit's device protects against faults only; the conductors are protected per Article 430.
  const protectionOf = (size: ConductorSize, allowable: number) =>
    input.motor_branch ? { ok: true, reason: `the ${ocpdA} A device protects against short circuit and ground fault only`, cite: [necCite(nec, "motor_conductor_protection", "motor circuit conductors protected per Article 430")] } : protection(nec, size, input.material, allowable, ocpdA, input.supplies_receptacles);
  const meetsAmpacity = new Map<ConductorSize, boolean>();
  const findMinimum = (sets: number, largest?: ConductorSize): { size: ConductorSize; ampacity: AmpacityResult; reason: string; cite: Citation[] } | null => {
    for (const size of sets > 1 ? smallest.filter(parallelOk) : smallest) {
      if (largest && sizeIndex(size) > sizeIndex(largest)) break;
      const a = ampacityOf(size);
      if (a.allowable === null) continue;
      const total = a.allowable * sets;
      const p = protectionOf(size, total);
      if (total + 1e-9 >= requiredA && p.ok) return { size, ampacity: a, reason: p.reason, cite: [...p.cite] };
    }
    return null;
  };
  let sets = input.parallel_sets ?? 1;
  let found = findMinimum(sets);
  let preferredLargest = false;
  if (!found && input.parallel_sets === undefined) {
    // Fewest sets of conductors no larger than PARALLEL_PREFERRED_MAX (a design preference), else the fewest sets at all.
    for (const cap of [PARALLEL_PREFERRED_MAX, undefined]) {
      for (let n = 2; n <= 10 && !found; n++) {
        found = findMinimum(n, cap);
        if (found) {
          sets = n;
          preferredLargest = cap !== undefined;
        }
      }
      if (found) break;
    }
  }
  if (!found) return refuse(`No ${sets > 1 ? `${sets} parallel sets of` : "single"} ${input.material} conductor up to 2000 kcmil carries ${round(requiredA, 1)} A under these conditions${input.parallel_sets === undefined ? ", even in 10 parallel sets" : "; use more parallel sets"}.`, steps, values);
  const candidates = sets > 1 ? smallest.filter(parallelOk) : smallest;
  for (const size of candidates) {
    const a = ampacityOf(size);
    if (a.allowable !== null) meetsAmpacity.set(size, protectionOf(size, a.allowable * sets).ok && a.allowable * sets + 1e-9 >= requiredA);
  }
  const minimum = { size: found.size, ampacity: found.ampacity };
  const a0 = found.ampacity;
  const setsText = sets > 1 ? ` x ${sets} parallel sets = ${round((a0.allowable ?? 0) * sets, 1)} A` : "";
  steps.push({
    label: "Minimum conductor",
    detail: `${sizeLabel(found.size)} ${materialLabel(input.material)} ${input.insulation}: ${a0.base} A at ${insulationTemp}°C${a0.ambientFactor !== 1 ? ` x ${a0.ambientFactor} ambient` : ""}${a0.adjustmentFactor !== 1 ? ` x ${a0.adjustmentFactor} for ${ccc} conductors` : ""}, limited to ${a0.terminalLimit} A at the ${a0.terminalColumnTempC}°C terminations → ${round(a0.allowable ?? 0, 1)} A${setsText} ≥ ${round(requiredA, 1)} A; ${found.reason}`,
    cite: [...a0.cite, ...found.cite, ...(sets > 1 ? [necCite(nec, "parallel", `${sets} sets, 1/0 and larger, each set in its own raceway`)] : []), ...(preferredLargest ? [criteriaCite(criteria, `parallel sets chosen so each conductor is ${PARALLEL_PREFERRED_MAX} kcmil or smaller, a design preference, not a code requirement`)] : [])],
  });
  if (sets > 1) values.push({ key: "parallel_sets", label: "Parallel sets", value: sets, unit: null, cite: [necCite(nec, "parallel")] });
  values.push({ key: "minimum_conductor", label: "Smallest conductor with the ampacity", value: sizeLabel(minimum.size), unit: null, cite: minimum.ampacity.cite });

  // 5. Voltage drop: upsize until the drop meets the target.
  const raceway = CONDUIT_TABLE9_RACEWAY[input.conduit];
  const target = input.max_voltage_drop_pct ?? (isBranch ? criteria.electrical.branchVoltageDropPct : criteria.electrical.feederVoltageDropPct);
  const targetCite = input.max_voltage_drop_pct !== undefined ? criteriaCite(criteria, `${target}% voltage drop target for this run, as given`) : criteriaCite(criteria, `${target}% ${isBranch ? "branch" : "feeder"} voltage drop target`);
  const noteCite = necCite(nec, isBranch ? "branch_vd_note" : "feeder_vd_note", "recommendation, not enforceable");
  const loadA = input.continuous_load_a + input.noncontinuous_load_a;
  const vdOf = (size: ConductorSize) => {
    if (input.length_ft === undefined) return null;
    const z = effectiveImpedance(nec, size, input.material, raceway, pf);
    if (!z) return null;
    return { z, ...voltageDrop(z.ze, q(loadA, "A"), q(input.length_ft, "ft"), q(input.voltage_v, "V"), sys.phases, sets) };
  };
  const vdCite = (size: ConductorSize) => necCite(nec, "ac_impedance", `${sizeLabel(size)} ${input.material}, ${raceway} raceway, Ze = R x ${pf} + XL x sin(arccos ${pf})`);
  let chosen = minimum.size;
  let vdChosen = vdOf(chosen);
  if (input.length_ft !== undefined) {
    if (!vdChosen) {
      issues.push({ severity: "warning", message: `Chapter 9 Table 9 doesn't list ${sizeLabel(minimum.size)} ${input.material}, so voltage drop wasn't checked.`, cite: [necCite(nec, "ac_impedance")] });
    } else {
      const atMin = vdChosen;
      steps.push({ label: "Voltage drop at the minimum size", detail: `${sys.phases === 3 ? "√3" : "2"} x ${loadA} A x ${round(atMin.z.ze, 4)} Ω/kft x ${input.length_ft} ft${sets > 1 ? ` / ${sets} sets` : ""} = ${round(atMin.volts, 2)} V (${round(atMin.pct, 2)}% of ${input.voltage_v} V); target ${target}%`, cite: [vdCite(minimum.size), targetCite, noteCite] });
      if (atMin.pct > target + 1e-9) {
        const bigger = candidates.filter((s) => sizeIndex(s) > sizeIndex(minimum.size));
        const ok = bigger.find((s) => {
          const v = vdOf(s);
          return v !== null && v.pct <= target + 1e-9;
        });
        if (ok) {
          chosen = ok;
          vdChosen = vdOf(ok);
          steps.push({ label: "Upsized for voltage drop", detail: `${sizeLabel(ok)}: ${round(vdChosen?.volts ?? 0, 2)} V (${round(vdChosen?.pct ?? 0, 2)}%) meets ${target}%; the ${ocpdA} A device stays`, cite: [vdCite(ok), targetCite] });
        } else {
          issues.push({ severity: "error", message: `No single conductor up to 1000 kcmil keeps this run within ${target}%; shorten the run, raise the voltage, or use parallel sets.`, cite: [targetCite] });
        }
      }
    }
  }
  const chosenAmpacity = ampacityOf(chosen);
  values.push({ key: "conductor", label: "Phase conductor", value: sizeLabel(chosen), unit: null, cite: chosen === minimum.size ? minimum.ampacity.cite : [...minimum.ampacity.cite, vdCite(chosen), targetCite] });
  values.push({ key: "conductor_ampacity_a", label: "Phase conductor allowable ampacity", value: chosenAmpacity.allowable === null ? null : round(chosenAmpacity.allowable, 1), unit: "A", cite: chosenAmpacity.cite });
  if (vdChosen) {
    values.push({ key: "voltage_drop_v", label: "Voltage drop", value: round(vdChosen.volts, 2), unit: "V", cite: [vdCite(chosen)] });
    values.push({ key: "voltage_drop_pct", label: "Voltage drop", value: round(vdChosen.pct, 2), unit: "pct", cite: [vdCite(chosen), targetCite] });
    if (input.upstream_voltage_drop_pct !== undefined) {
      const combined = input.upstream_voltage_drop_pct + vdChosen.pct;
      const cCite = criteriaCite(criteria, `${criteria.electrical.combinedVoltageDropPct}% combined feeder and branch target`);
      values.push({ key: "combined_voltage_drop_pct", label: "Feeder + branch voltage drop", value: round(combined, 2), unit: "pct", cite: [cCite] });
      if (combined > criteria.electrical.combinedVoltageDropPct + 1e-9) issues.push({ severity: "warning", message: `Feeder plus branch drop is ${round(combined, 2)}%, over the ${criteria.electrical.combinedVoltageDropPct}% combined target.`, cite: [cCite, noteCite] });
    }
  }
  if (chosen !== minimum.size && ocpdA <= 20 && sizeIndex(chosen) > sizeIndex("10")) {
    issues.push({ severity: "info", message: `${sizeLabel(chosen)} is larger than many ${ocpdA} A breaker and device terminals take (often #14–#10); plan a splice or pigtail where it lands.`, cite: [] });
  }

  // 6. Equipment grounding conductor.
  const egc = equipmentGround(nec, ocpdA, egcMaterial, minimum.size, chosen);
  if (egc) {
    const egcCite = sets > 1 ? [...egc.cite, necCite(nec, "egc_parallel", "a full-size EGC in each parallel raceway, sized on the device rating")] : egc.cite;
    steps.push({ label: "Equipment grounding conductor", detail: `${egc.upsized ? `${sizeLabel(egc.tableSize)} from the table, grown x${egc.ratio.toFixed(3)} with the phase conductors → ${sizeLabel(egc.size)} ${materialLabel(egcMaterial)}` : `${sizeLabel(egc.size)} ${materialLabel(egcMaterial)} for a ${ocpdA} A device`}${sets > 1 ? `, one in each of the ${sets} raceways` : ""}`, cite: egcCite });
    values.push({ key: "egc", label: "Equipment grounding conductor", value: sizeLabel(egc.size), unit: null, cite: egcCite });
  } else issues.push({ severity: "error", message: `Table 250.122 stops at 6000 A; a ${ocpdA} A device needs an engineered grounding design.`, cite: [necCite(nec, "egc_table")] });

  // 7. Conduit.
  let fill: FillResult | null = null;
  if (egc) {
    fill = conduitFill(nec, input.conduit, [
      { size: chosen, insulation: input.insulation, count: sys.hots, role: "phase" },
      ...(sys.neutral ? [{ size: chosen, insulation: input.insulation, count: 1, role: "neutral" }] : []),
      { size: egc.size, insulation: input.insulation, count: 1, role: "EGC" },
    ]);
    if (fill.missing.length > 0) issues.push({ severity: "warning", message: `Chapter 9 Table 5 has no area for ${fill.missing.join(", ")}; conduit not sized.`, cite: [necCite(nec, "conductor_areas")] });
    else if (!fill.conduit) issues.push({ severity: "warning", message: `${round(fill.areaIn2, 4)} in² of conductors is more than the largest ${conduitLabel(input.conduit)} takes; use two raceways.`, cite: fill.cite });
    else {
      steps.push({ label: "Conduit", detail: `${fill.conductors} conductors, ${round(fill.areaIn2, 4)} in² → ${fill.conduit.tradeSize} in ${conduitLabel(input.conduit)} (${round(fill.usedPct ?? 0, 1)}% of ${fill.conduit.totalIn2} in²; ${fill.fillPercent}% allowed)`, cite: fill.cite });
      values.push({ key: "conduit", label: "Conduit", value: `${fill.conduit.tradeSize} in ${conduitLabel(input.conduit)}`, unit: null, cite: fill.cite });
      values.push({ key: "conduit_fill_pct", label: "Conduit fill", value: round(fill.usedPct ?? 0, 1), unit: "pct", cite: fill.cite });
    }
    if (sys.neutral) issues.push({ severity: "info", message: "The neutral is sized the same as the phase conductors; size it separately where the load has a known unbalance.", cite: [] });
  }

  const from = candidates.indexOf(minimum.size);
  const sizes: SizeRow[] = candidates.slice(from, Math.max(from + 4, candidates.indexOf(chosen) + 2)).map((s) => {
    const a = ampacityOf(s);
    const v = vdOf(s);
    return { size: s, label: sizeLabel(s), allowableA: a.allowable === null ? null : round(a.allowable, 1), meetsAmpacity: meetsAmpacity.get(s) ?? false, voltageDropPct: v ? round(v.pct, 2) : null };
  });
  const description = egc
    ? `${sets > 1 ? `(${sets}) sets of ` : ""}${sys.hots}-${sizeLabel(chosen)}${sys.neutral ? `, 1-${sizeLabel(chosen)} N` : ""}, 1-${sizeLabel(egc.size)} EGC ${materialLabel(input.material)} ${input.insulation}${fill?.conduit ? ` in ${fill.conduit.tradeSize} in ${conduitLabel(input.conduit)}${sets > 1 ? " each" : ""}` : ""}; ${ocpdA} A ${sys.phases === 3 ? 3 : sys.hots}P`
    : null;
  if (description) values.push({ key: "description", label: "Circuit", value: description, unit: null, cite: steps.flatMap((s) => s.cite) });
  return {
    values,
    steps,
    issues,
    detail: {
      requiredA,
      ocpdA,
      terminalTempC: terminal.tempC,
      minimum,
      chosen: { size: chosen, ampacity: chosenAmpacity, voltageDropPct: vdChosen ? vdChosen.pct : null, voltageDropV: vdChosen ? vdChosen.volts : null },
      upsizedForVoltageDrop: chosen !== minimum.size,
      sets,
      egc: egc ? { size: egc.size, tableSize: egc.tableSize, material: egcMaterial } : null,
      fill,
      sizes,
      description,
    },
  };
}

function emptyDetail(requiredA: number, ocpdA: number): SizeCircuitDetail {
  return { requiredA, ocpdA, terminalTempC: 60, minimum: null, chosen: null, upsizedForVoltageDrop: false, sets: 1, egc: null, fill: null, sizes: [], description: null };
}

function refuse(message: string, steps: CalcStep[], values: CalcValue[]): CalcOutput<SizeCircuitDetail> {
  const cite: Citation[] = [];
  return { values, steps, issues: [{ severity: "error", message, cite }], detail: emptyDetail(0, 0) };
}
