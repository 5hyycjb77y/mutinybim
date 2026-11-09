/**
 * Round 15 lane E15: what the live plan pays to draw circuits as they are
 * made, and what one Continue circuit placement plans. Measured on the
 * full-BIM model.
 *
 * - viewer.live_plan.view_graphics.<tier>: the live plan's symbol layer
 *   (`livePlanSymbols`) on the busiest level, opened as a power plan (the
 *   view graphics rows draw its circuit lines, home runs and tags), p50 / p95
 *   ms per redraw, with 60 circuits of 8 receptacles added to the model. Budget 8 / 16 ms at 250k, 30 / 60 ms at 1M.
 * - electrical.continue_circuit.plan.<tier>: one device joining a circuit
 *   (`planContinueCircuit`, the connect face's plan), p50 / p95 ms. Budget
 *   5 / 10 ms at 250k.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/e15-live-circuits.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock (lane Q15 runs them).
 */
import { builtinPartType, executeCommand, freezeElements, type Command, type ModelState } from "../../../packages/bim-kernel/src";
import { livePlanSymbols } from "../../../packages/bim-viewer-3d/src/live-plan-graphics";
import { planContinueCircuit } from "../../../packages/bim-pack-electrical/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

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
  console.error(`[perf/e15-live-circuits] usage: e15-live-circuits.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `e15-circuits-${tier}` });
// The full-BIM model is the background the live plan scans; the power plan is added on its own level.
const levelId = "perf-e1";
/** Circuits drawn on the busiest level: a panel per 21 circuits, 8 receptacles on each (a dense power plan). */
const CIRCUITS = 60;
const PER_CIRCUIT = 8;
let model: ModelState = { ...built, elements: freezeElements(built.elements) };
const run = (command: Command) => {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`[perf/e15-live-circuits] ${command.type} refused: ${r.error.message}`);
  model = r.model;
};
run({ type: "create_level", levelId, name: "Power", elevationMm: 0 });
const panelType = builtinPartType("builtin:panelboard-225@1");
const receptacleType = builtinPartType("builtin:duplex-receptacle@1");
if (!panelType || !receptacleType) throw new Error("[perf/e15-live-circuits] starter types missing");
for (let c = 0; c < CIRCUITS; c++) {
  const panel = `perf-p${Math.floor(c / 21)}`;
  if (c % 21 === 0) run({ type: "place_part", partId: panel, typeId: panelType.id, ...(c === 0 ? { partType: panelType.definition } : {}), levelId, position: { x: -5000, y: c * 3000 }, values: { panel_name: `P${c / 21}` } });
  const members = Array.from({ length: PER_CIRCUIT }, (_, i) => `perf-r${c}-${i}`);
  members.forEach((id, i) => run({ type: "place_part", partId: id, typeId: receptacleType.id, ...(c === 0 && i === 0 ? { partType: receptacleType.definition } : {}), levelId, position: { x: i * 1500, y: c * 3000 }, mark: id }));
  run({ type: "create_service_link", linkId: `perf-c${c}`, sourceId: panel, positions: [1 + 2 * (c % 21)], members: members.map((elementId) => ({ elementId })) });
}
run({ type: "place_part", partId: "perf-next", typeId: receptacleType.id, levelId, position: { x: 13000, y: 0 }, mark: "NEXT" });
const sample = { device: "perf-next", panel: "perf-p0", link: "perf-c0" };
const circuits = CIRCUITS;

const partition = model.elements["perf-p0"]?.partition?.level ?? levelId;
const options = { levelId: partition, scale: 48, detail: "medium" as const, levels: new Set([partition]), hasBody: () => true, view: { props: { discipline: "electrical" as const } } };

const redraw: number[] = [];
const plan: number[] = [];
let segments = 0;
livePlanSymbols(model, options);
for (let i = 0; i < samples; i++) {
  gc();
  const r = timeSync(() => livePlanSymbols(model, options));
  segments = r.value.segments.length;
  redraw.push(r.ms);
  plan.push(timeSync(() => planContinueCircuit(model, sample.device, { panelId: sample.panel, linkId: sample.link, newLinkId: "perf-new" })).ms);
}

console.log(
  JSON.stringify({
    [`viewer.live_plan.view_graphics.${tier}`]: { ...stats(redraw), circuits, segments },
    [`electrical.continue_circuit.plan.${tier}`]: stats(plan),
  }),
);
