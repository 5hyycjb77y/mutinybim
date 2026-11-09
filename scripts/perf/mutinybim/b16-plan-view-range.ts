/**
 * Batch 16-A (product review, Nov 6): what "a plan shows what's in its height
 * range, whichever level owns it" and "linked models draw their MEP" cost.
 *
 * - drawing.plan.other_levels.<tier>: `otherLevelElementsInRange` for a plan of
 *   a middle floor of the full-BIM tier (every floor a level element, 14 ft
 *   apart), p50 / p95 ms. Read through the partition index: only levels whose
 *   floor is within a storey's reach of the plan's range are opened. Prints the
 *   elements it tested against the model's size, which is the proof it is no
 *   full-model scan.
 * - linked.plan.cut.mep.large: cutIfcPlan with hidden lines on a synthetic MEP
 *   floor (mepLinkIfc grid 40: 1,600 bays, 12,800 elements: ducts, fittings,
 *   diffusers, pipes, rooftop units, ceilings, walls, slabs) at 4 ft, every
 *   category drawn by the add-ons' rules.
 * - linked.plan.cut.large.b16: the existing furniture floor (grid 40) cut with
 *   the add-ons' rules, against `linked.plan.cut.large`'s budget.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/b16-plan-view-range.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import * as WebIFC from "web-ifc";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { GLOBAL_PARTITION, asElementId, otherLevelElementsInRange, type BimElement, type Level, type ModelState, type ViewElement } from "@permitzip/bim-kernel";
import { cutIfcPlan } from "../../../packages/bim-sheets/src/ifc-plan";
import { IDENTITY4 } from "../../../packages/bim-sheets/src/plan-geometry";
import { furnitureIfc } from "../../../packages/bim-sheets/__tests__/fixtures/furniture-ifc";
import { FIRST_PARTY_LINKED_DISPLAY } from "../../../packages/bim-sheets/__tests__/fixtures/linked-display";
import { mepLinkIfc } from "../../../packages/bim-sheets/__tests__/fixtures/mep-link-ifc";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const FT = 304.8;
const FLOOR_MM = 14 * FT;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3) };
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "50");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/b16-plan-view-range] usage: b16-plan-view-range.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

/** The full-BIM model names its floors only in partitions; give each a level element so plans know their heights. */
function withLevels(model: ModelState): { model: ModelState; floors: string[] } {
  const names = new Set<string>();
  for (const el of Object.values(model.elements)) if (el.partition && el.partition.level !== GLOBAL_PARTITION.level) names.add(el.partition.level);
  const floors = [...names].sort();
  const elements: Record<string, BimElement> = { ...model.elements };
  floors.forEach((name, i) => {
    const level: Level = { id: asElementId(`perf-level-${name}`), kind: "level", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, name, elevationMm: i * FLOOR_MM };
    elements[level.id] = level;
  });
  return { model: { ...model, elements }, floors };
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `b16-plan-range-${tier}` });
const { model, floors } = withLevels(built);
const middle = floors[Math.floor(floors.length / 2)] ?? floors[0] ?? "L01";
/** One of the tier's own floor plans, set to its floor's level. */
function planOf(m: ModelState, level: string): ViewElement {
  for (const el of Object.values(m.elements)) if (el.kind === "view" && el.viewType === "floor_plan") return { ...el, props: { ...el.props, level } };
  throw new Error("[perf/b16-plan-view-range] the tier has no floor plan");
}
const view = planOf(model, middle);

gc();
const first = timeSync(() => otherLevelElementsInRange(model, view));
const plan: number[] = [];
for (let i = 0; i < samples; i++) plan.push(timeSync(() => otherLevelElementsInRange(model, view)).ms);

async function cut(bytes: Uint8Array, file: string, runs: number): Promise<{ total: number[]; elements: number; layers: number }> {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  const total: number[] = [];
  let elements = 0;
  let layers = 0;
  try {
    for (let i = 0; i < runs; i++) {
      gc();
      const r = cutIfcPlan(api, modelId, { id: "perf", file, bytes, discipline: "mep", ifcToHostMetres: IDENTITY4, storeyName: file.startsWith("mep") ? "LEVEL 01" : "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY });
      total.push(r.stats.ms.total);
      elements = r.stats.elementsWithGeometry;
      layers = r.plan.layers.length;
    }
  } finally {
    api.CloseModel(modelId);
  }
  return { total, elements, layers };
}

async function main(): Promise<void> {
  const runs = Math.max(3, Math.min(5, samples));
  const mep = await cut(new TextEncoder().encode(mepLinkIfc({ grid: 40 })), "mep-link.ifc", runs);
  const furniture = await cut(new TextEncoder().encode(furnitureIfc({ grid: 40 })), "perf-furniture.ifc", runs);
  console.log(
    JSON.stringify({
      [`drawing.plan.other_levels.${tier}`]: { ...stats(plan), first: round(first.ms, 2), modelElements: Object.keys(model.elements).length, floors: floors.length, plan: middle, reached: first.value.length },
      "linked.plan.cut.mep.large": { ...stats(mep.total), elements: mep.elements, layers: mep.layers },
      "linked.plan.cut.large.b16": { ...stats(furniture.total), elements: furniture.elements, layers: furniture.layers },
    }),
  );
}

main().catch((err: unknown) => {
  console.error("[perf/b16-plan-view-range] failed", err);
  process.exit(1);
});
