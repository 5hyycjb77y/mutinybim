/**
 * @jest-environment node
 *
 * Round 14 lane M14 step 1: the Checklist's lint findings for Mechanical's
 * route rules. A supply duct across a 1-hour wall with no damper there is a
 * `duct-rated-crossing` finding that selects the duct and the wall and
 * offers Fix (place a fire damper); a ceiling step above the duct is a
 * `duct-ceiling-clearance` finding. Findings come from the pieces in the
 * edit's scope only: a scope away from the duct reports nothing. Placing the
 * damper clears the crossing finding.
 *
 * Fails on round 13's code: Mechanical had no route lint rules
 * (`lint/route-crossings.ts` didn't exist).
 */
import { withPackSet } from "@permitzip/bim-kernel/packs";
import { DEFAULT_LINT_CONFIG, LintEngine } from "@permitzip/bim-lint";
import { DUCT_CEILING_CLEARANCE_RULE_ID, DUCT_RATED_CROSSING_RULE_ID, routeCrossingRules } from "../src/lint/route-crossings";
import { M14_SET, ratedWalls, routeSupply, segmentIds, withDamperType } from "./m14-fixtures";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";

describe("m14 lint: rated crossings and ceiling clearance on touched ducts", () => {
  it("flags the crossing with Select (duct + wall) and Fix; a scope away from the duct says nothing; the damper clears it", () => {
    withPackSet(M14_SET, () => {
      const m = new Log(withDamperType(ratedWalls("m14-lint").head, "t-fd", "fire_smoke"));
      const routed = m.ok(routeSupply("run-l"));
      const seg = segmentIds(m.head, routed.elements.map((e) => e.id))[0];
      if (!seg) throw new Error("no segment");
      const engine = new LintEngine(routeCrossingRules);
      engine.build(m.head);
      const found = engine.check({ config: DEFAULT_LINT_CONFIG }).filter((f) => f.rule === DUCT_RATED_CROSSING_RULE_ID);
      expect(found.map((f) => [f.elementIds.includes(seg), f.elementIds.includes("corridor") || f.elementIds.includes("smoke")])).toEqual([
        [true, true],
        [true, true],
      ]);
      expect(found.map((f) => f.message).sort()).toEqual([expect.stringMatching(/^1-hour wall .*: a fire damper goes here$/), expect.stringMatching(/^Smoke barrier wall .*: a smoke damper goes here$/)]);
      expect(found.every((f) => f.fix?.tool === "bim_place_part" && /damper/.test(f.fix.hint))).toBe(true);
      expect(found.find((f) => f.elementIds.includes("corridor"))?.at).toMatchObject({ level: "Level 1", x_ft: expect.closeTo(9.84, 1), y_ft: 0 });

      // Touched spans only: a scope far from the duct runs nothing on it.
      const far = engine.run({ box: { min: { x: 50_000, y: 50_000, z: 0 }, max: { x: 51_000, y: 51_000, z: 3000 } }, documents: [], changed: [] }, { config: DEFAULT_LINT_CONFIG });
      expect(far.filter((f) => f.rule === DUCT_RATED_CROSSING_RULE_ID)).toEqual([]);

      // A fire/smoke damper at each crossing clears both.
      m.ok({ type: "place_part", partId: "fd-1", typeId: "t-fd", levelId: "L1", position: { x: 3000, y: 0 }, offsetMm: 3048 });
      m.ok({ type: "place_part", partId: "fd-2", typeId: "t-fd", levelId: "L1", position: { x: 5000, y: 0 }, offsetMm: 3048 });
      const cleared = new LintEngine(routeCrossingRules);
      cleared.build(m.head);
      expect(cleared.check({ config: DEFAULT_LINT_CONFIG }).filter((f) => f.rule === DUCT_RATED_CROSSING_RULE_ID)).toEqual([]);
    });
  });

  it("a ceiling step reaching down over the duct is a clearance finding with the height to drop to", () => {
    withPackSet(M14_SET, () => {
      const m = ratedWalls("m14-clear");
      m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "soffit", levelId: "L1", outline: [{ x: 500, y: -1000 }, { x: 2500, y: -1000 }, { x: 2500, y: 1000 }, { x: 500, y: 1000 }], heightMm: 3200 }] });
      m.ok(routeSupply("run-c"));
      const engine = new LintEngine(routeCrossingRules);
      engine.build(m.head);
      const clearance = engine.check({ config: DEFAULT_LINT_CONFIG }).filter((f) => f.rule === DUCT_CEILING_CLEARANCE_RULE_ID);
      expect(clearance).toHaveLength(1);
      expect(clearance[0]?.message).toMatch(/drop the run to .* or lower here/);
      expect(clearance[0]?.fix?.tool).toBe("bim_move_elements");
    });
  });
});
