/**
 * Round 15 (lane SH15): what a library title block's key plan costs per sheet
 * on the full-BIM model. The level's linework is read once per model revision
 * and level (cached); each sheet then fits it and hatches its plan's crop.
 * Budget: ≤ 2 ms p50 / 5 ms p95 per sheet at 250k (warm), first sheet of a
 * revision reported separately.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/sh15-key-plan.ts [XS|250k|1M] [samples]
 *
 * 250k and 1M only through the shared stack's heavy lock.
 *
 * Edits are committed through planCommit, as the app commits them. Until Nov 7
 * this script used the bare command result, which skips the commit's index
 * carry-over, so its "document index after edit" (171–184 ms at 250k) was a
 * cost the app never paid; through the commit path it is about 0.01 ms.
 */
import { commandSchema, documentIndex, elementsOfKind, freezeElements, keyPlanPrimitives, planCommit, type ModelState, type Sheet, type TitleBlockRow } from "../../../packages/bim-kernel/src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { gc, percentile, round, timeSync } from "./lib";

type Tier = keyof typeof FULL_BIM_TIERS;
const isTier = (value: string): value is Tier => value in FULL_BIM_TIERS;

const tier = process.argv[2] ?? "250k";
const samples = Number(process.argv[3] ?? "30");
if (!isTier(tier) || !Number.isInteger(samples) || samples < 1) {
  console.error(`[perf/sh15-key-plan] usage: sh15-key-plan.ts [${Object.keys(FULL_BIM_TIERS).join("|")}] [samples]; got ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

let commits = 0;
/** Commits the way the app does (planCommit, which carries the model's indexes to the new head), so "after an edit" is what a person pays. */
function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `sh15-key-plan-${++commits}-key`, baseRevision: model.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command: commandSchema.parse(command) }, () => "2026-11-07T00:00:00.000Z");
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

const IN = 25.4;
const font = { family: "Perf", weight: 400, file: "/perf.ttf", capHeight: 0.7 };
const row: TitleBlockRow = {
  id: "perf:title_block:e1",
  revision: 1,
  name: "Perf",
  definition: {
    schema: 1,
    paperName: "ARCH E1",
    paperMm: { x: 42 * IN, y: 30 * IN },
    marginsMm: { top: 12.7, right: 12.7, bottom: 12.7, left: 38.1 },
    stripWidthMm: 4 * IN,
    colors: { ink: "#000000", label: "#000000", accent: "#000000" },
    fonts: { display: font, displayBold: font, body: font },
    lines: { borderMm: 0.7, dividerMm: 0.35, ruleMm: 0.18 },
    slots: [{ kind: "key_plan", heightMm: 64, boxMm: { x: 3 * IN, y: 2 * IN } }, { kind: "revisions" }],
  },
};

const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `sh15-key-plan-${tier}` });
let m: ModelState = { ...built, elements: freezeElements(built.elements) };
const level = Object.values(m.elements).find((e) => e.kind === "level");
const levelName = level?.kind === "level" ? level.name : "L1";
m = run(m, { type: "create_sheet", sheetId: "perf-sheet", number: "M-101", name: "Plan", titleBlockRow: row });
m = run(m, { type: "create_view", viewId: "perf-view", name: "Plan", viewType: "floor_plan", crop: { min: { x: 0, y: 0 }, max: { x: 20000, y: 15000 } }, props: { level: levelName } });
m = run(m, { type: "place_viewport", viewportId: "perf-vp", sheetId: "perf-sheet", viewId: "perf-view", center: { x: 400, y: 300 }, scale: 96 });
m = { ...m, elements: freezeElements(m.elements) };
const box = { at: { x: 0, y: 0 }, size: { x: 3 * IN, y: 2 * IN } };
const sheetIn = (model: ModelState) => model.elements["perf-sheet"] as Sheet;
const walls = Object.values(m.elements).filter((e) => e.kind === "wall");
const part = Object.values(m.elements).find((e) => e.kind === "equipment");
if (!part || walls.length === 0) {
  console.error(`[perf/sh15-key-plan] the ${tier} model needs walls and equipment (walls ${walls.length})`);
  process.exit(1);
}

/** The first sheet's key plan after an edit, with the document index the sheet render builds anyway already built (timed separately). */
function afterEdit(command: Record<string, unknown> & { type: string }): { keyPlanMs: number; indexMs: number } {
  m = run(m, command);
  const index = timeSync(() => documentIndex(m)).ms;
  const keyPlan = timeSync(() => keyPlanPrimitives(m, sheetIn(m), box)).ms;
  return { keyPlanMs: keyPlan, indexMs: index };
}

gc();
// Opening the model: the store's kind index and the document index are built once and shared by every reader; timed apart.
const kindIndexMs = timeSync(() => elementsOfKind(m.elements, "wall", "slab")).ms;
const openIndexMs = timeSync(() => documentIndex(m)).ms;
const cold = timeSync(() => keyPlanPrimitives(m, sheetIn(m), box));
const warm: number[] = [];
for (let i = 0; i < samples; i++) warm.push(timeSync(() => keyPlanPrimitives(m, sheetIn(m), box)).ms);
// An edit that touches no wall, floor or level: the level's outline is reused.
const other: number[] = [];
const index: number[] = [];
for (let i = 0; i < samples; i++) {
  const r = afterEdit({ type: "move_equipment", equipmentId: part.id, delta: { x: 1, y: 0 } });
  other.push(r.keyPlanMs);
  index.push(r.indexMs);
}
// A wall moved: the outline follows the walls written, not the model.
const wall: number[] = [];
for (let i = 0; i < samples; i++) {
  const w = walls[i % walls.length];
  if (w) wall.push(afterEdit({ type: "move_wall", wallId: w.id, delta: { x: 1, y: 0 } }).keyPlanMs);
}
const p = (values: number[], q: number) => round(percentile(values, q) ?? 0);
console.log(
  JSON.stringify({
    suite: "sh15-key-plan",
    tier,
    elements: Object.keys(m.elements).length,
    walls: walls.length,
    level: levelName,
    primitives: cold.value.length,
    modelOpen: { kindIndexMs: round(kindIndexMs), documentIndexMs: round(openIndexMs) },
    firstKeyPlanMs: round(cold.ms),
    warm: { p50: p(warm, 0.5), p95: p(warm, 0.95) },
    firstAfterOtherEdit: { p50: p(other, 0.5), p95: p(other, 0.95) },
    firstAfterWallEdit: { p50: p(wall, 0.5), p95: p(wall, 0.95) },
    documentIndexAfterEdit: { p50: p(index, 0.5), p95: p(index, 0.95) },
  }),
);
