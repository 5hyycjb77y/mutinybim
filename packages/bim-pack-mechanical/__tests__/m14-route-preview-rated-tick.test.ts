/**
 * @jest-environment node
 *
 * Round 14 lane M14 step 1: while a supply duct is drawn across a 1-hour
 * wall and a smoke barrier, the preview checks each drawn leg (pointer-follow,
 * nothing sent) and reports, per leg, where it crosses and what goes there:
 * "1-hour wall …: a fire damper goes here". A leg that crosses nothing says
 * nothing; a pipe across the same wall gets nothing from Mechanical.
 *
 * Fails on round 13's code: there was no leg check (`checkRouteLegs`,
 * `routeLegOf`, `routeCheckLines` didn't exist); the preview never asked.
 */
import { executeCommand, type ModelState } from "@permitzip/bim-kernel";
import { checkRouteLegs, routeCheckLines, routeLegOf } from "@permitzip/bim-kernel/rated-routes";
import { withPackSet } from "@permitzip/bim-kernel/packs";
import { M14_SET, ratedWalls, routeSupply, segmentIds } from "./m14-fixtures";

function preview(head: ModelState, command: ReturnType<typeof routeSupply> | Record<string, unknown>) {
  const res = executeCommand(head, command as Parameters<typeof executeCommand>[1]);
  if (!res.ok) throw new Error(res.error.message);
  return res;
}

describe("m14 route preview: a red tick and words where a leg crosses a rated wall", () => {
  it("the leg across the 1-hour wall and the smoke barrier reports both crossings in order, with the add-on's words; nothing is sent", () => {
    withPackSet(M14_SET, () => {
      const m = ratedWalls("m14-preview");
      const before = m.head.revision;
      const res = preview(m.head, routeSupply("route-preview"));
      const legs = checkRouteLegs(res.model, res.changedIds);
      expect(legs).toHaveLength(1);
      const leg = legs[0];
      if (!leg) throw new Error("no leg");
      expect(leg.span).toMatchObject({ kind: "run_segment", serviceId: "supply_air", levelId: "L1", bottomMm: 3048 - 127, topMm: 3048 + 127, widthMm: 355.6 });
      expect(leg.hits.map((h) => [h.ruleId, h.hostId, h.at.x])).toEqual([
        ["mechanical.fire_damper_at_rated_wall", "corridor", 3000],
        ["mechanical.smoke_damper_at_smoke_barrier", "smoke", 5000],
      ]);
      const lines = routeCheckLines(legs);
      expect(lines.map((l) => l.message)).toEqual([expect.stringMatching(/^1-hour wall .*: a fire damper goes here$/), expect.stringMatching(/^Smoke barrier wall .*: a smoke damper goes here$/)]);
      // The tick sits on the leg at the crossing.
      expect(lines.map((l) => [l.at.x, l.at.y, l.segmentId])).toEqual([
        [3000, 0, leg.segmentId],
        [5000, 0, leg.segmentId],
      ]);
      expect(m.head.revision).toBe(before);
    });
  });

  it("legs are checked one by one: a leg past the walls says nothing; a pipe across the same wall gets nothing; a riser has no plan line", () => {
    withPackSet(M14_SET, () => {
      const m = ratedWalls("m14-legs");
      const two = preview(m.head, { ...routeSupply("route-preview"), points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }] });
      const segs = segmentIds(two.model, two.changedIds);
      const legs = checkRouteLegs(two.model, segs);
      expect(legs.map((l) => l.hits.map((h) => h.hostId))).toEqual(expect.arrayContaining([["corridor"], []]));
      const pipe = preview(m.head, { type: "route_run", idPrefix: "route-preview", levelId: "L1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 3048, system: { id: "dcw-1", kind: "domestic_cold_water" }, points: [{ x: 0, y: 0 }, { x: 8000, y: 0 }] });
      expect(checkRouteLegs(pipe.model, pipe.changedIds).flatMap((l) => l.hits)).toEqual([]);
      expect(routeLegOf(two.model, "corridor")).toBeNull();
    });
  });
});
