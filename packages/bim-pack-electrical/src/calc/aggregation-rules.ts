import { type ConductorSet } from "@permitzip/bim-kernel";
import { type AmpacityAnswer, type DemandInput, type DemandLine, type DemandResult, type ElectricalRules, type MinimumConductors } from "../connections/rules";
import { NEC_EDITIONS, continuousClassRule, necEdition, type NecEdition, type NecEditionYear, CONDUCTOR_SIZES, parseConductorSize, sizeLabel, type LightingOccupancy } from "@permitzip/bim-calc";
import { demandLoad, type DemandInput as CalcDemandInput } from "./demand";
import { motorFullLoad } from "./motor";
import { conductorAmpacity, defaultTerminalTemp, egcFromTable, protection } from "./nec";

let necRuleSetRows: readonly ElectricalRules[] | null = null;

/**
 * The NEC editions as demand rule sets by id ("nec-2023"): rows of the
 * kernel's `DEMAND_RULE_SET_POINT` that the Electrical pack contributes, so a
 * schedule placed on a sheet names its rules and every process that prints
 * it (browser, PDF printer, agent) computes the same demand for the same
 * model. The same objects on every call.
 */
export function necRuleSets(): readonly ElectricalRules[] {
  necRuleSetRows ??= NEC_EDITIONS.map((year) => necElectricalRules(year));
  return necRuleSetRows;
}

/**
 * The NEC pack as the kernel aggregation engine's rules
 * (`ElectricalLoadEngine`): Article 220 demand at each node from the raw
 * inventory below it (`demandLoad`, the same calc `nec.demand_load` runs), and
 * Table 310.16 ampacity for the capacity chain. Every line keeps its
 * citations.
 */

/** The calc's limit on identical units per input row; larger groups are split. */
const MAX_QUANTITY = 10_000;

export interface NecRulesOptions {
  /** For the general lighting demand table (220.42 / 220.45). Default: all other occupancies (100%). */
  readonly occupancy?: LightingOccupancy;
  /** Conductor insulation for ampacity. Default 90°C (THHN / THWN-2), limited by the terminations. */
  readonly insulationTempC?: 75 | 90;
  readonly ambientC?: number;
}

export function necElectricalRules(edition: NecEdition | NecEditionYear, options: NecRulesOptions = {}): ElectricalRules {
  const nec = typeof edition === "string" ? necEdition(edition) : edition;
  const occupancy = options.occupancy ?? "other";
  return {
    id: `nec-${nec.edition}${occupancy === "other" ? "" : `-${occupancy}`}`,
    label: `NEC ${nec.edition} Article 220${occupancy === "other" ? "" : ` (${occupancy} lighting)`}`,
    placeholder: false,
    demand: (input) => necDemand(nec, occupancy, input),
    conductorAmpacity: (c, deviceA) => necAmpacity(nec, c, deviceA, options),
    motorLoad: (hp, volts, poles) => {
      const phases = poles >= 3 ? 3 : 1;
      const flc = motorFullLoad(nec, hp, volts, phases);
      if (!flc) return null;
      const va = flc.amps * volts * (phases === 3 ? Math.sqrt(3) : 1);
      return { va, text: `${flc.hp} hp at ${flc.columnV} V: ${flc.amps} A full-load current x ${volts} V${phases === 3 ? " x √3" : ""}`, cite: flc.cite.map((c) => c.text) };
    },
    conductorsFor: (deviceA, material) => necMinimumConductors(nec, deviceA, material, options),
    continuousByDefault: (loadClass) => continuousClassRule(nec, loadClass) !== null,
  };
}

/**
 * The smallest phase conductor a `deviceA` breaker protects (Table 310.16 at
 * the 110.14(C) termination column, 240.4(B)/(D)) and its Table 250.122 EGC.
 * Schedules print it where the engineer chose no conductors; an engineer's
 * set (voltage-drop upsizing, parallel sets) always prints instead.
 */
function necMinimumConductors(nec: NecEdition, deviceA: number, material: ConductorSet["material"], options: NecRulesOptions): MinimumConductors | null {
  if (!(deviceA > 0)) return null;
  const m = material === "cu" ? "copper" : "aluminum";
  const terminal = defaultTerminalTemp(nec, deviceA);
  for (const size of CONDUCTOR_SIZES) {
    const r = conductorAmpacity(nec, { size, material: m, insulationTempC: options.insulationTempC ?? 90, terminalTempC: terminal.tempC, ambientC: options.ambientC ?? 30, currentCarrying: 3 });
    if (r.allowable === null) continue;
    const p = protection(nec, size, m, r.allowable, deviceA, true);
    if (!p.ok) continue;
    const egc = egcFromTable(nec, deviceA, m);
    return { phaseSize: size, ...(egc ? { groundSize: egc.size } : {}), cite: [...r.cite, terminal.cite, ...p.cite, ...(egc ? [egc.cite] : [])].map((c) => c.text) };
  }
  return null;
}

function necDemand(nec: NecEdition, occupancy: LightingOccupancy, input: DemandInput): DemandResult {
  const loads: CalcDemandInput["loads"] = [];
  for (const l of input.loads) {
    if (!(l.va > 0) || l.quantity < 1) continue;
    for (let left = l.quantity; left > 0; left -= MAX_QUANTITY) loads.push({ label: l.label.slice(0, 120), class: l.loadClass, va: l.va, quantity: Math.min(left, MAX_QUANTITY), continuous: l.continuous });
  }
  if (loads.length === 0) return { lines: [], connectedVa: 0, demandVa: 0, continuousVa: 0, sizingVa: 0, largestMotor: null, minimumDeviceA: null, notes: [] };
  const out = demandLoad(nec, { node: input.node.slice(0, 80), occupancy, voltage_v: input.system.lineToLine, phases: input.system.phases, loads });
  const d = out.detail;
  const lines: DemandLine[] = d.rows.map((r) => ({ key: r.key, label: r.label, units: r.units, connectedVa: r.connectedVa, demandVa: r.demandVa, factor: r.factor, basis: r.basis, cite: r.cite.map((c) => c.text) }));
  const motor = d.rows.find((r) => r.key === "largest_motor");
  const continuousVa = d.rows.reduce((a, r) => a + r.continuousVa, 0);
  return {
    lines,
    connectedVa: d.connectedVa,
    demandVa: d.demandVa,
    continuousVa,
    sizingVa: d.sizingVa,
    largestMotor: motor ? { label: motor.basis, va: motor.demandVa / nec.tables.LARGEST_MOTOR_EXTRA, adderVa: motor.demandVa } : null,
    minimumDeviceA: d.minimumOcpdA,
    notes: out.issues.map((i) => i.message),
  };
}

function necAmpacity(nec: NecEdition, c: ConductorSet, deviceA: number | null, options: NecRulesOptions): AmpacityAnswer | null {
  const size = parseConductorSize(c.phaseSize);
  if (!size) return null;
  const terminal = defaultTerminalTemp(nec, deviceA ?? Number.POSITIVE_INFINITY);
  const r = conductorAmpacity(nec, { size, material: c.material === "cu" ? "copper" : "aluminum", insulationTempC: options.insulationTempC ?? 90, terminalTempC: terminal.tempC, ambientC: options.ambientC ?? 30, currentCarrying: 3 });
  if (r.allowable === null) return null;
  const sets = Math.max(1, c.sets);
  return {
    amps: r.allowable * sets,
    basis: `${sets > 1 ? `${sets} x ` : ""}${Math.round(r.allowable)} A for ${sizeLabel(size)} ${c.material === "cu" ? "Cu" : "Al"} at ${r.terminalColumnTempC}°C terminations`,
    cite: [...r.cite, terminal.cite].map((x) => x.text),
  };
}
