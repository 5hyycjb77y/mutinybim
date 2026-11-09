/**
 * @jest-environment node
 *
 * Round 13 lane M13 (M12 step 3): a duct in the space above a ceiling keeps
 * 2 in under any ceiling that reaches above its bottom. The ceiling it runs
 * over is not a problem; a raised step that cuts through the duct, and one
 * that leaves less than 2 in over its top, are each reported once with the
 * height to drop to. Ceilings are read through the ceiling index at points
 * along the span only.
 *
 * Fails on round 12's code: `checkRouteSpan` refused every span.
 */
import { checkRouteSpan, ROUTE_CONSTRAINT_POINT, type RouteConstraintHit, type RouteSpan } from "@permitzip/bim-kernel/rated-routes";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_ROUTE_RULES } from "../src/constraints/rated-crossings";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

const SET = PackSet.create([definePack({ id: "mechanical", name: "Mechanical (route rules)", version: "1.0.0", kernel: "^1.0.0", firstParty: true }, [contribute(ROUTE_CONSTRAINT_POINT, MECHANICAL_ROUTE_RULES)])]);
const DUCT: RouteSpan = { kind: "run_segment", serviceId: "supply_air", levelId: "L1", start: { x: 500, y: 0 }, end: { x: 5500, y: 0 }, bottomMm: 2800, topMm: 3100, widthMm: 400 };

const rect = (x0: number, x1: number) => [
  { x: x0, y: -2000 },
  { x: x1, y: -2000 },
  { x: x1, y: 2000 },
  { x: x0, y: 2000 },
];

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

function ceilings() {
  const m = twoLevels("m12-clearance");
  m.ok({
    type: "create_ceiling",
    ceilings: [
      { ceilingId: "c-main", levelId: "L1", outline: rect(0, 6000), heightMm: 2700 },
      { ceilingId: "c-step-high", levelId: "L1", outline: rect(2000, 3000), heightMm: 3000 },
      { ceilingId: "c-step-close", levelId: "L1", outline: rect(4000, 5000), heightMm: 3140 },
    ],
  });
  return m.head;
}

describe("m12 step ceiling clearance", () => {
  it("the ceiling it runs over passes; a step through the duct and one within 2 in of its top are each flagged once", () => {
    withPackSet(SET, () => {
      const found = hits(checkRouteSpan(ceilings(), DUCT));
      expect(found.map((h) => h.hostId)).toEqual(["c-step-high", "c-step-close"]);
      expect(found.every((h) => h.ruleId === "mechanical.duct_ceiling_clearance")).toBe(true);
      expect(found[0]?.message).toMatch(/^The ceiling at 9\.84 ft comes down through the run \(its top is at 10\.17 ft\): drop the run to 9\.68 ft or lower here$/);
      expect(found[1]?.message).toMatch(/^The run's top is 0\.13 ft under the ceiling at 10\.3 ft; Duct clearance under ceilings keeps 0\.17 ft: drop the run to 10\.14 ft or lower here$/);
    });
  });

  it("dropped below the steps it passes; a pipe gets nothing from Mechanical's rule", () => {
    withPackSet(SET, () => {
      expect(hits(checkRouteSpan(ceilings(), { ...DUCT, bottomMm: 2400, topMm: 2640 }))).toEqual([]);
      expect(hits(checkRouteSpan(ceilings(), { ...DUCT, serviceId: "domestic_cold_water" }))).toEqual([]);
    });
  });
});
