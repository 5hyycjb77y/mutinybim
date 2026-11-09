/**
 * @jest-environment node
 *
 * P15 (round 15) step 1: the "+" grip on a plumbing fixture. The plumbing
 * add-on's network adapter row names the kernel's physical faces, answered
 * for its own pipe ends only: hovering a closet lists the nearest sanitary
 * run; dropping on it connects the waste as one edit. A supply diffuser's
 * neck is not this add-on's to answer.
 *
 * Fails on round 14 (and on K15 before this lane): the plumbing row had no
 * `sourcesFor` / `connect`, so the grip offered nothing on a fixture.
 */
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { asElementId, connectToSource, sourcesFor, validateModel } from "@permitzip/bim-kernel";
import { PLUMBING_GAS_PACK, plumbingSourcesFor } from "../src";
import { DIFFUSER, SA, IN } from "../../bim-kernel/__tests__/k15-fixtures";
import { FT, toiletRoom } from "./p15-fixtures";

describe("the + grip on a closet (plumbing add-on only)", () => {
  it("hover lists the sanitary branch 3 ft away; drop connects the waste with a combination wye, one edit", () => {
    withPackSet(PackSet.create([PLUMBING_GAS_PACK]), () => {
      const m = toiletRoom();
      const answer = sourcesFor(m.head, { elementId: asElementId("wc-1") });
      if (!answer) throw new Error("the plumbing add-on offered nothing for the closet");
      expect(answer.candidates.map((c) => c.sourceId)).toEqual(["san-s1"]);
      const nearest = answer.candidates[0];
      if (!nearest) throw new Error("no candidate");
      expect(nearest.note).toMatch(/, 3 ft$/);
      const plan = connectToSource(m.head, { elementId: asElementId("wc-1") }, nearest, "grip1");
      if (!plan.ok) throw new Error(plan.reason);
      const before = m.log.length;
      for (const command of plan.commands) m.ok(command);
      expect(m.log.length).toBe(before + 1);
      expect(m.part("wc-1").links?.w).toBeDefined();
      expect(m.takeoffsOn("san-s1").map((f) => f.family)).toEqual(["dwv.combo_wye_eighth"]);
      expect(validateModel(m.head)).toEqual([]);
    });
  });

  it("names its vent end too, and leaves a diffuser's neck to another add-on", () => {
    withPackSet(PackSet.create([PLUMBING_GAS_PACK]), () => {
      const m = toiletRoom({ withVent: true });
      expect(sourcesFor(m.head, { elementId: asElementId("wc-1"), end: "v" })?.candidates.map((c) => c.sourceId)).toEqual(["vent-s1"]);
      m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 40 * FT }, { x: 30 * FT, y: 40 * FT }] });
      m.place("sd", DIFFUSER, 10 * FT, 45 * FT, 8 * FT, "SD-1");
      expect(plumbingSourcesFor(m.head, { elementId: asElementId("sd") })).toBeNull();
    });
  });
});
