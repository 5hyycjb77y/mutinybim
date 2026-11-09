/**
 * @jest-environment node
 *
 * Routed library fittings draw as sheet metal (their own triangles), and the
 * duct beside them draws only its straight piece. Before, every fitting was a
 * box or cylinder 12% bigger than the duct, centred on the corner, and
 * segments ran into it.
 */
import { DEFAULT_SETTINGS, builtinPartType, planCommit, straightPiece, type Command, type ModelState } from "@permitzip/bim-kernel";
import { elementSolids } from "../src/native-geometry";

const FT = 304.8;
const IN = 25.4;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `s-${model.revision}-key`, baseRevision: model.revision, actor: { id: "s", name: "S", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function routed(): ModelState {
  const RTU = builtinPartType("builtin:rtu-5-ton@1");
  const SD = builtinPartType("builtin:supply-diffuser-24@1");
  if (!RTU || !SD) throw new Error("starter library");
  let m: ModelState = { modelId: "v", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd", typeId: SD.id, partType: SD.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  return commit(m, { type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: { id: "sa", kind: "supply_air" }, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd", connectorId: "neck" } });
}

describe("routed fittings in 3D", () => {
  it("a library elbow is one mesh solid around its corner, sized like its body", () => {
    const m = routed();
    const elbow = m.elements["r-f1"];
    if (elbow?.kind !== "run_fitting") throw new Error("no elbow");
    const [solid, ...rest] = elementSolids(elbow, undefined, m);
    expect(rest).toHaveLength(0);
    expect(solid?.shape).toBe("mesh");
    const positions = solid?.mesh?.positions ?? new Float32Array();
    expect(positions.length).toBeGreaterThan(0);
    expect(Array.from(positions).every(Number.isFinite)).toBe(true);
    // A 14x10 radius elbow turning down reaches 10" along each leg: about 0.25 m of body plus half the duct.
    expect(Math.max(...(solid?.size ?? [0]))).toBeGreaterThan(0.25);
    expect(Math.max(...(solid?.size ?? [9]))).toBeLessThan(0.7);
  });

  it("the duct between two fittings draws only its straight piece", () => {
    const m = routed();
    const seg = m.elements["r-s2"];
    if (seg?.kind !== "run_segment") throw new Error("no trunk");
    const [solid] = elementSolids(seg, undefined, m);
    const piece = straightPiece(m.elements, seg);
    expect(solid?.size[0]).toBeCloseTo((piece.lengthMm / 1000), 4);
    expect(piece.lengthMm).toBeLessThan(Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y));
  });

  it("a pipe library fitting draws its own body too, and the pipe beside it stops at its take-out", () => {
    let m: ModelState = { modelId: "p", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m = commit(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "copper" }, elevationMm: 9 * FT, system: { id: "cw", kind: "domestic_cold_water" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }] });
    const elbow = m.elements["p-f1"];
    const pipe = m.elements["p-s1"];
    if (elbow?.kind !== "run_fitting" || pipe?.kind !== "run_segment") throw new Error("routed");
    expect(elbow.family).toBe("pipe.water.elbow_90");
    const [solid] = elementSolids(elbow, undefined, m);
    expect(solid?.shape).toBe("mesh");
    expect(solid?.mesh?.indices.length).toBeGreaterThan(0);
    const [straight] = elementSolids(pipe, undefined, m);
    // 2" type L: OD 2.125", short-radius 90° take-out R tan 45° = 2.125".
    expect(straightPiece(m.elements, pipe).cutEnd).toBeCloseTo(2.125 * IN, 3);
    expect((straight?.size[0] ?? 0) * 1000).toBeCloseTo(10 * FT - 2.125 * IN, 0);
  });
});
