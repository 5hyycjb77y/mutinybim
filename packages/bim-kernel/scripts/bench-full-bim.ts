/**
 * Full-BIM test buildings, per tier, as a server holding the whole model sees
 * them: a freshly loaded head (plain records, no caches), its first commit,
 * then 21 warm commits per edit category (p50 / max), zone-slice joins before
 * and after commits, and process memory with the head loaded.
 *
 * One tier per process so memory figures are not polluted by earlier tiers:
 *   npx tsx --expose-gc packages/bim-kernel/scripts/bench-full-bim.ts --tier=1M
 * Compare against another copy of the kernel sources (e.g. the previous one):
 *   npx tsx packages/bim-kernel/scripts/bench-full-bim.ts --tier=1M --src=/path/to/bim-kernel/src
 */
import path from "node:path";
import type { Command, Interest, ModelState } from "../src";
import { FULL_BIM_TIERS, ZONE_SQ_FT, createFullBimModel, describeModel } from "@permitzip/bim-first-party/seed";

type Kernel = typeof import("../src");

const args = process.argv.slice(2);
const tier = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "250k";
const srcArg = args.find((a) => a.startsWith("--src="))?.split("=")[1];
const kernel: Kernel = srcArg ? await import(path.resolve(srcArg, "index.ts")) : await import("../src");
const { planCommit, sliceModel } = kernel;
if (!(tier in FULL_BIM_TIERS)) throw new Error(`Unknown tier ${tier}; one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];

const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number): number => Math.round(n / 1e6);
function memory(): { rssMB: number; heapMB: number } {
  gc?.();
  const m = process.memoryUsage();
  return { rssMB: mb(m.rss), heapMB: mb(m.heapUsed) };
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: Math.round((performance.now() - start) * 100) / 100, value };
}

function stats(samples: readonly number[]): { p50: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: s[Math.floor((s.length - 1) / 2)] ?? 0, max: s[s.length - 1] ?? 0 };
}

/** What a backend has after loading from storage: plain records, fresh objects, no identity caches. */
function loaded(model: ModelState): ModelState {
  return structuredClone({ ...model, elements: Object.fromEntries(Object.entries(model.elements)) });
}

let keys = 0;
function commit(model: ModelState, command: Command): { ms: number; ok: boolean; model: ModelState } {
  keys += 1;
  const request = { idempotencyKey: `bench-full-${keys}`, baseRevision: model.revision, actor: { id: "bench", name: "Bench", kind: "human" as const }, command };
  const run = time(() => planCommit(model, [], request));
  return run.value.ok ? { ms: run.ms, ok: true, model: run.value.model } : { ms: run.ms, ok: false, model };
}

const level = `L${String(opts.floors).padStart(2, "0")}`;
const p = `${level}-Z${opts.zonesPerFloor}`;
/** One edit per category in the last zone of the top floor; `i` alternates the value so every commit really changes something. */
const categories: Array<[string, (i: number) => Command]> = [
  ["move a wall (doors, windows, tags, dims follow)", (i) => ({ type: "move_wall", wallId: `${p}-wh1-0`, delta: { x: 0, y: i % 2 === 0 ? 152.4 : -152.4 } })],
  ["slide a duct branch", (i) => ({ type: "slide_branch", tapId: `${p}-air-t1-s2-b1-tap`, s: (i % 2 === 0 ? 3.5 : 3.25) * 304.8 })],
  ["change a plumbing fixture load (ripples up the main)", (i) => ({ type: "set_terminal_cfm", terminalId: `${p}-dw-t1-s3-b2-dev`, cfm: 4 + (i % 2) })],
  ["resize a riser through every level", (i) => ({ type: "resize_riser", riserId: `riser-Z${opts.zonesPerFloor}-air`, profile: { shape: "rect", width: (i % 2 === 0 ? 40 : 36) * 25.4, height: 24 * 25.4 } })],
  ["retag a door", (i) => ({ type: "set_tag_text", tagId: `${p}-door-101-tag`, text: `D101 rev ${i}` })],
];
const zoneInterest: Interest = { areas: [{ level, zone: `Z${opts.zonesPerFloor}` }] };

/** Generate, then keep only the loaded copy, so memory reflects one head. */
function generateAndLoad(): { generateMs: number; mix: ReturnType<typeof describeModel>; head: ModelState } {
  const generated = time(() => createFullBimModel(opts));
  return { generateMs: generated.ms, mix: describeModel(generated.value), head: loaded(generated.value) };
}
let setup: ReturnType<typeof generateAndLoad> | null = generateAndLoad();
const { generateMs, mix } = setup;
let head = setup.head;
setup = null;
const memoryLoaded = memory();

const firstSlice = time(() => sliceModel(head, zoneInterest));
const first = commit(head, { type: "set_tag_text", tagId: `${p}-door-102-tag`, text: "D102" });
const second = commit(first.model, { type: "set_tag_text", tagId: `${p}-door-102-tag`, text: "D102b" });
head = second.model;

const commits: Record<string, { p50: number; max: number; ok: number; of: number }> = {};
for (const [name, make] of categories) {
  const samples: number[] = [];
  let ok = 0;
  for (let i = 0; i < 21; i++) {
    const r = commit(head, make(i));
    samples.push(r.ms);
    if (r.ok) ok += 1;
    head = r.model;
  }
  commits[name] = { ...stats(samples), ok, of: samples.length };
}

const warmSlices: number[] = [];
for (let i = 0; i < 5; i++) warmSlices.push(time(() => sliceModel(head, zoneInterest)).ms);
const memoryAfter = memory();

console.log(
  JSON.stringify({
    tier,
    kernel: srcArg ?? "current",
    elements: mix.total,
    areaSqFt: opts.floors * opts.zonesPerFloor * ZONE_SQ_FT,
    generateMs,
    firstCommitAfterLoadMs: first.ms,
    secondCommitMs: second.ms,
    zoneSlice: { elements: Object.keys(firstSlice.value.elements).length, firstMs: firstSlice.ms, warm: stats(warmSlices) },
    warmCommits: commits,
    memory: { loaded: memoryLoaded, afterCommits: memoryAfter },
  }),
);
