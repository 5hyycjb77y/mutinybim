/**
 * Round 15 gap G-K15-1: what one multi-step edit costs on the full-BIM model
 * (`batch_edits` of N `place_part` steps, committed through `planCommit` as
 * one revision), after a preview of another edit on the same head, as an
 * agent script or the approval card does it. Each step runs on the step
 * before; the cost must follow the steps, not the model (before the fix every
 * step after the first rebuilt the whole element record).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/k15-batch-edits.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 */
import { builtinPartType, commandSchema, executeCommand, freezeElements, planCommit, type Command, type ModelState } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

const FT = 304.8;
const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "20");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/k15-batch-edits] usage: k15-batch-edits.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
const wc = builtinPartType("builtin:water-closet-floor@1");
if (!wc) {
  console.error("[perf/k15-batch-edits] the starter library has no closet");
  process.exit(1);
}

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `k15-batch-${tier}` });
const actor = { id: "perf", name: "Perf", kind: "agent" as const };
let head: ModelState = { ...built, elements: freezeElements(built.elements) };
const setup = (command: Command) => {
  const r = planCommit(head, [], { idempotencyKey: `k15-setup-${command.type}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) });
  if (!r.ok) {
    console.error(`[perf/k15-batch-edits] setup ${command.type} refused: ${r.error.message}`);
    process.exit(1);
  }
  head = r.model;
};
setup({ type: "create_level", levelId: "k15b-l1", name: "K15 batch level", elevationMm: -40 * FT });
setup({ type: "place_part", partId: "k15b-seed", typeId: wc.id, partType: wc.definition, levelId: "k15b-l1", position: { x: -20 * FT, y: -20 * FT }, offsetMm: 0, mark: "WC-0" });

// Closets and short pipe runs alternate, so no two neighbouring steps can run together as one.
const place = (id: string, i: number): Command =>
  i % 2 === 0
    ? commandSchema.parse({ type: "place_part", partId: id, typeId: wc.id, levelId: "k15b-l1", position: { x: i * 3 * FT, y: -20 * FT }, offsetMm: 0, mark: `WC-${id}` })
    : commandSchema.parse({ type: "route_run", idPrefix: id, levelId: "k15b-l1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 9 * FT, system: { id: "k15b-cw", kind: "domestic_cold_water", name: "Cold water K15 batch" }, points: [{ x: i * 3 * FT, y: -30 * FT }, { x: i * 3 * FT + 2 * FT, y: -30 * FT }] });

function sampleBatch(n: number, sample: number): number {
  // The preview the operator saw first: a sibling revision over the same head.
  const preview = executeCommand(head, place(`k15b-prev-${n}-${sample}`, -1));
  if (!preview.ok) throw new Error(preview.error.message);
  const command = commandSchema.parse({ type: "batch_edits", label: `${n} closets and runs`, commands: Array.from({ length: n }, (_, i) => place(`k15b-${n}-${sample}-${i}`, i)) });
  const t = timeSync(() => planCommit(head, [], { idempotencyKey: `k15-batch-${n}-${sample}`, baseRevision: head.revision, actor, command }));
  if (!t.value.ok) throw new Error(`batch of ${n} refused: ${t.value.error.message}`);
  return t.ms;
}

const out: Record<string, { p50: number; p95: number; max: number; elements: number; budget: { p50: number; p95: number } }> = {};
// The kernel.batch_edits.* rows of docs/perf/mutinybim-budgets.json.
const budgets: Record<number, { p50: number; p95: number }> = tier === "1M" ? { 10: { p50: 20, p95: 40 }, 50: { p50: 50, p95: 100 } } : { 10: { p50: 10, p95: 20 }, 50: { p50: 25, p95: 50 } };
for (const n of [10, 50]) {
  sampleBatch(n, -1); // warm, not timed
  gc();
  const times: number[] = [];
  for (let s = 0; s < samples; s++) times.push(sampleBatch(n, s));
  out[`kernel.batch_edits.${n}.${tier}`] = { p50: round(percentile(times, 0.5) ?? 0, 2), p95: round(percentile(times, 0.95) ?? 0, 2), max: round(Math.max(...times), 2), elements: Object.keys(head.elements).length, budget: budgets[n] ?? { p50: 0, p95: 0 } };
}
console.log(JSON.stringify(out));
