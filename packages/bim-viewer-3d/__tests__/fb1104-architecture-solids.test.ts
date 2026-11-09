/**
 * @jest-environment node
 *
 * Product decision, Nov 4 ("more comments" review video): in the 3D model and the live plan,
 * doors and windows he placed never showed, an L-shaped floor came out as a
 * rectangle, and ceilings and stairs he drew were not there at all. The
 * kernel already had those bodies (sections draw them); the 3D viewer drew
 * every wall as a plain box, every floor as its bounding box, and nothing for
 * ceilings or add-on kinds.
 *
 * Fails on the old viewer: the wall with a door is one box with no hole, the
 * L floor's corners are its bounding box's, and the ceiling and the stair
 * have no solids.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import type { ModelState, Vec2 } from "@permitzip/bim-kernel";
import { twoLevels, type Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { kernelToScene, MM } from "../src/coords";
import { elementSolids, type Solid } from "../src/native-geometry";
import { triangulatePolygon } from "../src/prism-mesh";

installFirstPartyAddOns();

const solidsOf = (m: Log, id: string): Solid[] => {
  const el = m.head.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return elementSolids(el, undefined, m.head as ModelState);
};

/** Mesh corners in kernel plan mm and elevation mm. */
function corners(s: Solid): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const p = s.mesh?.positions ?? new Float32Array();
  for (let i = 0; i < p.length; i += 3) out.push({ x: Math.round(((p[i] ?? 0) + s.center[0]) / MM), y: Math.round(-((p[i + 2] ?? 0) + s.center[2]) / MM), z: Math.round(((p[i + 1] ?? 0) + s.center[1]) / MM) });
  return out;
}

describe("fb1104: the 3D model draws what Architecture makes", () => {
  it("a wall with a door is cut round the door (blocks beside, a lintel over), not one box", () => {
    const m = twoLevels("fb1104");
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w", s: 3000, side: 1, size: { widthMm: 900, heightMm: 2100 } });
    const [wall, ...rest] = solidsOf(m, "w");
    expect(rest).toEqual([]);
    expect(wall).toMatchObject({ group: "wall", shape: "mesh" });
    const pts = corners(wall as Solid);
    // The door's jambs and head are corners of the body; nothing of the wall stands inside the door.
    expect(pts.some((p) => p.x === 2550 && p.z === 0)).toBe(true);
    expect(pts.some((p) => p.x === 3450 && p.z === 2100)).toBe(true);
    expect(pts.filter((p) => p.x > 2550 && p.x < 3450)).toEqual([]);
    expect(Math.max(...pts.map((p) => p.z))).toBe(3000);
  });

  it("an L-shaped floor is drawn as drawn, not as its bounding box", () => {
    const m = twoLevels("fb1104");
    const L: Vec2[] = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 3000, y: 3000 }, { x: 3000, y: 6000 }, { x: 0, y: 6000 }];
    m.ok({ type: "create_element", elementId: "f", kind: "slab", levelId: "L1", size: { thicknessMm: 150 }, placement: { kind: "area", outline: L, holes: [] } });
    const [floor] = solidsOf(m, "f");
    expect(floor).toMatchObject({ group: "slab", shape: "mesh" });
    const pts = corners(floor as Solid);
    expect(pts.some((p) => p.x === 3000 && p.y === 3000)).toBe(true);
    expect(pts.some((p) => p.x === 6000 && p.y === 6000)).toBe(false);
    // Two caps of four triangles each, six sides of two.
    expect(floor?.mesh?.indices.length).toBe((4 * 2 + 6 * 2) * 3);
  });

  it("a plain rectangular floor stays one box (instanced like before)", () => {
    const m = twoLevels("fb1104");
    m.ok({ type: "create_element", elementId: "f", kind: "slab", levelId: "L1", size: { thicknessMm: 150 }, placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }], holes: [] } });
    expect(solidsOf(m, "f")).toMatchObject([{ group: "slab", shape: "box" }]);
  });

  it("a ceiling is drawn at its height above its level", () => {
    const m = twoLevels("fb1104");
    m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "c", levelId: "L2", outline: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }], heightMm: 2743 }] });
    const [ceiling] = solidsOf(m, "c");
    expect(ceiling).toMatchObject({ shape: "mesh" });
    expect(Math.min(...corners(ceiling as Solid).map((p) => p.z))).toBe(4000 + 2743);
  });

  it("an add-on kind with a body (the Architecture add-on's stair) draws that body", () => {
    const m = twoLevels("fb1104");
    m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", size: { widthMm: 1200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6160, y: 0 } } });
    const [stair] = solidsOf(m, "s");
    expect(stair).toMatchObject({ group: "structure", shape: "mesh" });
    expect(stair?.center[1]).toBeGreaterThan(kernelToScene(0, 0, 0)[1]);
  });
});

describe("fb1104: prism caps", () => {
  it("ear-clips a concave outline in either winding", () => {
    const L: Vec2[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
    for (const ring of [L, [...L].reverse()]) {
      const t = triangulatePolygon(ring);
      expect(t).toHaveLength(4 * 3);
      let area = 0;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [ring[t[i] as number], ring[t[i + 1] as number], ring[t[i + 2] as number]] as Vec2[];
        area += ((b as Vec2).x - (a as Vec2).x) * ((c as Vec2).y - (a as Vec2).y) - ((b as Vec2).y - (a as Vec2).y) * ((c as Vec2).x - (a as Vec2).x);
      }
      expect(area / 2).toBeCloseTo(3, 9);
    }
  });
});
