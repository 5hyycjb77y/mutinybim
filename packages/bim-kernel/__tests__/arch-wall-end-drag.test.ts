/**
 * @jest-environment node
 *
 * Architecture follow-ups: drag one end of a wall. In a closed rectangle,
 * dragging the end of the bottom wall carries the corner at that end (the
 * right wall's start goes with it), while the bottom wall's other end and the
 * left wall stay exactly where they were. A wall teed into the dragged wall's
 * face stays on it. Doors keep their place in plan; one that would fall off
 * the shortened wall is refused in words. One Undo puts everything back.
 *
 * Fails on the previous code: there was no single-end move, and the joined
 * carry only knew a rigid move, which drags both ends' corners.
 */
import { joinedEndFollowers, type BimElement, type Vec2 } from "../src";
import { element, twoLevels } from "./a13a-fixtures";

const ROOM: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

const ends = (el: BimElement): [Vec2, Vec2] => {
  if (el.kind !== "wall") throw new Error(`${el.id} is not a wall`);
  return [el.start, el.end];
};

function room() {
  const m = twoLevels("arch-end-drag");
  m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true, size: { thicknessMm: 200 } });
  return m;
}

describe("arch drag one wall end", () => {
  it("dragging the bottom wall's end carries only the corner at that end", () => {
    const m = room();
    const before = Object.fromEntries(["w-1", "w-2", "w-3", "w-4"].map((id) => [id, ends(element(m.head, id))]));
    expect(joinedEndFollowers(m.head.elements, "w-1", "end")).toEqual(["w-2"]);
    m.ok({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 7000, y: 0 } });
    expect(ends(element(m.head, "w-1"))).toEqual([{ x: 0, y: 0 }, { x: 7000, y: 0 }]);
    // The right wall's start followed the corner; its top end stayed.
    expect(ends(element(m.head, "w-2"))).toEqual([{ x: 7000, y: 0 }, before["w-2"]?.[1]]);
    // The far corner and the walls there did not move.
    expect(ends(element(m.head, "w-4"))).toEqual(before["w-4"]);
    expect(ends(element(m.head, "w-3"))).toEqual(before["w-3"]);
  });

  it("the rigid move still carries both corners (unchanged behaviour)", () => {
    const m = room();
    m.ok({ type: "move_wall", wallId: "w-1", delta: { x: 0, y: -500 } });
    expect(ends(element(m.head, "w-2"))[0]).toEqual({ x: 6000, y: -500 });
    expect(ends(element(m.head, "w-4"))[1]).toEqual({ x: 0, y: -500 });
  });

  it("a wall teed into the dragged wall's face stays on it as it turns", () => {
    const m = room();
    m.ok({ type: "create_element", elementId: "tee", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: 100 }, end: { x: 3000, y: 2000 } }, size: { thicknessMm: 200 } });
    expect(joinedEndFollowers(m.head.elements, "w-1", "end")).toContain("tee");
    m.ok({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 6000, y: 600 } });
    const [start] = ends(element(m.head, "tee"));
    // On the turned wall's top face: the face line rises 1 mm per 10 mm from (0, 100).
    expect(start.x).toBe(3000);
    expect(start.y).toBeGreaterThan(100);
    expect(ends(element(m.head, "tee"))[1]).toEqual({ x: 3000, y: 2000 });
  });

  it("doors keep their place in plan; one that would no longer fit is refused; one Undo puts it all back", () => {
    const m = room();
    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", mark: "D1", hostId: "w-1", s: 4000, side: 1, size: { widthMm: 900 } });
    const keep = Object.keys(m.head.elements).sort();
    const cs = m.ok({ type: "move_line_end", elementId: "w-1", end: "start", to: { x: -1000, y: 0 } });
    const d = element(m.head, "d");
    expect(d.kind === "opening" ? [d.offset, d.position] : null).toEqual([5000, { x: 4000, y: 0 }]);
    expect(m.refused({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 4200, y: 0 } })).toMatch(/door D1 would no longer fit/);
    m.ok({ type: "undo", revision: cs.revision });
    expect(Object.keys(m.head.elements).sort()).toEqual(keep);
    expect(ends(element(m.head, "w-1"))).toEqual([{ x: 0, y: 0 }, { x: 6000, y: 0 }]);
    expect(ends(element(m.head, "w-4"))[1]).toEqual({ x: 0, y: 0 });
  });

  it("refuses a too-short wall, a no-op, and a kind with no line, in plain words", () => {
    const m = room();
    expect(m.refused({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 50, y: 0 } })).toMatch(/shorter than 100 mm/);
    expect(m.refused({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 6000, y: 0 } })).toMatch(/already there/);
    expect(m.refused({ type: "move_line_end", elementId: "L1", end: "end", to: { x: 1, y: 1 } })).toMatch(/isn't drawn on a line/);
  });

  it("disjoin leaves the corner open", () => {
    const m = room();
    m.ok({ type: "move_line_end", elementId: "w-1", end: "end", to: { x: 7000, y: 0 }, disjoin: true });
    expect(ends(element(m.head, "w-2"))[0]).toEqual({ x: 6000, y: 0 });
  });
});
