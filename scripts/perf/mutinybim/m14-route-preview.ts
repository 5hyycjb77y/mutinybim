/**
 * Round 14 lane M14: what checking one drawn leg costs while routing
 * (`route.preview.check_leg`, pointer-follow, nothing sent), on the full-BIM
 * model with every wall rated 1-hour.
 *
 * Each sample is a 6 m supply-air leg on a wall's level, square across the
 * wall's middle (so it crosses at least that wall), checked through
 * `checkRouteSpan` with the first-party add-ons in force: the boundary index
 * near the leg, the rated-element reader, and the ceiling index along it.
 * Budget 2 / 4 ms p50 / p95.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/m14-route-preview.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { checkRouteSpan, type RouteSpan } from "../../../packages/bim-kernel/src/routing/rated-routes";
import { freezeElements, type BimElement } from "../../../packages/bim-kernel/src";
import { lineLevelId } from "../../../packages/bim-kernel/src/joins/rows";
import { FIRE_RESISTANCE_KEY } from "@permitzip/bim-pack-architecture";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "400");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/m14-route-preview] usage: m14-route-preview.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `m14-preview-${tier}` });
const raw: Record<string, BimElement> = {};
const walls: { levelId: string; mid: { x: number; y: number }; dir: { x: number; y: number } }[] = [];
for (const [id, el] of Object.entries(built.elements)) {
  if (el.kind === "wall") {
    const { start, end } = el;
    const len = Math.hypot(end.x - start.x, end.y - start.y);
    if (len > 1) walls.push({ levelId: lineLevelId(el, built.elements), mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, dir: { x: (end.x - start.x) / len, y: (end.y - start.y) / len } });
    raw[id] = { ...el, values: { ...(el.values ?? {}), [FIRE_RESISTANCE_KEY]: 1 } };
  } else raw[id] = el;
}
if (walls.length === 0) {
  console.error(`[perf/m14-route-preview] the ${tier} model has no line walls; nothing to measure`);
  process.exit(1);
}
const model = { ...built, elements: freezeElements(raw) };

const legFor = (i: number): RouteSpan => {
  const w = walls[(i * 7919) % walls.length];
  if (!w) throw new Error("no wall");
  const n = { x: -w.dir.y, y: w.dir.x };
  return { kind: "run_segment", serviceId: "supply_air", levelId: w.levelId, start: { x: w.mid.x - n.x * 3000, y: w.mid.y - n.y * 3000 }, end: { x: w.mid.x + n.x * 3000, y: w.mid.y + n.y * 3000 }, bottomMm: 2921, topMm: 3175, widthMm: 355.6 };
};

// Warm the indexes once (not timed): the first read of a level builds its boundary and ceiling indexes.
for (let i = 0; i < Math.min(walls.length, 50); i++) checkRouteSpan(model, legFor(i));
gc();
const ms: number[] = [];
let hitsMax = 0;
for (let i = 0; i < samples; i++) {
  const span = legFor(i);
  const t = timeSync(() => {
    const a = checkRouteSpan(model, span);
    return "refused" in a ? -1 : a.length;
  });
  if (t.value < 0) {
    console.error(`[perf/m14-route-preview] a leg was refused on the ${tier} model`);
    process.exit(1);
  }
  hitsMax = Math.max(hitsMax, t.value);
  ms.push(t.ms);
}

console.log(JSON.stringify({ [`route.preview.check_leg.${tier}`]: { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4), walls: walls.length, elements: Object.keys(raw).length, hitsMax, budget: { p50: 2, p95: 4 } } }));
