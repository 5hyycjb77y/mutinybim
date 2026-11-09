/**
 * @jest-environment node
 *
 * Catching up the 1M grid (round 16): one on-request run measures every
 * pending 1M row. The runner's own checkpoint covers its suites; the rows
 * round 15 lanes measured with standalone scripts and opt-in tests ("1M not
 * run, swap") are run by `one-million-grid.ts`, which the on-request job
 * calls. Each is judged against its budget, unchanged.
 *
 * Fails on the previous code: no step ran those scripts at 1M, so the 1M
 * dispatch left them pending with nothing saying so.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, RESULT_PREFIX, loadBudgets } from "../lib";
import { MEASURED_BY_OTHER_JOB_STEPS, NO_ONE_MILLION_MODE, ONE_MILLION_STEPS, judge, readEmit, readJestStderr, readJson, rowAtTier } from "../one-million-grid";

const ONE_MILLION_ROW = /\.(1M|1m)(?=\.|$)/;
const stepRows = ONE_MILLION_STEPS.flatMap((s) => (s.kind === "json" ? s.rows : s.rows.map((r) => r.row)));

describe("s6d: the rest of the 1M grid in one run", () => {
  it("every pending 1M row is measured by a step, by another step of the 1M job, or named with the work it still needs", () => {
    const metrics = loadBudgets().metrics;
    const pending = Object.entries(metrics)
      .filter(([key, m]) => ONE_MILLION_ROW.test(key) && (m as { status?: string }).status === "pending")
      .map(([key]) => key);
    expect(pending.length).toBeGreaterThan(0);
    const accounted = [...stepRows, ...Object.keys(MEASURED_BY_OTHER_JOB_STEPS), ...Object.keys(NO_ONE_MILLION_MODE)];
    expect(pending.filter((k) => !accounted.includes(k))).toEqual([]);
    // Each row in one place only, and every row named is a real budget row.
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(accounted.filter((k) => !(k in metrics))).toEqual([]);
  })

  it("every step's script or test is there, and the on-request 1M job runs the grid and the steps it is said to", () => {
    for (const step of ONE_MILLION_STEPS) {
      const file = step.kind === "jest" ? step.testFile : path.join("scripts/perf/mutinybim", step.script);
      expect(existsSync(path.join(REPO_ROOT, file))).toBe(true);
    }
    const ci = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("\n  bim-perf-1m:"));
    expect(job).toMatch(/scripts\/perf\/mutinybim\/one-million-grid\.ts --out=\$OUT\/grid/);
    for (const name of Object.values(MEASURED_BY_OTHER_JOB_STEPS)) expect(job).toContain(`name: ${name}`);
  })

  it("reads each kind of output: the runner's result line, a JSON row object, a perf test's stderr", () => {
    const emitted = `${RESULT_PREFIX}${JSON.stringify({ suite: "batch", workload: {}, network: "none", participants: 1, samples: [{ metric: "branch.fork", variant: "head", values: [1, 2, 3] }, { metric: "branch.fork", variant: "version", values: [10, 20, 30] }] })}\n`;
    expect(readEmit(emitted, [{ row: "branch.fork.1M", metric: "branch.fork" }]).get("branch.fork.1M")?.map((m) => m.variant)).toEqual(["head", "version"]);
    expect(readJson('noise\n{"mechanical.size_system.1M":{"p50":12.5,"p95":20,"runs":4}}\n', ["mechanical.size_system.1M"]).get("mechanical.size_system.1M")).toEqual([{ p50: 12.5, p95: 20 }]);
    const o8 = ONE_MILLION_STEPS.find((s) => s.id === "o8-delta");
    if (o8?.kind !== "jest") throw new Error("no o8 step");
    expect(readJestStderr("[o8-delta-perf] 1M elements=996856 changed=2000 p50=9.6ms p95=13.5ms\n", o8.rows).get("qto.delta.revision_pair.1M")).toEqual([{ p50: 9.6, p95: 13.5 }]);
    const g11 = ONE_MILLION_STEPS.find((s) => s.id === "g11-gates");
    if (g11?.kind !== "jest") throw new Error("no g11 step");
    expect(readJestStderr("[g11 gate.freeze] 998000 elements, 9 lines; first freeze (every record hashed) 20600 ms; again on the same records p50 4100 / p95 4600 ms; with a host checkpoint digest p50 1400 / p95 1500 ms\n", g11.rows).get("gate.freeze.1M")).toEqual([{ p50: 4100, p95: 4600 }]);
  })

  it("judges a row on every variant against its budget, and says when a row wasn't produced", () => {
    const budget = { p50: 10, p95: 20 };
    expect(judge("r.1M", [{ p50: 5, p95: 9 }], budget, "").status).toBe("within");
    expect(judge("r.1M", [{ p50: 5, p95: 9, variant: "head" }, { p50: 11, p95: 15, variant: "version" }], budget, "").status).toBe("over");
    expect(judge("r.1M", undefined, budget, "m15-size-system exited 1")).toEqual({ row: "r.1M", status: "not_produced", why: "m15-size-system exited 1" });
    expect(judge("r.XS", [{ p50: 1, p95: 2 }], undefined, "").status).toBe("no_budget");
  })

  it("a smoke run at a smaller size names its rows at that size", () => {
    expect(rowAtTier("mechanical.size_system.1M", "XS")).toBe("mechanical.size_system.XS");
    expect(rowAtTier("kernel.batch_edits.10.1M", "250k")).toBe("kernel.batch_edits.10.250k");
    expect(rowAtTier("lineage.compare.1m.diverged_10", "1M")).toBe("lineage.compare.1m.diverged_10");
  })
})
