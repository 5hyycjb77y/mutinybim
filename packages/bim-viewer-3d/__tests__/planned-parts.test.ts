/**
 * @jest-environment node
 *
 * A planned part (not placed yet) is never drawn in 3D: it has no location,
 * only placeholder fields at the level origin. Taking a placed part off the
 * drawing removes its solids on the next incremental update.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { changedElements, elementSolids } from "../src/native-geometry";
import { TYPES } from "../../bim-kernel/__tests__/fixtures/electrical-building";

let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `planned-3d-${++n}-key`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-27T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function placedPanel(): ModelState {
  let m: ModelState = { modelId: "planned-3d", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return commit(m, { type: "place_part", partId: "p1", typeId: "type-panel", partType: TYPES.panel208, levelId: "lvl-1", position: { x: 1000, y: 1000 }, mark: "P1" });
}

const solidsOf = (m: ModelState, id: string) => {
  const el = m.elements[id];
  if (!el) throw new Error(id);
  return elementSolids(el, undefined, m);
};

describe("planned parts in the 3D viewer", () => {
  it("a placed panel has solids (the control)", () => {
    expect(solidsOf(placedPanel(), "p1").length).toBeGreaterThan(0);
  });

  it("a planned panel has none, and unplacing one drops its solids on the next update", () => {
    const placed = placedPanel();
    const planned = commit(placed, { type: "unplace_part", partId: "p1" });
    expect(solidsOf(planned, "p1")).toEqual([]);
    expect(changedElements(placed, planned).changed).toContain("p1");
    const fresh = commit(planned, { type: "plan_part", partId: "p2", typeId: "type-panel", mark: "P2" });
    expect(solidsOf(fresh, "p2")).toEqual([]);
  });
});
