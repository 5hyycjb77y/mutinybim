/**
 * Kernel cost at heavy-model scale, per tier: full validate / recompute, the
 * first commit on a freshly loaded head (index + one-off checks), and warm
 * commits on the head a sequencer keeps. `--reference` also times the frozen
 * full-scan kernel (S and M only; L takes minutes per commit there).
 *
 *   npx tsx packages/bim-kernel/scripts/bench-heavy.ts [--reference] [--tiers=S,M,L]
 */
import {
  planCommit,
  recomputeDerived,
  validateModel,
  type CommandRequest,
  type ModelState,
  plainElements,
} from "../src";
import { HEAVY_TIERS, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";
import { planCommit as refPlan, type CommandRequest as RefCommandRequest } from "../__tests__/reference/changeset";
import { recomputeDerived as refRecompute } from "../__tests__/reference/derived";
import { validateModel as refValidate } from "../__tests__/reference/validate";
import { asReference } from "../__tests__/reference/adapt";

const FT = 304.8;
const args = process.argv.slice(2);
const withReference = args.includes("--reference");
const tierArg = args.find((a) => a.startsWith("--tiers="))?.split("=")[1] ?? "S,M,L";
const tiers = tierArg.split(",").filter((t): t is keyof typeof HEAVY_TIERS => t in HEAVY_TIERS);

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: Math.round((performance.now() - start) * 10) / 10, value };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

let keys = 0;
/** Duct commands both kernels understand. */
type DuctCommand = RefCommandRequest["command"];

function request(model: ModelState, command: DuctCommand): CommandRequest & RefCommandRequest {
  keys += 1;
  return { idempotencyKey: `bench-${keys}-key`, baseRevision: model.revision, actor: { id: "bench", name: "Bench", kind: "human" }, command };
}

/** Deep in the network: last unit, last trunk segment, so the airflow path is the longest. */
function commands(units: number, segments: number, i: number): DuctCommand[] {
  const n = `u${units}-s${segments}-b1`;
  return [
    { type: "slide_branch", tapId: `tap-${n}`, s: (i % 2 === 0 ? 7.5 : 8.5) * FT },
    { type: "set_terminal_cfm", terminalId: `sd-${n}`, cfm: 300 + (i % 7) * 25 },
  ];
}

for (const tier of tiers) {
  const opts = HEAVY_TIERS[tier];
  const gen = time(() => createHeavyModel(opts));
  const model = gen.value;
  const elements = Object.keys(model.elements).length;
  const modelBytes = JSON.stringify(model).length;

  // Fresh copies so no identity cache helps; cloning stays outside the timing.
  const forValidate = structuredClone({ ...model, elements: plainElements(model.elements) });
  const forRecompute = structuredClone({ ...model, elements: plainElements(model.elements) });
  const validate = time(() => validateModel(forValidate)).ms;
  const recompute = time(() => recomputeDerived(forRecompute)).ms;

  // First commit on a head loaded from storage: builds the index and checks the head once.
  const fresh = structuredClone({ ...model, elements: plainElements(model.elements) });
  const [slide0, cfm0] = commands(opts.units, opts.segmentsPerTrunk, 0);
  if (!slide0 || !cfm0) throw new Error("bench commands missing");
  const first = time(() => planCommit(fresh, [], request(fresh, slide0)));
  if (!first.value.ok) throw new Error(`first commit refused: ${first.value.error.message}`);

  // Warm: the sequencer's head, commit after commit.
  let head = first.value.model;
  const slideMs: number[] = [];
  const cfmMs: number[] = [];
  let slideBytes = 0;
  let cfmBytes = 0;
  for (let i = 1; i <= 20; i++) {
    const [slide, cfm] = commands(opts.units, opts.segmentsPerTrunk, i);
    if (!slide || !cfm) throw new Error("bench commands missing");
    const s = time(() => planCommit(head, [], request(head, slide)));
    if (!s.value.ok) throw new Error(`slide refused: ${s.value.error.message}`);
    slideMs.push(s.ms);
    slideBytes = JSON.stringify(s.value.changeset).length;
    head = s.value.model;
    const c = time(() => planCommit(head, [], request(head, cfm)));
    if (!c.value.ok) throw new Error(`airflow edit refused: ${c.value.error.message}`);
    cfmMs.push(c.ms);
    cfmBytes = JSON.stringify(c.value.changeset).length;
    head = c.value.model;
  }

  const row: Record<string, number | string> = {
    tier,
    elements,
    modelMB: Math.round(modelBytes / 1e4) / 100,
    generateMs: gen.ms,
    validateFullMs: validate,
    recomputeFullMs: recompute,
    firstCommitColdMs: first.ms,
    slideCommitP50Ms: median(slideMs),
    slideCommitMaxMs: Math.max(...slideMs),
    airflowCommitP50Ms: median(cfmMs),
    airflowCommitMaxMs: Math.max(...cfmMs),
    slideChangesetBytes: slideBytes,
    airflowChangesetBytes: cfmBytes,
    heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
  };

  if (withReference && tier !== "L") {
    const ref = asReference(model);
    row.refValidateMs = time(() => refValidate(ref)).ms;
    row.refRecomputeMs = time(() => refRecompute(ref)).ms;
    row.refSlideCommitMs = time(() => refPlan(ref, [], request(model, slide0))).ms;
    row.refAirflowCommitMs = time(() => refPlan(ref, [], request(model, cfm0))).ms;
  }
  console.log(JSON.stringify(row));
}
