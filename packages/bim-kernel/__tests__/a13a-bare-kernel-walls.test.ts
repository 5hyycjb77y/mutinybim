/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 13 lane A13a (the product owner's decision 3): with the Architecture add-on off,
 * walls, doors and windows still classify (the kernel's fallback
 * `gen.building_element`), draw, join, cut their host and say where their
 * types come from. A stored add-on class is kept, never rewritten.
 *
 * Fails on round 12's code: there was no fallback class (a bare kernel
 * still carried `arch.*` itself), no note, no joins and no voids.
 */
import { elementClass, fieldProviderRegistry, type ModelState } from "../src";
import { BUILDING_FALLBACK_CLASS_ID } from "../src/registry";
import { addonOffNote } from "../src/elements/building-fallback";
import { elementSolid } from "../src/drawing/solids";
import { endCleanupsOf } from "../src/joins/point";
import { voidsOf } from "../src/hosting/void-point";
import { installedFirstPartyPacks } from "../src/packs";
import { element, twoLevels } from "./a13a-fixtures";

const ROOM = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

describe("a13a bare kernel walls", () => {
  it("runs with no add-on installed, and the field registry builds without the building classes", () => {
    expect(installedFirstPartyPacks()).toEqual([]);
    expect(() => fieldProviderRegistry()).not.toThrow();
    expect(fieldProviderRegistry().getClass("arch.wall")).toBeUndefined();
  });

  it("walls and a door classify under the fallback, draw, join, cut and carry the note", () => {
    const m = twoLevels();
    m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true });
    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w-1", s: 1500, side: 1, size: { widthMm: 900 } });
    const wall = element(m.head, "w-1");
    const door = element(m.head, "d");
    expect(elementClass(m.head.elements, wall)).toBe(BUILDING_FALLBACK_CLASS_ID);
    expect(elementClass(m.head.elements, door)).toBe(BUILDING_FALLBACK_CLASS_ID);
    expect("classId" in wall).toBe(false);
    expect(addonOffNote(wall, m.head.elements)).toBe("Types and rules for this wall come from the Architecture add-on, which isn't on");
    expect(addonOffNote(door, m.head.elements)).toBe("Types and rules for this door come from the Architecture add-on, which isn't on");
    const ends = endCleanupsOf(m.head, wall.id);
    expect(Array.isArray(ends) && ends.map((e) => e.style)).toEqual(["butt", "butt"]);
    const voids = voidsOf(m.head, wall.id);
    expect(Array.isArray(voids) && voids.length).toBe(1);
    expect(elementSolid(m.head, wall, 0)?.pieces.length).toBe(3);
  });

  it("a wall stored with an add-on class keeps it through an edit", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    const stored = element(m.head, "w");
    const withClass: ModelState = { ...m.head, elements: { ...m.head.elements, w: { ...stored, classId: "arch.wall", classSource: "recognised" } as typeof stored } };
    const again = twoLevels();
    again.head = withClass;
    again.ok({ type: "move_wall", wallId: "w", delta: { x: 100, y: 0 } });
    expect(element(again.head, "w")).toMatchObject({ classId: "arch.wall", classSource: "recognised", start: { x: 100, y: 0 } });
    expect(addonOffNote(element(again.head, "w"), again.head.elements)).toBe("Types and rules for this wall come from the Architecture add-on, which isn't on");
  });
});
