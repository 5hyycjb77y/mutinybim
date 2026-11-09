/**
 * @jest-environment node
 *
 * G15: clash reads a modeled part's real solid (the mesh the screen and the
 * sheets draw, as convex pieces), not its feature boxes. A duct inside the
 * hollow of a rooftop unit's curb is clear; one through its casing clashes.
 * Fails on round 14: shapes.ts tested the curb's feature box, which is solid
 * all the way across, so the duct in the hollow was a hard clash.
 */
import { MeshCache } from "@permitzip/bim-geometry";
import { exampleRooftopUnit, setPartMeshProvider } from "@permitzip/bim-kernel";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import { FT, IN, Model, rulesFired, SUPPLY } from "./fixtures";

beforeAll(async () => {
  setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
});
afterAll(() => setPartMeshProvider(null));

function withUnit(): Model {
  const m = new Model();
  m.ok({ type: "place_part", partId: "rtu-1", typeId: "g15-rtu", partType: exampleRooftopUnit(), levelId: "lvl-roof", position: { x: 20 * FT, y: 20 * FT }, mark: "RTU-1" });
  return m;
}

const small = { shape: "rect", width: 6 * IN, height: 4 * IN } as const;

describe("g15-clash-reads-mesh", () => {
  it("a duct inside the curb's hollow, under the unit, is clear", () => {
    const m = withUnit();
    // The curb is 14 in tall with 2 in walls around a 1.8 m x 1.0 m opening; the duct runs 0.6 m along its middle, 6 in up.
    m.duct("sa", SUPPLY, [[20 - 300 / FT, 20], [20 + 300 / FT, 20]], (6 * IN) / FT, small, "lvl-roof");
    const fired = rulesFired(m.head, []);
    expect(fired.get("clash-hard") ?? []).toEqual([]);
  });

  it("the same duct through the casing above still clashes", () => {
    const m = withUnit();
    m.duct("sa", SUPPLY, [[20 - 300 / FT, 20], [20 + 300 / FT, 20]], ((14 + 20) * IN) / FT, small, "lvl-roof");
    expect((rulesFired(m.head, []).get("clash-hard") ?? []).length).toBeGreaterThan(0);
  });
});
