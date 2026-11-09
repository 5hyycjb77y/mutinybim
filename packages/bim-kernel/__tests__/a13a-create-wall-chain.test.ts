/**
 * @jest-environment node
 *
 * Round 13 lane A13a: walls join. Four clicks (`create_elements`, closed)
 * make four walls that share ends; at each corner one runs to the outer
 * corner and the other stops at its inner face, so the outline closes with
 * no overlap and no notch, and the plan draws no line across a clean
 * corner. A wall ending on another's face tees into it; "Disallow join"
 * leaves an end free; an edit re-joins only what sits at the edited ends,
 * from the index carried to the new revision.
 *
 * Fails on round 12's code: no create command, and `endCleanupsOf` refused
 * ("Clean corners where walls meet aren't built yet").
 */
import { asElementId, elementsFromRows, elementValues, type ElementId, type ModelState, type Vec2 } from "../src";
import { endCleanupsOf, type EndCleanup } from "../src/joins/point";
import { lineJoinsOf } from "../src/joins/solve";
import { lineJoinPlanGraphics } from "../src/joins/plan";
import type { PlanGraphic, PlanGraphicsContext } from "../src/registry/kind-row-faces";
import { element, twoLevels } from "./a13a-fixtures";

const ROOM: Vec2[] = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

function cleanups(m: ModelState, id: string): readonly EndCleanup[] {
  const r = endCleanupsOf(m, asElementId(id));
  if (!Array.isArray(r)) throw new Error(`no cleanups for ${id}`);
  return r;
}

function ctx(m: ModelState): PlanGraphicsContext {
  return { elements: m.elements, scale: 100, levelId: "L1", detail: "medium", drawing: "view", lookingUp: false, connectedTo: () => null };
}

const area = (pts: readonly Vec2[]): number => Math.abs(pts.reduce((s, a, i) => { const b = pts[(i + 1) % pts.length] as Vec2; return s + a.x * b.y - b.x * a.y; }, 0) / 2);

function chain() {
  const m = twoLevels();
  m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: ROOM, closed: true, size: { thicknessMm: 200 } });
  return m;
}

describe("a13a create wall chain", () => {
  it("four clicks make four walls sharing ends that butt at every corner, and the outlines close with no overlap", () => {
    const m = chain();
    for (const [id, prev, next] of [["w-1", "w-4", "w-2"], ["w-2", "w-1", "w-3"], ["w-3", "w-2", "w-4"], ["w-4", "w-3", "w-1"]] as const) {
      const [start, end] = cleanups(m.head, id);
      expect([start?.style, start?.with]).toEqual(["butt", [prev]]);
      expect([end?.style, end?.with]).toEqual(["butt", [next]]);
    }
    // Outer edge 6.2 x 4.2 m, inner 5.8 x 3.8 m: the four bodies tile the ring exactly.
    const total = ["w-1", "w-2", "w-3", "w-4"].reduce((s, id) => s + area(lineJoinsOf(m.head.elements, id)?.outline ?? []), 0);
    expect(total).toBeCloseTo(6200 * 4200 - 5800 * 3800, 3);
    // w-1 outranks w-2 (same thickness, lower id): it runs to the outer corner, w-2 stops at its inner face.
    expect(lineJoinsOf(m.head.elements, "w-1")?.faces).toMatchObject({ endLeft: 6100, endRight: 6100 });
    expect(lineJoinsOf(m.head.elements, "w-2")?.faces).toMatchObject({ startLeft: 100, startRight: 100 });
  });

  it("the plan draws both faces of each wall with no end line at a clean corner", () => {
    const m = chain();
    const g = lineJoinPlanGraphics(element(m.head, "w-1"), ctx(m.head)) as readonly PlanGraphic[];
    expect(g.filter((x) => x.form === "line")).toHaveLength(2);
    const lone = twoLevels();
    lone.ok({ type: "create_element", elementId: "solo", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    expect(lineJoinPlanGraphics(element(lone.head, "solo"), ctx(lone.head))).toBeNull();
  });

  it("a wall ending on another's face tees into it; the through wall is untouched", () => {
    const m = chain();
    m.ok({ type: "create_element", elementId: "t", kind: "wall", levelId: "L1", size: { thicknessMm: 100 }, placement: { kind: "line", start: { x: 3000, y: 0 }, end: { x: 3000, y: 2000 } } });
    const [start, end] = cleanups(m.head, "t");
    expect([start?.style, start?.with, end?.style]).toEqual(["tee", ["w-1"], "free"]);
    expect(lineJoinsOf(m.head.elements, "t")?.faces).toMatchObject({ startLeft: 100, startRight: 100 });
    expect(cleanups(m.head, "w-1").map((c) => c.style)).toEqual(["butt", "butt"]);
  });

  it("Disallow join leaves both ends at that corner free", () => {
    const m = chain();
    m.ok({ type: "set_element_values", elementIds: ["w-4"], values: { "join.disallow_end": true } });
    expect(cleanups(m.head, "w-4")[1]?.style).toBe("free");
    expect(cleanups(m.head, "w-1")[0]?.style).toBe("free");
    expect(cleanups(m.head, "w-2")[0]?.style).toBe("butt");
  });

  it("an edit re-joins from the carried index: moving one wall away frees exactly its neighbours' ends, same as a fresh build", () => {
    const m = chain();
    lineJoinsOf(m.head.elements, "w-1");
    m.ok({ type: "set_element_placement", elementId: "w-3", placement: { kind: "line", levelId: "L1", start: { x: 6000, y: 9000 }, end: { x: 0, y: 9000 }, startOffsetMm: 0, endOffsetMm: 0, lateral: "center", vertical: "bottom" } });
    const carried = (id: string) => lineJoinsOf(m.head.elements, id)?.cleanups.map((c) => c.style);
    const fresh = elementsFromRows(elementValues(m.head.elements));
    const rebuilt = (id: string) => lineJoinsOf(fresh, id)?.cleanups.map((c) => c.style);
    expect(carried("w-2")).toEqual(["butt", "free"]);
    expect(carried("w-4")).toEqual(["free", "butt"]);
    expect(carried("w-3")).toEqual(["free", "free"]);
    for (const id of ["w-1", "w-2", "w-3", "w-4"]) expect(carried(id)).toEqual(rebuilt(id));
  });

  it("a 10 mm nudge of an exterior wall keeps its corners and its tee joined, and the ring still closes", () => {
    const m = chain();
    m.ok({ type: "create_element", elementId: "t", kind: "wall", levelId: "L1", size: { thicknessMm: 100 }, placement: { kind: "line", start: { x: 3000, y: 0 }, end: { x: 3000, y: 2000 } } });
    m.ok({ type: "move_wall", wallId: "w-1", delta: { x: 0, y: -10 } });
    expect(cleanups(m.head, "w-1").map((c) => [c.style, c.with])).toEqual([
      ["butt", ["w-4"]],
      ["butt", ["w-2"]],
    ]);
    expect(cleanups(m.head, "w-2")[0]?.style).toBe("butt");
    expect(cleanups(m.head, "t")[0]?.style).toBe("tee");
    // Round 16: the corner neighbour and the tee follow the moved wall 10 mm down (joins/carry.ts),
    // so they stop on its faces exactly where they did before the move, and no gap opens.
    const w2 = element(m.head, "w-2");
    const t = element(m.head, "t");
    expect(w2.kind === "wall" ? w2.start : null).toEqual({ x: 6000, y: -10 });
    expect(t.kind === "wall" ? t.start : null).toEqual({ x: 3000, y: -10 });
    expect(lineJoinsOf(m.head.elements, "w-2")?.faces.startLeft).toBeCloseTo(100, 6);
    expect(lineJoinsOf(m.head.elements, "w-2")?.faces.startRight).toBeCloseTo(100, 6);
    expect(lineJoinsOf(m.head.elements, "t")?.faces.startLeft).toBeCloseTo(100, 6);
    expect(lineJoinsOf(m.head.elements, "t")?.faces.startRight).toBeCloseTo(100, 6);
  });

  it("refuses in words for an element that doesn't join", () => {
    const m = chain();
    m.ok({ type: "create_element", elementId: "g", kind: "grid", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 1 } } });
    expect(endCleanupsOf(m.head, "g" as ElementId)).toEqual({ refused: "g doesn't join others: no add-on in this model says how a grid's ends meet" });
  });
});
