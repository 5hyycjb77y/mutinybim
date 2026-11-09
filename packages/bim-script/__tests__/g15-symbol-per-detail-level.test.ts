/** @jest-environment node */
import { MeshCache } from "@permitzip/bim-geometry";
import { DEFAULT_SETTINGS, GEOMETRY_SOLID_PROGRAM_2_FEATURE, executeCommand, setPartMeshProvider, withUpgradePolicy, type Command, type DetailLevel, type ModelState, type PartInstance, type Revision, type Vec2 } from "@permitzip/bim-kernel";
import { drawPartSymbol } from "../../bim-kernel/src/drawing/runs";
import { parts, units } from "../src";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";

/**
 * G15: a part's plan symbol is per detail level. The coarse plan draws the
 * script's symbol (an outline with an X); at a level with no symbol the plan
 * draws the solid seen from above. Fails on round 14: the kit had no symbol
 * call and plans drew one symbol at every level.
 */

const IN = 25.4;

function unitPart() {
  const b = parts.part("Unit", { type: "48x30", category: "mechanical_equipment" });
  b.extrude(parts.rect(units.in(48), units.in(30), { fillet: units.in(2) }), { to: units.in(36) });
  b.cut(parts.circle(units.in(12)), { from: units.in(30), to: units.in(40) });
  b.symbol("coarse", { shapes: [parts.rect(units.in(48), units.in(30))], lines: [[[units.in(-24), units.in(-15)], [units.in(24), units.in(15)]]] });
  return b.build();
}

function placed(): { m: ModelState; part: PartInstance } {
  let m: ModelState = { modelId: "g15-sym", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (command: Command) => {
    // A current model server reads solid programs.
    const r = withUpgradePolicy((f) => f === GEOMETRY_SOLID_PROGRAM_2_FEATURE, () => executeCommand(m, command));
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  };
  run({ type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
  run({ type: "place_part", partId: "u1", typeId: "g15-unit", partType: unitPart(), levelId: "l1", position: { x: 1000, y: 2000 }, mark: "U-1" });
  const part = m.elements["u1"];
  if (part?.kind !== "part") throw new Error("not placed");
  return { m, part };
}

function lines(detail: DetailLevel): Array<[Vec2, Vec2]> {
  const { m, part } = placed();
  const out: Array<[Vec2, Vec2]> = [];
  drawPartSymbol(m, part, (a, b) => void out.push([a, b]), () => undefined, null, detail);
  return out;
}

const isDiagonal = ([a, b]: [Vec2, Vec2]) => Math.abs(a.x - (1000 - 24 * IN)) < 1 && Math.abs(a.y - (2000 - 15 * IN)) < 1 && Math.abs(b.x - (1000 + 24 * IN)) < 1 && Math.abs(b.y - (2000 + 15 * IN)) < 1;

beforeAll(async () => {
  setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
});
afterAll(() => setPartMeshProvider(null));

describe("g15-symbol-per-detail-level", () => {
  it("coarse plans draw the script's symbol: the outline and its X, not the solid", () => {
    const coarse = lines("coarse");
    expect(coarse.some(isDiagonal)).toBe(true);
    // Four outline sides and the X; the solid's edges (its filleted corners, the round cut on top) are not drawn.
    expect(coarse).toHaveLength(5);
  });

  it("medium and fine plans have no symbol, so they draw the solid seen from above", () => {
    for (const detail of ["medium", "fine"] as const) {
      const drawn = lines(detail);
      expect(drawn.some(isDiagonal)).toBe(false);
      // The filleted outline and the round opening on top are many short edges.
      expect(drawn.length).toBeGreaterThan(20);
    }
  });
});
