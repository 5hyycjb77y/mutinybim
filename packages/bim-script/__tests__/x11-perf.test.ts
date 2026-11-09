/**
 * @jest-environment node
 *
 * Round 11 lane X11, perf flag: `script.check.500_steps` (target ≤ 300 ms)
 * and `script.snapshot.slice` on the full-BIM model. X11_PERF=1 runs the
 * 250k tier (the row); the default runs XS so the jest run stays light. The
 * perf gate's numbers come from `scripts/perf/mutinybim/scripts.ts`.
 */
import { freezeElements, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { checkScriptOutput, chunkEdits, sliceModel, type EditStep } from "../src";

const TIER: keyof typeof FULL_BIM_TIERS = process.env.X11_PERF === "1" ? "250k" : "XS";

function p50(list: number[]): number {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

describe("x11-perf", () => {
  it("script.check.500_steps and script.snapshot.slice", () => {
    installFirstPartyAddOns();
    const built = createFullBimModel({ ...FULL_BIM_TIERS[TIER], modelId: `x11-perf-${TIER}` });
    const head: ModelState = { ...built, elements: freezeElements(built.elements) };
    const walls = Object.values(head.elements).filter((e) => e.kind === "wall");
    const n = Math.min(500, walls.length);
    const steps: EditStep[] = walls.slice(0, n).map((w) => ({ type: "move_wall", wallId: w.id, delta: { x: 1, y: 0 } }));
    const output = JSON.parse(JSON.stringify({ kind: "edits", label: "Walls by script", steps: n, batches: chunkEdits("Walls by script", steps) })) as unknown;
    const warm = checkScriptOutput(head, output);
    expect(warm.ok).toBe(true);
    const check: number[] = [];
    const slice: number[] = [];
    for (let i = 0; i < 5; i++) {
      let t = performance.now();
      checkScriptOutput(head, output);
      check.push(performance.now() - t);
      t = performance.now();
      JSON.stringify(sliceModel(head, { levels: true, kinds: ["wall", "room"] }));
      slice.push(performance.now() - t);
    }
    process.stderr.write(`[x11 script perf ${TIER}] ${Object.keys(head.elements).length} elements; check ${n} steps p50 ${p50(check).toFixed(1)} ms; slice p50 ${p50(slice).toFixed(1)} ms\n`);
    expect(p50(check)).toBeLessThan(300);
  }, 600_000);
});
