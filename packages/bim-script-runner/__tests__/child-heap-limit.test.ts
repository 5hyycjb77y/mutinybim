/**
 * @jest-environment node
 *
 * The child's heap limit stays inside the supervisor's allowance on every
 * Node the runner ships on. Node 24's larger default semi-space made a
 * 1024 MB child report 1120 MB on the sealed machine, so every script run was
 * refused as "heap limit 1120 MB, over the 1024 MB cap".
 *
 * Fails on the old flags: this test starts node with a Node 24-sized
 * semi-space ahead of the child's flags, and only a pinned semi-space in the
 * child's own flags brings the limit back under the allowance.
 */
import { execFileSync } from "node:child_process";
import { childNodeArgs, clampLimits } from "../src/protocol";

const SUPERVISOR_ALLOWANCE_MB = 64;

function heapLimitMb(args: readonly string[]): number {
  const out = execFileSync(process.execPath, [...args, "-e", 'process.stdout.write(String(require("v8").getHeapStatistics().heap_size_limit / 1048576))'], { encoding: "utf8" });
  return Number(out);
}

describe("child heap limit", () => {
  it.each([1024, 512])("a %i MB child stays within the supervisor's allowance even with Node 24's semi-space", (memoryMb) => {
    const limits = clampLimits({ memoryMb });
    const v8Flags = childNodeArgs(limits, "child.cjs").filter((a) => a.startsWith("--max-"));
    const limit = heapLimitMb(["--max-semi-space-size=64", ...v8Flags]);
    expect(limit).toBeGreaterThanOrEqual(memoryMb);
    expect(limit).toBeLessThanOrEqual(memoryMb + SUPERVISOR_ALLOWANCE_MB);
  });
});
