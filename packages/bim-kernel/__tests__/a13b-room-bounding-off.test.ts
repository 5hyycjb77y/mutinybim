/**
 * @jest-environment node
 *
 * A13b: whether a wall bounds rooms is a parameter, not a kind case. A wall
 * whose type says `room_bounding = false` (a low partition, a glass screen
 * you want inside one room), or whose own instance value says so, doesn't
 * bound: the two rooms it would split read as one. Switching the type back
 * on re-asks only that type's walls (by changed ids).
 *
 * Fails on round 12's code: there is no boundary index or face walk, and
 * `boundarySegmentsOnLevel` refuses as not built.
 */
import { asElementId, carryRevision, type BimElement } from "../src";
import { withPackSet } from "../src/packs";
import { boundarySegmentsOnLevel } from "../src/spaces/boundaries/point";
import { boundaryIndexStats } from "../src/spaces/boundaries/boundary-index";
import { roomAt } from "../src/spaces/boundaries/room-at";
import { outlineAreaMm2 } from "../src/spaces/space-geometry";
import { box, L1, modelWith, wall, BUILTINS } from "./a13b-fixtures";

const run = <T>(fn: () => T): T => withPackSet(BUILTINS, fn);
const screenType = (bounds: boolean): BimElement => ({ id: asElementId("t-screen"), kind: "element_type", version: 1, authoredRev: {}, name: "Glass screen", values: { room_bounding: bounds } }) as BimElement;
const area = (m: ReturnType<typeof modelWith>, seed: { x: number; y: number }): number => {
  const r = run(() => roomAt(m.elements, L1, seed));
  if (!r.ok) throw new Error("not closed");
  return outlineAreaMm2(r.outline) / 1e6;
};

describe("a13b room bounding off", () => {
  const walls = box("w", 0, 0, 6000, 4000);
  const screen = (extra: Record<string, unknown>) => wall("w-mid", { x: 3000, y: 0 }, { x: 3000, y: 4000 }, extra);

  it("a wall bounds by default: the screen splits the room", () => {
    const m = modelWith([...walls, screen({})]);
    expect(area(m, { x: 1000, y: 2000 })).toBeCloseTo(2.8 * 3.8, 6);
  });

  it("its type's room_bounding = false: it doesn't bound, one room", () => {
    const m = modelWith([...walls, screenType(false), screen({ typeId: "t-screen" })]);
    expect(area(m, { x: 1000, y: 2000 })).toBeCloseTo(5.8 * 3.8, 6);
    expect(run(() => boundarySegmentsOnLevel(m, L1))).toHaveLength(8);
  });

  it("the instance's own room_bounding = false wins over a type that bounds", () => {
    const m = modelWith([...walls, screenType(true), screen({ typeId: "t-screen", values: { room_bounding: false } })]);
    expect(area(m, { x: 1000, y: 2000 })).toBeCloseTo(5.8 * 3.8, 6);
  });

  it("switching the type back on splits it again, carried by the type's id alone", () => {
    const m = modelWith([...walls, screenType(false), screen({ typeId: "t-screen" })], "a13b-type-carry");
    expect(area(m, { x: 1000, y: 2000 })).toBeCloseTo(5.8 * 3.8, 6);
    const next = { ...m, elements: { ...m.elements, "t-screen": screenType(true) } };
    run(() => carryRevision(m.elements, next.elements, ["t-screen"]));
    expect(area(next, { x: 1000, y: 2000 })).toBeCloseTo(2.8 * 3.8, 6);
    expect(run(() => boundaryIndexStats(next.elements)).levelBuilds).toBe(1);
  });
});
