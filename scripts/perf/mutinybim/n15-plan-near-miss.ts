/**
 * What the live plan's near-miss pick costs (a receptacle under a pixel at a
 * far zoom, found by its footprint once every pick ray missed). Measured on
 * the full-BIM model's solids, as the viewer draws them.
 *
 * - viewer.plan_near_miss.<tier>: one hover's near miss (`PlanFootprintGrid.nearMiss`),
 *   8 px reach at 0.17 m per px, at points beside real solids, p50 / p95 ms.
 *   Budget 2 / 4 ms at 250k and 1M. Also prints the footprints scored per hover.
 * - viewer.plan_near_miss.sync_one_edit.<tier>: the grid brought to a
 *   revision where one element moved (what every draw pays), p50 / p95 ms.
 * - viewer.plan_near_miss.build.<tier>: the first sync, once per model open.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/n15-plan-near-miss.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { DEFAULT_ELEVATIONS, modelSolids, type Solid } from "../../../packages/bim-viewer-3d/src/native-geometry";
import { PlanFootprintGrid } from "../../../packages/bim-viewer-3d/src/plan-near-miss";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4) };
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "200");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/n15-plan-near-miss] usage: n15-plan-near-miss.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const model = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `n15-near-miss-${tier}` });
const solids = modelSolids(model, DEFAULT_ELEVATIONS);
const byId = new Map<string, Solid[]>();
for (const s of solids) {
  const list = byId.get(s.elementId);
  if (list) list.push(s);
  else byId.set(s.elementId, [s]);
}

const grid = new PlanFootprintGrid();
gc();
const build = timeSync(() => grid.sync(byId)).ms;

/** 8 px at about 0.17 m per px: the far zoom where a receptacle draws under a pixel. */
const REACH_M = 8 * 0.17;
const keepAll = () => true;
const targets = solids.filter((s) => s.shape !== "mesh");
if (targets.length === 0) throw new Error("[perf/n15-plan-near-miss] the model has no box or cylinder solids");
const hover: number[] = [];
const examined: number[] = [];
for (let i = 0; i < samples; i++) {
  const s = targets[Math.floor((i * 7919) % targets.length)] as Solid;
  // Half a metre off its centre: a near miss, not a direct hit.
  const at = { x: s.center[0] + 0.5, z: s.center[2] + 0.25 };
  const r = timeSync(() => grid.nearMiss(at, REACH_M, keepAll));
  hover.push(r.ms);
  examined.push(r.value.examined);
}

const sync: number[] = [];
const moved = targets[0] as Solid;
for (let i = 0; i < Math.min(samples, 40); i++) {
  const next = new Map(byId);
  next.set(moved.elementId, [{ ...moved, center: [moved.center[0] + (i % 2 === 0 ? 0.3 : 0), moved.center[1], moved.center[2]] }]);
  gc();
  sync.push(timeSync(() => grid.sync(next)).ms);
}

console.log(
  JSON.stringify({
    [`viewer.plan_near_miss.${tier}`]: { ...stats(hover), solids: solids.length, examinedP95: percentile(examined, 0.95) ?? 0, examinedMax: Math.max(...examined) },
    [`viewer.plan_near_miss.sync_one_edit.${tier}`]: stats(sync),
    [`viewer.plan_near_miss.build.${tier}`]: { ms: round(build, 1) },
  }),
);
