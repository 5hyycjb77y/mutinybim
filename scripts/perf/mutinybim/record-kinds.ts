/**
 * One record registry (round 11 K11): `anchorOf` reads each kind's row
 * instead of a switch over every kernel kind. Measured on the full-BIM model.
 *
 * - kinds.anchor_of.row.<tier>: `anchorOf` on every element, one pass, p50 / p95 ms.
 * - ab.anchor_of.round10_switch.<tier>: round 10's switch (frozen copy in the kernel's
 *   test references, importing its helpers by module as model.ts did) on
 *   the same elements in the same process, interleaved, for the A/B.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/record-kinds.ts [250k|1M] [samples]
 *
 * 1M only through the shared stack's heavy lock.
 */
import { anchorOf, freezeElements, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { round10AnchorOf } from "../../../packages/bim-kernel/__tests__/reference/round10-anchor-of";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 2), p95: round(percentile(ms, 0.95) ?? 0, 2) };
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "15");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/record-kinds] usage: record-kinds.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `record-kinds-${tier}` });
const head: ModelState = { ...built, elements: freezeElements(built.elements) };
const elements = Object.values(head.elements);

// Bound once: an imported function is read through a getter on every call when transpiled, and the two sides import through different depths.
const rowAnchor = anchorOf;
const switchAnchor = round10AnchorOf;
let placed = 0;
// Two loops, not one shared helper: one call site per function, so neither pass makes the other's call polymorphic.
const passRow = () => {
  placed = 0;
  for (const el of elements) if (rowAnchor(el) !== null) placed++;
};
const passAb = () => {
  placed = 0;
  for (const el of elements) if (switchAnchor(el) !== null) placed++;
};
const row: number[] = [];
const ab: number[] = [];
let placedRow = 0;
let placedAb = 0;
const timeRow = () => {
  gc();
  const ms = timeSync(passRow).ms;
  placedRow = placed;
  return ms;
};
const timeAb = () => {
  gc();
  const ms = timeSync(passAb).ms;
  placedAb = placed;
  return ms;
};
// Alternate which runs first: the second pass of a pair runs on a warmer heap.
for (let i = 0; i <= samples; i++) {
  let a: number;
  let b: number;
  if (i % 2 === 0) {
    a = timeRow();
    b = timeAb();
  } else {
    b = timeAb();
    a = timeRow();
  }
  if (i === 0) continue;
  row.push(a);
  ab.push(b);
}
if (placedRow !== placedAb) {
  console.error(`[perf/record-kinds] anchorOf placed ${placedRow} elements, round 10's switch ${placedAb}`);
  process.exit(1);
}
console.log(JSON.stringify({ [`kinds.anchor_of.row.${tier}`]: { ...stats(row), elements: elements.length, placed: placedRow }, [`ab.anchor_of.round10_switch.${tier}`]: stats(ab) }));
