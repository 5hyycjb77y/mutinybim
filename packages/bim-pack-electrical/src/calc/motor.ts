import { z } from "zod";
import { necCite, type NecEdition, type MotorOcpdDevice, type CalcIssue, type CalcOutput, type CalcStep, type CalcValue, type Citation, type DesignCriteria, round } from "@permitzip/bim-calc";
import { nextStandardRating } from "./nec";
import { sizeCircuit, type SizeCircuitDetail } from "./size-circuit";

/**
 * Article 430 for one motor: its table full-load current (430.6(A)(1): the
 * tables, not the nameplate, size conductors and the short-circuit device),
 * branch conductors at 125% (430.22) and the largest short-circuit and
 * ground-fault device Table 430.52 allows (the next standard rating up when
 * the percentage lands between ratings). Conductors, EGC and conduit then come
 * from the same circuit sizing every branch and feeder uses.
 */

export const MOTOR_OCPD_DEVICES = ["inverse_time_breaker", "dual_element_fuse", "nontime_delay_fuse", "instantaneous_breaker"] as const satisfies readonly MotorOcpdDevice[];

export interface MotorFullLoad {
  readonly amps: number;
  /** The table column used (115, 208, 230, 460…). */
  readonly columnV: number;
  readonly hp: string;
  readonly phases: 1 | 3;
  readonly cite: readonly Citation[];
}

/** The table column a nameplate voltage reads (430.6(A)(1)), or null when it has none. */
function column(volts: number, phases: 1 | 3): number | null {
  if (phases === 1) {
    if (volts >= 110 && volts <= 120) return 115;
    if (volts >= 199 && volts <= 201) return 200;
    if (volts >= 202 && volts <= 215) return 208;
    if (volts >= 220 && volts <= 240) return 230;
    return null;
  }
  if (volts >= 199 && volts <= 201) return 200;
  if (volts >= 202 && volts <= 215) return 208;
  if (volts >= 220 && volts <= 240) return 230;
  if (volts >= 440 && volts <= 480) return 460;
  if (volts >= 550 && volts <= 600) return 575;
  return null;
}

/** Full-load current of a motor from Table 430.248 / 430.250, or null when the table has no such motor (horsepower not listed, voltage without a column). */
export function motorFullLoad(nec: NecEdition, hp: number, volts: number, phases: 1 | 3): MotorFullLoad | null {
  const col = column(volts, phases);
  if (col === null || !(hp > 0)) return null;
  const use = necCite(nec, "motor_table_use", `${volts} V uses the ${col} V column`);
  if (phases === 1) {
    const i = nec.tables.MOTOR_FLC_1PH_VOLTS.indexOf(col as (typeof nec.tables.MOTOR_FLC_1PH_VOLTS)[number]);
    const row = nec.tables.MOTOR_FLC_1PH.find((r) => Math.abs(r.value - hp) < 1e-6);
    const amps = row && i >= 0 ? row.amps[i] : undefined;
    if (!row || amps === undefined) return null;
    return { amps, columnV: col, hp: row.hp, phases, cite: [necCite(nec, "motor_flc_1ph", `${row.hp} hp at ${col} V: ${amps} A`), use] };
  }
  const i = nec.tables.MOTOR_FLC_3PH_VOLTS.indexOf(col as (typeof nec.tables.MOTOR_FLC_3PH_VOLTS)[number]);
  const row = nec.tables.MOTOR_FLC_3PH.find((r) => Math.abs(r.value - hp) < 1e-6);
  const amps = row && i >= 0 ? row.amps[i] : undefined;
  if (!row || amps === undefined || amps === null) return null;
  return { amps, columnV: col, hp: row.hp, phases, cite: [necCite(nec, "motor_flc_3ph", `${row.hp} hp at ${col} V: ${amps} A`), use] };
}

export const motorCircuitInput = z
  .object({
    hp: z.number().positive().max(500).describe("Motor horsepower as listed in Table 430.248 / 430.250 (0.5, 1.5, 7.5, 10…)."),
    voltage_v: z.number().positive().max(1000).describe("Nameplate voltage (115, 208, 230, 460, 575)."),
    phases: z.union([z.literal(1), z.literal(3)]),
    device: z.enum(MOTOR_OCPD_DEVICES).default("inverse_time_breaker").describe("The branch short-circuit and ground-fault device (Table 430.52)."),
    length_ft: z.number().positive().max(10000).optional().describe("One-way length, feet, for voltage drop."),
    material: z.enum(["copper", "aluminum"]).default("copper"),
    conduit: z.enum(["emt", "pvc40", "pvc80"]).default("emt"),
  })
  .strict();

export type MotorCircuitInput = z.infer<typeof motorCircuitInput>;

export interface MotorCircuitDetail {
  readonly fullLoad: MotorFullLoad | null;
  readonly conductorA: number;
  /** The largest device Table 430.52 allows (next standard rating up). */
  readonly maxDeviceA: number | null;
  readonly circuit: SizeCircuitDetail | null;
}

export function motorCircuit(nec: NecEdition, criteria: DesignCriteria, input: MotorCircuitInput): CalcOutput<MotorCircuitDetail> {
  const steps: CalcStep[] = [];
  const values: CalcValue[] = [];
  const issues: CalcIssue[] = [];
  const flc = motorFullLoad(nec, input.hp, input.voltage_v, input.phases);
  if (!flc) {
    issues.push({ severity: "error", message: `Tables 430.248 / 430.250 have no ${input.hp} hp ${input.phases === 3 ? "three" : "single"}-phase motor at ${input.voltage_v} V; give its full-load current from the manufacturer and size it as a load.`, cite: [necCite(nec, input.phases === 3 ? "motor_flc_3ph" : "motor_flc_1ph")] });
    return { values, steps, issues, detail: { fullLoad: null, conductorA: 0, maxDeviceA: null, circuit: null } };
  }
  steps.push({ label: "Full-load current", detail: `${flc.hp} hp, ${input.phases === 3 ? "3-phase" : "1-phase"}, ${flc.columnV} V column: ${flc.amps} A`, cite: [...flc.cite] });
  values.push({ key: "flc_a", label: "Table full-load current", value: flc.amps, unit: "A", cite: [...flc.cite] });
  const conductorA = flc.amps * nec.tables.MOTOR_CONDUCTOR_FACTOR;
  const conductorCite = [necCite(nec, "motor_conductor", "125% of the full-load current")];
  steps.push({ label: "Conductor ampacity", detail: `${flc.amps} A x 125% = ${round(conductorA, 2)} A`, cite: conductorCite });
  values.push({ key: "conductor_a", label: "Branch conductor ampacity needed", value: round(conductorA, 2), unit: "A", cite: conductorCite });
  const pct = nec.tables.MOTOR_OCPD_PERCENT[input.device];
  const raw = (flc.amps * pct) / 100;
  const maxDeviceA = nextStandardRating(nec, raw);
  const deviceCite = [necCite(nec, "motor_ocpd", `${input.device.replace(/_/g, " ")}: ${pct}%`), necCite(nec, "motor_ocpd_next", "next standard rating up")];
  steps.push({ label: "Short-circuit and ground-fault device", detail: `${flc.amps} A x ${pct}% = ${round(raw, 1)} A → ${maxDeviceA ?? "no standard rating"} A at most`, cite: deviceCite });
  if (maxDeviceA !== null) values.push({ key: "max_device_a", label: "Largest device allowed", value: maxDeviceA, unit: "A", cite: deviceCite });
  const system = input.phases === 3 ? "3ph_3w" : flc.columnV === 115 ? "1ph_2w" : "1ph_2pole";
  const sized = sizeCircuit(nec, criteria, {
    circuit: "branch",
    system,
    voltage_v: input.voltage_v,
    continuous_load_a: flc.amps,
    noncontinuous_load_a: 0,
    ...(input.length_ft !== undefined ? { length_ft: input.length_ft } : {}),
    material: input.material,
    insulation: "THHN",
    ...(maxDeviceA !== null ? { ocpd_a: maxDeviceA } : {}),
    conduit: input.conduit,
    supplies_receptacles: false,
    motor_branch: true,
  });
  return { values: [...values, ...sized.values], steps: [...steps, ...sized.steps], issues: [...issues, ...sized.issues], detail: { fullLoad: flc, conductorA, maxDeviceA, circuit: sized.detail } };
}
