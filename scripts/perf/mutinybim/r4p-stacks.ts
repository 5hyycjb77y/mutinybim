/**
 * plumbing.stacks — stack derivation after an edit (ROADMAP P6), on a 14-storey
 * building with 24 sanitary stacks, each split at every floor with a floor
 * branch per storey (336 branches).
 *
 *   node --import tsx scripts/perf/mutinybim/r4p-stacks.ts [--samples=7]
 *
 *   plumbing.stacks.advance   the stack index after one committed edit (a new floor branch on one
 *                             stack), advanced from the changed ids: the untouched stacks are kept
 *   plumbing.stacks.full      the same index built from scratch on that state (what a full scan costs)
 *   plumbing.stacks.at        one stack read from one of its pipes (what a tag or Properties pays)
 *
 * Prints one JSON object (median and p95 per metric, plus how many stacks the advance walked).
 */
import { asElementId, DEFAULT_SETTINGS, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { advanceStackRunIndex, stackAt, stackRunIndex, verticalRunStats } from "@permitzip/bim-pack-plumbing";
import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const FT = 304.8;
const IN = 25.4;
const FLOORS = 14;
const STACKS = 24;
const STOREY = 12 * FT;
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });

let seq = 0;
function commit(model: ModelState, command: Command): { model: ModelState; changed: string[] } {
  seq += 1;
  const d = planCommit(model, [], { idempotencyKey: `perf-stacks-${seq}-key`, baseRevision: model.revision, actor: { id: "agent:perf", name: "Perf", kind: "agent" }, command });
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return { model: d.model, changed: [...d.changeset.elements.map((e) => e.id), ...(d.changeset.removedIds ?? [])] };
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

/** The piece of stack `k` just below floor `f` (stacks are drawn top down and split where they cross a floor). */
function pieceBelow(model: ModelState, k: number, f: number): string {
  const x = k * 20 * FT;
  const z = f * STOREY - 1 * FT;
  for (const el of Object.values(model.elements)) {
    if (el.kind !== "run_segment" || !el.id.startsWith(`stk${k}-`)) continue;
    const lo = Math.min(el.start.z, el.end.z);
    const hi = Math.max(el.start.z, el.end.z);
    if (Math.abs(el.start.x - x) < 1 && lo <= z && hi >= z) return el.id;
  }
  throw new Error(`no piece of stack ${k} at floor ${f}`);
}

function build(): ModelState {
  let model: ModelState = { modelId: "perf-stacks-14", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  model = commit(model, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).model;
  for (let f = 1; f < FLOORS; f++) model = commit(model, { type: "create_level", levelId: `lvl-${f + 1}`, name: `Level ${f + 1}`, elevationMm: f * STOREY }).model;
  const top = (FLOORS - 1) * STOREY + 8 * FT;
  for (let k = 0; k < STACKS; k++) {
    const x = k * 20 * FT;
    model = commit(model, { type: "route_run", idPrefix: `stk${k}`, levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: top, system: SAN, points: [{ x, y: 0 }, { x, y: 0, elevationMm: -2 * FT }] }).model;
    for (let f = 0; f < FLOORS; f++) {
      model = commit(model, { type: "route_run", idPrefix: `br${k}-${f}`, levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: f * STOREY - 1 * FT, system: SAN, points: [{ x: x + 12 * FT, y: 0 }, { x, y: 0 }], to: { kind: "run_branch", segmentId: pieceBelow(model, k, f) } }).model;
    }
  }
  return model;
}

const advance: number[] = [];
const full: number[] = [];
const at: number[] = [];
let walked = 0;
let stacks = 0;
const base = build();
stackRunIndex(base.elements);
for (let i = 0; i < samples; i++) {
  const k = i % STACKS;
  const target = pieceBelow(base, k, 1 + (i % (FLOORS - 1)));
  const { model: next, changed } = commit(base, { type: "route_run", idPrefix: `extra${i}`, levelId: "lvl-1", domain: "pipe", size: pvc(2), elevationMm: (1 + (i % (FLOORS - 1))) * STOREY - 1.5 * FT, system: SAN, points: [{ x: k * 20 * FT, y: 8 * FT }, { x: k * 20 * FT, y: 0 }], to: { kind: "run_branch", segmentId: target } });
  const before = verticalRunStats.walked;
  advance.push(time(() => (stacks = advanceStackRunIndex(base.elements, next.elements, changed).chains.length)));
  walked = verticalRunStats.walked - before;
  const fresh = { ...next, elements: { ...next.elements } };
  full.push(time(() => stackRunIndex(fresh.elements)));
  at.push(time(() => stackAt({ ...next.elements }, asElementId(target))));
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "plumbing-stacks", metrics: { "plumbing.stacks.advance": row(advance), "plumbing.stacks.full": row(full), "plumbing.stacks.at": row(at) }, counts: { stacks, walkedPerEdit: walked, elements: Object.keys(base.elements).length } }, null, 2)}\n`);
const c = { totalElements: Object.keys(base.elements).length, affectedElements: 1 };
emit({
  suite: "batch",
  workload: { building: `${FLOORS} storeys`, stacks: STACKS, branches: STACKS * FLOORS, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { stacks, walkedPerEdit: walked },
  samples: [
    { metric: "plumbing.stacks.advance", values: advance, counts: c, note: "Stack index after one new floor branch, advanced from the changed ids (only the touched stack is walked again)." },
    { metric: "plumbing.stacks.full", values: full, counts: c, note: "The stack index built from scratch on the same state." },
    { metric: "plumbing.stacks.at", values: at, counts: c, note: "One stack read from one of its pipes, on a state with no index." },
  ],
});
