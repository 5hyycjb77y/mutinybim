/**
 * @jest-environment node
 *
 * Round 6 lane K: the eight trade installers that wrote process-wide state
 * are gone as exports (kernel and bim-calc); what they installed is a pack's
 * contribution read per model. Two models with different demand rule sets on
 * one process don't cross. Before round 6, `registerElectricalRules` put a
 * rule set into one process map every model read.
 */
import * as kernel from "@permitzip/bim-kernel";
import { CONNECTED_LOAD_ONLY, DEMAND_RULE_SET_POINT, electricalEngineFor, electricalRulesById, registeredElectricalRules, type ElectricalRules } from "@permitzip/bim-pack-electrical";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";

const INSTALLERS = ["installVentilation", "registerPressureTargets", "registerNecRules", "registerElectricalRules", "registerVentilationReader", "registerFeederTypeCatalog", "registerTradeAdapter", "registerDerivedZoneRule"] as const;

function rules(label: string): ElectricalRules {
  return { ...CONNECTED_LOAD_ONLY, id: "shared-id", label };
}

function setWith(packId: string, label: string): PackSet {
  return PackSet.create([definePack({ id: packId, name: packId, version: "1.0.0", kernel: "^1.3.0" }, [contribute(DEMAND_RULE_SET_POINT, [rules(label)])])]);
}

describe("c6k no global trade installers", () => {
  it.each(INSTALLERS)("%s is not exported by the kernel (bim-calc: its own c6k-no-global-installers test)", (name) => {
    expect(Object.keys(kernel)).not.toContain(name);
  });

  it("two models' demand rule sets don't cross, and neither leaks outside its scope", () => {
    const a = setWith("aa", "Firm A rules");
    const b = setWith("bb", "Firm B rules");
    expect(withPackSet(a, () => electricalRulesById("shared-id").label)).toBe("Firm A rules");
    expect(withPackSet(b, () => electricalRulesById("shared-id").label)).toBe("Firm B rules");
    expect(electricalRulesById("shared-id")).toBe(CONNECTED_LOAD_ONLY);
    expect(withPackSet(a, () => registeredElectricalRules().map((r) => r.label))).toContain("Firm A rules");
    expect(registeredElectricalRules().map((r) => r.label)).not.toContain("Firm A rules");
    expect(withPackSet(a, () => electricalEngineFor("shared-id").rules.label)).toBe("Firm A rules");
    expect(withPackSet(b, () => electricalEngineFor("shared-id").rules.label)).toBe("Firm B rules");
  });
});
