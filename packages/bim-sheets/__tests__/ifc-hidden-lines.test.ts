/**
 * @jest-environment node
 */
import * as WebIFC from "web-ifc";
import type { ReferencePlan } from "@permitzip/bim-kernel";
import { cutIfcPlan, cutIfcSection } from "../src/ifc-plan";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { IDENTITY4 } from "../src/plan-geometry";
import { FURNITURE_FT, furnitureIfc } from "./fixtures/furniture-ifc";

const FT = 304.8;
const bytes = new TextEncoder().encode(furnitureIfc());

function segments(plan: ReferencePlan, key: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const l of plan.layers) {
    if (`${l.kind}:${l.category}` !== key) continue;
    for (let i = 0; i + 3 < l.segments.length; i += 4) out.push([l.segments[i] ?? 0, l.segments[i + 1] ?? 0, l.segments[i + 2] ?? 0, l.segments[i + 3] ?? 0]);
  }
  return out;
}

/** Furniture linework strictly inside a plan rectangle (ft), sampled along each segment. */
function inside(segs: ReadonlyArray<readonly [number, number, number, number]>, r: { minX: number; maxX: number; minY: number; maxY: number }, insetFt = 0.1): number {
  let n = 0;
  for (const [x1, y1, x2, y2] of segs) {
    for (const t of [0.25, 0.5, 0.75]) {
      const x = (x1 + (x2 - x1) * t) / FT;
      const y = (y1 + (y2 - y1) * t) / FT;
      if (x > r.minX + insetFt && x < r.maxX - insetFt && y > r.minY + insetFt && y < r.maxY - insetFt) n++;
    }
  }
  return n;
}

const chairBox = (c: { cx: number; cy: number }) => ({ minX: c.cx - 0.75, maxX: c.cx + 0.75, minY: c.cy - 0.75, maxY: c.cy + 0.75 });

describe("linked model hidden lines", () => {
  let api: WebIFC.IfcAPI;
  let modelId: number;
  const plan = (extra: { hiddenLines?: boolean; minObjectMm?: number; lowestAboveLevelMm?: number } = {}) =>
    cutIfcPlan(api, modelId, { id: "arch", file: "furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY, ...extra });

  beforeAll(async () => {
    api = new WebIFC.IfcAPI();
    await api.Init();
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  });
  afterAll(() => api.CloseModel(modelId));

  it("draws every chair line through the table when hidden lines are off (the old background)", () => {
    const { plan: p } = plan({ hiddenLines: false });
    expect(inside(segments(p, "projection:IFCFURNITURE"), chairBox(FURNITURE_FT.chairUnder))).toBeGreaterThan(0);
  });

  it("removes the chair under the table and keeps the chair in the open", () => {
    const { plan: p, stats } = plan();
    const furniture = segments(p, "projection:IFCFURNITURE");
    expect(inside(furniture, chairBox(FURNITURE_FT.chairUnder))).toBe(0);
    expect(inside(furniture, chairBox(FURNITURE_FT.chairOpen), -0.01)).toBeGreaterThan(0);
    expect(stats.hiddenStretches).toBeGreaterThan(0);
    // The table's own outline still draws.
    const t = FURNITURE_FT.table;
    const xs = furniture.flatMap(([x1, , x2]) => [x1 / FT, x2 / FT]);
    expect(Math.min(...xs)).toBeCloseTo(t.minX, 1);
  });

  it("leaves out small objects when asked (the cup)", () => {
    const all = plan();
    const simplified = plan({ minObjectMm: 6 * 25.4 });
    expect(simplified.stats.small).toBe(1);
    const cup = { minX: FURNITURE_FT.cup.cx - 0.125, maxX: FURNITURE_FT.cup.cx + 0.125, minY: FURNITURE_FT.cup.cy - 0.125, maxY: FURNITURE_FT.cup.cy + 0.125 };
    expect(inside(segments(all.plan, "projection:IFCFURNISHINGELEMENT"), cup, 0)).toBeGreaterThan(0);
    expect(segments(simplified.plan, "projection:IFCFURNISHINGELEMENT")).toHaveLength(0);
  });

  it("the view's bottom drops what lies wholly below it", () => {
    const high = plan({ lowestAboveLevelMm: 2.6 * FT });
    expect(segments(high.plan, "projection:IFCFURNITURE")).toHaveLength(0);
    expect(segments(high.plan, "projection:IFCFURNISHINGELEMENT").length).toBeGreaterThan(0);
    expect(segments(high.plan, "cut:IFCWALL").length).toBeGreaterThan(0);
  });

  it("a section hides the far wall behind the wall it cuts", () => {
    const at = (hiddenLines: boolean) =>
      cutIfcSection(api, modelId, { id: "arch", file: "furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, hiddenLines, cut: { start: { x: -5 * FT, y: 0.25 * FT }, end: { x: 35 * FT, y: 0.25 * FT }, direction: 1, depthMm: 30 * FT } });
    const open = at(false);
    const hidden = at(true);
    expect(segments(open.plan, "cut:IFCWALL").length).toBeGreaterThan(0);
    // Wall B's face is 15 ft behind wall A, entirely within its cut outline.
    const behind = (p: ReferencePlan) => segments(p, "projection:IFCWALL").filter(([x1, y1, x2, y2]) => Math.min(x1, x2) > 5.5 * FT && Math.max(x1, x2) < 34.5 * FT && Math.min(y1, y2) > 0.5 * FT && Math.max(y1, y2) < 9.5 * FT);
    expect(behind(open.plan).length).toBeGreaterThan(0);
    expect(behind(hidden.plan)).toHaveLength(0);
    expect(hidden.stats.hiddenStretches).toBeGreaterThan(0);
  });
});
