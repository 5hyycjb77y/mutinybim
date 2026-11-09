/**
 * Round 15 lane K15: what planning "connect these into the nearest run"
 * costs (`route.connect_into.preview`, nothing sent), on the full-BIM model.
 *
 * The full-BIM elements plus a fifth as many kernel pipe runs on a 10 ft
 * grid; on its level, a 4" sanitary branch 2 ft below the floor and a row of
 * floor-mounted closets 3 ft off it, then `planConnectInto` with "nearest":
 * the run index finds the branch from the few cells around each closet (no
 * model scan), and each source's route is checked once. Reported per source
 * (one closet at a time, 400 samples) and for 50 closets in one request.
 * Budgets 5 / 10 ms per source p50 / p95 at 250k, 10 / 20 ms at 1M; 50
 * sources ≤ 250 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/k15-connect-into.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { DEFAULT_SETTINGS, asElementId, builtinPartType, executeCommand, freezeElements, planConnectInto, withUpgradePolicy, type BimElement, type Command, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const FT = 304.8;
const IN = 25.4;
const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "400");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/k15-connect-into] usage: k15-connect-into.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `k15-connect-${tier}` });
const wc = builtinPartType("builtin:water-closet-floor@1");
if (!wc) {
  console.error("[perf/k15-connect-into] the starter library has no closet");
  process.exit(1);
}

const CLOSETS = 50;
const X0 = 0;
const Y0 = 0;
const SAN = { id: "k15-san", kind: "sanitary" as const, name: "Sanitary K15" };
const CW = { id: "k15-cw", kind: "domestic_cold_water" as const, name: "Cold water K15" };
const all = withUpgradePolicy(
  () => true,
  (): ModelState => {
    let model: ModelState = { modelId: built.modelId, revision: built.revision, elements: freezeElements({}), connections: [], settings: DEFAULT_SETTINGS };
    const run = (command: Command) => {
      const r = executeCommand(model, command);
      if (!r.ok) {
        console.error(`[perf/k15-connect-into] setup ${command.type} refused: ${r.error.message}`);
        process.exit(1);
      }
      model = r.model;
    };
    run({ type: "create_level", levelId: "k15-l1", name: "K15 Level 1", elevationMm: 0 });
    run({ type: "route_run", idPrefix: "k15-fill", levelId: "k15-l1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "copper" }, elevationMm: 9 * FT, system: CW, points: [{ x: 0, y: 0 }, { x: 8 * FT, y: 0 }] });
    // Kernel pipe runs, a fifth of the tier, on a 10 ft grid around the toilet row: the cells near each closet hold runs of other systems to pass over.
    const seed = model.elements["k15-fill-s1"];
    if (seed?.kind !== "run_segment") throw new Error("no seed run");
    const raw: Record<string, BimElement> = { ...built.elements, ...model.elements };
    const fill = Math.floor(Object.keys(built.elements).length / 5);
    const side = Math.ceil(Math.sqrt(fill));
    for (let i = 0; i < fill; i++) {
      const dx = ((i % side) - side / 2) * 10 * FT;
      const dy = (Math.floor(i / side) - side / 2) * 10 * FT + 5 * FT;
      raw[`k15-fill-${i}`] = { ...seed, id: asElementId(`k15-fill-${i}`), start: { ...seed.start, x: seed.start.x + dx, y: seed.start.y + dy }, end: { ...seed.end, x: seed.end.x + dx, y: seed.end.y + dy }, links: {} };
    }
    model = { ...model, elements: freezeElements(raw) };
    run({ type: "route_run", idPrefix: "k15-main", levelId: "k15-l1", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: -2 * FT, system: SAN, points: [{ x: X0 - 10 * FT, y: Y0 }, { x: X0 + CLOSETS * 3 * FT + 10 * FT, y: Y0 }] });
    for (let i = 0; i < CLOSETS; i++) {
      run({ type: "place_part", partId: `k15-wc-${i}`, typeId: wc.id, ...(model.elements[wc.id] ? {} : { partType: wc.definition }), levelId: "k15-l1", position: { x: X0 + i * 3 * FT, y: Y0 + 3 * FT }, offsetMm: 0, mark: `WC-${i + 1}` });
    }
    return model;
  },
);

const source = (i: number) => ({ elementId: `k15-wc-${i % CLOSETS}`, port: "waste" });
const plan = (from: ReturnType<typeof source>[]) => withUpgradePolicy(() => true, () => planConnectInto(all, { from, into: "nearest", idPrefix: "k15-ci" }));

// Warm once (not timed): the first read builds the run index for this revision.
const warm = plan([source(0)]);
if (warm.sources.some((s) => "refused" in s)) {
  console.error(`[perf/k15-connect-into] a closet was refused on the ${tier} model: ${JSON.stringify(warm.sources)}`);
  process.exit(1);
}
gc();
const ten: number[] = [];
for (let i = 0; i < Math.max(3, Math.min(10, Math.floor(samples / 40))); i++) {
  const t = timeSync(() => plan(Array.from({ length: 10 }, (_, k) => source(k))));
  if (t.value.sources.some((s) => "refused" in s)) {
    console.error(`[perf/k15-connect-into] of 10 closets, some were refused on the ${tier} model`);
    process.exit(1);
  }
  ten.push(t.ms);
}
const fifty: number[] = [];
for (let i = 0; i < Math.max(3, Math.min(10, Math.floor(samples / 40))); i++) {
  const t = timeSync(() => plan(Array.from({ length: CLOSETS }, (_, k) => source(k))));
  if (process.env.K15_TRACE) console.error(`[perf/k15-connect-into] 50 sources: ${round(t.ms, 1)} ms`);
  if (t.value.sources.some((s) => "refused" in s)) {
    console.error(`[perf/k15-connect-into] of 50 closets, some were refused on the ${tier} model`);
    process.exit(1);
  }
  fifty.push(t.ms);
}

gc();
const one: number[] = [];
for (let i = 0; i < samples; i++) one.push(timeSync(() => plan([source(i)]).sources.length).ms);
const budget = tier === "1M" ? { p50: 10, p95: 20 } : { p50: 5, p95: 10 };
console.log(
  JSON.stringify({
    [`route.connect_into.preview.${tier}`]: { p50: round(percentile(one, 0.5) ?? 0, 3), p95: round(percentile(one, 0.95) ?? 0, 3), elements: Object.keys(all.elements).length, budget },
    [`route.connect_into.preview_10.${tier}`]: { p50: round(percentile(ten, 0.5) ?? 0, 2), max: round(Math.max(...ten), 2) },
    [`route.connect_into.preview_50.${tier}`]: { p50: round(percentile(fifty, 0.5) ?? 0, 2), max: round(Math.max(...fifty), 2), budget: { max: 250 } },
  }),
);
