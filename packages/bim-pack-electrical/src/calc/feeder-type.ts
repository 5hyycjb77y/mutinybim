import { type FeederTypeEntry } from "../catalog/feeder-types";
import { vaPerAmp } from "../connections/engine";
import { type VoltageSystem } from "../connections/systems";
import type { NecEdition, CalcOutput, DesignCriteria } from "@permitzip/bim-calc";
import { sizeCircuit, type CircuitSystem, type SizeCircuitDetail } from "./size-circuit";

/**
 * A feeder type from a load: the circuit sizing every feeder uses (breaker,
 * conductors with voltage drop, parallel sets when one set won't do, EGC,
 * conduit), packaged as the catalog record the model stores ("F225"). The
 * engineer reviews and saves it; nothing here picks the equipment it feeds.
 */

export interface FeederSizingRequest {
  /** The mark to give it; default "F" + the breaker rating ("F225"), with "T" for a three-wire feeder with no neutral ("F100T"). */
  readonly mark?: string;
  /** What the fed equipment needs from the feeder (a transformer's primary). */
  readonly system: VoltageSystem;
  /** The calculated load's continuous and noncontinuous parts, amps at that system. */
  readonly continuousA: number;
  readonly noncontinuousA: number;
  /** Keep this breaker instead of the smallest that carries the load (to match a bus or main rating). */
  readonly ratingA?: number;
  readonly lengthFt?: number;
  readonly material?: "copper" | "aluminum";
  readonly conduit?: "emt" | "pvc40" | "pvc80";
  readonly conduitBelowGrade?: "emt" | "pvc40" | "pvc80";
  readonly parallelSets?: number;
}

export interface FeederSizing {
  readonly entry: FeederTypeEntry | null;
  /** The sizing run: steps, values, issues and citations, for the trail. */
  readonly run: CalcOutput<SizeCircuitDetail>;
  /** Why no record could be made, in plain words. */
  readonly refusal: string | null;
}

function circuitSystem(s: VoltageSystem): { readonly system: CircuitSystem; readonly volts: number; readonly neutral: boolean } {
  const neutral = s.lineToNeutral !== null && s.lineToNeutral !== s.lineToLine && s.wires >= 3;
  if (s.phases === 3) return { system: neutral ? "3ph_4w" : "3ph_3w", volts: s.lineToLine, neutral };
  if (s.wires === 2) return { system: "1ph_2w", volts: s.lineToLine, neutral: true };
  return { system: "1ph_2pole", volts: s.lineToLine, neutral };
}

export function proposeFeederType(nec: NecEdition, criteria: DesignCriteria, req: FeederSizingRequest): FeederSizing {
  const sys = circuitSystem(req.system);
  const run = sizeCircuit(nec, criteria, {
    circuit: "feeder",
    system: sys.system,
    voltage_v: sys.volts,
    continuous_load_a: Math.max(0, req.continuousA),
    noncontinuous_load_a: Math.max(0, req.noncontinuousA),
    ...(req.lengthFt !== undefined ? { length_ft: req.lengthFt } : {}),
    material: req.material ?? "copper",
    insulation: "THHN",
    ...(req.ratingA !== undefined ? { ocpd_a: req.ratingA } : {}),
    conduit: req.conduit ?? "emt",
    supplies_receptacles: false,
    motor_branch: false,
    ...(req.parallelSets !== undefined ? { parallel_sets: req.parallelSets } : {}),
  });
  const d = run.detail;
  const error = run.issues.find((i) => i.severity === "error");
  if (error || !d.chosen || !d.egc) return { entry: null, run, refusal: error?.message ?? "The feeder couldn't be sized from that load." };
  const poles = sys.system === "3ph_3w" || sys.system === "3ph_4w" ? 3 : sys.system === "1ph_2pole" ? 2 : 1;
  const hasNeutral = sys.neutral && sys.system !== "1ph_2w" ? true : sys.system === "1ph_2w";
  const mark = req.mark ?? `F${d.ocpdA}${hasNeutral ? "" : "T"}`;
  const belowGrade = req.conduitBelowGrade && req.conduitBelowGrade !== (req.conduit ?? "emt") ? req.conduitBelowGrade : null;
  const cite = [...new Set(run.steps.flatMap((s) => s.cite.map((c) => c.text)))].slice(0, 16);
  const entry: FeederTypeEntry = {
    type: "feeder_type",
    mark,
    ratingA: d.ocpdA,
    poles: poles as 1 | 2 | 3,
    conductors: { sets: d.sets, phaseSize: d.chosen.size, ...(hasNeutral ? { neutralSize: d.chosen.size } : {}), groundSize: d.egc.size, material: (req.material ?? "copper") === "copper" ? "cu" : "al" },
    insulation: "THHN",
    conduit: d.fill?.conduit ? { type: req.conduit ?? "emt", tradeSize: d.fill.conduit.tradeSize } : null,
    conduitBelowGrade: belowGrade && d.fill?.conduit ? { type: belowGrade, tradeSize: d.fill.conduit.tradeSize } : null,
    description: `${hasNeutral ? "" : "3-wire, no neutral; "}sized for ${Math.round(d.requiredA)} A${req.lengthFt !== undefined ? ` over ${req.lengthFt} ft` : ""}`.slice(0, 160),
    basis: { source: "calc", text: (d.description ?? "").slice(0, 400), cite },
  };
  return { entry, run, refusal: null };
}

/** What a feeder's "Size it" says when the project has no NEC edition yet. */
export const FEEDER_SIZING_NEEDS_EDITION = "Set the NEC edition in the Code Study to size feeders.";

export type FeederSizingResult = FeederSizing | { readonly entry: null; readonly run: null; readonly refusal: string };

/**
 * Size the feeder to a piece of equipment from its calculated load (the
 * aggregation engine's demand and continuous parts, VA at the system it is
 * fed at), as the feeder's own "Size it" does: the same circuit sizing as
 * `proposeFeederType`, refused in plain words without an NEC edition.
 */
export function sizeFeederFromDemand(nec: NecEdition | null, criteria: DesignCriteria, req: { readonly system: VoltageSystem; readonly demandVa: number; readonly continuousVa: number; readonly lengthFt?: number; readonly mark?: string; readonly material?: "copper" | "aluminum" }): FeederSizingResult {
  if (!nec) return { entry: null, run: null, refusal: FEEDER_SIZING_NEEDS_EDITION };
  if (!(req.demandVa > 0)) return { entry: null, run: null, refusal: "It has no calculated load yet, so there is nothing to size the feeder for." };
  const per = vaPerAmp(req.system);
  return proposeFeederType(nec, criteria, {
    system: req.system,
    continuousA: Math.max(0, req.continuousVa) / per,
    noncontinuousA: Math.max(0, req.demandVa - req.continuousVa) / per,
    ...(req.lengthFt !== undefined ? { lengthFt: req.lengthFt } : {}),
    ...(req.mark !== undefined ? { mark: req.mark } : {}),
    ...(req.material !== undefined ? { material: req.material } : {}),
  });
}
