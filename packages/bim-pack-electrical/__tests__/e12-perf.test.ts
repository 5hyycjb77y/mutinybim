/**
 * @jest-environment node
 *
 * Round 12 lane E speed rows, behind `E12_PERF=1` (a heavy job: run it
 * through the laptop's heavy lock). The "+" grip's hover answer is the hot
 * path: 4 / 8 ms (p50 / p95). The full rows at 250k and 1M, the plan with
 * hash marks and the one-line with fault current are in
 * `scripts/perf/mutinybim/e12-drafting.ts`.
 */
import { asElementId, sourcesFor, DEFAULT_SETTINGS, type ModelState, type PartInstance } from "@permitzip/bim-kernel";
import { syntheticDistribution } from "@permitzip/bim-pack-electrical";

const run = process.env.E12_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

run("e12-perf: the grip's hover answer", () => {
  it("answers within 4 / 8 ms on the 7903-shaped distribution", () => {
    const syn = syntheticDistribution({ floors: 4, zonesPerFloor: 4 });
    const elements = { ...syn.elements };
    const r = elements[syn.receptacleId];
    if (r?.kind !== "part") throw new Error("no receptacle");
    elements[syn.receptacleId] = { ...r, served: undefined } as PartInstance;
    const model: ModelState = { modelId: "e12-perf", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
    sourcesFor(model, { elementId: asElementId(syn.receptacleId) });
    const ms: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      sourcesFor(model, { elementId: asElementId(syn.receptacleId) });
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    if (ABSOLUTE_BUDGETS) {
      expect(ms[10]).toBeLessThan(4);
      expect(ms[19]).toBeLessThan(8);
    }
  });
});
