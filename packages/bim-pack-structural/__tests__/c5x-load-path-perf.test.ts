/**
 * @jest-environment node
 *
 * Workload of perf row `struct.load_path.one_edit.grid_20x20`
 * (docs/perf/mutinybim-budgets.json, timed by
 * scripts/perf/mutinybim/structural-load-path.ts). A 20 × 20 bay roof: 441 columns and footings, 420 beams, one
 * deck, 400 rooftop units. One edit (a unit's weight) makes a new elements
 * record, so the frame is read again and the whole path re-totalled; the
 * tributary strips of unchanged beams come back from the derived-zone cache.
 */
import { PackSet, withPackSet } from "@permitzip/bim-pack";
import { installedFirstPartyPacks } from "@permitzip/bim-pack";

/** The first-party add-ons every host installs (jest.setup.js installs them before this file loads). */
const FIRST_PARTY_PACKS = installedFirstPartyPacks();
import { to } from "@permitzip/bim-units";
import type { ModelState } from "@permitzip/bim-kernel/types";
import { structuralLoadPath } from "../src";
import { gridFrame } from "./two-bay-frame";

// Structural is first-party (round 14), so it is one of these.
const SET = PackSet.create([...FIRST_PARTY_PACKS]);

function edit(model: ModelState, n: number): ModelState {
  const rtu = model.elements["RTU-0-0"];
  if (rtu?.kind !== "part") throw new Error("grid has no RTU-0-0");
  return { ...model, elements: { ...model.elements, "RTU-0-0": { ...rtu, values: { weight: 1500 + n } } } };
}

const equipmentLbf = (r: ReturnType<typeof structuralLoadPath>): number => r.footings.reduce((a, f) => a + to(f.load.equipment, "lbf"), 0);

// The time budget is `struct.load_path.one_edit.grid_20x20` in the BIM perf gate (plain node, 100 ms p50, unscaled on CI).
// A clock here measured the Unit Tests job's CPU contention (106 ms median on CI against ~15 ms in plain node).
describe("c5x load path on a 20 × 20 bay grid", () => {
  it("re-totals the whole path after each one-unit edit", () => {
    let model = gridFrame(20);
    const first = withPackSet(SET, () => structuralLoadPath(model));
    expect(first.problems).toEqual([]);
    // Every load reaches a footing: 400 units × 1,500 lb plus the roof live load and the members.
    expect(equipmentLbf(first)).toBeCloseTo(400 * 1500, 3);
    for (let n = 1; n <= 5; n++) {
      model = edit(model, n);
      const r = withPackSet(SET, () => structuralLoadPath(model));
      expect(r.problems).toEqual([]);
      expect(r.footings).toHaveLength(first.footings.length);
      // RTU-0-0 now weighs 1,500 + n lb; the other 399 units are unchanged.
      expect(equipmentLbf(r)).toBeCloseTo(400 * 1500 + n, 3);
    }
  });
});
