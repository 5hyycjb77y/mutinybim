/**
 * @jest-environment node
 *
 * The open local script runner: a part script runs in a fresh capped
 * process and its output comes back re-parsed; a script that never ends is
 * stopped at the wall-clock cap (and says which cap), not left running.
 */
import { resolve } from "node:path";
import { KIT_ENTRIES } from "@permitzip/bim-script";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { SLICE_FORMAT, type ModelSlice } from "@permitzip/bim-script";
import { LocalScriptRunner } from "@permitzip/bim-script-runner/local";

const REPO_ROOT = resolve(__dirname, "../../..");
const PART = KIT_ENTRIES.find((e) => e.name === "PartBuilder.connector")?.example ?? "";
const EMPTY: ModelSlice = { format: SLICE_FORMAT, version: 1, modelId: "none", revision: 0, reads: {}, selection: [], elements: {}, connections: [], settings: DEFAULT_SETTINGS, features: [] };

describe("local-runner", () => {
  const runner = new LocalScriptRunner({ repoRoot: REPO_ROOT, limits: { memoryMb: 512, wallMs: 3_000, outputBytes: 2 * 1024 * 1024 } });

  it("is available on this Node", async () => {
    expect(await runner.availability()).toEqual({ ok: true });
  }, 120_000);

  it("runs a part script and returns its checked output", async () => {
    expect(PART).toContain("defineScript");
    const result = await runner.run({ source: PART, scriptHash: "sha256:local-runner-test", values: {}, slice: EMPTY });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && (result.output as { kind: string }).kind).toBe("part_types");
  }, 120_000);

  it("stops a script that never ends at the wall-clock cap", async () => {
    const forever = 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "part", reads: {}, parameters: {}, run() { for (;;) {} } });\n';
    const result = await runner.run({ source: forever, scriptHash: "sha256:forever", values: {}, slice: EMPTY });
    expect(result).toMatchObject({ ok: false, code: "cap_time" });
  }, 120_000);
});
