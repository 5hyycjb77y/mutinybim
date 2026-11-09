/**
 * @jest-environment node
 *
 * Round 13 lane M13 (M12 step 3): a supply duct crossing a 1-hour wall (rated
 * by the Architecture add-on) needs a fire damper there, and one crossing a
 * smoke barrier a smoke damper. A damper part at the crossing meets it. A
 * pipe or an unrated wall gets nothing.
 *
 * Fails on round 12's code: `checkRouteSpan` refused every span and
 * Mechanical had no route rules.
 */
import { ARCHITECTURE_PACK, FIRE_RESISTANCE_KEY, SMOKE_BARRIER_KEY } from "@permitzip/bim-pack-architecture";
import { type BimElement, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { checkRouteSpan, ROUTE_CONSTRAINT_POINT, type RouteConstraintHit, type RouteSpan } from "@permitzip/bim-kernel/rated-routes";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "@permitzip/bim-kernel/packs";
import { DAMPER_KIND_PARAM, MECHANICAL_ROUTE_RULES } from "../src/constraints/rated-crossings";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

const RULES = definePack({ id: "mechanical", name: "Mechanical (route rules)", version: "1.0.0", kernel: "^1.0.0", firstParty: true }, [contribute(ROUTE_CONSTRAINT_POINT, MECHANICAL_ROUTE_RULES)]);
const SET = PackSet.create([ARCHITECTURE_PACK, RULES]);
const DUCT: RouteSpan = { kind: "run_segment", serviceId: "supply_air", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, bottomMm: 2700, topMm: 3000, widthMm: 400 };

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

function withValues(model: ModelState, id: string, values: Record<string, unknown>): ModelState {
  const el = model.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return { ...model, elements: { ...model.elements, [id]: { ...el, values: { ...("values" in el ? el.values : {}), ...values } } as BimElement } };
}

function building(): ModelState {
  const m = twoLevels("m12-damper");
  m.ok({ type: "create_element", elementId: "corridor", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: -2000 }, end: { x: 3000, y: 2000 } } });
  m.ok({ type: "create_element", elementId: "smoke", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 5000, y: -2000 }, end: { x: 5000, y: 2000 } } });
  m.ok({ type: "create_element", elementId: "plain", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 7000, y: -2000 }, end: { x: 7000, y: 2000 } } });
  return withValues(withValues(m.head, "corridor", { [FIRE_RESISTANCE_KEY]: 1 }), "smoke", { [SMOKE_BARRIER_KEY]: true });
}

const damperType: PartTypeDefinition = {
  familyName: "Damper",
  typeName: "Fire damper",
  category: "duct_accessory",
  typeParams: [{ name: DAMPER_KIND_PARAM, label: "Damper", kind: "choice", choices: ["fire", "smoke", "fire_smoke"] }],
  typeValues: { [DAMPER_KIND_PARAM]: "fire" },
  instanceParams: [],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 0], size: [400, 100, 300] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [400, 100] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

describe("m12 dampers at rated crossings", () => {
  it("a duct crossing the 1-hour wall needs a fire damper there; the smoke barrier a smoke damper; the plain wall nothing", () => {
    withPackSet(SET, () => {
      const found = hits(checkRouteSpan(building(), DUCT));
      expect(found.map((h) => [h.ruleId, h.hostId, h.at.x])).toEqual([
        ["mechanical.fire_damper_at_rated_wall", "corridor", 3000],
        ["mechanical.smoke_damper_at_smoke_barrier", "smoke", 5000],
      ]);
      expect(found[0]?.message).toMatch(/^1-hour wall .*: a fire damper goes here$/);
      expect(found[1]?.message).toMatch(/^Smoke barrier wall .*: a smoke damper goes here$/);
    });
  });

  it("a fire damper at the crossing meets it; a pipe crossing the same wall gets nothing from Mechanical", () => {
    const model = building();
    const placed: ModelState = {
      ...model,
      elements: {
        ...model.elements,
        "t-fd": { version: 1, authoredRev: {}, id: "t-fd", kind: "part_type", definition: damperType } as unknown as BimElement,
        "fd-1": { version: 1, authoredRev: {}, id: "fd-1", kind: "part", typeId: "t-fd", levelId: "L1", position: { x: 3000, y: 0 }, offsetMm: 2850, rotationDeg: 0, mark: "FD-1", values: {} } as unknown as BimElement,
      },
    };
    withPackSet(SET, () => {
      expect(hits(checkRouteSpan(placed, DUCT)).map((h) => h.ruleId)).toEqual(["mechanical.smoke_damper_at_smoke_barrier"]);
      expect(hits(checkRouteSpan(model, { ...DUCT, serviceId: "domestic_cold_water" }))).toEqual([]);
    });
  });
});
