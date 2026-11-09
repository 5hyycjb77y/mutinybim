/**
 * @jest-environment node
 *
 * A wall's own fire rating overrides its type's, and every rated-wall check
 * reads the rating in force: a duct crossing a wall whose 2-hour type it
 * overrides to 1 hour asks for a fire damper at a 1-hour wall; clearing the
 * override puts the type's 2 hours back; a wall of an unrated type rated on
 * its own is found too, and a fire area closes on walls rated that way.
 * `ratingSourceOf` says which it is (own, differs from its type), from the
 * kernel's general instance-over-type read (`elementValueSource`).
 *
 * Fails on the previous code: there was no `ratingSourceOf` or
 * `elementValueSource`, so nothing could say a wall differs from its type.
 */
import { ARCHITECTURE_PACK, DOOR_FIRE_RATING_KEY, FIRE_RESISTANCE_KEY } from "@permitzip/bim-pack-architecture";
import { asElementId, elementValueSource, proposeRatedZones, type ModelState } from "@permitzip/bim-kernel";
import { checkRouteSpan, ratingSourceOf, ROUTE_CONSTRAINT_POINT, type RouteConstraintHit, type RouteSpan } from "@permitzip/bim-kernel/rated-routes";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_ROUTE_RULES } from "../src/constraints/rated-crossings";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

const RULES = definePack({ id: "mechanical", name: "Mechanical (route rules)", version: "1.0.0", kernel: "^1.0.0", firstParty: true }, [contribute(ROUTE_CONSTRAINT_POINT, MECHANICAL_ROUTE_RULES)]);
const SET = PackSet.create([ARCHITECTURE_PACK, RULES]);
const DUCT: RouteSpan = { kind: "run_segment", serviceId: "supply_air", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, bottomMm: 2700, topMm: 3000, widthMm: 400 };

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

function typedWall() {
  const m = twoLevels("a15-rating");
  m.ok({ type: "create_element_type", typeId: "two-hour", name: "2-hour wall", forKinds: ["wall"], values: { [FIRE_RESISTANCE_KEY]: 2 } });
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: -2000 }, end: { x: 3000, y: 2000 } } });
  m.ok({ type: "set_element_type", elementIds: ["w"], typeId: "two-hour" });
  return m;
}

const at = (model: ModelState, id: string) => {
  const el = model.elements[id];
  if (!el) throw new Error(`no ${id}`);
  return el;
};

describe("a15 a wall's own fire rating over its type's", () => {
  it("the override wins in the damper check, says it differs, and clearing it puts the type's back", () => {
    const m = typedWall();
    withPackSet(SET, () => {
      expect(hits(checkRouteSpan(m.head, DUCT))[0]?.message).toMatch(/^2-hour wall .*: a fire damper goes here$/);
      expect(ratingSourceOf(m.head.elements, at(m.head, "w"), "fire_resistance")).toEqual({ value: 2, typeValue: 2, ownKeys: [], differsFromType: false });

      m.ok({ type: "set_element_values", elementIds: ["w"], values: { [FIRE_RESISTANCE_KEY]: 1 } });
      expect(hits(checkRouteSpan(m.head, DUCT))[0]?.message).toMatch(/^1-hour wall .*: a fire damper goes here$/);
      expect(ratingSourceOf(m.head.elements, at(m.head, "w"), "fire_resistance")).toEqual({ value: 1, typeValue: 2, ownKeys: [FIRE_RESISTANCE_KEY], differsFromType: true });
      expect(elementValueSource(m.head.elements, at(m.head, "w"), FIRE_RESISTANCE_KEY)).toEqual({ value: 1, from: "instance", typeValue: 2, overridesType: true });

      m.ok({ type: "set_element_values", elementIds: ["w"], values: { [FIRE_RESISTANCE_KEY]: null } });
      expect(hits(checkRouteSpan(m.head, DUCT))[0]?.message).toMatch(/^2-hour wall /);
      expect(elementValueSource(m.head.elements, at(m.head, "w"), FIRE_RESISTANCE_KEY)).toEqual({ value: 2, from: "type", typeValue: 2, overridesType: false });
    });
  });

  it("a wall rated on its own (text, no type) is found, and four of them close a fire area", () => {
    const m = twoLevels("a15-own");
    const corners = [
      { x: 0, y: 0 },
      { x: 6000, y: 0 },
      { x: 6000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % corners.length] ?? p;
      m.ok({ type: "create_element", elementId: `w${i}`, kind: "wall", levelId: "L1", placement: { kind: "line", start: p, end: q } });
      m.ok({ type: "set_element_values", elementIds: [`w${i}`], values: { [DOOR_FIRE_RATING_KEY]: "1" } });
    });
    withPackSet(SET, () => {
      const cross = hits(checkRouteSpan(m.head, { ...DUCT, start: { x: 3000, y: -1000 }, end: { x: 3000, y: 1000 } }));
      expect(cross[0]?.message).toMatch(/^1-hour wall .*: a fire damper goes here$/);
      expect(ratingSourceOf(m.head.elements, at(m.head, "w0"), "fire_resistance")).toEqual({ value: 1, typeValue: null, ownKeys: [DOOR_FIRE_RATING_KEY], differsFromType: true });
      expect(proposeRatedZones(m.head.elements, asElementId("L1"), { ratingKind: "fire_resistance", atLeast: 1 })).toHaveLength(1);
    });
  });
});
