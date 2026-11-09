/**
 * @jest-environment node
 *
 * Round 13 lane A13a: roofs and stairs are the Architecture add-on's own
 * kinds (`architecture.roof`, `architecture.stair`), drawn by
 * `create_element` through their rows' create faces, with plan graphics and
 * a body. A roof is a footprint with a thickness and a stored slope; a stair
 * is one straight run whose risers and treads come from the level-to-level
 * height. The kernel names neither.
 *
 * Fails on round 12's code: neither kind existed (no rows, no create face,
 * no create command).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorOf, kindRowOf } from "../src";
import { elementSolid } from "../src/drawing/solids";
import { planGraphicsContext, planGraphicsOf } from "../src/drawing/plan-graphics";
import { asStair, stairGeometry } from "@permitzip/bim-pack-architecture";
import { element, twoLevels } from "./a13a-fixtures";

const RECT = [
  { x: 0, y: 0 },
  { x: 10_000, y: 0 },
  { x: 10_000, y: 8000 },
  { x: 0, y: 8000 },
];

const ctx = (m: ReturnType<typeof twoLevels>, levelId = "L1") => planGraphicsContext(m.head, { scale: 100, levelId, detail: "medium", drawing: "view" });

describe("a13a roof and stair kinds", () => {
  it("the kinds are the add-on's rows, not the kernel's", () => {
    expect(kindRowOf("architecture.roof")?.label).toBe("Roof");
    expect(kindRowOf("architecture.stair")?.label).toBe("Stair");
    const kernelKinds = readFileSync(path.join(__dirname, "..", "src", "registry", "element-kinds.ts"), "utf8");
    expect(kernelKinds).not.toMatch(/roof|stair/);
  });

  it("a roof is drawn as an area on a level with its thickness and slope, and has a body over its footprint", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", size: { thicknessMm: 300 }, values: { "architecture.slope_rise": 0.25 }, placement: { kind: "area", outline: RECT } });
    const roof = element(m.head, "r");
    expect(roof).toMatchObject({ kind: "architecture.roof", levelId: "L2", outline: RECT, thicknessMm: 300, baseOffsetMm: 0, slope: { directionDeg: 90, rise: 0.25 } });
    expect(anchorOf(roof)).toEqual({ x: 5000, y: 4000 });
    const body = elementSolid(m.head, roof, 0);
    expect(body?.pieces).toHaveLength(1);
    expect(body?.pieces[0]?.r0[0]?.z).toBe(4000);
    expect(body?.pieces[0]?.r1[0]?.z).toBe(4300);
    const g = planGraphicsOf(roof, ctx(m, "L2")) ?? [];
    expect(g[0]).toMatchObject({ form: "polyline", closed: true, points: RECT });
    expect(g.find((x) => x.form === "text")).toMatchObject({ text: "3 in 12" });
    expect(m.refused({ type: "create_element", elementId: "r2", kind: "architecture.roof", levelId: "L2", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } })).toBe("A roof is drawn as an area, not on a line");
  });

  it("a stair rises from its level to the one above: risers at most 178 mm, treads share the run, a stepped body", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", size: { widthMm: 1200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6160, y: 0 } } });
    const stair = asStair(element(m.head, "s"));
    if (!stair) throw new Error("not a stair");
    const g = stairGeometry(stair, m.head.elements);
    expect(g).toMatchObject({ heightMm: 4000, runMm: 6160, risers: 23, treads: 22, topLevelId: "L2" });
    expect(g?.riserMm).toBeCloseTo(173.91, 2);
    expect(g?.treadMm).toBeCloseTo(280, 6);
    const body = elementSolid(m.head, element(m.head, "s"), 0);
    expect(body?.pieces).toHaveLength(22);
    expect(body?.pieces[21]?.r1[0]?.z).toBeCloseTo(22 * (4000 / 23), 6);
    const plan = planGraphicsOf(element(m.head, "s"), ctx(m)) ?? [];
    expect(plan.filter((x) => x.form === "line")).toHaveLength(21 + 1);
    expect(plan.find((x) => x.form === "text")).toMatchObject({ text: "UP" });
  });

  it("asked risers win; a stair on the top level is refused in words", () => {
    const m = twoLevels();
    m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", values: { "architecture.risers": 25 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 6000 } } });
    const stair = asStair(element(m.head, "s"));
    expect(stair && stairGeometry(stair, m.head.elements)?.risers).toBe(25);
    expect(m.refused({ type: "create_element", elementId: "t", kind: "architecture.stair", levelId: "L2", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } })).toBe(
      "A stair rises to the level above, and this level has none; add a level above or pick the level it rises to",
    );
  });
});
