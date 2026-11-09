/**
 * @jest-environment node
 *
 * Round 6 lane K: the always-installed first-party add-ons. They are the base
 * of every pack set (outside any scope and under each model's set), install
 * idempotently, refuse a pack that isn't first-party and a second, different
 * pack for an installed id, keep today's row order, and keep their stored
 * bare ids while any other pack namespaces its own. A model whose owning
 * add-on isn't loaded is refused by name.
 */
import { LOADS_FIELD_PROVIDER, NETWORK_ADAPTER_POINT, qtoFieldProvider, PLACEMENT_FIELD_PROVIDER, SERVES_PROVIDER, SPATIAL_FIELD_PROVIDER, derivedZoneRule, fieldProviders, symbolById, tradeAdapter } from "@permitzip/bim-kernel";
import { GAS_FIELD_PROVIDER, PLUMBING_FIELD_PROVIDER } from "@permitzip/bim-pack-plumbing";
import { MECHANICAL_FIELD_PROVIDER, VENTILATION_FIELD_PROVIDER } from "@permitzip/bim-pack-mechanical";
import { ELECTRICAL_FIELD_PROVIDER, ELECTRICAL_PACK } from "@permitzip/bim-pack-electrical";
import { ELECTRICAL_MANIFEST, PackDefinitionError, PackSet, PackSetError, activePackSet, contribute, defineExtensionPoint, definePack, installFirstPartyPacks, installedFirstPartyPacks, keepsBareIds, packNotLoadedMessage, withPackSet } from "@permitzip/bim-kernel/packs";
import { FIRST_PARTY_ADDONS as FIRST_PARTY_PACKS } from "@permitzip/bim-first-party";
import { ARCHITECTURE_FIELD_PROVIDER } from "@permitzip/bim-pack-architecture";
import { STRUCTURAL_FIELD_PROVIDER } from "@permitzip/bim-pack-structural";

const WIDGET_POINT = defineExtensionPoint<{ readonly id: string }>({ id: "test.widget", version: 1, label: "Widgets", idOf: (w) => w.id });

describe("c6k first-party add-ons are the base of every set", () => {
  it("the kernel entry installs the six, in first-party order (Structural since round 14), and an explicit install of the same packs changes nothing", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).toEqual(["electrical", "plumbing_gas", "mechanical", "fire_protection", "architecture", "struct"]);
    const before = installedFirstPartyPacks();
    installFirstPartyPacks([...FIRST_PARTY_PACKS].reverse());
    installFirstPartyPacks(FIRST_PARTY_PACKS);
    expect(installedFirstPartyPacks()).toBe(before);
  });

  it("refuses a pack that isn't first-party, and a second, different pack for an installed id", () => {
    const zz = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, []);
    expect(() => installFirstPartyPacks([zz])).toThrow(PackSetError);
    expect(() => installFirstPartyPacks([zz])).toThrow(/zz isn't a first-party add-on/);
    const impostor = definePack({ ...ELECTRICAL_MANIFEST, version: "9.9.9" }, []);
    expect(() => installFirstPartyPacks([impostor])).toThrow(/Electrical is already installed \(1\.0\.0\); a second, different electrical pack 9\.9\.9 was refused/);
    expect(installedFirstPartyPacks()[0]).toBe(ELECTRICAL_PACK);
  });

  it("their rows reach every set, outside any scope and under a model's own packs, in today's order", () => {
    const zz = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(WIDGET_POINT, [{ id: "zz.one" }])]);
    const set = PackSet.create([zz]);
    // Round 13: the Architecture add-on's building fields (rank 10) follow Electrical's; round 14: Structural's members (rank 10) follow them.
    const order = [SPATIAL_FIELD_PROVIDER, ELECTRICAL_FIELD_PROVIDER, ARCHITECTURE_FIELD_PROVIDER, STRUCTURAL_FIELD_PROVIDER, PLUMBING_FIELD_PROVIDER, GAS_FIELD_PROVIDER, MECHANICAL_FIELD_PROVIDER, SERVES_PROVIDER, PLACEMENT_FIELD_PROVIDER, LOADS_FIELD_PROVIDER, qtoFieldProvider(), VENTILATION_FIELD_PROVIDER];
    for (const where of [activePackSet(), set]) {
      withPackSet(where, () => {
        expect(activePackSet().items(NETWORK_ADAPTER_POINT).map((i) => i.id)).toEqual(["electrical", "plumbing", "mechanical", "struct.load_path"]);
        expect(fieldProviders()).toEqual(order);
        expect(tradeAdapter("electrical")).not.toBeNull();
        expect(derivedZoneRule("dedicated")?.label).toBe("Dedicated equipment space");
        expect(symbolById("elec_utility_source")).not.toBeNull();
      });
    }
    expect(set.pins()).toEqual([{ id: "zz", version: "1.0.0" }]);
    expect(set.has("electrical")).toBe(true);
  });

  it("first-party packs keep bare ids; any other pack, even one calling itself first-party, namespaces", () => {
    expect(keepsBareIds(ELECTRICAL_MANIFEST)).toBe(true);
    expect(() => definePack(ELECTRICAL_MANIFEST, [contribute(WIDGET_POINT, [{ id: "bare_row" }])])).not.toThrow();
    expect(() => definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(WIDGET_POINT, [{ id: "bare_row" }])])).toThrow(PackDefinitionError);
    expect(() => definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0", firstParty: true }, [contribute(WIDGET_POINT, [{ id: "bare_row" }])])).toThrow(/must start with "zz\."/);
  });

  it("a pack row may not replace a first-party row", () => {
    const zz = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.electrical" }])]);
    expect(() => PackSet.create([zz]).items(NETWORK_ADAPTER_POINT)).not.toThrow();
    const clash = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [contribute(defineExtensionPoint<{ readonly id: string }>({ id: "kernel.network_adapter", version: 1, label: "Network adapters", idOf: (w) => w.id, namespaced: false }), [{ id: "electrical" }])]);
    expect(() => PackSet.create([clash]).items(NETWORK_ADAPTER_POINT)).toThrow(/"electrical" is a first-party row/);
  });

  it("names the add-on a model needs when it isn't loaded", async () => {
    expect(packNotLoadedMessage("electrical")).toBe("This model uses Electrical, which isn't loaded here");
    // A process that loads the command entry alone (no kernel entry, no host install): Electrical isn't loaded.
    await jest.isolateModulesAsync(async () => {
      const { commandSchema } = await import("@permitzip/bim-kernel/commands");
      const r = commandSchema.safeParse({ type: "place_service_layout", label: "x", levelId: "l", partTypes: [], equipment: [], feeders: [] });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.message)).toEqual(["This model uses Electrical, which isn't loaded here"]);
    });
  });
});
