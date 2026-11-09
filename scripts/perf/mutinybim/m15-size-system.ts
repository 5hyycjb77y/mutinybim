/**
 * Round 15 lane M15: what planning Mechanical › Analyze › Size ducts costs
 * (`mechanical.size_system`, nothing sent) for one air system of 250 runs, on
 * the full-BIM model.
 *
 * The full-BIM elements, plus one supply system: a trunk with a diffuser
 * connected (so the trunk carries airflow) copied into 250 separate runs on
 * a 10 ft grid. `planSizeAirSystems` reads that system's duct pieces and
 * taps from the kind index (no model scan by system), groups them into runs
 * and sizes each by the system's rule. Budget 50 / 100 ms p50 / p95.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/m15-size-system.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { DEFAULT_SETTINGS, asElementId, builtinPartType, executeCommand, freezeElements, withUpgradePolicy, type BimElement, type Command, type ModelState } from "../../../packages/bim-kernel/src";
import { planSizeAirSystems, previewAirConnect } from "../../../packages/bim-pack-mechanical/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const FT = 304.8;
const IN = 25.4;
const RUNS = 250;
const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "60");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/m15-size-system] usage: m15-size-system.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `m15-size-${tier}` });
const diffuser = builtinPartType("builtin:supply-diffuser-24@1");
if (!diffuser) {
  console.error("[perf/m15-size-system] the starter library has no supply diffuser");
  process.exit(1);
}

const SA = { id: "m15-sa", kind: "supply_air" as const, name: "Supply Air M15" };
const model = withUpgradePolicy(
  () => true,
  (): ModelState => {
    let m: ModelState = { modelId: built.modelId, revision: built.revision, elements: freezeElements({}), connections: [], settings: DEFAULT_SETTINGS };
    const run = (command: Command) => {
      const r = executeCommand(m, command);
      if (!r.ok) {
        console.error(`[perf/m15-size-system] setup ${command.type} refused: ${r.error.message}`);
        process.exit(1);
      }
      m = r.model;
    };
    run({ type: "create_level", levelId: "m15-l1", name: "M15 Level 1", elevationMm: 0 });
    run({ type: "route_run", idPrefix: "m15-trunk", levelId: "m15-l1", domain: "duct", size: { shape: "rect", width: 24 * IN, height: 20 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 8 * FT, y: 0 }] });
    run({ type: "place_part", partId: "m15-sd", typeId: diffuser.id, partType: diffuser.definition, levelId: "m15-l1", position: { x: 4 * FT, y: 5 * FT }, offsetMm: 8 * FT, mark: "SD-1" });
    const preview = previewAirConnect(m, ["m15-sd"], "m15-ci");
    if ("refused" in preview) {
      console.error(`[perf/m15-size-system] the diffuser didn't connect: ${preview.refused}`);
      process.exit(1);
    }
    for (const command of preview.plan.commands) run(command);
    const seed = m.elements["m15-trunk-s1"];
    if (seed?.kind !== "run_segment" || !(seed.flow > 0)) throw new Error("the seed trunk carries no airflow");
    const raw: Record<string, BimElement> = { ...built.elements, ...m.elements };
    const side = Math.ceil(Math.sqrt(RUNS));
    for (let i = 0; i < RUNS - 1; i++) {
      const dx = ((i % side) + 1) * 10 * FT;
      const dy = (Math.floor(i / side) + 1) * 10 * FT;
      raw[`m15-run-${i}`] = { ...seed, id: asElementId(`m15-run-${i}`), flow: seed.flow + (i % 50) * 25, start: { ...seed.start, x: seed.start.x + dx, y: seed.start.y + dy }, end: { ...seed.end, x: seed.end.x + dx, y: seed.end.y + dy }, links: {} };
    }
    return { ...m, elements: freezeElements(raw) };
  },
);

const plan = () => planSizeAirSystems(model, [asElementId(SA.id)]);
const warm = plan();
if ((warm.systems[0]?.runs ?? 0) < RUNS || warm.changes.length === 0) {
  console.error(`[perf/m15-size-system] expected ${RUNS} runs to size on the ${tier} model, got ${JSON.stringify({ systems: warm.systems, changes: warm.changes.length, refused: warm.refused.length })}`);
  process.exit(1);
}
gc();
const times: number[] = [];
for (let i = 0; i < samples; i++) times.push(timeSync(() => plan().changes.length).ms);
console.log(
  JSON.stringify({
    [`mechanical.size_system.${tier}`]: { p50: round(percentile(times, 0.5) ?? 0, 2), p95: round(percentile(times, 0.95) ?? 0, 2), runs: warm.systems[0]?.runs ?? 0, changes: warm.changes.length, elements: Object.keys(model.elements).length, budget: { p50: 50, p95: 100 } },
  }),
);
