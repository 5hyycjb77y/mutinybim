/**
 * @jest-environment node
 *
 * Runs draw in their system's colour in 3D (cold water blue, vent green, the
 * system's own colour when it sets one), and recolouring a system rebuilds
 * its runs. Before this every pipe drew the same green whatever it carried.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type RunSize } from "@permitzip/bim-kernel";
import { changedElements, elementSolids } from "../src/native-geometry";

const FT = 304.8;
const pex: RunSize = { shape: "pipe", nominalMm: 25.4, material: "pex" };
const pvc: RunSize = { shape: "pipe", nominalMm: 50.8, material: "pvc" };

let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `colour-${++n}-key`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-23T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function model(): ModelState {
  let m: ModelState = { modelId: "colours", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: pex, elevationMm: 9 * FT, system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" }, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 10 * FT }] });
  m = commit(m, { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "pipe", size: pvc, elevationMm: 9 * FT, system: { id: "sys-v", kind: "vent", name: "Vent 1" }, points: [{ x: 0, y: 5 * FT }, { x: 20 * FT, y: 5 * FT }] });
  return m;
}

const tints = (m: ModelState, id: string) => {
  const el = m.elements[id];
  if (!el) throw new Error(id);
  return elementSolids(el, undefined, m).map((s) => s.tint);
};

describe("3D system colours", () => {
  const m = model();

  it("each pipe and its fittings draw in their system's colour, not one green for all", () => {
    expect(tints(m, "cw-s1")).toEqual([0x1f6fd1]);
    expect(tints(m, "v-s1")).toEqual([0x5f8f1f]);
    const elbow = Object.values(m.elements).find((e) => e.kind === "run_fitting" && e.systemId === "sys-cw");
    if (!elbow) throw new Error("no elbow");
    expect(new Set(tints(m, elbow.id))).toEqual(new Set([0x1f6fd1]));
  });

  it("recolouring a system recolours its runs and rebuilds only them", () => {
    const next = commit(m, { type: "set_system_graphics", systemId: "sys-cw", colour: "#0b3d91" });
    expect(tints(next, "cw-s1")).toEqual([0x0b3d91]);
    const { changed } = changedElements(m, next);
    expect(changed).toEqual(expect.arrayContaining(["sys-cw", "cw-s1", "cw-s2"]));
    expect(changed).not.toContain("v-s1");
  });
});
