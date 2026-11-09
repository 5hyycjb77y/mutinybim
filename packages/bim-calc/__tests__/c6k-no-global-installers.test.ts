/**
 * @jest-environment node
 *
 * Round 6 lane K: bim-calc installs nothing into the kernel when it loads.
 * The NEC rule sets and the outdoor-air engine are contributions a pack
 * carries (`necRuleSets`, `ventilationReaderContribution`); before round 6
 * loading this package registered the NEC editions for every model in the
 * process, and `installVentilation` did the same for outdoor air.
 *
 * @mutinybim-bare-kernel: the point is that loading bim-calc installs
 * nothing, so the test setup must not install the add-ons first.
 */
import * as calc from "@permitzip/bim-calc";
import { VentilationEngine, ventilationReaderContribution } from "@permitzip/bim-pack-mechanical";
import { necRuleSets, DEMAND_RULE_SET_POINT, electricalRulesById } from "@permitzip/bim-pack-electrical";
import { OUTDOOR_AIR_READER_POINT, registeredVentilationReader } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { spaceUseCatalog } from "@permitzip/bim-library";

describe("c6k bim-calc has no global installers", () => {
  it.each(["installVentilation", "registerNecRules", "registerVentilationReader", "registerElectricalRules"])("%s is not exported", (name) => {
    expect(Object.keys(calc)).not.toContain(name);
  });

  it("the NEC editions and the outdoor-air engine reach only a set whose pack carries them", () => {
    expect(electricalRulesById("nec-2023").id).toBe("connected-only");
    expect(registeredVentilationReader()).toBeNull();
    const engine = new VentilationEngine({ uses: spaceUseCatalog().catalog });
    const pack = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(DEMAND_RULE_SET_POINT, necRuleSets()), ventilationReaderContribution(engine)]);
    const set = PackSet.create([pack]);
    expect(withPackSet(set, () => electricalRulesById("nec-2023").label)).toBe("NEC 2023 Article 220");
    expect(withPackSet(set, () => registeredVentilationReader())).toBe(engine);
    expect(set.items(OUTDOOR_AIR_READER_POINT)).toEqual([engine]);
    expect(necRuleSets()).toBe(necRuleSets());
  });
});
