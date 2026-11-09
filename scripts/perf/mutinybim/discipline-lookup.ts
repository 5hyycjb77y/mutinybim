/**
 * What naming a stored discipline costs on every row that shows one (schedule
 * columns, filters, tags): `disciplineLabel` plus `disciplineCovers`, the
 * registry's map reads, with the first-party add-ons installed as in the app.
 * Each sample is the mean of CALLS label + cover pairs over four ids (two
 * built-in, one child discipline, one unknown id that falls back to its own
 * words) after a warm-up.
 *
 *   node --import tsx scripts/perf/mutinybim/discipline-lookup.ts --samples=21
 *
 * Metric:
 *   kernel.discipline.lookup   ns per label + cover
 *
 * Moved from packages/bim-kernel/__tests__/d8-disciplines.test.ts, whose Jest
 * wall clock measured the Unit Tests job: CI read 578-2,047 ns per call on
 * the same commit (runs 42486085358 and 42486086426, two attempts each) while
 * the same code reads 111-137 ns under Jest on an M-series laptop. The test
 * keeps the lookup's answers. Prints one `@@perf-result` JSON line.
 */
import { disciplineCovers, disciplineLabel } from "../../../packages/bim-kernel/src";
import { installFirstPartyAddOns } from "../../../packages/bim-first-party/src";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 21);
const CALLS = 200_000;
const WARMUP = 2_000;
const IDS = ["fire_alarm", "mechanical", "vt.unknown", "architecture"] as const;

installFirstPartyAddOns();

if (disciplineLabel("vt.unknown") !== "Unknown" || !disciplineCovers("fire_protection", "fire_alarm")) {
  throw new Error("discipline lookup answered wrong before timing: check the registry rows");
}

function nsPerCall(): number {
  let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < CALLS; i++) {
    const id = IDS[i % IDS.length] as string;
    sink += disciplineLabel(id).length + (disciplineCovers("fire_protection", id) ? 1 : 0);
  }
  const ns = ((performance.now() - t0) * 1e6) / CALLS;
  if (sink === 0) throw new Error("discipline lookup returned nothing");
  return ns;
}

for (let i = 0; i < WARMUP; i++) {
  const id = IDS[i % IDS.length] as string;
  disciplineLabel(id);
  disciplineCovers("fire_protection", id);
}

const values: number[] = [];
for (let n = 0; n < samples; n++) values.push(nsPerCall());

emit({
  suite: "batch",
  workload: { callsPerSample: CALLS, samples, ids: IDS.length },
  network: "in-process",
  participants: 1,
  samples: [{ metric: "kernel.discipline.lookup", values, note: "disciplineLabel + disciplineCovers over four ids, ns per pair." }],
});
