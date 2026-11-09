/**
 * @jest-environment node
 *
 * Showcase run, Nov 8: "Building section A" through a two-storey model drew
 * the Level 1 walls but no Level 2 walls and no Level 2 or roof slab, while it
 * drew the Level 2 ducts. A section names no level, so every wall and slab
 * was drawn on the section's own floor (0): the Level 2 walls sat on top of
 * the Level 1 walls and every slab sat at the ground. Ducts were right because
 * runs read their own level.
 *
 * Fails on the old drawing: the cut shading spans one storey (about 40 mm on
 * paper at 1/8" = 1'-0"), not two storeys and the roof slab (about 78 mm).
 */
import { DEFAULT_SETTINGS, buildViewScene, levelOf, type ModelState, type Primitive } from "../src";
import { Log } from "./a13a-fixtures";

const FT = 304.8;
const SCALE = 96;

function twoStoreys(): Log {
  const m = new Log({ modelId: "section-levels", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "level-a1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_level", levelId: "level-a2", name: "Level 2", elevationMm: 12 * FT });
  m.ok({ type: "create_level", levelId: "level-a3", name: "Roof", elevationMm: 24 * FT });
  const outline = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 6000 }, { x: 0, y: 6000 }];
  for (const [id, levelId, thicknessMm] of [["slab-1", "level-a1", 152.4], ["slab-2", "level-a2", 152.4], ["slab-r", "level-a3", 203.2]] as const) {
    m.ok({ type: "create_element", elementId: id, levelId, kind: "slab", placement: { kind: "area", outline }, size: { thicknessMm } });
  }
  for (const [prefix, levelId, top] of [["w1", "level-a1", "level-a2"], ["w2", "level-a2", "level-a3"]] as const) {
    m.ok({ type: "create_elements", idPrefix: prefix, levelId, kind: "wall", points: [{ x: 0, y: 1000 }, { x: 6000, y: 1000 }], size: { thicknessMm: 203.2 }, topLevelId: top });
  }
  m.ok({ type: "create_view", viewId: "sec", name: "Building section A", viewType: "section", props: { scale: SCALE, section: { start: { x: 3000, y: -1000 }, end: { x: 3000, y: 7000 }, direction: 1, depthMm: 3000 } } });
  return m;
}

const fills = (prims: readonly Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "fill" }> => p.kind === "fill");

describe("a section draws every level's walls and slabs at their own height", () => {
  it("the cut shading reaches from the Level 1 slab's underside to the roof slab's top", () => {
    const m = twoStoreys();
    const { scene } = buildViewScene(m.head, "sec");
    const ys = fills(scene.primitives).flatMap((f) => f.points.map((q) => q.y));
    expect(ys.length).toBeGreaterThan(0);
    const extentMm = (Math.max(...ys) - Math.min(...ys)) * SCALE;
    // Level 1 slab underside (-152.4) to the roof slab's top (24 ft).
    expect(Math.abs(extentMm - (24 * FT + 152.4))).toBeLessThan(SCALE);
  });

  it("the Level 2 wall's cut sits a storey above the Level 1 wall's", () => {
    const m = twoStoreys();
    const bands = (ids: readonly string[]) => {
      const head: ModelState = { ...m.head, elements: Object.fromEntries(Object.entries(m.head.elements).filter(([id, el]) => el.kind !== "wall" && el.kind !== "slab" ? true : ids.includes(id))) };
      const ys = fills(buildViewScene(head, "sec").scene.primitives).flatMap((f) => f.points.map((q) => q.y));
      return { min: Math.min(...ys), max: Math.max(...ys) };
    };
    const l1 = bands(["w1-1"]);
    const l2 = bands(["w2-1"]);
    const shiftMm = Math.abs((l1.min + l1.max) / 2 - (l2.min + l2.max) / 2) * SCALE;
    expect(Math.abs(shiftMm - 12 * FT)).toBeLessThan(SCALE);
  });

  it("the kernel's level lookup reads a wall's placement level when no partition names it", () => {
    const m = twoStoreys();
    const wall = m.head.elements["w2-1"];
    if (!wall) throw new Error("no w2-1");
    const { partition: _partition, ...placedOnly } = wall;
    expect(levelOf(m.head.elements, placedOnly)?.id).toBe("level-a2");
  });
});
