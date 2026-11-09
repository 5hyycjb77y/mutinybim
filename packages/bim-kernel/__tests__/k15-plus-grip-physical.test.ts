/**
 * @jest-environment node
 *
 * K5 (round 15): the "+" grip works on physical networks. The kernel answers
 * the grip's two faces once (`physicalSourcesFor`, `physicalConnect`): the
 * nearest runs of the end's own system, through the run index, and the drop
 * as one `connect_into`. Any add-on names them in its network adapter row
 * (here an outside test add-on; the plumbing and mechanical rows next). Round
 * 14: only Electrical answered, so hovering a closet or a diffuser offered
 * nothing.
 */
import { NETWORK_ADAPTER_POINT, asElementId, connectToSource, physicalConnect, physicalSourcesFor, sourcesFor, validateModel } from "../src";
import { PACK_CONTRACT_VERSION, PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { DIFFUSER, FT, IN, K15Model, PVC, SA, SAN, WC } from "./k15-fixtures";

const ADDON = definePack({ id: "zzgrip", name: "K15 test grip add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
  contribute(NETWORK_ADAPTER_POINT, [{ id: "zzgrip.physical", sourcesFor: physicalSourcesFor, connect: physicalConnect }]),
]);

function room(): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: -2 * FT, system: SAN, points: [{ x: -10 * FT, y: 0 }, { x: 30 * FT, y: 0 }] });
  m.ok({ type: "route_run", idPrefix: "far", levelId: "lvl-1", domain: "pipe", size: PVC(4), elevationMm: -2 * FT, system: { ...SAN, id: "sys-san-2", name: "Sanitary 2" }, points: [{ x: -10 * FT, y: 20 * FT }, { x: 30 * FT, y: 20 * FT }] });
  m.place("wc-1", WC, 4 * FT, 8 * FT, 0, "WC-1");
  return m;
}

describe("the + grip on a closet and a diffuser", () => {
  it("hovering a closet lists the sanitary runs nearest first, with how far each is; dropping on one connects it, one edit", () => {
    withPackSet(PackSet.create([ADDON]), () => {
      const m = room();
      const answer = sourcesFor(m.head, { elementId: asElementId("wc-1") });
      if (!answer) throw new Error("no grip answer for the closet");
      expect(answer.sourceWord).toBe("run");
      // The nearest ring only: the branch 8 ft away; the other system's branch 12 ft away is not listed (10 ft first, then wider).
      expect(answer.candidates.map((c) => c.sourceId)).toEqual(["main-s1"]);
      const nearest = answer.candidates[0];
      if (!nearest) throw new Error("no candidate");
      expect(nearest.note).toMatch(/, 8 ft$/);
      const plan = connectToSource(m.head, { elementId: asElementId("wc-1") }, nearest, "grip1");
      if (!plan.ok) throw new Error(plan.reason);
      expect(plan.labels[0]).toMatch(/^Connect WC-1's waste into the /);
      const before = m.log.length;
      for (const command of plan.commands) m.ok(command);
      expect(m.log.length).toBe(before + 1);
      expect(m.part("wc-1").links?.waste).toBeDefined();
      expect(m.takeoffsOn("main-s1").map((f) => f.family)).toEqual(["dwv.combo_wye_eighth"]);
      expect(validateModel(m.head)).toEqual([]);
    });
  });

  it("a diffuser's neck lists the supply duct; a closet already connected has nothing to offer", () => {
    withPackSet(PackSet.create([ADDON]), () => {
      const m = room();
      m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 40 * FT }, { x: 30 * FT, y: 40 * FT }] });
      m.place("sd", DIFFUSER, 10 * FT, 45 * FT, 8 * FT, "SD-1");
      expect(sourcesFor(m.head, { elementId: asElementId("sd") })?.candidates.map((c) => c.sourceId)).toEqual(["trunk-s1"]);
      m.ok({ type: "connect_into", from: [{ elementId: "wc-1", port: "waste" }], into: "main-s1", idPrefix: "ci" });
      // The closet's waste is served; its cold water has no cold water run, so the grip offers no run for it.
      expect(sourcesFor(m.head, { elementId: asElementId("wc-1") })?.candidates ?? []).toEqual([]);
    });
  });

  it("with no add-on naming the faces, the grip has nothing to say for a closet (the add-on decides)", () => {
    const m = room();
    // The first-party Plumbing add-on names them (P15), so the case asks a fresh kernel with no add-on installed.
    jest.isolateModules(() => {
      const bare = jest.requireActual<typeof import("../src")>("../src");
      expect(bare.sourcesFor(m.head, { elementId: bare.asElementId("wc-1") })).toBeNull();
    });
  });
});
