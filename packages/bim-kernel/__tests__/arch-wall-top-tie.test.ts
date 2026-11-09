/**
 * @jest-environment node
 *
 * Architecture follow-ups (A3): a wall's top tied to a level. Drawn "up to
 * Level 2" its height is the floor-to-floor; move Level 2 up a foot and the
 * wall is a foot taller, move Level 1 and it shortens. A wall with a typed
 * height keeps it. Untie it and type a height; tie it back.
 *
 * Fails on the previous code: create_element took no top level, update_level
 * only moved parts and runs, and set_element_placement wrote no height.
 */
import { asElementId, tiedHeightMm, topLevelOf, type BimElement } from "../src";
import type { LinePlacement } from "../src/placement/geometric";
import { element, twoLevels } from "./a13a-fixtures";

const FT = 304.8;
const heightOf = (el: BimElement): number => (el.kind === "wall" ? el.height : NaN);
const LINE = { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } as const;

function drawn() {
  const m = twoLevels();
  m.ok({ type: "create_element", elementId: "tied", kind: "wall", levelId: "L1", placement: LINE, topLevelId: "L2" });
  m.ok({ type: "create_element", elementId: "typed", kind: "wall", levelId: "L1", placement: { ...LINE, start: { x: 0, y: 3000 }, end: { x: 6000, y: 3000 } }, size: { heightMm: 2700 } });
  return m;
}

describe("arch wall top tied to a level", () => {
  it("a wall drawn up to Level 2 is floor to floor and names its top level", () => {
    const m = drawn();
    const w = element(m.head, "tied");
    expect(heightOf(w)).toBe(4000);
    expect(topLevelOf(w, m.head.elements)?.name).toBe("Level 2");
    expect(heightOf(element(m.head, "typed"))).toBe(2700);
  });

  it("moving Level 2 up 1 ft makes the tied wall 1 ft taller; the typed wall keeps its height", () => {
    const m = drawn();
    const cs = m.ok({ type: "update_level", levelId: "L2", elevationMm: 4000 + FT });
    expect(heightOf(element(m.head, "tied"))).toBe(Math.round(4000 + FT));
    expect(heightOf(element(m.head, "typed"))).toBe(2700);
    expect(JSON.stringify(cs)).toContain("tied");
  });

  it("moving the base level shortens it, and a move that puts the top under the base is refused in plain words", () => {
    const m = drawn();
    m.ok({ type: "update_level", levelId: "L1", elevationMm: 1000 });
    expect(heightOf(element(m.head, "tied"))).toBe(3000);
    expect(m.refused({ type: "update_level", levelId: "L2", elevationMm: 500 })).toMatch(/runs up to Level 2; that move would put its top at or below its base/);
  });

  it("untie with a typed height, then tie back with an offset", () => {
    const m = drawn();
    const w = element(m.head, "tied");
    const p = w.kind === "wall" && w.placement?.kind === "line" ? w.placement : null;
    if (!p) throw new Error("tied wall has no line placement");
    const { topLevelId: _top, ...untied } = p;
    m.ok({ type: "set_element_placement", elementId: "tied", placement: untied, heightMm: 3300 });
    expect(heightOf(element(m.head, "tied"))).toBe(3300);
    expect(topLevelOf(element(m.head, "tied"), m.head.elements)).toBeNull();
    m.ok({ type: "update_level", levelId: "L2", elevationMm: 5000 });
    expect(heightOf(element(m.head, "tied"))).toBe(3300);
    m.ok({ type: "set_element_placement", elementId: "tied", placement: { ...untied, topLevelId: "L2", topOffsetMm: -300 } });
    expect(heightOf(element(m.head, "tied"))).toBe(4700);
  });

  it("refuses a top level that isn't above, a height beside a tie, and a top on a kind with no height", () => {
    const m = twoLevels();
    expect(m.refused({ type: "create_element", elementId: "down", kind: "wall", levelId: "L2", placement: LINE, topLevelId: "L1" })).toMatch(/Level 1 isn't above Level 2/);
    expect(m.refused({ type: "create_element", elementId: "both", kind: "wall", levelId: "L1", placement: LINE, topLevelId: "L2", size: { heightMm: 3000 } })).toMatch(/either a height or the level/);
    expect(m.refused({ type: "create_element", elementId: "g", kind: "grid", levelId: "L1", placement: LINE, topLevelId: "L2" })).toMatch(/keeps no height/);
  });

  it("chains take the tie too: every wall of a closed room follows the level", () => {
    const m = twoLevels();
    m.ok({ type: "create_elements", idPrefix: "r", kind: "wall", levelId: "L1", points: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }], closed: true, topLevelId: "L2" });
    m.ok({ type: "update_level", levelId: "L2", elevationMm: 4500 });
    for (const id of ["r-1", "r-2", "r-3", "r-4"]) expect(heightOf(element(m.head, id))).toBe(4500);
  });

  it("tiedHeightMm reads the two levels and the offsets", () => {
    const p: LinePlacement = { kind: "line", levelId: asElementId("a"), topLevelId: asElementId("b"), topOffsetMm: 100, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, startOffsetMm: 50, endOffsetMm: 50, lateral: "center", vertical: "bottom" };
    const elevation = (id: string): number | null => (id === "a" ? 0 : id === "b" ? 3000 : null);
    expect(tiedHeightMm(p, elevation)).toBe(3050);
  });

  it("a model server that doesn't store ties (walls:top_constraint) is sent the height it works out to", () => {
    const m = twoLevels("arch-top-old-peer");
    const oldPeer = (feature: string) => feature !== "walls:top_constraint";
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: LINE, topLevelId: "L2" }, oldPeer);
    const w = element(m.head, "w");
    expect(heightOf(w)).toBe(4000);
    expect(topLevelOf(w, m.head.elements)).toBeNull();
  });
});
