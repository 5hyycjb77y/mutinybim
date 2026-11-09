/**
 * @jest-environment node
 *
 * Wrapped duct shows its insulation in 3D as a see-through skin, its own
 * render group, the wrap's thickness outside the metal on every side. A liner
 * is inside the metal and adds nothing. Before, the 3D view had no insulation.
 */
import { DEFAULT_SETTINGS, builtinPartType, planCommit, type Command, type DuctInsulation, type ModelState } from "@permitzip/bim-kernel";
import { elementSolids } from "../src/native-geometry";

const FT = 304.8;
const IN = 25.4;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `i-${model.revision}-key`, baseRevision: model.revision, actor: { id: "s", name: "S", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function routed(insulation?: DuctInsulation): ModelState {
  const RTU = builtinPartType("builtin:rtu-5-ton@1");
  const SD = builtinPartType("builtin:supply-diffuser-24@1");
  if (!RTU || !SD) throw new Error("starter library");
  let m: ModelState = { modelId: "v", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd", typeId: SD.id, partType: SD.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  return commit(m, {
    type: "route_run",
    idPrefix: "r",
    levelId: "lvl-1",
    domain: "duct",
    size: { shape: "rect", width: 14 * IN, height: 10 * IN },
    elevationMm: 10 * FT,
    system: { id: "sa", kind: "supply_air" },
    points: [],
    from: { kind: "part", partId: "rtu", connectorId: "supply" },
    to: { kind: "part", partId: "sd", connectorId: "neck" },
    ...(insulation ? { insulation } : {}),
  });
}

describe("insulation in 3D", () => {
  it("bare duct draws no insulation skin", () => {
    const m = routed();
    for (const el of Object.values(m.elements)) expect(elementSolids(el, undefined, m).some((s) => s.group === "insulation")).toBe(false);
  });

  it("a 2\" wrap adds one see-through skin per piece, 4\" wider and taller than the 14x10 metal", () => {
    const m = routed({ kind: "wrap", thicknessMm: 2 * IN });
    const seg = m.elements["r-s2"];
    if (seg?.kind !== "run_segment") throw new Error("no trunk");
    const solids = elementSolids(seg, undefined, m);
    const metal = solids.find((s) => s.group === "duct");
    const skin = solids.find((s) => s.group === "insulation");
    expect(skin?.shape).toBe("mesh");
    expect(skin?.elementId).toBe(seg.id);
    // The trunk runs east: scene X is its length; Y up is the 10" height (+4"), Z the 14" width (+4").
    expect(skin?.size[1]).toBeCloseTo((14 * IN) / 1000, 3);
    expect(skin?.size[2]).toBeCloseTo((18 * IN) / 1000, 3);
    expect(skin?.size[0]).toBeCloseTo(metal?.size[0] ?? 0, 3);
    const elbow = m.elements["r-f1"];
    if (elbow?.kind !== "run_fitting") throw new Error("no elbow");
    expect(elementSolids(elbow, undefined, m).filter((s) => s.group === "insulation")).toHaveLength(1);
  });

  it("a liner is inside the metal: nothing extra draws", () => {
    const m = routed({ kind: "liner", thicknessMm: 1 * IN });
    const seg = m.elements["r-s2"];
    if (seg?.kind !== "run_segment") throw new Error("no trunk");
    expect(elementSolids(seg, undefined, m).map((s) => s.group)).toEqual(["duct"]);
  });
});
