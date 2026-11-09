/**
 * Add-on kinds (round 10 K10): connector ends come from the add-ons' kind
 * rows, so resolving them and the index that reads them are measured on the
 * full-BIM model.
 *
 * - kinds.connector_ends.resolve.<tier>: a fresh pack set's ends table
 *   resolved, then every element's downstream ends read, p50 / p95 ms.
 * - network.index.build.<tier>: a fresh revision's topology index, p50 / p95 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/addon-kinds.ts [250k|1M]
 *
 * 1M only through the shared stack's heavy lock.
 */
import { connectorEndsTable, draftElements, freezeElements, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PackSet } from "../../../packages/bim-kernel/src/packs";
import { NetworkIndex } from "../../../packages/bim-kernel/src/network";
import { installFirstPartyAddOns } from "../../../packages/bim-first-party/src";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const SAMPLES = 7;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 2), p95: round(percentile(ms, 0.95) ?? 0, 2) };
}

const tier = process.argv[2] ?? "250k";
if (!isTier(tier)) {
  console.error(`[perf/addon-kinds] ${tier} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  process.exit(1);
}
installFirstPartyAddOns();
const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `addon-kinds-${tier}` });
const head: ModelState = { ...built, elements: freezeElements(built.elements) };
const elements = Object.values(head.elements);

const resolve: number[] = [];
const build: number[] = [];
let ends = 0;
for (let i = 0; i < SAMPLES; i++) {
  gc();
  resolve.push(
    timeSync(() => {
      const table = connectorEndsTable(PackSet.create([]));
      ends = 0;
      for (const el of elements) ends += table.downstream(el.kind).length;
    }).ms,
  );
  gc();
  build.push(timeSync(() => new NetworkIndex(head.connections, draftElements(head.elements))).ms);
}

console.log(JSON.stringify({ [`kinds.connector_ends.resolve.${tier}`]: { ...stats(resolve), elements: elements.length, ends }, [`network.index.build.${tier}`]: stats(build) }));
