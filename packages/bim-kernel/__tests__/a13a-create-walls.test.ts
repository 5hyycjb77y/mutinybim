/**
 * @jest-environment node
 *
 * Round 13 lane A13a: the create family. `create_elements` draws a chain of
 * walls whose neighbours share ends (so joins can form), on a level, in
 * their partition; `create_element` draws one; `create_hosted` puts a door
 * in a wall. Undo takes the model back exactly. Refusals say what to do in
 * words, and a peer that doesn't advertise `elements:create` is never sent
 * a drawn element.
 *
 * Fails on round 12's code: `create_element`, `create_elements` and
 * `create_hosted` didn't parse; walls arrived only by IFC import or the
 * `add_architecture` tracer.
 */
import { canonicalJson, ELEMENTS_CREATE_FEATURE, type Wall } from "../src";
import { twoLevels } from "./a13a-fixtures";

const ROOM = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

function wall(m: ReturnType<typeof twoLevels>, id: string): Wall {
  const el = m.head.elements[id];
  if (el?.kind !== "wall") throw new Error(`${id} is not a wall`);
  return el;
}

describe("a13a create walls", () => {
  it("create_elements makes N walls sharing ends on the level, and undo restores the model exactly", () => {
    const m = twoLevels();
    const before = canonicalJson(m.head.elements);
    const cs = m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true, size: { thicknessMm: 200, heightMm: 3000 } });
    const walls = [1, 2, 3, 4].map((i) => wall(m, `w-${i}`));
    for (let i = 0; i < 4; i++) {
      const a = walls[i] as Wall;
      const b = walls[(i + 1) % 4] as Wall;
      expect(a.end).toEqual(b.start);
    }
    expect(walls.map((w) => [w.start, w.end])).toEqual(ROOM.map((p, i) => [p, ROOM[(i + 1) % 4]]));
    for (const w of walls) {
      expect(w).toMatchObject({ thickness: 200, height: 3000, placement: { kind: "line", levelId: "L1", lateral: "center" }, partition: { level: "Level 1" } });
      expect(w.classId).toBeDefined();
    }
    expect(m.head.elements["w-5"]).toBeUndefined();
    m.ok({ type: "undo", revision: cs.revision });
    expect(canonicalJson(m.head.elements)).toBe(before);
  });

  it("an open chain of three corners makes two walls; one wall with create_element; a door goes in a wall", () => {
    const m = twoLevels();
    m.ok({ type: "create_elements", idPrefix: "a", kind: "wall", levelId: "L1", points: ROOM.slice(0, 3) });
    expect(["a-1", "a-2", "a-3"].map((id) => m.head.elements[id]?.kind)).toEqual(["wall", "wall", undefined]);
    m.ok({ type: "create_element", elementId: "solo", kind: "wall", levelId: "L2", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    expect(wall(m, "solo")).toMatchObject({ thickness: 150, placement: { levelId: "L2" }, partition: { level: "Level 2" } });
    const door = m.ok({ type: "create_hosted", elementId: "d-1", kind: "opening", openingType: "door", mark: "101", hostId: "a-1", s: 1500, side: -1, size: { widthMm: 900 } });
    expect(m.head.elements["d-1"]).toMatchObject({ kind: "opening", openingType: "door", hostId: "a-1", offset: 1500, width: 900, height: 2134, position: { x: 1500, y: 0 }, values: { "host.side": -1 } });
    const before = canonicalJson(m.head.elements);
    m.ok({ type: "undo", revision: door.revision });
    expect(m.head.elements["d-1"]).toBeUndefined();
    m.ok({ type: "undo", revision: m.log[m.log.length - 1]?.revision ?? 0 });
    expect(canonicalJson(m.head.elements)).toBe(before);
  });

  it("refuses in words", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "s-1", kind: "slab", levelId: "L1", placement: { kind: "area", outline: ROOM } });
    m.ok({ type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 2000, y: 0 } } });
    expect(m.refused({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "s-1", s: 500, side: 1, size: { widthMm: 900 } })).toBe("A door needs a wall to sit in; click a wall");
    expect(m.refused({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "window", hostId: "nowhere", s: 500, side: 1, size: { widthMm: 900 } })).toBe("A window needs a wall to sit in; click a wall");
    expect(m.refused({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w-1", s: 1800, side: 1, size: { widthMm: 900 } })).toBe(
      "The door is 900 mm wide and doesn't fit there: the wall is 2000 mm long. Move it along the wall or make it narrower",
    );
    expect(m.refused({ type: "create_elements", idPrefix: "z", kind: "wall", levelId: "L1", points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }] })).toBe("Corners 1 and 2 are the same point; each wall needs two different points");
    expect(m.refused({ type: "create_element", elementId: "z", kind: "wall", levelId: "nope", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } })).toBe("A wall can't go on nope: it isn't a level in this model");
    expect(m.refused({ type: "create_element", elementId: "z", kind: "wall", levelId: "L1", placement: { kind: "area", outline: ROOM } })).toBe("A wall is drawn on a line, not as an area");
    expect(m.refused({ type: "create_element", elementId: "z", kind: "space", levelId: "L1", placement: { kind: "area", outline: ROOM } })).toBe("Spaces aren't drawn here; make one with create_space");
    expect(m.refused({ type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } })).toBe("w-1 already exists; choose a new id");
    expect(m.refused({ type: "create_element", elementId: "z", kind: "zz.partition", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } })).toMatch(/^There is no "zz.partition" kind in this model/);
  });

  it("a peer that doesn't advertise elements:create is never sent a drawn element", () => {
    const m = twoLevels();
    const older = (f: string) => f !== ELEMENTS_CREATE_FEATURE;
    expect(m.refused({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true }, older)).toBe(
      "A wall can't be drawn yet: the model server this model is open on is an older version that doesn't take drawn elements. Try again once the server is updated",
    );
    expect(Object.values(m.head.elements).some((e) => e.kind === "wall")).toBe(false);
  });
});
