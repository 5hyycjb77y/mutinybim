/**
 * @jest-environment node
 *
 * Round 11 A11 perf row `library.install.verify.one_package` (D5): one signed
 * package with a 50-class data add-on through the whole install gate
 * (manifest, hashes, signature, licence, tier, namespace, conformance)
 * within 200 ms p50. Behind A11_PERF=1. Measured in a plain Node process
 * (`scripts/perf/mutinybim/outside-packs.ts verify`), like the other perf
 * rows: Jest's transformed modules run the conformance suite's registry
 * builds about 30 times slower than the code a host runs.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const run = process.env.A11_PERF === "1" ? it : it.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";
const ROOT = path.resolve(__dirname, "../../..");

describe("a11 perf", () => {
  run(
    "verifies a 50-class package within 200 ms p50",
    () => {
      const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/perf/mutinybim/outside-packs.ts", "250k", "verify"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
      const line = out.trim().split("\n").pop() ?? "{}";
      const row = (JSON.parse(line) as Record<string, { p50: number; p95: number }>)["library.install.verify.one_package"];
      expect(row).toBeDefined();
      if (ABSOLUTE_BUDGETS) expect(row?.p50).toBeLessThanOrEqual(200);
    },
    150_000,
  );
});
