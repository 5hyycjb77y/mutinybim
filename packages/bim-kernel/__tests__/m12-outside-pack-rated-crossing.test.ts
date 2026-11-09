/**
 * @jest-environment node
 *
 * Round 13 lane M13 (Bedrock proof; M12 step 3): an outside fire-protection
 * add-on's rule asks for a firestop where its pipe crosses a 1-hour wall,
 * through `kernel.route_constraint` and `kernel.rating_kind`, with zero
 * kernel edits. The add-on rates the wall and names what the crossing needs;
 * the kernel finds the crossing through the boundary index (only walls near
 * the span) and says so in words. A crossing the add-on's own check finds
 * met is not reported; without the add-on nothing is.
 *
 * Fails on round 12's code: `checkRouteSpan` refused every span ("Route
 * checks against rated walls and ceilings aren't built yet").
 */
import { checkRouteSpan, RATING_KIND_POINT, ROUTE_CONSTRAINT_POINT, type CrossingRule, type RatingKindRow, type RouteConstraintHit, type RouteSpan } from "../src/routing/rated-routes";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet } from "../src/packs";
import { twoLevels } from "./a13a-fixtures";

const RATED: RatingKindRow = { id: "zzfp.fire", label: "Fire rating", unit: "hour", parameterKeys: ["zzfp.fire_rating"], read: (el) => (el.id === "w-1" ? 1 : el.id === "w-2" ? 0 : null), format: (h) => `${h}-hour` };
const FIRESTOP: CrossingRule = { id: "zzfp.firestop", label: "Firestop at rated walls", form: "crossing", routes: ["run_segment"], ratingKind: "zzfp.fire", atLeast: 1, requires: { id: "zzfp.firestop", label: "firestop" }, appliesTo: (s) => s.serviceId === "zzfp.sprinkler" };
const pack = (rule: CrossingRule) => definePack({ id: "zzfp", name: "Test fire protection", version: "1.0.0", kernel: "^1.0.0" }, [contribute(RATING_KIND_POINT, [RATED]), contribute(ROUTE_CONSTRAINT_POINT, [rule])]);

const SPAN: RouteSpan = { kind: "run_segment", serviceId: "zzfp.sprinkler", levelId: "L1", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 }, bottomMm: 2700, topMm: 2800, widthMm: 50 };

function hits(answer: ReturnType<typeof checkRouteSpan>): readonly RouteConstraintHit[] {
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer;
}

function walls() {
  const m = twoLevels("m12-crossing");
  m.ok({ type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 3000, y: -2000 }, end: { x: 3000, y: 2000 } } });
  m.ok({ type: "create_element", elementId: "w-2", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 6000, y: -2000 }, end: { x: 6000, y: 2000 } } });
  return m.head;
}

describe("m12 outside pack: a firestop where a pipe crosses a rated wall", () => {
  it("the add-on's rule finds the 1-hour crossing and says what goes there; the unrated wall is passed", () => {
    const model = walls();
    withPackSet(PackSet.create([pack(FIRESTOP)]), () => {
      const found = hits(checkRouteSpan(model, SPAN));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ruleId: "zzfp.firestop", hostId: "w-1", at: { x: 3000, y: 0 }, requires: "zzfp.firestop" });
      expect(found[0]?.message).toMatch(/^1-hour wall .*: a firestop goes here$/);
      // Short of the wall, or another service: nothing.
      expect(hits(checkRouteSpan(model, { ...SPAN, end: { x: 2000, y: 0 } }))).toEqual([]);
      expect(hits(checkRouteSpan(model, { ...SPAN, serviceId: "zzfp.other" }))).toEqual([]);
    });
  });

  it("a crossing the add-on finds met is not reported; without the add-on nothing is", () => {
    const model = walls();
    withPackSet(PackSet.create([pack({ ...FIRESTOP, satisfied: (_m, hit) => hit.hostId === "w-1" })]), () => {
      expect(hits(checkRouteSpan(model, SPAN))).toEqual([]);
    });
    expect(hits(checkRouteSpan(model, SPAN))).toEqual([]);
    expect(checkRouteSpan(model, { ...SPAN, topMm: 100 })).toEqual({ refused: "That route span's top is below its bottom" });
  });
});
