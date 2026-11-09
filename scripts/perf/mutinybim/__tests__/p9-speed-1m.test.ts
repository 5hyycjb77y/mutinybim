/**
 * @jest-environment node
 *
 * Round 9 P9: the four 1M rows that were red on main, each measured by its
 * own harness in a child process (as the gate runs them) and held to its
 * budget in docs/perf/mutinybim-budgets.json. Before round 9 (8b's code, a
 * quiet M5 Max): lint.advance.50 5.78 ms, lint.block.build 1.58 ms,
 * lint.memory.index 52.7 MB, requirements.engine.cold 361 ms; all four over.
 *
 * P9_PERF=1 runs it (two 1M models; a few minutes). Run it through the shared
 * run lock, on a machine with nothing else heavy running.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const run = process.env.P9_PERF === "1" ? describe : describe.skip;
const ROOT = path.resolve(__dirname, "../../../..");
const HARNESS = path.join(ROOT, "scripts/perf/mutinybim");

interface Budget {
  readonly p50: number;
  readonly p95: number;
}
interface SuiteSample {
  readonly metric: string;
  readonly values: readonly number[];
}

function budgets(): Record<string, Budget> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(ROOT, "docs/perf/mutinybim-budgets.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("metrics" in parsed)) throw new Error("budgets file has no metrics");
  const metrics: unknown = parsed.metrics;
  if (typeof metrics !== "object" || metrics === null) throw new Error("budgets file metrics is not an object");
  const out: Record<string, Budget> = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === "object" && v !== null && "p50" in v && "p95" in v && typeof v.p50 === "number" && typeof v.p95 === "number") out[k] = { p50: v.p50, p95: v.p95 };
  }
  return out;
}

function isSample(v: unknown): v is SuiteSample {
  return typeof v === "object" && v !== null && "metric" in v && typeof v.metric === "string" && "values" in v && Array.isArray(v.values) && v.values.every((x: unknown) => typeof x === "number");
}

/** Runs one harness at 1M and returns its samples by metric. */
function harness(script: string): Map<string, readonly number[]> {
  const res = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=12288", "--import", "tsx", path.join(HARNESS, script), "--tier=1M"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`[p9] ${script} exited ${res.status ?? res.signal}: ${res.stderr.slice(-2000)}`);
  const line = res.stdout.split("\n").find((l) => l.startsWith("@@perf-result "));
  if (!line) throw new Error(`[p9] ${script} printed no @@perf-result line`);
  const parsed: unknown = JSON.parse(line.slice("@@perf-result ".length));
  if (typeof parsed !== "object" || parsed === null || !("samples" in parsed) || !Array.isArray(parsed.samples)) throw new Error(`[p9] ${script}: no samples`);
  const out = new Map<string, readonly number[]>();
  for (const s of parsed.samples) if (isSample(s)) out.set(s.metric, s.values);
  return out;
}

/** Nearest-rank percentile, as lib.ts computes it. */
function pct(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? Number.NaN;
}

function expectWithin(metric: string, values: readonly number[] | undefined, budget: Budget | undefined): void {
  if (!values || values.length === 0) throw new Error(`[p9] ${metric}: the harness reported no values`);
  if (!budget) throw new Error(`[p9] ${metric}: no budget row`);
  const p50 = pct(values, 0.5);
  const p95 = pct(values, 0.95);
  process.stderr.write(`[p9 ${metric} 1M] p50 ${p50.toFixed(2)} p95 ${p95.toFixed(2)} (budget ${budget.p50} / ${budget.p95})\n`);
  expect(p50).toBeLessThanOrEqual(budget.p50);
  expect(p95).toBeLessThanOrEqual(budget.p95);
}

run("p9: the four 1M rows inside their budgets", () => {
  const b = budgets();
  let lint: Map<string, readonly number[]> | null = null;
  const lintSamples = () => (lint ??= harness("lint.ts"));

  it("p9-lint-advance-1m: lint.advance.50", () => {
    expectWithin("lint.advance.50", lintSamples().get("lint.advance.50"), b["lint.advance.50"]);
  }, 600_000);

  it("p9-lint-block-build-1m: lint.block.build", () => {
    expectWithin("lint.block.build", lintSamples().get("lint.block.build"), b["lint.block.build"]);
  }, 600_000);

  it("p9-lint-index-memory-1m: lint.memory.index", () => {
    expectWithin("lint.memory.index", lintSamples().get("lint.memory.index"), b["lint.memory.index"]);
    // The index cold build moved to a bulk load; it must stay inside its own row.
    expectWithin("lint.index.cold", lintSamples().get("lint.index.cold"), b["lint.index.cold"]);
  }, 600_000);

  it("p9-requirements-cold-1m: requirements.engine.cold", () => {
    expectWithin("requirements.engine.cold", harness("requirements-engine.ts").get("requirements.engine.cold"), b["requirements.engine.cold"]);
  }, 600_000);
});
