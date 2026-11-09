/**
 * @jest-environment node
 *
 * K4 (round 15), outside add-on: a fire sprinkler add-on that is not
 * first-party (a test fixture, namespace `zzsp`) brings its own service, a
 * pendent head part type and an armover fitting, and names the armover as
 * its system's tee. `connect_into` joins its heads into its branch line with
 * that armover and no kernel edit. Round 14 had no `connect_into` (contract
 * 1.13.0 refused every request).
 */
import { FITTING_FAMILY_POINT, SERVICE_POINT, activeServiceRegistry, fittingFamily, isConnectIntoRefusal, planConnectInto, serviceById, validateModel, type FittingFamily, type LibraryEntry } from "../src";
import { PACK_CONTRACT_VERSION, PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { COPPER, FT, IN, K15Model } from "./k15-fixtures";

const wet = serviceById("fire_protection_wet", activeServiceRegistry());
const tee = fittingFamily("pipe.water.tee");
if (!wet || !tee) throw new Error("the first-party wet sprinkler service and water tee are the test's starting rows");

const ARMOVER: FittingFamily = { ...tee, id: "zzsp.armover", name: "Armover" };
const ADDON = definePack({ id: "zzsp", name: "K15 test sprinkler add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
  contribute(SERVICE_POINT, [{ ...wet, id: "zzsp.wet", label: "Sprinkler, wet (test add-on)" }]),
  contribute(FITTING_FAMILY_POINT, [{ family: ARMOVER, defaults: [] }]),
]);

const HEAD: LibraryEntry = {
  id: "zzsp:pendent-head@1",
  definition: {
    familyName: "Sprinkler head, pendent",
    typeName: "K5.6, 1/2 in.",
    category: "pipe_accessory",
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: [{ id: "in", label: "Inlet", domain: "pipe", systemKind: "zzsp.wet", position: [0, 0, 50], direction: [0, 0, 1], shape: "round", diameter: 1 * IN }],
    geometry: [{ kind: "box", center: [0, 0, 25], size: [60, 60, 50] }],
    symbol: [{ kind: "circle", center: [0, 0], radius: 60 }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  },
};

const SP = { id: "sys-sp", kind: "zzsp.wet", name: "Sprinkler 1" };

describe("an outside sprinkler add-on gets connect-into", () => {
  it("two pendent heads 3 ft off the branch line: each rises and joins it through the add-on's armover, one edit", () => {
    withPackSet(PackSet.create([ADDON]), () => {
      const m = new K15Model();
      m.ok({ type: "route_run", idPrefix: "bl", levelId: "lvl-1", domain: "pipe", size: COPPER(1.5), elevationMm: 10 * FT, system: SP, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
      m.ok({ type: "set_system_design", systemId: "sys-sp", fittingDefaults: { pipe_tee: { family: ARMOVER.id } } });
      m.place("h-1", HEAD, 8 * FT, 3 * FT, 9 * FT - 50, "H-1");
      m.place("h-2", HEAD, 20 * FT, 3 * FT, 9 * FT - 50, "H-2");
      const from = [{ elementId: "h-1", port: "in" }, { elementId: "h-2", port: "in" }];
      const plan = planConnectInto(m.head, { from, into: "nearest", idPrefix: "ci" });
      for (const answer of plan.sources) {
        if (isConnectIntoRefusal(answer)) throw new Error(answer.refused);
        expect(answer.fittings.map((f) => f.partDefinitionId)).toContain(ARMOVER.id);
      }
      const before = m.log.length;
      m.ok({ type: "connect_into", from, into: "nearest", idPrefix: "ci" });
      expect(m.log.length).toBe(before + 1);
      expect(m.takeoffsOn("bl-s1").map((f) => f.family)).toEqual([ARMOVER.id, ARMOVER.id]);
      expect(m.part("h-1").links?.in).toBeDefined();
      expect(m.part("h-2").links?.in).toBeDefined();
      expect(validateModel(m.head)).toEqual([]);
    });
  });
});
