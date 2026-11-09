/**
 * @jest-environment node
 *
 * Expand, then contract, for the service registry (MIGRATION-PLAN §3, §6
 * "Services"), in both directions:
 *
 * - An old reader (round 4: `z.enum` of the twenty kinds) can't read a part
 *   type or system carrying grease waste, so a writer emits a registry row
 *   only when its peer advertises `services:registry`. The gate runs in every
 *   command's finish, through the same upgrade policy gated record steps use.
 * - A new reader meets a kind it doesn't know (a newer peer's): the part type
 *   still parses, the model round-trips byte-for-byte, it draws as Other, and
 *   edits that don't change the kind are not refused.
 *
 * Every refusal is in plain words. Fails on the old code: grease waste was
 * not a system kind (the connector enum refused it outright), and nothing
 * checked a peer before writing one.
 */
import { z } from "zod";
import { asElementId, partTypeDefinitionSchema, systemStyle, withUpgradePolicy, withoutUpgrades, type MepSystem, type PartTypeDefinition, type SystemKind } from "../src";
import { LEGACY_SYSTEM_KIND_IDS } from "../src/services/builtin";
import { createServiceRegistry, firstPartyServiceRegistry, withFirmServices } from "../src/services/registry";
import { SERVICES_REGISTRY_FEATURE } from "../src/services/types";
import { withServiceRegistry } from "../src/services/write-gate";
import { plumbingAdapter } from "@permitzip/bim-pack-plumbing";
import { DrainageBuilding, FT } from "./drainage-fixtures";

const advertised = (f: string) => f === SERVICES_REGISTRY_FEATURE;

function interceptorType(kind: string): PartTypeDefinition {
  return {
    familyName: "Grease interceptor",
    typeName: "50 gpm",
    category: "pipe_accessory",
    typeParams: [{ name: "plumbing_source", label: "Plumbing source", kind: "text" }],
    typeValues: { plumbing_source: "grease_interceptor" },
    instanceParams: [],
    tagFields: [],
    geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
    connectors: [
      { id: "in", label: "Inlet", domain: "pipe", systemKind: kind as SystemKind, position: [-300, 0, 300], direction: [-1, 0, 0], shape: "round", diameter: 101.6, flowDirection: "in" },
      { id: "out", label: "Outlet", domain: "pipe", systemKind: "sanitary", position: [300, 0, 300], direction: [1, 0, 0], shape: "round", diameter: 101.6, flowDirection: "out" },
    ],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

const place = (kind: string, id = "gi-1") => ({ type: "place_part" as const, partId: id, typeId: `type-${id}`, partType: interceptorType(kind), levelId: "lvl-1", position: { x: 0, y: 0 }, mark: id.toUpperCase(), values: {} });

/** The round-4 connector schema's systemKind, as a deployed old reader parses it. */
const oldReaderConnector = z.object({ systemKind: z.enum(LEGACY_SYSTEM_KIND_IDS) });

describe("old readers vs the registry's new rows: writers wait for the peer", () => {
  it("an old reader can't read grease waste, which is why it is gated", () => {
    expect(oldReaderConnector.safeParse({ systemKind: "grease_waste" }).success).toBe(false);
    expect(oldReaderConnector.safeParse({ systemKind: "sanitary" }).success).toBe(true);
  });

  it("with no peer advertising services:registry, a part type with a grease waste inlet is refused in plain words", () => {
    const b = new DrainageBuilding();
    const why = b.try(place("grease_waste"));
    expect(why).toBe("Grease waste can't be saved yet: the model server this model is open on is an older version that doesn't store grease waste systems. Draw it as sanitary for now, or try again once the server is updated");
    expect(b.head.elements["gi-1"]).toBeUndefined();
  });

  it("once the server advertises it, the same edit commits; round-4 kinds never needed it", () => {
    const b = new DrainageBuilding();
    expect(b.try(place("sanitary", "gi-old"))).toBeNull();
    expect(withUpgradePolicy(advertised, () => b.try(place("grease_waste")))).toBeNull();
    const type = b.head.elements["type-gi-1"];
    expect(type?.kind === "part_type" ? type.definition.connectors[0]?.systemKind : null).toBe("grease_waste");
  });

  it("a load needing grease waste was always readable, so it is never gated", () => {
    const b = new DrainageBuilding();
    expect(b.try({ type: "create_load", loads: [{ id: "lp-sk3", mark: "SK3-1", service: "grease_waste", values: { dfu: 3 } }] })).toBeNull();
  });

  it("undo restores stored records exactly: the gate stands aside", () => {
    const b = new DrainageBuilding();
    expect(withoutUpgrades(() => b.try(place("grease_waste")))).toBeNull();
  });

  it("an id the registry doesn't know is refused at command time, and a firm's registry makes its own row writable", () => {
    const b = new DrainageBuilding();
    const refused = b.try(place("steam_condensate"));
    expect(refused).toMatch(/^Grease interceptor 50 gpm can't carry "Steam condensate": it isn't a system this version of the model knows\. Choose ".*"grease waste"/);
    expect(refused).not.toContain('"steam condensate"');
    const base = firstPartyServiceRegistry().rows.find((r) => r.id === "condensate");
    if (!base) throw new Error("condensate row");
    const firm = withFirmServices(firstPartyServiceRegistry(), [{ ...base, id: "firm:steam_condensate", label: "Steam condensate" }]);
    expect(withServiceRegistry(firm, () => b.try(place("firm:steam_condensate")))).toBeNull();
    expect(createServiceRegistry(firm.rows).byId.has("firm:steam_condensate")).toBe(true);
  });
});

describe("new readers vs kinds from a newer peer", () => {
  const future: PartTypeDefinition = { ...interceptorType("future_kind") };

  it("a part type with an unknown kind still parses and round-trips byte-for-byte", () => {
    const json = JSON.stringify(future);
    const parsed = partTypeDefinitionSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.connectors[0]?.systemKind : null).toBe("future_kind");
    // Malformed ids are still refused: tolerance is for well-formed service ids only.
    expect(partTypeDefinitionSchema.safeParse({ ...future, connectors: [{ ...future.connectors[0], systemKind: "Not An Id" }] }).success).toBe(false);
  });

  it("a stored system of an unknown kind loads, draws as Other, and edits that keep its kind are not refused", () => {
    const b = new DrainageBuilding();
    const system: MepSystem = { kind: "mep_system", id: asElementId("sys-future"), version: 1, authoredRev: {}, name: "Future 1", systemKind: "future_kind" as SystemKind, domain: "pipe" };
    b.head = { ...b.head, elements: { ...b.head.elements, [system.id]: system } };
    const before = JSON.stringify(b.head.elements["sys-future"]);
    expect(systemStyle(system)).toMatchObject({ colour: "#2ea86b", pattern: "solid" });
    expect(b.try({ type: "set_system_graphics", systemId: "sys-future", colour: "#123456" })).toBeNull();
    const after = b.head.elements["sys-future"];
    expect(after?.kind === "mep_system" ? after.systemKind : null).toBe("future_kind");
    // Every stored field is as it was; the edit added only its own field and the kernel's bookkeeping.
    const fields = (json: string): Record<string, unknown> => {
      const o: Record<string, unknown> = JSON.parse(json);
      delete o.version;
      delete o.authoredRev;
      return o;
    };
    expect(JSON.stringify(fields(JSON.stringify(after)))).toBe(JSON.stringify({ ...fields(before), graphics: { colour: "#123456" } }));
  });

  it("the plumbing network ignores a connector of an unknown kind instead of failing", () => {
    const b = new DrainageBuilding();
    b.head = { ...b.head, elements: { ...b.head.elements, "type-f": { kind: "part_type", id: asElementId("type-f"), version: 1, authoredRev: {}, definition: future } } };
    expect(withUpgradePolicy(advertised, () => b.try({ type: "place_part", partId: "gi-f", typeId: "type-f", levelId: "lvl-1", position: { x: 10 * FT, y: 0 }, mark: "GI-F", values: {} }))).toBeNull();
    const part = b.head.elements["gi-f"];
    if (part?.kind !== "part") throw new Error("placed");
    expect(plumbingAdapter.connectors(b.head.elements, part)).toEqual(["out"]);
  });
});
