/**
 * @jest-environment node
 *
 * Round 12 lane P12: the round 4 system-kind order ("never reorder or
 * remove") is frozen. Every deployed reader lists system kinds in this order
 * and old models store these strings, so the list, and where each Plumbing
 * and gas row sits in it, fails this test the moment it changes.
 * (@mutinybim-bare-kernel: the list is the kernel's stored strings; no add-on
 * needs to be on to read it.)
 *
 * Fails on round 11's code: `PLUMBING_SERVICE_ROWS` didn't exist, so the
 * add-on's rows couldn't be checked against the frozen order.
 */
import { LEGACY_SYSTEM_KIND_IDS, firstPartyServiceRegistry, systemKindIds } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, PLUMBING_SERVICE_ROWS } from "../src";

const ROUND_4_ORDER = [
  "supply_air",
  "return_air",
  "exhaust_air",
  "outside_air",
  "domestic_cold_water",
  "domestic_hot_water",
  "domestic_hot_water_return",
  "sanitary",
  "vent",
  "storm",
  "natural_gas",
  "hydronic_supply",
  "hydronic_return",
  "condensate",
  "refrigerant",
  "power",
  "lighting",
  "data",
  "fire_alarm",
  "other",
];

describe("p12-legacy-order-frozen", () => {
  it("the round 4 system kinds keep their order and none is removed", () => {
    expect([...LEGACY_SYSTEM_KIND_IDS]).toEqual(ROUND_4_ORDER);
    // Bare kernel with Plumbing and gas: the kinds this set has (its own and the kernel's Other) list in round 4's order.
    installFirstPartyPacks([PLUMBING_GAS_PACK]);
    const present = new Set(systemKindIds(firstPartyServiceRegistry()));
    expect(systemKindIds(firstPartyServiceRegistry()).filter((id) => (ROUND_4_ORDER as readonly string[]).includes(id))).toEqual(ROUND_4_ORDER.filter((id) => present.has(id)));
    expect([...present].slice(0, 8)).toEqual(["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "vent", "storm", "natural_gas", "other"]);
  });

  it("Plumbing and gas's legacy system rows sit where round 4 put them", () => {
    const legacy = PLUMBING_SERVICE_ROWS.filter((r) => r.asSystem && (ROUND_4_ORDER as readonly string[]).includes(r.id)).map((r) => r.id);
    expect(legacy).toEqual(["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "vent", "storm", "natural_gas"]);
    expect(legacy.map((id) => ROUND_4_ORDER.indexOf(id))).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
});
