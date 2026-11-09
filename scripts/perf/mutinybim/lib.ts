/**
 * Shared pieces of the MutinyBIM performance gate: sample statistics, the run
 * context (hardware, cache, network, participants, workload), the result
 * shape every suite emits, and budget + regression evaluation.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";

// Every suite runs as a host: the kernel carries no trade, so the first-party add-ons are installed before any model is read.
installFirstPartyAddOns();

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const BUDGETS_FILE = path.join(REPO_ROOT, "docs/perf/mutinybim-budgets.json");
export const BASELINE_DIR = path.join(REPO_ROOT, "scripts/perf/mutinybim/baselines");

// ------------------------------------------------------------------ samples

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[rank] ?? null;
}

export function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

export interface Summary {
  readonly p50: number;
  readonly p95: number;
  readonly n: number;
}

export function summarize(values: readonly number[]): Summary | null {
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  if (p50 === null || p95 === null) return null;
  return { p50: round(p50), p95: round(p95), n: values.length };
}

/** Median-of-N across runs: p50 = median of run p50s, p95 = median of run p95s (one sample per run: nearest-rank p95 of the runs). */
export function combineRuns(perRun: readonly Summary[]): Summary | null {
  if (perRun.length === 0) return null;
  if (perRun.every((s) => s.n === 1)) return summarize(perRun.map((s) => s.p50));
  const p50 = percentile(
    perRun.map((s) => s.p50),
    0.5,
  );
  const p95 = percentile(
    perRun.map((s) => s.p95),
    0.5,
  );
  if (p50 === null || p95 === null) return null;
  return { p50: round(p50), p95: round(p95), n: perRun.reduce((a, s) => a + s.n, 0) };
}

export function timeSync<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

export function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
}

export function memoryMB(): { rss: number; heap: number } {
  gc();
  const m = process.memoryUsage();
  return { rss: round(m.rss / 1e6, 1), heap: round(m.heapUsed / 1e6, 1) };
}

// ------------------------------------------------------------------ context

export interface Hardware {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGB: number;
  readonly freeMemoryGB: number;
  readonly loadAvg1m: number;
  readonly platform: string;
  readonly node: string;
  /** Stable slug used to match baselines: same class, comparable numbers. */
  readonly hardwareClass: string;
  readonly noisy: boolean;
}

/** Reclaimable memory. On macOS os.freemem() counts only never-used pages, so read free + inactive + speculative from vm_stat. */
function availableMemoryBytes(): number {
  if (os.platform() !== "darwin") return os.freemem();
  try {
    const text = execFileSync("vm_stat", { encoding: "utf8" });
    const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
    const pages = (label: string): number => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
    return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * pageSize;
  } catch (err) {
    console.error("[perf] vm_stat failed; using os.freemem()", err);
    return os.freemem();
  }
}

export function hardware(): Hardware {
  const cpu = os.cpus()[0]?.model ?? "unknown";
  const cores = os.cpus().length;
  const memoryGB = round(os.totalmem() / 2 ** 30, 0);
  const freeMemoryGB = round(availableMemoryBytes() / 2 ** 30, 1);
  const loadAvg1m = round(os.loadavg()[0] ?? 0, 2);
  const runner = process.env.GITHUB_ACTIONS === "true" ? `gha-${process.env.RUNNER_OS ?? "unknown"}-` : "";
  const hardwareClass = `${runner}${cpu}-${cores}c-${memoryGB}g`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    cpu,
    cores,
    memoryGB,
    freeMemoryGB,
    loadAvg1m,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    hardwareClass,
    noisy: loadAvg1m > cores * 0.75 || freeMemoryGB < 4,
  };
}

export interface GitInfo {
  readonly sha: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export function gitInfo(): GitInfo {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    } catch (err) {
      console.error("[perf] git read failed", { args, err });
      return "unknown";
    }
  };
  return { sha: run(["rev-parse", "HEAD"]), branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: run(["status", "--porcelain"]) !== "" };
}

// ------------------------------------------------------------------ results

/** What a metric value was measured on, so totals / subscribed / visible / affected are never conflated. */
export interface Counts {
  readonly totalElements?: number;
  readonly subscribedElements?: number;
  readonly visibleSolids?: number;
  readonly visibleTriangles?: number;
  readonly networkElements?: number;
  readonly affectedElements?: number;
  readonly solidsRebuilt?: number;
  readonly bytes?: number;
  readonly landedElements?: number;
  readonly acceptedRecords?: number;
  readonly differences?: number;
}

export interface Sample {
  readonly metric: string;
  /** Distinguishes rows of one metric within a run (e.g. the host vs the linked model); each row meets the budget on its own. */
  readonly variant?: string;
  readonly values: number[];
  readonly counts?: Counts;
  readonly note?: string;
}

export interface SuiteOutput {
  readonly suite: "synthetic" | "reference" | "browser" | "remote" | "parameters" | "sheets" | "parts" | "calc" | "electrical" | "plumbing" | "lint" | "schedules" | "grid" | "batch" | "findings";
  readonly workload: Record<string, unknown>;
  readonly network: string;
  readonly participants: number;
  readonly samples: Sample[];
  /** Structural facts checked against `invariants` (exact, not timed). */
  readonly invariants?: Record<string, number>;
  readonly info?: Record<string, unknown>;
}

export const RESULT_PREFIX = "@@perf-result ";

/** Children print exactly one line with this prefix; the orchestrator ignores everything else. */
export function emit(out: SuiteOutput): void {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(out)}\n`);
}

// ------------------------------------------------------------------ budgets

export type Unit = "ms" | "us" | "ns" | "frameMs" | "MB" | "KB" | "count" | "ratio";

export interface MetricBudget {
  readonly label: string;
  readonly unit: Unit;
  readonly scope: string;
  readonly cache: "cold" | "warm";
  readonly p50: number;
  readonly p95: number;
  readonly status: "active" | "pending";
  readonly measures?: string;
  readonly appliesTo?: string;
  /** Set to 1 when the budget already describes the CI runner (it is then not multiplied by `ci.budgetFactor`). */
  readonly ciBudgetFactor?: 1;
}

export interface Tolerance {
  readonly rel: { readonly p50: number; readonly p95: number };
  readonly absFloor: number;
}

export interface Budgets {
  readonly regression: { readonly minRuns: number; readonly defaults: Partial<Record<Unit, Tolerance>> };
  readonly ci: { readonly tier: string; readonly runs: number; readonly budgetFactor: number };
  readonly metrics: Record<string, MetricBudget & { readonly tolerance?: Tolerance }>;
  readonly invariants: Record<string, { readonly label: string; readonly max: number; readonly minTier?: string }>;
  /**
   * Per tier: metric rows (metric or metric|variant) already over budget at the last
   * recorded baseline. Reported, not blocking in CI; a listed row that passes must be removed.
   * The checkpoint run treats every absolute failure as blocking regardless.
   */
  readonly knownBudgetFailures?: Record<string, readonly string[]>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadBudgets(file = BUDGETS_FILE): Budgets {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.metrics) || !isRecord(parsed.invariants) || !isRecord(parsed.regression) || !isRecord(parsed.ci)) {
    throw new Error(`${file} is not a budgets file (metrics / invariants / regression / ci missing)`);
  }
  for (const [id, m] of Object.entries(parsed.metrics)) {
    if (!isRecord(m) || typeof m.p50 !== "number" || typeof m.p95 !== "number" || typeof m.unit !== "string") {
      throw new Error(`${file}: metric ${id} needs numeric p50 / p95 and a unit`);
    }
  }
  // Shape checked above; the remaining fields are documented strings.
  const budgets = parsed as unknown as Budgets;
  const missing = metricsWithoutTolerance(budgets);
  if (missing.length > 0) {
    throw new Error(`${file}: no regression tolerance for ${missing.join(", ")}: give each a tolerance, or its unit a default under regression.defaults`);
  }
  return budgets;
}

/** Metrics (as "id (unit u)") that have neither their own tolerance nor a default for their unit. */
export function metricsWithoutTolerance(budgets: Budgets): string[] {
  return Object.entries(budgets.metrics)
    .filter(([, m]) => !m.tolerance && !budgets.regression.defaults[m.unit])
    .map(([id, m]) => `${id} (unit ${m.unit})`);
}

export type Verdict = "PASS" | "FAIL" | "PENDING" | "NOT-RUN";
export type RegressionVerdict = "OK" | "REGRESSED" | "IMPROVED" | "NO-BASELINE";

export interface MetricResult {
  readonly metric: string;
  readonly label: string;
  readonly unit: Unit;
  readonly scope: string;
  readonly cache: string;
  readonly current: Summary | null;
  readonly budget: { readonly p50: number; readonly p95: number };
  readonly verdict: Verdict;
  readonly regression: RegressionVerdict;
  readonly baseline: Summary | null;
  readonly counts?: Counts;
  readonly note?: string;
}

export function toleranceFor(budgets: Budgets, metric: string): Tolerance {
  const m = budgets.metrics[metric];
  if (!m) throw new Error(`no budget for ${metric}`);
  const tolerance = m.tolerance ?? budgets.regression.defaults[m.unit];
  if (!tolerance) throw new Error(`no regression tolerance for ${metric} (unit ${m.unit}): give it a tolerance, or its unit a default, in docs/perf/mutinybim-budgets.json`);
  return tolerance;
}

export function regressionVerdict(current: Summary, baseline: Summary | null, tol: Tolerance): RegressionVerdict {
  if (!baseline) return "NO-BASELINE";
  const worse = (cur: number, base: number, rel: number) => cur - base > tol.absFloor && cur > base * (1 + rel);
  const better = (cur: number, base: number, rel: number) => base - cur > tol.absFloor && cur < base * (1 - rel);
  if (worse(current.p50, baseline.p50, tol.rel.p50) || worse(current.p95, baseline.p95, tol.rel.p95)) return "REGRESSED";
  if (better(current.p50, baseline.p50, tol.rel.p50) && !worse(current.p95, baseline.p95, tol.rel.p95)) return "IMPROVED";
  return "OK";
}

export function absoluteVerdict(current: Summary, budget: { p50: number; p95: number }): Verdict {
  return current.p50 <= budget.p50 && current.p95 <= budget.p95 ? "PASS" : "FAIL";
}
