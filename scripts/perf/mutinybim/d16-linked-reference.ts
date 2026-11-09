/**
 * Batch 16-D (product review, Nov 6: "the linked model is a picture, not
 * geometry"): what linked reference geometry costs.
 *
 * - linked.reference.index.large: buildLinkedReferenceIndex over a synthetic
 *   linked building of 50,000 walls (once per loaded set of linked models).
 * - linked.reference.snap.large: one pointer move's snap read
 *   (linkedSnapCandidates, 300 mm reach) on that index, p50 / p95 µs. Prints
 *   the elements it looked at against the index size: the proof it reads the
 *   cells round the pointer, not the model.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/d16-linked-reference.ts [walls] [samples]
 *
 * The first build of the process is timed too (cold), so the index row's p95
 * carries the cold build the d16 Jest test used to hold to 1.5 s. The batch
 * suite of the perf gate (run.ts) runs this at 50,000 walls and reads the
 * `@@perf-result` line; the JSON above it is for people.
 */
import { buildLinkedReferenceIndex, linkedItemsNear, linkedSnapCandidates, linkedReferenceRulesOf, type LinkedReferenceElement, type LinkedReferenceModel } from "@permitzip/bim-kernel";
import { emit, gc, percentile, round, timeSync } from "./lib";

const walls = Number(process.argv[2] ?? "50000");
const samples = Number(process.argv[3] ?? "5000");
if (!Number.isInteger(walls) || walls < 1 || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/d16-linked-reference] usage: d16-linked-reference.ts [walls] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const RULES = linkedReferenceRulesOf([{ id: "perf.walls", label: "Walls", ifcEntities: ["IFCWALL"], noun: "wall", snap: true, boundsRooms: true, envelope: "wall" }], []);

function building(n: number): LinkedReferenceModel {
  const side = Math.ceil(Math.sqrt(n));
  const elements: LinkedReferenceElement[] = [];
  for (let k = 0; k < n; k++) {
    const x = (k % side) * 4000;
    const y = Math.floor(k / side) * 1000;
    elements.push({ globalId: `W${k}`, name: "Wall", ifcClass: "IFCWALL", box: [x - 100, y - 100, 0, x + 3100, y + 100, 3600], hull: [x - 100, y + 100, x + 3100, y + 100, x + 3100, y - 100, x - 100, y - 100] });
  }
  return { modelId: "perf-link", label: "Perf link", elements };
}

const model = building(walls);
const cold = timeSync(() => buildLinkedReferenceIndex([model], RULES));
const builds: number[] = [cold.ms];
let index = cold.value;
for (let i = 0; i < 5; i++) {
  gc();
  const t = timeSync(() => buildLinkedReferenceIndex([model], RULES));
  index = t.value;
  builds.push(t.ms);
}
const side = Math.ceil(Math.sqrt(walls));
const spanX = side * 4000;
const spanY = Math.ceil(walls / side) * 1000;
const snaps: number[] = [];
let read = 0;
for (let k = 0; k < samples; k++) {
  const at = { x: (k * 7919) % spanX, y: (k * 104_729) % spanY };
  snaps.push(timeSync(() => linkedSnapCandidates(index, { at, reachMm: 300, zMm: 1200 })).ms * 1000);
  read = Math.max(read, linkedItemsNear(index, { minX: at.x - 300, minY: at.y - 300, maxX: at.x + 300, maxY: at.y + 300 }, 1200).length);
}
const s = (v: readonly number[]) => ({ p50: round(percentile(v, 0.5) ?? 0, 3), p95: round(percentile(v, 0.95) ?? 0, 3) });
console.log(JSON.stringify({ "linked.reference.index.large": { unit: "ms", walls: index.items.length, ...s(builds) }, "linked.reference.snap.large": { unit: "µs", ...s(snaps), mostElementsRead: read, ofIndexed: index.items.length } }, null, 2));
emit({
  suite: "batch",
  workload: { linkedWalls: walls, buildsPerRun: builds.length, snapsPerRun: samples },
  network: "in-process",
  participants: 1,
  samples: [
    { metric: "linked.reference.index.large", values: builds, counts: { totalElements: index.items.length }, note: "buildLinkedReferenceIndex, ms; the first value of each run is the process's cold build." },
    { metric: "linked.reference.snap.large", values: snaps.map((us) => us / 1000), counts: { totalElements: index.items.length, affectedElements: read }, note: "linkedSnapCandidates at 300 mm, ms per pointer move; affected = most elements one move looked at." },
  ],
});
