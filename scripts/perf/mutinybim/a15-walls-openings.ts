/**
 * Round 15 lane A15: what the live model pays for joined walls and for door
 * and window bodies. Measured on the full-BIM model.
 *
 * - viewer.walls.level_batch.<tier>: merging one level's joined wall bodies
 *   into one mesh (`batchMeshSolids`), the busiest level, p50 / p95 ms.
 *   Budget 8 / 16 ms at 250k, 30 / 60 ms at 1M.
 * - viewer.walls.level_bodies.<tier> (context, not budgeted): building that
 *   level's joined wall bodies (`elementSolids`), which every redraw already pays.
 * - viewer.opening.body.build.<tier>: one opening's class body (frame, leaf,
 *   glass), per opening, p50 / p95 ms. Budget 0.2 / 0.5 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/a15-walls-openings.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock (lane Q15 runs them).
 * The batch suite of the perf gate (run.ts) runs this at the CI tier and reads
 * the `@@perf-result` line; the JSON above it is for people.
 */
import { freezeElements, type BimElement, type ModelState } from "../../../packages/bim-kernel/src";
import { batchMeshSolids } from "../../../packages/bim-viewer-3d/src/mesh-batches";
import { elementSolids, type Solid } from "../../../packages/bim-viewer-3d/src/native-geometry";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { emit, gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4) };
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "20");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/a15-walls-openings] usage: a15-walls-openings.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `a15-walls-${tier}` });
const model: ModelState = { ...built, elements: freezeElements(built.elements) };
const byLevel = new Map<string, BimElement[]>();
const openings: BimElement[] = [];
for (const el of Object.values(model.elements)) {
  if (el.kind === "opening") openings.push(el);
  if (el.kind !== "wall") continue;
  const level = el.partition?.level ?? "";
  const list = byLevel.get(level) ?? [];
  list.push(el);
  byLevel.set(level, list);
}
const busiest = [...byLevel.values()].sort((a, b) => b.length - a.length)[0] ?? [];
if (busiest.length === 0 || openings.length === 0) {
  console.error(`[perf/a15-walls-openings] the ${tier} model has ${busiest.length} walls on its busiest level and ${openings.length} openings; nothing to measure`);
  process.exit(1);
}

const wallIds = new Set<string>(busiest.map((w) => w.id));
const solidsOf = (els: readonly BimElement[]): Solid[] => els.flatMap((el) => elementSolids(el, undefined, model));
let solids = solidsOf(busiest);
batchMeshSolids(solids, (s) => (wallIds.has(s.elementId) ? "level:wall" : null));
solidsOf(openings);

const merge: number[] = [];
const bodies: number[] = [];
const opening: number[] = [];
for (let i = 0; i < samples; i++) {
  gc();
  const b = timeSync(() => solidsOf(busiest));
  solids = b.value;
  bodies.push(b.ms);
  merge.push(timeSync(() => batchMeshSolids(solids, (s) => (wallIds.has(s.elementId) ? "level:wall" : null))).ms);
  opening.push(timeSync(() => solidsOf(openings)).ms / openings.length);
}

console.log(
  JSON.stringify({
    [`viewer.walls.level_batch.${tier}`]: { ...stats(merge), walls: busiest.length },
    [`viewer.walls.level_bodies.${tier}`]: stats(bodies),
    [`viewer.opening.body.build.${tier}`]: { ...stats(opening), openings: openings.length },
  }),
);
emit({
  suite: "batch",
  workload: { tier, walls: busiest.length, openings: openings.length, samples },
  network: "in-process",
  participants: 1,
  samples: [
    { metric: `viewer.opening.body.build.${tier}`, values: opening, counts: { totalElements: Object.keys(model.elements).length, affectedElements: openings.length }, note: "elementSolids for every opening, ms per opening." },
    { metric: `viewer.walls.level_batch.${tier}`, values: merge, counts: { affectedElements: busiest.length }, note: "batchMeshSolids of the busiest level's joined walls." },
    { metric: `viewer.walls.level_bodies.${tier}`, values: bodies, counts: { affectedElements: busiest.length }, note: "elementSolids of the busiest level's joined walls (context, not budgeted)." },
  ],
});
