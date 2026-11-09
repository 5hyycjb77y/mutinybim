/**
 * @jest-environment node
 *
 * Round 13 (product decision, Nov 4): duct-to-ceiling clearance is a design limit, 2 in
 * by default, editable by the firm and the project and per system, with its
 * source. Fails on the round 13 build before this change: the rule's 2 in
 * was fixed, so a firm's 1 in or a project's 3 in for exhaust changed nothing
 * and the words never said where the number came from.
 */
import { checkRouteSpan, ROUTE_CONSTRAINT_POINT, type RouteConstraintHit, type RouteSpan } from "@permitzip/bim-kernel/rated-routes";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "@permitzip/bim-kernel/packs";
import { DESIGN_LIMIT_DEFAULT_POINT, type DesignLimit } from "@permitzip/bim-kernel/policy";
import { MECHANICAL_ROUTE_RULES } from "../src/constraints/rated-crossings";
import { DUCT_CEILING_CLEARANCE_LIMIT_ID, MECHANICAL_DESIGN_LIMIT_DEFAULTS } from "../src/design-limits";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

const SET = PackSet.create([
  definePack({ id: "mechanical", name: "Mechanical (route rules + limits)", version: "1.0.0", kernel: "^1.0.0", firstParty: true }, [
    contribute(ROUTE_CONSTRAINT_POINT, MECHANICAL_ROUTE_RULES),
    contribute(DESIGN_LIMIT_DEFAULT_POINT, MECHANICAL_DESIGN_LIMIT_DEFAULTS),
  ]),
]);
const SUPPLY: RouteSpan = { kind: "run_segment", serviceId: "supply_air", levelId: "L1", start: { x: 500, y: 0 }, end: { x: 5500, y: 0 }, bottomMm: 2800, topMm: 3100, widthMm: 400 };
const EXHAUST: RouteSpan = { ...SUPPLY, serviceId: "exhaust_air" };

const rect = (x0: number, x1: number) => [
  { x: x0, y: -2000 },
  { x: x1, y: -2000 },
  { x: x1, y: 2000 },
  { x: x0, y: 2000 },
];

/** One step ceiling 40 mm (1.57 in) above the duct's top. */
function model() {
  const m = twoLevels("m13-clearance-limit");
  m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "c-step", levelId: "L1", outline: rect(2000, 3000), heightMm: 3140 }] });
  return m.head;
}

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

const base = MECHANICAL_DESIGN_LIMIT_DEFAULTS[0] as DesignLimit;

describe("m13 duct clearance is a design limit", () => {
  it("the add-on's 2 in default binds and the words name its source", () => {
    withPackSet(SET, () => {
      const found = hits(checkRouteSpan(model(), SUPPLY));
      expect(found.map((h) => [h.hostId, h.basis?.limitId, h.basis?.layer])).toEqual([["c-step", DUCT_CEILING_CLEARANCE_LIMIT_ID, "addon"]]);
      expect(found[0]?.message).toMatch(/keeps 0\.17 ft \(PermitZIP practice/);
    });
  });

  it("the firm's 1 in replaces it by id; the project's 3 in for exhaust binds for exhaust only", () => {
    withPackSet(SET, () => {
      const firm: DesignLimit[] = [{ ...base, band: { min: 1 }, citation: { source: "Firm standard" } }];
      const project: DesignLimit[] = [{ ...base, id: `${DUCT_CEILING_CLEARANCE_LIMIT_ID}.exhaust_air`, appliesTo: { discipline: "mechanical", systems: ["exhaust_air"] }, band: { min: 3 }, citation: { source: "Owner's spec 23 31 00" } }];
      expect(hits(checkRouteSpan(model(), SUPPLY, { limits: { firm, project } }))).toEqual([]);
      const exhaust = hits(checkRouteSpan(model(), EXHAUST, { limits: { firm, project } }));
      expect(exhaust.map((h) => [h.basis?.limitId, h.basis?.layer])).toEqual([[`${DUCT_CEILING_CLEARANCE_LIMIT_ID}.exhaust_air`, "project"]]);
      expect(exhaust[0]?.message).toMatch(/keeps 0\.25 ft \(Owner's spec 23 31 00\)/);
    });
  });
});
