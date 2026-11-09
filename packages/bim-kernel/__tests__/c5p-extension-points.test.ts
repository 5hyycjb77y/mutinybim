/**
 * @jest-environment node
 *
 * Batch 5c lane A: the kernel's extension points. Outside any pack scope
 * every reader answers exactly what it answered before packs (the same
 * registry objects, the same adapter objects in the same order, the same
 * derived rules); inside a scope a pack's rows join, and only there. On the
 * old code the points don't exist and pack rows had no way in except the
 * global maps, which leaked to every model in the process.
 *
 * Round 6: the trades' rows are the first-party packs' contributions, the base
 * of every set, so "what they answered before" now comes through that base:
 * the same objects in the same order, with the points' built-ins holding only
 * the shared rows.
 */
import { activePackSet, definePack, contribute, PackSet, PackSetError, withPackSet, withModelPacks, bindModelPacks, unbindModelPacks } from "../src/packs";
import { FIRST_PARTY_ADDONS as FIRST_PARTY_PACKS } from "@permitzip/bim-first-party";
import { ELECTRICAL_COMPONENTS, electricalAdapter } from "@permitzip/bim-pack-electrical";
import { NETWORK_ADAPTER_POINT, adapterForService, networkAdapterOwner, tradeAdapter } from "../src/connections/model";
import { plumbingAdapter } from "@permitzip/bim-pack-plumbing";
import { mechanicalAdapter } from "@permitzip/bim-pack-mechanical";
import type { TradeAdapter } from "../src/connections/adapter";
import { BUILTIN_SERVICE_REGISTRY, SERVICE_POINT, activeServiceRegistry, firstPartyServiceRegistry, serviceById, serviceLabel, serviceRowOwner } from "../src/services/registry";
import type { ServiceRow } from "../src/services/builtin";
import { DEDICATED_SPACE_RULE, DERIVED_ZONE_RULE_POINT, derivedZoneRule, derivedZoneRuleOwner } from "../src/spaces/derived-zones";
import { BUILTIN_ZONE_PURPOSES, ZONE_PURPOSE_POINT } from "../src/spaces/types";
import { KNOWN_ZONE_PURPOSES } from "../src/spaces/zone-bounds";
import { BUILTIN_FACET_REGISTRY, FACET_POINT, activeFacetRegistry, facetLabel } from "../src/requirements/facets";
import { BUILTIN_SYMBOL_REGISTRY, SYMBOL_POINT, activeSymbolRegistry, symbolById } from "../src/categories/symbol-registry";
import { activeCategoryRegistry, builtinCategoryRegistry } from "../src/categories/registry";
import { CLASS_POINT, activeClassRegistry, builtinRegistry } from "../src/registry";

const zzAdapter: TradeAdapter = {
  trade: "mechanical",
  source: () => null,
  connectors: () => [],
  positionsNeeded: () => null,
  refusal: () => null,
  positionsRefusal: () => null,
};

const zzService: ServiceRow = { id: "zz.slurry", label: "Slurry", discipline: "civil", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "zz.slurry_flow", quantities: [], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem", predefinedType: "USERDEFINED", objectType: "SLURRY" } };

const zz = definePack({ id: "zz", name: "Test pack", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.slurry_flow", adapter: zzAdapter }]),
  contribute(SERVICE_POINT, [zzService]),
  contribute(DERIVED_ZONE_RULE_POINT, [{ id: "zz.swing", label: "Swing clearance", ifcPredefinedType: "RESERVATION", derive: () => [] }]),
  contribute(ZONE_PURPOSE_POINT, [{ id: "zz.tributary", label: "Tributary area" }]),
  contribute(FACET_POINT, [{ id: "zz.loads", label: "Slurry loads", order: 200 }]),
  contribute(SYMBOL_POINT, [{ id: "zz.valve", label: "Slurry valve", primitives: [], connectionPoint: [0, 0] }]),
  contribute(CLASS_POINT, [{ id: "zz.pump", label: "Slurry pump", discipline: "civil", drawsUnder: "equipment" }]),
]);
const set = PackSet.create([zz]);

describe("c5p kernel points outside any scope: what they answered before packs", () => {
  it("network adapters: the same objects in the same order, electrical first", () => {
    expect(tradeAdapter("electrical")).toBe(electricalAdapter);
    expect(tradeAdapter("plumbing")).toBe(plumbingAdapter);
    expect(tradeAdapter("mechanical")).toBe(mechanicalAdapter);
    expect(adapterForService("sanitary")).toBe(plumbingAdapter);
    // Round 14: Structural is first-party, so its load path follows the three trades.
    expect(activePackSet().items(NETWORK_ADAPTER_POINT).map((a) => a.id)).toEqual(["electrical", "plumbing", "mechanical", "struct.load_path"]);
    expect(NETWORK_ADAPTER_POINT.builtins).toBeUndefined();
    expect(tradeAdapter("zz.slurry_flow")).toBeNull();
  });

  it("services, facets, symbols, categories and classes are the built-in registry objects themselves", () => {
    // Round 14: the kernel keeps Other alone; every trade's row is its first-party add-on's own object, and Structural adds its gravity load.
    const services = activeServiceRegistry();
    expect(services).toBe(firstPartyServiceRegistry());
    for (const [id, row] of BUILTIN_SERVICE_REGISTRY.byId) expect(services.byId.get(id)).toBe(row);
    expect([...BUILTIN_SERVICE_REGISTRY.byId.keys()]).toEqual(["other"]);
    for (const pack of FIRST_PARTY_PACKS) for (const c of pack.contributions) if (c.pointId === SERVICE_POINT.id) for (const row of c.items as readonly ServiceRow[]) expect(services.byId.get(row.id)).toBe(row);
    expect([...services.byId.keys()].filter((id) => /[.:]/.test(id))).toEqual(["struct.gravity_load"]);
    expect(activeFacetRegistry()).toBe(BUILTIN_FACET_REGISTRY);
    expect(BUILTIN_SYMBOL_REGISTRY.rows).toEqual([]);
    expect(activeSymbolRegistry().rows.map((r) => r.id)).toEqual(ELECTRICAL_COMPONENTS.map((c) => c.id));
    expect(activeSymbolRegistry()).toBe(activeSymbolRegistry());
    expect(activeCategoryRegistry()).toBe(builtinCategoryRegistry());
    expect(activeClassRegistry()).toBe(builtinRegistry());
    expect(serviceById("zz.slurry")).toBeNull();
    expect(serviceLabel("zz.slurry")).toBe("Slurry");
  });

  it("derived rules: dedicated space and the clearances, as before", () => {
    expect(derivedZoneRule(DEDICATED_SPACE_RULE)?.label).toBe("Dedicated equipment space");
    expect(derivedZoneRule("clearance:working_space")?.ifcPredefinedType).toBe("RESERVATION");
    expect(derivedZoneRule("zz.swing")).toBeNull();
  });

  it("zone purposes: the point's built-ins are the list readers check", () => {
    expect([...BUILTIN_ZONE_PURPOSES]).toEqual([...KNOWN_ZONE_PURPOSES]);
    expect(ZONE_PURPOSE_POINT.builtins?.().map((p) => p.id)).toEqual([...KNOWN_ZONE_PURPOSES]);
  });

  it("first-party rows are tagged with their pack for listing; bare ids never change", () => {
    expect(FIRST_PARTY_PACKS.map((p) => [p.manifest.id, p.manifest.firstParty, p.contributions.some((c) => c.pointId === NETWORK_ADAPTER_POINT.id)])).toEqual([
      ["electrical", true, true],
      ["plumbing_gas", true, true],
      ["mechanical", true, true],
      // Round 8: disciplines only (fire protection, fire alarm, fire sprinkler); no network of its own yet.
      ["fire_protection", true, false],
      // Round 13: the building (rows arrive with lane A13a); no network of its own.
      ["architecture", true, false],
      // Round 14: Structural, first-party, with its load path.
      ["struct", true, true],
    ]);
    expect(networkAdapterOwner({ id: "electrical" })).toBe("electrical");
    expect(networkAdapterOwner({ id: "plumbing" })).toBe("plumbing_gas");
    expect(networkAdapterOwner({ id: "mechanical" })).toBe("mechanical");
    expect(derivedZoneRuleOwner({ id: DEDICATED_SPACE_RULE })).toBe("electrical");
    expect(derivedZoneRuleOwner({ id: "clearance:service_access" })).toBeNull();
    const sanitary = firstPartyServiceRegistry().byId.get("sanitary");
    expect(sanitary && serviceRowOwner(sanitary)).toBe("plumbing_gas");
    expect(["power", "fire_alarm", "fire_protection_wet", "supply_air", "other"].map((id) => serviceRowOwner({ id }))).toEqual(["electrical", "electrical", "fire_protection", "mechanical", null]);
    expect(serviceRowOwner(zzService)).toBeNull();
  });
});

describe("c5p kernel points inside a pack scope", () => {
  it("the pack's rows join every reader, and leave with the scope", () => {
    withPackSet(set, () => {
      expect(tradeAdapter("zz.slurry_flow")).toBe(zzAdapter);
      expect(adapterForService("zz.slurry")).toBe(zzAdapter);
      expect(tradeAdapter("electrical")).toBe(electricalAdapter);
      expect(serviceById("zz.slurry")?.label).toBe("Slurry");
      expect(activeServiceRegistry().systemKindIds).toContain("zz.slurry");
      expect(derivedZoneRule("zz.swing")?.label).toBe("Swing clearance");
      expect(facetLabel("zz.loads")).toBe("Slurry loads");
      expect(symbolById("zz.valve")?.label).toBe("Slurry valve");
      expect(activeClassRegistry().getClass("zz.pump")?.source).toBe("provider:pack:zz");
      expect(activeCategoryRegistry().get("zz.pump")?.parent).toBe("equipment");
      expect(activeCategoryRegistry().get("service:zz.slurry")?.label).toBe("Slurry");
    });
    expect(tradeAdapter("zz.slurry_flow")).toBeNull();
    expect(serviceById("zz.slurry")).toBeNull();
    expect(activeCategoryRegistry().get("zz.pump")).toBeUndefined();
  });

  it("the table is built once per set: a lookup is a map read", () => {
    withPackSet(set, () => {
      const first = activeServiceRegistry();
      expect(activeServiceRegistry()).toBe(first);
    });
  });

  it("one model's pack never reaches another model on the same server", () => {
    bindModelPacks("model-a", set);
    bindModelPacks("model-b", PackSet.create([]));
    try {
      expect(withModelPacks("model-a", () => tradeAdapter("zz.slurry_flow"))).toBe(zzAdapter);
      expect(withModelPacks("model-b", () => tradeAdapter("zz.slurry_flow"))).toBeNull();
      expect(withModelPacks("model-c", () => serviceById("zz.slurry"))).toBeNull();
    } finally {
      unbindModelPacks("model-a");
      unbindModelPacks("model-b");
    }
  });

  it("a pack row may not replace a built-in row", () => {
    const thief = definePack({ id: "thief", name: "Thief", version: "1.0.0", kernel: "^1.0.0" }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "thief.x", adapter: zzAdapter }])]);
    expect(() => PackSet.create([thief])).not.toThrow();
    // A first-party namespace's class id is a built-in row; a pack using the `mep` namespace can't redefine it.
    const mep = definePack({ id: "mep", name: "Not us", version: "1.0.0", kernel: "^1.0.0" }, [contribute(CLASS_POINT, [{ id: "mep.air_terminal", label: "Mine", discipline: "mechanical" }])]);
    const s = PackSet.create([mep]);
    expect(() => withPackSet(s, () => activeClassRegistry())).toThrow(PackSetError);
  });
});
