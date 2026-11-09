/**
 * `validate.addon_switch.first_edit_after_reopen` (250k) and `.1M`: the first
 * ordinary edit after an add-on is switched on or off and the model is
 * reopened from its stored rows with the validation state it kept. The kept
 * checks must be re-used, so the edit re-checks only what the switched add-on
 * contributes, never the whole model. Round 12 measured 611–713 ms at 1M
 * before the fix (budget 500 / 1000, round 12 DECISIONS).
 *
 * Each sample: switch the test add-on (on, then off, alternating) on the
 * all-discipline building plus a gas system the add-on flags, keep the
 * validation state, reopen the head from JSON rows (as the model server reads
 * storage), offer it the kept state, and time `planCommit` of one ordinary
 * edit (adoption included: it is what the person waits for).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/addon-switch-reopen.ts --tier=250k|1M [--samples=N] [--enforce] [--out=dir]
 *
 * --enforce exits 1 when p50 / p95 is over the budget row or any first edit
 * ran a whole-model check. 250k and 1M only through the shared stack's heavy
 * lock (or the dispatch-only bim-perf-1m CI job).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildPointReads,
  elementsFromRows,
  incrementalValidationStats,
  installModelSetupHost,
  issuesOf,
  offerValidationState,
  planCommit,
  validationStateOf,
  validationStateStats,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
} from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { buildSampleMarketGas } from "../../../packages/bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_TEST_PACK } from "../../../packages/bim-pack/__tests__/fixtures/check-addon";
import { loadBudgets, percentile, REPO_ROOT, round } from "./lib";

export type ReopenTier = keyof typeof FULL_BIM_TIERS;

export interface ReopenSample {
  readonly switched: "on" | "off";
  readonly ms: number;
  readonly wholeModelChecks: number;
  readonly unitsRerun: number;
  readonly adopted: number;
  readonly declined: number;
  readonly lastDeclined: string | null;
}

export interface ReopenReport {
  readonly tier: ReopenTier;
  readonly elements: number;
  readonly samples: readonly ReopenSample[];
  readonly p50: number;
  readonly p95: number;
  readonly metric: string;
}

const NOW = () => "2026-11-04T00:00:00.000Z";
let seq = 0;

function commit(head: ModelState, command: Command): { readonly model: ModelState; readonly ms: number } {
  seq += 1;
  const t0 = performance.now();
  const decided = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `q14-reopen-${seq}`, baseRevision: head.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command }, NOW),
  );
  const ms = performance.now() - t0;
  if (!decided.ok) throw new Error(`[addon-switch-reopen] ${command.type} refused: ${decided.error.message}`);
  return { model: decided.model, ms };
}

/** The head as the model server reads it back from storage: plain rows, no in-memory indexes. */
function reopenFromRows(head: ModelState): ModelState {
  return {
    ...head,
    elements: elementsFromRows(JSON.parse(JSON.stringify(Object.values(head.elements))) as BimElement[]),
    connections: JSON.parse(JSON.stringify(head.connections)) as ModelState["connections"],
  };
}

function wholeChecks(s: ReturnType<typeof incrementalValidationStats>): number {
  return s.fullPasses + s.coldPasses;
}

/** The metric row a tier is held to. */
export function reopenMetric(tier: ReopenTier): string {
  return tier === "1M" ? "validate.addon_switch.first_edit_after_reopen.1M" : "validate.addon_switch.first_edit_after_reopen";
}

export function measureReopenFirstEdit(tier: ReopenTier, samples: number): ReopenReport {
  const uninstall = installModelSetupHost(() => [CHECK_TEST_PACK]);
  try {
    const big = createFullBimModel(FULL_BIM_TIERS[tier]);
    const gas = buildSampleMarketGas();
    let head: ModelState = { ...big, modelId: `q14-reopen-${tier}`, elements: { ...big.elements, ...gas.elements }, connections: [...big.connections, ...gas.connections] };
    const walls = Object.values(head.elements).filter((e) => e.kind === "wall").map((e) => e.id);
    if (walls.length === 0) throw new Error("[addon-switch-reopen] the building has no walls to edit");
    let n = 0;
    const ordinary = (): Command => ({ type: "move_wall", wallId: walls[(++n * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } });
    head = commit(head, ordinary()).model;
    const out: ReopenSample[] = [];
    for (let i = 0; i < samples; i++) {
      const on = i % 2 === 0;
      head = commit(head, { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on }).model;
      // The model server's warm-up after the switch: facts established, point reads built, state kept.
      issuesOf(head);
      buildPointReads(head);
      const kept = validationStateOf(head, "q14");
      if (!kept) throw new Error(`[addon-switch-reopen] no validation state was kept after switching the add-on ${on ? "on" : "off"}`);
      const fresh = reopenFromRows(head);
      offerValidationState(fresh, JSON.parse(JSON.stringify(kept)), "q14");
      (globalThis as { gc?: () => void }).gc?.();
      const before = { ...incrementalValidationStats(), ...validationStateStats() };
      const edited = commit(fresh, ordinary());
      const after = { ...incrementalValidationStats(), ...validationStateStats() };
      out.push({
        switched: on ? "on" : "off",
        ms: round(edited.ms, 2),
        wholeModelChecks: wholeChecks(after) - wholeChecks(before),
        unitsRerun: after.unitsRerun - before.unitsRerun,
        adopted: after.adopted - before.adopted,
        declined: after.declined - before.declined,
        lastDeclined: after.declined > before.declined ? after.lastDeclined : null,
      });
      head = edited.model;
    }
    const ms = out.map((s) => s.ms);
    const p50 = percentile(ms, 0.5);
    const p95 = percentile(ms, 0.95);
    if (p50 === null || p95 === null) throw new Error("[addon-switch-reopen] no samples were measured");
    return { tier, elements: Object.keys(head.elements).length, samples: out, p50: round(p50, 2), p95: round(p95, 2), metric: reopenMetric(tier) };
  } finally {
    uninstall();
  }
}

/** Over-budget and whole-model-check problems, in words; empty when the report passes. */
export function reopenProblems(report: ReopenReport, budget: { readonly p50: number; readonly p95: number }): string[] {
  const problems: string[] = [];
  if (report.p50 > budget.p50) problems.push(`${report.metric} p50 ${report.p50} ms is over its ${budget.p50} ms budget`);
  if (report.p95 > budget.p95) problems.push(`${report.metric} p95 ${report.p95} ms is over its ${budget.p95} ms budget`);
  for (const [i, s] of report.samples.entries()) {
    if (s.adopted === 0) problems.push(`sample ${i + 1} (add-on ${s.switched}) did not adopt the kept checks${s.lastDeclined ? ` (declined: ${s.lastDeclined})` : ""}`);
    if (s.wholeModelChecks > 0) problems.push(`sample ${i + 1} (add-on ${s.switched}) re-checked the whole model ${s.wholeModelChecks} time(s) instead of re-using the kept checks${s.lastDeclined ? ` (declined: ${s.lastDeclined})` : ""}`);
  }
  return problems;
}

function isTier(value: string): value is ReopenTier {
  return value in FULL_BIM_TIERS;
}

function main(): void {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
  const tier = arg("tier", "250k");
  if (!isTier(tier)) throw new Error(`[addon-switch-reopen] --tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}; got ${tier}`);
  const samples = Number(arg("samples", tier === "1M" ? "4" : "6"));
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`[addon-switch-reopen] --samples must be a whole number of at least 1; got ${arg("samples", "")}`);
  const outDir = arg("out", path.join(REPO_ROOT, ".perf-results/mutinybim", `addon-switch-reopen-${tier}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  const report = measureReopenFirstEdit(tier, samples);
  const budget = loadBudgets().metrics[report.metric];
  if (!budget) throw new Error(`[addon-switch-reopen] docs/perf/mutinybim-budgets.json has no ${report.metric} row`);
  const problems = reopenProblems(report, budget);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ recordedAt: new Date().toISOString(), budget: { p50: budget.p50, p95: budget.p95 }, report, problems }, null, 2));
  console.log(`[addon-switch-reopen] ${report.metric} at ${report.elements} elements: p50 ${report.p50} / p95 ${report.p95} ms (budget ${budget.p50} / ${budget.p95}); ${report.samples.map((s) => `${s.switched} ${s.ms} ms, whole ${s.wholeModelChecks}`).join("; ")}`);
  if (problems.length > 0) {
    console.error(`[addon-switch-reopen] ${args.includes("--enforce") ? "FAIL" : "over budget (not enforced)"}: ${problems.join("; ")}`);
    if (args.includes("--enforce")) process.exitCode = 1;
  } else console.log("[addon-switch-reopen] PASS");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (err) {
    console.error("[addon-switch-reopen] failed", err);
    process.exit(1);
  }
}
