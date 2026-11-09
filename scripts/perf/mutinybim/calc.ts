/**
 * One run of the calc plugin workload, in one process: size one feeder (what
 * a panel schedule re-runs per edited circuit), the NEC demand at a service
 * with 5,000 loads below it, and every feeder of a 300-panel building. Every
 * repeat is compared with the first result's bytes, so a calc that stops
 * being deterministic fails the gate's invariants.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/calc.ts --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { builtinCalcRegistry, canonicalJson, type RunRequest } from "@permitzip/bim-calc";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const samplesPerRun = Number(arg("samples", "21"));
/** One sizing is well under a millisecond; more samples keep its p95 off the single slowest one. */
const sizeSamples = Math.max(201, samplesPerRun);
const WARMUP = 5;

const registry = builtinCalcRegistry();

const FEEDER: RunRequest = { calc: "nec.size_circuit", necEdition: "2023", inputs: { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250 } };

/** 5,000 loads in the classes a building has: lighting, receptacles, kitchen units, motors and HVAC. */
function serviceInventory(): RunRequest {
  const loads = Array.from({ length: 5000 }, (_, i) => {
    const k = i % 10;
    if (k < 4) return { class: "lighting", va: 400 + (i % 7) * 40 };
    if (k < 7) return { class: "receptacle", va: 180 };
    if (k === 7) return { class: "kitchen", va: 1200 + (i % 5) * 300 };
    if (k === 8) return { class: "motor", va: 600 + (i % 11) * 250 };
    return { class: "hvac", va: 5000 + (i % 13) * 1000 };
  });
  return { calc: "nec.demand_load", necEdition: "2023", inputs: { node: "MDP", voltage_v: 480, phases: 3, loads } };
}

/** A feeder per panel: 300 panels, loads from 20 A to 400 A, 25 ft to 400 ft. */
const PANELS: RunRequest[] = Array.from({ length: 300 }, (_, i) => ({
  calc: "nec.size_circuit",
  necEdition: "2023",
  inputs: { circuit: "feeder", system: i % 3 === 0 ? "3ph_3w" : "3ph_4w", voltage_v: i % 2 === 0 ? 480 : 208, continuous_load_a: 16 + (i % 25) * 12, noncontinuous_load_a: (i % 7) * 5, length_ft: 25 + (i % 16) * 25 },
}));

function runOnce(req: RunRequest): string {
  const r = registry.run(req);
  if (!r.ok) throw new Error(`[perf/calc] ${req.calc} refused: ${r.reason}`);
  return canonicalJson(r.run);
}

function measure(req: () => string, samples: number): { values: number[]; mismatches: number; first: string } {
  const first = req();
  for (let i = 0; i < WARMUP; i++) req();
  const values: number[] = [];
  let mismatches = 0;
  for (let i = 0; i < samples; i++) {
    const t = timeSync(req);
    values.push(t.ms);
    if (t.value !== first) mismatches++;
  }
  return { values, mismatches, first };
}

function main(): void {
  gc();
  const one = measure(() => runOnce(FEEDER), sizeSamples);
  const service = serviceInventory();
  const demand = measure(() => runOnce(service), samplesPerRun);
  const building = measure(() => PANELS.map(runOnce).join("\n"), samplesPerRun);
  const samples: Sample[] = [
    { metric: "calc.size_circuit", values: one.values, note: "nec.size_circuit: 100 A continuous feeder, 250 ft, 480 V 3-phase, through the registry (validate, edition, run, citations, runKey)" },
    { metric: "calc.demand_load.5k", values: demand.values, counts: { networkElements: 5000 }, note: "nec.demand_load at a service with 5,000 loads below it" },
    { metric: "calc.size_circuit.300", values: building.values, counts: { networkElements: 300 }, note: "300 feeders, one per panel" },
  ];
  emit({
    suite: "calc",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { feeder: "100 A continuous, 250 ft, 480 V 3ph", service: "5,000 loads", building: "300 feeders", samplesPerRun, sizeSamples },
    samples,
    invariants: { calcMismatches: one.mismatches + demand.mismatches + building.mismatches },
    info: { memory: memoryMB() },
  });
}

try {
  main();
} catch (err) {
  console.error("[perf/calc] failed", err);
  process.exit(1);
}
