/**
 * @jest-environment node
 *
 * Round 13 lane A13a: doors and windows draw by class
 * (`kernel.class_plan_graphics`). The Architecture add-on's `arch.door` row
 * draws a leaf and a quarter-circle swing from the hinge on the wall face of
 * the side it opens to (a double door two half leaves); `arch.window` draws
 * frame and glass lines; plans read the class row before the kind row. An
 * outside add-on's class row draws its own class with no kernel edit.
 *
 * Fails on round 12's code: there was no class plan graphics point, and a
 * door drew as a mark and a thin line, with no swing.
 */
import type { ModelState } from "../src";
import { planGraphicsContext, planGraphicsOf } from "../src/drawing/plan-graphics";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { CLASS_PLAN_GRAPHICS_POINT, CLASS_POINT, classPlanGraphicsRowProblems } from "../src/registry";
import type { PlanGraphic } from "../src/registry/kind-row-faces";
import { element, twoLevels } from "./a13a-fixtures";

type Arc = Extract<PlanGraphic, { form: "arc" }>;
type Line = Extract<PlanGraphic, { form: "line" }>;

function wallWithOpening(openingType: string, extra: Record<string, unknown> = {}) {
  const m = twoLevels();
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  m.ok({ type: "create_hosted", elementId: "o", kind: "opening", openingType, mark: "101", hostId: "w", s: 3000, side: 1, size: { widthMm: 900, heightMm: 2100 }, ...extra });
  return m;
}

const drawn = (m: ModelState, id: string) => planGraphicsOf(element(m, id), planGraphicsContext(m, { scale: 100, levelId: "L1", detail: "medium", drawing: "view" })) ?? [];
const arcs = (g: readonly PlanGraphic[]) => g.filter((x): x is Arc => x.form === "arc");
const lines = (g: readonly PlanGraphic[]) => g.filter((x): x is Line => x.form === "line");

describe("a13a door swing graphics", () => {
  it("a door swings a quarter circle from its hinge on the face of the side it opens to, with its mark", () => {
    const g = drawn(wallWithOpening("door").head, "o");
    // 45 mm jambs each side -> clear opening 810 mm hinged at x = 2595, y = 100
    expect(arcs(g)).toEqual([{ form: "arc", center: { x: 2595, y: 100 }, radiusMm: 810, startDeg: 0, sweepDeg: 90, pen: "thin" }]);
    expect(g.some((x) => x.form === "polyline" && x.closed && x.points.some((p) => p.x === 2595 && p.y === 910))).toBe(true);
    expect(g.find((x) => x.form === "tag_place")).toMatchObject({ text: "101" });
  });

  it("flipped to the other side, hinged on the right, or a double door", () => {
    expect(arcs(drawn(wallWithOpening("door", { side: -1 }).head, "o"))[0]).toMatchObject({ center: { x: 2595, y: -100 }, sweepDeg: -90 });
    expect(arcs(drawn(wallWithOpening("door", { values: { "architecture.door_operation": "SINGLE_SWING_RIGHT" } }).head, "o"))[0]).toMatchObject({ center: { x: 3405, y: 100 }, startDeg: 180, sweepDeg: -90 });
    const double = arcs(drawn(wallWithOpening("door", { values: { "architecture.door_operation": "DOUBLE_DOOR_SINGLE_SWING" } }).head, "o"));
    expect(double.map((a) => [a.center.x, a.radiusMm])).toEqual([
      [2595, 405],
      [3405, 405],
    ]);
    expect(arcs(drawn(wallWithOpening("door", { values: { "architecture.door_operation": "SLIDING_TO_LEFT" } }).head, "o"))).toEqual([]);
  });

  it("a window draws its frame and glass lines across the gap, no swing", () => {
    const g = drawn(wallWithOpening("window").head, "o");
    expect(arcs(g)).toEqual([]);
    // Outer wall face sill/head lines (±100) across rough opening + double glazing lines (±10) between jambs
    expect(lines(g).map((l) => [l.a.y, l.a.x, l.b.x])).toEqual([
      [100, 2550, 3450],
      [-100, 2550, 3450],
      [10, 2595, 3405],
      [-10, 2595, 3405],
    ]);
  });

  it("an outside add-on's class row draws its own class, with no kernel edit; malformed rows are refused", () => {
    const pack = definePack({ id: "zz", name: "ZZ louvers", version: "1.0.0", kernel: "^1.11.0" }, [
      contribute(CLASS_POINT, [{ id: "zz.louver", label: "Louvers", discipline: "general", recognize: { elementKinds: ["opening"], where: [{ path: "openingType", op: "equals", value: "louver" }] } }]),
      contribute(CLASS_PLAN_GRAPHICS_POINT, [{ classId: "zz.louver", label: "Louver", planGraphics: (el) => [{ form: "text", at: { x: 0, y: 0 }, text: `L ${el.id}`, heightMm: 2, rotationDeg: 0 }] }]),
    ]);
    const m = wallWithOpening("louver");
    expect(drawn(m.head, "o")).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      expect(drawn(m.head, "o")).toEqual([{ form: "text", at: { x: 0, y: 0 }, text: "L o", heightMm: 2, rotationDeg: 0 }]);
    });
    expect(classPlanGraphicsRowProblems([{ classId: "zz.a", label: " ", planGraphics: () => null }])).toEqual(["class plan graphics zz.a has no label"]);
  });
});
