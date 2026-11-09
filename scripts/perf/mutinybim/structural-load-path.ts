/**
 * The Structural pack's gravity load path on a 20 x 20 bay roof (441 columns
 * and footings, 420 beams, one deck, 400 rooftop units), re-totalled after one
 * edit to a unit's weight. Each edit makes a new elements record, so the frame
 * is read again and the whole path re-totalled; the tributary strips of
 * unchanged beams come back from the derived-zone cache.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/structural-load-path.ts --samples=21
 *
 * Metric:
 *   struct.load_path.one_edit.grid_20x20   structuralLoadPath after one RTU weight edit
 *
 * Moved from packages/bim-pack-structural/__tests__/c5x-load-path-perf.test.ts,
 * whose Jest wall clock measured the Unit Tests job's CPU contention (median
 * 106 ms on CI) rather than the load path. Prints one `@@perf-result` JSON line.
 */
import { installedFirstPartyPacks, PackSet, withPackSet } from "@permitzip/bim-pack";
import { to } from "@permitzip/bim-units";
import type { ModelState } from "@permitzip/bim-kernel/types";
import { structuralLoadPath } from "@permitzip/bim-pack-structural";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { gridFrame } from "../../../packages/bim-pack-structural/__tests__/two-bay-frame";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 21);
const BAYS = 20;

// Structural is a first-party add-on: installed with the others, never added a second time.
installFirstPartyAddOns();
const SET = PackSet.create(installedFirstPartyPacks());

function edit(model: ModelState, n: number): ModelState {
  const rtu = model.elements["RTU-0-0"];
  if (rtu?.kind !== "part") throw new Error("grid has no RTU-0-0");
  return { ...model, elements: { ...model.elements, "RTU-0-0": { ...rtu, values: { weight: 1500 + n } } } };
}

let model = gridFrame(BAYS);
const first = withPackSet(SET, () => structuralLoadPath(model));
if (first.problems.length > 0) throw new Error(`load path problems: ${JSON.stringify(first.problems)}`);
const total = first.footings.reduce((a, f) => a + to(f.load.equipment, "lbf"), 0);
if (Math.abs(total - 400 * 1500) > 1e-3) throw new Error(`footings carry ${total} lbf of equipment, expected ${400 * 1500}`);

const oneEdit: number[] = [];
let footings = 0;
for (let n = 1; n <= samples; n++) {
  model = edit(model, n);
  const t0 = performance.now();
  const r = withPackSet(SET, () => structuralLoadPath(model));
  oneEdit.push(performance.now() - t0);
  footings = r.footings.length;
}

emit({
  suite: "batch",
  workload: { bays: BAYS, footings, samples },
  network: "in-process",
  participants: 1,
  samples: [{ metric: "struct.load_path.one_edit.grid_20x20", values: oneEdit, note: `Load path re-totalled after one rooftop unit's weight changes, ${BAYS} x ${BAYS} bays, ${footings} footings.` }],
});
