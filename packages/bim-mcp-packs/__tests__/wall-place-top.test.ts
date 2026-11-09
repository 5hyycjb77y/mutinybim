/**
 * @jest-environment node
 *
 * bim_set_element `place` on a wall keeps the wall's top and base as they are
 * (tied to a level, or bound to the structure above and the floor under it),
 * so moving a wall never unties it. Scripts set a wall's top and base
 * (`building.walls` top / base, wall-top-base.test.ts); the tool's schema
 * stays inside the host's token budget and matches its registered tool
 * snapshot. Fails on the code before #3412: `place` built a line with no top,
 * so a wall moved by an agent lost its tie to Level 2 and its surface bindings.
 */
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { buildSetElement, PART_EDIT_ARGS } from "../src/parts/parts";

const FT = 304.8;
const FLOOR = [
  { x: 0, y: 0 },
  { x: 10_000, y: 0 },
  { x: 10_000, y: 8000 },
  { x: 0, y: 8000 },
];

function model() {
  const m = twoLevels("wall-place-top");
  m.ok({ type: "create_element", elementId: "f2", kind: "slab", levelId: "L2", placement: { kind: "area", outline: FLOOR }, size: { thicknessMm: 200 } });
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 1000, y: 1000 }, end: { x: 7000, y: 1000 } }, topLevelId: "L2", topOffsetMm: -100 });
  return m;
}

const build = (m: ReturnType<typeof model>, place: Record<string, unknown>) => buildSetElement(PART_EDIT_ARGS.bim_set_element.parse({ element_ids: ["w"], place }), m.head, "k", null);
const wall = (m: ReturnType<typeof model>) => {
  const w = m.head.elements.w;
  if (w?.kind !== "wall" || w.placement?.kind !== "line") throw new Error("no wall");
  return { height: w.height, placement: w.placement };
};
const POINTS = [
  { x: 2, y: 2 },
  { x: 20, y: 2 },
];

describe("bim_set_element place: a wall's top and base", () => {
  it("moving a wall keeps its top tied to Level 2 with its offset", () => {
    const m = model();
    const built = build(m, { kind: "line", level: "Level 1", points_ft: POINTS });
    if (!built.ok) throw new Error(built.message);
    m.ok(built.command);
    expect(wall(m).placement.topLevelId).toBe("L2");
    expect(wall(m).height).toBe(3900);
  });

  it("moving a wall bound to the structure above and the floor under it keeps both bindings", () => {
    const m = model();
    m.ok({ type: "create_element", elementId: "w2", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 1000, y: 3000 }, end: { x: 7000, y: 3000 } }, topSurface: { to: "structure", offsetMm: -25.4 }, baseSurface: { to: "floor" } });
    const built = buildSetElement(PART_EDIT_ARGS.bim_set_element.parse({ element_ids: ["w2"], place: { kind: "line", level: "Level 1", points_ft: [{ x: 2, y: 12 }, { x: 20, y: 12 }] } }), m.head, "k", null);
    if (!built.ok) throw new Error(built.message);
    m.ok(built.command);
    const w2 = m.head.elements.w2;
    if (w2?.kind !== "wall" || w2.placement?.kind !== "line") throw new Error("no wall");
    expect(w2.placement.topSurface).toEqual({ to: "structure", offsetMm: -25.4 });
    expect(w2.placement.baseSurface).toEqual({ to: "floor" });
    expect(w2.placement.start).toEqual({ x: 2 * FT, y: 12 * FT });
  });
});
