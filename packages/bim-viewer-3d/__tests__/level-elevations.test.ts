/**
 * @jest-environment node
 *
 * Showcase run, Nov 8: on a two-storey model built at 12 ft floor to floor,
 * the Level 2 walls stood 1.8 ft above the Level 2 ducts (a gap the ducts
 * showed through), the roof's elements sat at the ground, and no floor slab
 * drew at any level. Walls, slabs and openings took their height from a guess
 * of 4.2 m per level number in the level's name ("Roof" has none, so 0), while
 * ducts, pipes and parts read the level's own elevation.
 *
 * Fails on the old viewer: the Level 2 wall's base is 4200 mm, the roof slab's
 * top is 0, and the slabs have no solids.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, type ModelState } from "@permitzip/bim-kernel";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { MM } from "../src/coords";
import { elementSolids, modelSolids, type Solid } from "../src/native-geometry";

installFirstPartyAddOns();

const FT = 304.8;

/** A 12 ft floor-to-floor model: Level 1 at 0, Level 2 at 12 ft, Roof at 24 ft (no number in its name). */
function showcaseLevels(): Log {
  const m = new Log({ modelId: "levels", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "level-a1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_level", levelId: "level-a2", name: "Level 2", elevationMm: 12 * FT });
  m.ok({ type: "create_level", levelId: "level-a3", name: "Roof", elevationMm: 24 * FT });
  return m;
}

const solidsOf = (m: Log, id: string): Solid[] => {
  const el = m.head.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return elementSolids(el, undefined, m.head);
};

/** Lowest and highest elevation (mm) a solid reaches. */
function zRange(s: Solid): { bottom: number; top: number } {
  if (s.shape === "mesh" && s.mesh) {
    const ys: number[] = [];
    for (let i = 1; i < s.mesh.positions.length; i += 3) ys.push((s.mesh.positions[i] ?? 0) + s.center[1]);
    return { bottom: Math.min(...ys) / MM, top: Math.max(...ys) / MM };
  }
  return { bottom: (s.center[1] - s.size[1] / 2) / MM, top: (s.center[1] + s.size[1] / 2) / MM };
}

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.5);

describe("walls, slabs and openings stand on their level's real elevation", () => {
  it("a Level 2 wall on a 12 ft floor-to-floor model starts at 3657.6 mm", () => {
    const m = showcaseLevels();
    m.ok({ type: "create_elements", idPrefix: "w2", levelId: "level-a2", kind: "wall", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], size: { thicknessMm: 127, heightMm: 9 * FT } });
    const [wall] = solidsOf(m, "w2-1");
    expect(wall).toBeDefined();
    const z = zRange(wall as Solid);
    close(z.bottom, 3657.6);
    close(z.top, 3657.6 + 9 * FT);
  });

  it("a wall tied to the level above runs from its floor to that level", () => {
    const m = showcaseLevels();
    m.ok({ type: "create_elements", idPrefix: "w", levelId: "level-a2", kind: "wall", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], size: { thicknessMm: 203 }, topLevelId: "level-a3" });
    const z = zRange(solidsOf(m, "w-1")[0] as Solid);
    close(z.bottom, 12 * FT);
    close(z.top, 24 * FT);
  });

  it("the Roof level (no number in its name) gets its real elevation", () => {
    const m = showcaseLevels();
    m.ok({ type: "create_elements", idPrefix: "parapet", levelId: "level-a3", kind: "wall", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], size: { thicknessMm: 203, heightMm: 900 } });
    close(zRange(solidsOf(m, "parapet-1")[0] as Solid).bottom, 24 * FT);
  });

  it("slabs produce geometry, each at the top of its own level", () => {
    const m = showcaseLevels();
    const outline = [{ x: 0, y: 0 }, { x: 60 * FT, y: 0 }, { x: 60 * FT, y: 40 * FT }, { x: 0, y: 40 * FT }];
    for (const [id, levelId, thicknessMm] of [["slab-1", "level-a1", 152.4], ["slab-2", "level-a2", 152.4], ["slab-r", "level-a3", 203.2]] as const) {
      m.ok({ type: "create_element", elementId: id, levelId, kind: "slab", placement: { kind: "area", outline }, size: { thicknessMm } });
    }
    const tops = { "slab-1": 0, "slab-2": 12 * FT, "slab-r": 24 * FT };
    for (const [id, top] of Object.entries(tops)) {
      const solids = solidsOf(m, id);
      expect(solids.length).toBeGreaterThan(0);
      const z = zRange(solids[0] as Solid);
      close(z.top, top);
      expect(z.top - z.bottom).toBeGreaterThan(100);
    }
    // The whole-model pass the viewer draws keeps them too.
    const drawn = new Set(modelSolids(m.head).map((s) => s.elementId));
    for (const id of Object.keys(tops)) expect(drawn.has(id as Solid["elementId"])).toBe(true);
  });

  it("a window in a Level 2 wall sits exactly 12 ft above the same window on Level 1", () => {
    const m = showcaseLevels();
    const windowBottom = (levelId: string, prefix: string): number => {
      m.ok({ type: "create_elements", idPrefix: prefix, levelId, kind: "wall", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], size: { thicknessMm: 203, heightMm: 12 * FT } });
      m.ok({ type: "create_hosted", elementId: `${prefix}-win`, kind: "opening", openingType: "window", hostId: `${prefix}-1`, s: 3000, side: 1, size: { widthMm: 1200, heightMm: 1500 } });
      const win = solidsOf(m, `${prefix}-win`);
      expect(win.length).toBeGreaterThan(0);
      return Math.min(...win.map((s) => zRange(s).bottom));
    };
    close(windowBottom("level-a2", "w2") - windowBottom("level-a1", "w1"), 12 * FT);
  });
});
