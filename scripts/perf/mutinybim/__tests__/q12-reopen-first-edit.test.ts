/**
 * @jest-environment node
 *
 * Round 12 owed / round 14 Q14: the first edit after an add-on switch and a
 * reopen from stored rows re-uses the kept checks (no whole-model check) and
 * stays inside `validate.addon_switch.first_edit_after_reopen` (250k) /
 * `.1M` (500 / 1000 ms). Round 12 measured 611–713 ms at 1M before the fix.
 *
 * The harness runs in a child process, as the perf gate runs it. Without
 * Q12_PERF a small building checks the behaviour only (adopted, no whole
 * check). Q12_PERF=1 runs Q12_PERF_SCALE (250k, default; or 1M) and holds
 * the budget row: through the shared stack's heavy lock, or the dispatch-only
 * bim-perf-1m CI job.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(ROOT, "scripts/perf/mutinybim/addon-switch-reopen.ts");
const PERF = process.env.Q12_PERF === "1";
const SCALE = process.env.Q12_PERF_SCALE === "1M" ? "1M" : "250k";

interface Sample {
  readonly switched: string;
  readonly ms: number;
  readonly wholeModelChecks: number;
  readonly adopted: number;
}
interface Results {
  readonly budget: { readonly p50: number; readonly p95: number };
  readonly report: { readonly metric: string; readonly p50: number; readonly p95: number; readonly samples: readonly Sample[] };
  readonly problems: readonly string[];
}

function isResults(value: unknown): value is Results {
  if (typeof value !== "object" || value === null) return false;
  return "budget" in value && "report" in value && "problems" in value && Array.isArray(value.problems);
}

function runHarness(tier: string, samples: number, enforce: boolean): { readonly status: number | null; readonly results: Results; readonly log: string } {
  const out = mkdtempSync(path.join(tmpdir(), "q12-reopen-"));
  const heap = tier === "1M" ? 12288 : 4096;
  const child = spawnSync(process.execPath, ["--expose-gc", `--max-old-space-size=${heap}`, "--import", "tsx", SCRIPT, `--tier=${tier}`, `--samples=${samples}`, `--out=${out}`, ...(enforce ? ["--enforce"] : [])], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 1_500_000,
  });
  const log = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const parsed: unknown = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
  if (!isResults(parsed)) throw new Error(`the reopen harness wrote no results:\n${log}`);
  return { status: child.status, results: parsed, log };
}

describe("q12-reopen-first-edit", () => {
  it("re-uses the kept checks after a switch and a reopen (small building)", () => {
    const { status, results, log } = runHarness("XS", 4, true);
    expect(results.problems).toEqual([]);
    expect(results.report.samples.map((s) => s.switched)).toEqual(["on", "off", "on", "off"]);
    for (const s of results.report.samples) {
      expect(s.adopted).toBeGreaterThan(0);
      expect(s.wholeModelChecks).toBe(0);
    }
    if (status !== 0) throw new Error(`the reopen harness exited ${status}:\n${log}`);
  }, 120_000);

  (PERF ? it : it.skip)(`holds the first edit after reopen at ${SCALE} to its budget`, () => {
    const { status, results, log } = runHarness(SCALE, SCALE === "1M" ? 4 : 6, true);
    expect(results.report.metric).toBe(SCALE === "1M" ? "validate.addon_switch.first_edit_after_reopen.1M" : "validate.addon_switch.first_edit_after_reopen");
    expect(results.problems).toEqual([]);
    expect(results.report.p50).toBeLessThanOrEqual(results.budget.p50);
    expect(results.report.p95).toBeLessThanOrEqual(results.budget.p95);
    if (status !== 0) throw new Error(`the reopen harness exited ${status}:\n${log}`);
  }, 1_800_000);
});
