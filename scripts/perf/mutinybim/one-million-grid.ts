/**
 * The rest of the 1M column of the perf grid, in one run (round 16 "catch up
 * the 1M-element grid"). The 1M checkpoint (`npm run perf:bim:checkpoint`)
 * measures the runner's own suites. The rows below come from standalone
 * scripts and opt-in perf tests that each lane measured at 250k and left
 * "1M not run (swap)": nothing ran them at 1M, so they stayed pending.
 *
 * Each row is judged against its budget in docs/perf/mutinybim-budgets.json
 * (never changed here). The report lists every row: within budget, over, or
 * not produced. Over or not produced exits 1. A row measured within budget
 * can then be switched to "active" by hand, with the run's numbers.
 *
 *   node --import tsx scripts/perf/mutinybim/one-million-grid.ts [--out=<dir>] [--only=<step,…>] [--tier=XS|250k]
 *
 * `--tier` reruns the steps that take one at a smaller size (a smoke check of
 * this runner on a laptop); its rows have no budget there and say so.
 * 1M needs about 12 GB of heap per step: the on-request GitHub job
 * (`ci.yml` bim-perf-1m), or a laptop through the shared stack's heavy lock.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, RESULT_PREFIX, loadBudgets, percentile, round, type SuiteOutput } from "./lib";

const HEAP_1M_MB = 12_288;

export interface Measured {
  readonly p50: number;
  readonly p95: number;
  /** A metric measured more than once in a run (branch.fork at the head and a version back): each meets the budget. */
  readonly variant?: string;
}

interface StepBase {
  readonly id: string;
  /** What it measures, in words, for the report. */
  readonly label: string;
}

/** A script that prints the runner's result line (`emit`); its metric names carry no tier. */
export interface EmitStep extends StepBase {
  readonly kind: "emit";
  readonly script: string;
  readonly args: readonly string[];
  readonly rows: readonly { readonly row: string; readonly metric: string }[];
}

/** A script that prints one JSON object keyed by row (`{ "<row>": { p50, p95, … } }`). Takes the tier as its first argument. */
export interface JsonStep extends StepBase {
  readonly kind: "json";
  readonly script: string;
  readonly rows: readonly string[];
}

/** An opt-in perf test that prints its timings to stderr; `pattern` captures p50 and p95. */
export interface JestStep extends StepBase {
  readonly kind: "jest";
  readonly testFile: string;
  readonly env: Readonly<Record<string, string>>;
  readonly rows: readonly { readonly row: string; readonly pattern: RegExp }[];
}

export type GridStep = EmitStep | JsonStep | JestStep;

export const ONE_MILLION_STEPS: readonly GridStep[] = [
  { id: "branch-fork", kind: "emit", label: "Branches: fork and reads at a version", script: "branch-fork.ts", args: ["--elements=1000000"], rows: [{ row: "branch.fork.1M", metric: "branch.fork" }, { row: "branch.state_at.2k_ids.1M", metric: "branch.state_at.2k_ids" }] },
  { id: "lineages", kind: "emit", label: "Copies: fork and compare a diverged copy", script: "lineages.ts", args: ["--elements=1000000"], rows: [{ row: "lineage.fork.1m", metric: "lineage.fork" }, { row: "lineage.compare.1m.diverged_10", metric: "lineage.compare.diverged_10" }] },
  { id: "scripts", kind: "json", label: "Scripts: check a 500-step output", script: "scripts.ts", rows: ["script.check.500_steps.1M"] },
  { id: "m15-size-system", kind: "json", label: "Size an air system", script: "m15-size-system.ts", rows: ["mechanical.size_system.1M"] },
  { id: "e15-live-circuits", kind: "json", label: "Live plan redraw with circuits", script: "e15-live-circuits.ts", rows: ["viewer.live_plan.view_graphics.1M"] },
  { id: "n15-plan-near-miss", kind: "json", label: "Plan hover near misses", script: "n15-plan-near-miss.ts", rows: ["viewer.plan_near_miss.1M", "viewer.plan_near_miss.sync_one_edit.1M"] },
  { id: "k15-batch-edits", kind: "json", label: "Batches of 10 and 50 edits", script: "k15-batch-edits.ts", rows: ["kernel.batch_edits.10.1M", "kernel.batch_edits.50.1M"] },
  { id: "b16-plan-view-range", kind: "json", label: "A plan showing other levels", script: "b16-plan-view-range.ts", rows: ["drawing.plan.other_levels.1M"] },
  { id: "a15-walls-openings", kind: "json", label: "Door and window bodies", script: "a15-walls-openings.ts", rows: ["viewer.opening.body.build.1M"] },
  { id: "wall-surface-follow", kind: "json", label: "Walls follow a floor run to the structure above", script: "wall-surface-follow.ts", rows: ["arch.wall.surface_follow.1M"] },
  { id: "o8-delta", kind: "jest", label: "Quantity change between two revisions", testFile: "packages/bim-kernel/__tests__/o8-delta-perf.test.ts", env: { O8_PERF: "1", O8_PERF_SCALE: "1M" }, rows: [{ row: "qto.delta.revision_pair.1M", pattern: /\[o8-delta-perf\] 1M [^\n]*p50=([\d.]+)ms p95=([\d.]+)ms/ }] },
  { id: "n8-sensitivity", kind: "jest", label: "What drives the most, after one edit", testFile: "packages/bim-kernel/__tests__/n8-sensitivity-perf.test.ts", env: { N8_PERF_ROWS: "2176" }, rows: [{ row: "requirements.graph.sensitivity.1M", pattern: /\[n8 sensitivity\][^\n]*after one edit p50 ([\d.]+) \/ p95 ([\d.]+) ms/ }] },
  { id: "g11-gates", kind: "jest", label: "Freeze a stage at a repeat revision", testFile: "scripts/perf/mutinybim/__tests__/g11-perf.test.ts", env: { G11_PERF: "1", G11_PERF_ROWS: "2176" }, rows: [{ row: "gate.freeze.1M", pattern: /\[g11 gate\.freeze\][^\n]*again on the same records p50 ([\d.]+) \/ p95 ([\d.]+) ms/ }] },
];

/** Pending 1M rows another step of the on-request job already measures (`ci.yml` bim-perf-1m), by that step's name. */
export const MEASURED_BY_OTHER_JOB_STEPS: Readonly<Record<string, string>> = {
  "validate.addon_switch.first_edit_after_reopen.1M": "Reopen after an add-on switch, 1M",
  "memory.server.rss.two_copies.1M": "Memory probe, two copies open, 1M",
};

/** Pending 1M rows whose measuring code has no 1M mode yet, and the work that gives it one. */
export const NO_ONE_MILLION_MODE: Readonly<Record<string, string>> = {
  "questions.register.1M": "questions-index.ts builds only the synthetic 14-storey tower: give it --elements (as branch-fork.ts has) so the register is read on a 1M model.",
  "submittal.depends_on.one_type.1M": "submittals.ts runs on synthetic-250k only: give it --elements so the same reads run on a 1M model.",
  "cost.price_takeoff.1M": "q7-qto-perf.test.ts prices only the 250k model: add a 1M case behind an env flag, as o8-delta-perf.test.ts has.",
};

const TIER_ROW = /\.(1M|1m)(?=\.|$)/;

/** The row a step produces at another tier (a smoke run): `mechanical.size_system.1M` → `mechanical.size_system.XS`. */
export function rowAtTier(row: string, tier: string): string {
  return tier === "1M" ? row : row.replace(TIER_ROW, `.${tier}`);
}

function stats(values: readonly number[]): { p50: number; p95: number } | null {
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  return p50 === null || p95 === null ? null : { p50: round(p50, 3), p95: round(p95, 3) };
}

/** Rows from an `emit` script's stdout. */
export function readEmit(stdout: string, rows: EmitStep["rows"]): Map<string, Measured[]> {
  const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
  const out = new Map<string, Measured[]>();
  if (!line) return out;
  const result = JSON.parse(line.slice(RESULT_PREFIX.length)) as SuiteOutput;
  for (const { row, metric } of rows) {
    const found = result.samples
      .filter((s) => s.metric === metric)
      .flatMap((s) => {
        const st = stats(s.values);
        return st ? [{ ...st, ...(s.variant ? { variant: s.variant } : {}) }] : [];
      });
    if (found.length > 0) out.set(row, found);
  }
  return out;
}

/** Rows from a JSON script's stdout (its last line that is a JSON object). */
export function readJson(stdout: string, rows: readonly string[]): Map<string, Measured[]> {
  const out = new Map<string, Measured[]>();
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return out;
  const parsed = JSON.parse(line) as Record<string, { p50?: unknown; p95?: unknown } | undefined>;
  for (const row of rows) {
    const v = parsed[row];
    if (v && typeof v.p50 === "number" && typeof v.p95 === "number") out.set(row, [{ p50: v.p50, p95: v.p95 }]);
  }
  return out;
}

/** Rows from a perf test's stderr. */
export function readJestStderr(stderr: string, rows: JestStep["rows"]): Map<string, Measured[]> {
  const out = new Map<string, Measured[]>();
  for (const { row, pattern } of rows) {
    const m = pattern.exec(stderr);
    if (m?.[1] && m[2]) out.set(row, [{ p50: Number(m[1]), p95: Number(m[2]) }]);
  }
  return out;
}

export interface RowBudget {
  readonly p50: number;
  readonly p95: number;
}

export type Verdict =
  | { readonly row: string; readonly status: "within"; readonly measured: readonly Measured[]; readonly budget: RowBudget }
  | { readonly row: string; readonly status: "over"; readonly measured: readonly Measured[]; readonly budget: RowBudget }
  | { readonly row: string; readonly status: "not_produced"; readonly why: string }
  | { readonly row: string; readonly status: "no_budget"; readonly measured: readonly Measured[] };

/** One row against its budget: every variant within both p50 and p95. */
export function judge(row: string, measured: readonly Measured[] | undefined, budget: RowBudget | undefined, whyMissing: string): Verdict {
  if (!measured || measured.length === 0) return { row, status: "not_produced", why: whyMissing };
  if (!budget) return { row, status: "no_budget", measured };
  const over = measured.some((m) => m.p50 > budget.p50 || m.p95 > budget.p95);
  return { row, status: over ? "over" : "within", measured, budget };
}

/** Steps that take a tier argument run at a smaller one for a smoke check; the others need 1M. */
function runsAt(step: GridStep, tier: string): boolean {
  return tier === "1M" || step.kind === "json";
}

function command(step: GridStep, tier: string): { readonly cmd: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } {
  const heap = `--max-old-space-size=${HEAP_1M_MB}`;
  if (step.kind === "jest") return { cmd: "npx", args: ["jest", "--maxWorkers=1", "--runInBand", step.testFile], env: { ...process.env, ...step.env, NODE_OPTIONS: heap } };
  const script = path.join("scripts/perf/mutinybim", step.script);
  const args = step.kind === "json" ? [tier] : step.args;
  return { cmd: process.execPath, args: ["--expose-gc", heap, "--import", "tsx", script, ...args], env: process.env };
}

function run(step: GridStep, tier: string): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const { cmd, args, env } = command(step, tier);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      process.stderr.write(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rowsOf(step: GridStep): readonly string[] {
  return step.kind === "json" ? step.rows : step.rows.map((r) => r.row);
}

function words(v: Verdict): string {
  const m = "measured" in v ? v.measured.map((x) => `${x.variant ? `${x.variant} ` : ""}${x.p50} / ${x.p95}`).join(", ") : "";
  switch (v.status) {
    case "within":
      return `within budget: ${m} ms (budget ${v.budget.p50} / ${v.budget.p95})`;
    case "over":
      return `OVER budget: ${m} ms (budget ${v.budget.p50} / ${v.budget.p95})`;
    case "no_budget":
      return `measured ${m} (no budget at this size)`;
    case "not_produced":
      return `NOT PRODUCED: ${v.why}`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const tier = arg("tier") ?? "1M";
  const only = arg("only")?.split(",");
  const outDir = path.resolve(arg("out") ?? path.join(REPO_ROOT, ".perf-results/mutinybim/1m-grid"));
  const budgets: Readonly<Record<string, RowBudget | undefined>> = loadBudgets().metrics;
  console.log(`[perf/1m-grid] starting: tier ${tier}, ${only ? `steps ${only.join(",")}` : "every step"}`);
  const verdicts: Verdict[] = [];
  const skipped: string[] = [];
  for (const step of ONE_MILLION_STEPS) {
    if (only && !only.includes(step.id)) continue;
    if (!runsAt(step, tier)) {
      skipped.push(`${step.id} (needs 1M)`);
      continue;
    }
    const t0 = performance.now();
    const res = await run(step, tier).catch((err: unknown) => {
      console.error(`[perf/1m-grid] ${step.id} could not start`, err);
      return { code: -1, stdout: "", stderr: String(err) };
    });
    const measured = step.kind === "emit" ? readEmit(res.stdout, step.rows) : step.kind === "json" ? readJson(res.stdout, step.rows.map((r) => rowAtTier(r, tier))) : readJestStderr(res.stderr, step.rows);
    const why = res.code === 0 ? `${step.id} ran but printed no ${tier} numbers for it` : `${step.id} exited ${res.code}`;
    for (const row of rowsOf(step)) {
      const at = step.kind === "json" ? rowAtTier(row, tier) : row;
      verdicts.push(judge(at, measured.get(at), budgets[at], why));
    }
    console.log(`[perf/1m-grid] ${step.id} done in ${round((performance.now() - t0) / 1000, 1)} s`);
  }
  const lines = [`# The rest of the 1M grid (${tier})`, "", ...verdicts.map((v) => `- \`${v.row}\`: ${words(v)}`)];
  if (skipped.length > 0) lines.push("", `Not run at ${tier}: ${skipped.join(", ")}.`);
  lines.push("", "Measured by other steps of this job:", ...Object.entries(MEASURED_BY_OTHER_JOB_STEPS).map(([row, s]) => `- \`${row}\`: "${s}"`));
  lines.push("", "No 1M mode yet (not measured by this run):", ...Object.entries(NO_ONE_MILLION_MODE).map(([row, why]) => `- \`${row}\`: ${why}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(outDir, "verdicts.json"), `${JSON.stringify({ tier, verdicts }, null, 2)}\n`);
  console.log(lines.join("\n"));
  const failed = verdicts.filter((v) => v.status === "over" || v.status === "not_produced");
  console.log(`[perf/1m-grid] completed: ${verdicts.length} rows, ${failed.length} over budget or not produced; report ${path.relative(REPO_ROOT, outDir)}/report.md`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("[perf/1m-grid] failed", err);
    process.exit(1);
  });
}
