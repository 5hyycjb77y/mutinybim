/**
 * @jest-environment node
 *
 * A14 step 5: route checks see a rated wall that is set not to bound rooms
 * (a 1-hour shaft wall drawn inside a room, a rated screen). The rated
 * element index is a per-level grid beside the room-bounding one, read near
 * the span and carried revision to revision by changed ids: a type's rating
 * change re-asks only that type's walls, and the level is built once.
 *
 * Fails on round 13's code: `ratedSegmentsNear` refused ("isn't built yet"),
 * so the route check read only room-bounding walls and found no crossing.
 */
import { asElementId, carryRevision, type BimElement } from "../src";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "../src/packs";
import { checkRouteSpan, RATING_KIND_POINT, ROUTE_CONSTRAINT_POINT, type CrossingRule, type RatingKindRow, type RouteConstraintHit, type RouteSpan } from "../src/routing/rated-routes";
import { boundaryIndexStats, ratedIndexStats } from "../src/spaces/boundaries/boundary-index";
import { boundarySegmentsOnLevel, ratedSegmentsNear } from "../src/spaces/boundaries/point";
import { L1, modelWith, wall } from "./a13b-fixtures";

const FIRE: RatingKindRow = {
  id: "zzfp.fire",
  label: "Fire rating",
  unit: "hour",
  parameterKeys: ["zzfp.fire_rating"],
  read: (el, elements) => {
    const typeId = "typeId" in el && typeof el.typeId === "string" ? el.typeId : undefined;
    const type = typeId === undefined ? undefined : elements[typeId];
    const v = type && "values" in type ? (type.values as Record<string, unknown>)["zzfp.fire_rating"] : undefined;
    return typeof v === "number" ? v : null;
  },
  format: (h) => `${h}-hour`,
};
const FIRESTOP: CrossingRule = { id: "zzfp.firestop", label: "Firestop at rated walls", form: "crossing", routes: ["run_segment"], ratingKind: "zzfp.fire", atLeast: 1, requires: { id: "zzfp.firestop", label: "firestop" } };
const SET = PackSet.create([definePack({ id: "zzfp", name: "Test fire protection", version: "1.0.0", kernel: "^1.0.0" }, [contribute(RATING_KIND_POINT, [FIRE]), contribute(ROUTE_CONSTRAINT_POINT, [FIRESTOP])])]);
const run = <T>(fn: () => T): T => withPackSet(SET, fn);

const SPAN: RouteSpan = { kind: "run_segment", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, bottomMm: 2700, topMm: 2800, widthMm: 50 };
const BOX = { minX: 0, minY: -100, maxX: 8000, maxY: 100 };

const shaftType = (hours: number): BimElement => ({ id: asElementId("t-shaft"), kind: "element_type", version: 1, authoredRev: {}, name: "Shaft wall", values: { "zzfp.fire_rating": hours } }) as BimElement;
const shaft = (x: number): BimElement => wall("w-shaft", { x, y: -2000 }, { x, y: 2000 }, { typeId: "t-shaft", values: { room_bounding: false } });
const plain = wall("w-plain", { x: 6000, y: -2000 }, { x: 6000, y: 2000 });

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

describe("a14 rated wall not bounding rooms is seen by route checks", () => {
  it("the 1-hour wall set not to bound rooms is crossed: a firestop goes there", () => {
    const m = modelWith([shaftType(1), shaft(3000), plain], "a14-rated-seen");
    run(() => {
      // It doesn't bound rooms: only the plain wall's two faces are boundaries.
      const bounding = boundarySegmentsOnLevel(m, L1);
      if (isPackRefusal(bounding)) throw new Error(bounding.refused);
      expect(new Set(bounding.map((s) => s.elementId))).toEqual(new Set(["w-plain"]));
      // The rated index has it (both faces); the unrated plain wall isn't rated.
      const rated = ratedSegmentsNear(m, L1, BOX, "zzfp.fire");
      if (isPackRefusal(rated)) throw new Error(rated.refused);
      expect(rated.map((s) => s.elementId)).toEqual(["w-shaft", "w-shaft"]);
      const found = hits(checkRouteSpan(m, SPAN));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ruleId: "zzfp.firestop", hostId: "w-shaft", at: { x: 3000, y: 0 }, requires: "zzfp.firestop" });
      expect(found[0]?.message).toMatch(/^1-hour wall .*: a firestop goes here$/);
    });
  });

  it("reads near the box only, and refuses a rating kind no add-on gives", () => {
    const m = modelWith([shaftType(1), shaft(3000), plain], "a14-rated-near");
    run(() => {
      expect(ratedSegmentsNear(m, L1, { minX: 50_000, minY: 50_000, maxX: 51_000, maxY: 51_000 }, "zzfp.fire")).toEqual([]);
      expect(ratedSegmentsNear(m, L1, BOX, "zz.nobody")).toEqual({ refused: "No add-on in force gives the rating kind zz.nobody" });
    });
  });

  it("a type's rating change and a moved wall are carried by changed ids, the level built once", () => {
    const m = modelWith([shaftType(0.5), shaft(3000), plain], "a14-rated-carry");
    run(() => {
      expect(hits(checkRouteSpan(m, SPAN))).toEqual([]);
      expect(ratedIndexStats(m.elements, "zzfp.fire").levelBuilds).toBe(1);
    });
    const rerated = { ...m, elements: { ...m.elements, "t-shaft": shaftType(2) } };
    run(() => carryRevision(m.elements, rerated.elements, ["t-shaft"]));
    run(() => {
      const found = hits(checkRouteSpan(rerated, SPAN));
      expect(found.map((h) => [h.hostId, h.at.x])).toEqual([["w-shaft", 3000]]);
      expect(found[0]?.message).toMatch(/^2-hour wall/);
    });
    const moved = { ...rerated, elements: { ...rerated.elements, "w-shaft": shaft(4500) } };
    run(() => carryRevision(rerated.elements, moved.elements, ["w-shaft"]));
    run(() => {
      expect(hits(checkRouteSpan(moved, SPAN)).map((h) => [h.hostId, h.at.x])).toEqual([["w-shaft", 4500]]);
      const stats = ratedIndexStats(moved.elements, "zzfp.fire");
      expect(stats).toEqual({ levelBuilds: 1, advances: 2 });
      expect(boundaryIndexStats(moved.elements).levelBuilds).toBe(1);
    });
  });
});
