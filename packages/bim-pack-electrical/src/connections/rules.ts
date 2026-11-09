import type { ConductorSet, ElectricalLoadClass } from "@permitzip/bim-kernel";
import type { MotorLoad } from "./loads";
import type { VoltageSystem } from "./systems";

/**
 * The code rules the aggregation engine applies, supplied from outside the
 * kernel: `@permitzip/bim-calc` `necElectricalRules(edition)` is the NEC 2020
 * / 2023 pack. The kernel never hardcodes a demand factor or an ampacity; it
 * hands the rules the raw inventory below each node and reports what they
 * return, citations and all.
 */

/** Identical loads below one node: `quantity` units of `va` each. */
export interface DemandLoad {
  readonly label: string;
  readonly loadClass: ElectricalLoadClass;
  /** VA of one unit. */
  readonly va: number;
  readonly quantity: number;
  readonly continuous: boolean;
}

export interface DemandInput {
  /** The node's name, for the trail ("MDP", "L1"). */
  readonly node: string;
  readonly system: VoltageSystem;
  /** The raw inventory of everything below the node, never the demands of the panels it feeds. */
  readonly loads: readonly DemandLoad[];
}

export interface DemandLine {
  /** A load class, or "largest_motor" for the 25% adder. */
  readonly key: string;
  readonly label: string;
  readonly units: number;
  readonly connectedVa: number;
  readonly demandVa: number;
  /** demand / connected, for the schedule's demand-factor column. */
  readonly factor: number;
  /** Why, in plain words ("3 units at 90%"). */
  readonly basis: string;
  /** The clause each figure rests on ("NEC 2023 220.56, 3 units: 90%"). */
  readonly cite: readonly string[];
}

export interface DemandResult {
  readonly lines: readonly DemandLine[];
  readonly connectedVa: number;
  /** The calculated load: each class after its demand factor, plus 25% of the largest motor. */
  readonly demandVa: number;
  /** The share of the calculated load that is continuous. */
  readonly continuousVa: number;
  /** What conductors and the device are sized for: the calculated load with the continuous part at 125%. */
  readonly sizingVa: number;
  readonly largestMotor: { readonly label: string; readonly va: number; readonly adderVa: number } | null;
  /** The smallest standard overcurrent device for the sizing load, when the rules know the ratings. */
  readonly minimumDeviceA: number | null;
  readonly notes: readonly string[];
}

export interface AmpacityAnswer {
  /** Allowable amps of the whole set (parallel sets multiplied). */
  readonly amps: number;
  readonly basis: string;
  readonly cite: readonly string[];
}

export interface ElectricalRules {
  readonly id: string;
  readonly label: string;
  /** True when these are not a code calculation (no code pack chosen). Reports say so on every page. */
  readonly placeholder: boolean;
  demand(input: DemandInput): DemandResult;
  /** What a feeder's conductors may carry, behind a device of `deviceA` (it decides the terminal column), or null when the rules can't read the size. */
  conductorAmpacity(conductors: ConductorSet, deviceA: number | null): AmpacityAnswer | null;
  /** A motor's VA from its horsepower (the code's full-load current tables), for motors that state no load. Absent: such motors count nothing. */
  readonly motorLoad?: MotorLoad;
  /** Whether a load of this class is continuous (sized at 125%) when nothing on the load says; the NEC pack: lighting, and fixed electric space heating (424.4(B)). Absent: lighting only. */
  readonly continuousByDefault?: (loadClass: ElectricalLoadClass) => boolean;
  /** The smallest conductors (and equipment ground) a branch circuit or feeder behind a `deviceA` breaker may use; schedules print it where the engineer chose none. */
  conductorsFor?(deviceA: number, material: ConductorSet["material"]): MinimumConductors | null;
}

export interface MinimumConductors {
  readonly phaseSize: string;
  readonly groundSize?: string;
  readonly cite: readonly string[];
}

/**
 * No code pack: every class at 100% of connected, the continuous part at
 * 125%, no largest-motor adder, no conductor ampacities. For a model whose
 * code edition isn't known yet; never presented as a code calculation.
 */
export const CONNECTED_LOAD_ONLY: ElectricalRules = {
  id: "connected-only",
  label: "Connected load only (no code edition chosen)",
  placeholder: true,
  demand(input) {
    const byClass = new Map<string, { units: number; va: number; continuousVa: number }>();
    for (const l of input.loads) {
      const row = byClass.get(l.loadClass) ?? { units: 0, va: 0, continuousVa: 0 };
      row.units += l.quantity;
      row.va += l.va * l.quantity;
      if (l.continuous) row.continuousVa += l.va * l.quantity;
      byClass.set(l.loadClass, row);
    }
    const lines: DemandLine[] = [...byClass.entries()].map(([key, r]) => ({ key, label: key, units: r.units, connectedVa: r.va, demandVa: r.va, factor: 1, basis: "100%: no code edition chosen, so no demand factor applied", cite: [] }));
    const connectedVa = lines.reduce((a, l) => a + l.connectedVa, 0);
    const continuousVa = [...byClass.values()].reduce((a, r) => a + r.continuousVa, 0);
    return { lines, connectedVa, demandVa: connectedVa, continuousVa, sizingVa: connectedVa + 0.25 * continuousVa, largestMotor: null, minimumDeviceA: null, notes: ["No code edition is chosen, so these are connected loads, not a code calculation. Choose the NEC edition (or record it in the project's Code Study)."] };
  },
  conductorAmpacity() {
    return null;
  },
};
