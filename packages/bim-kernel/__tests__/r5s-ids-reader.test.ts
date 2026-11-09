/**
 * @jest-environment node
 *
 * One id grammar that readers accept now (foundation adjustments A, C3): a
 * part type saved by a later pack carries a connector on `fp.sprinkler_wet`
 * and a structural `member` connector. This release's readers keep it byte
 * for byte, show the raw words, and walk neither; its writers still refuse
 * an id their registry doesn't hold. Packs and firms add rows through
 * `withServiceRows`, never with a bare (built-in) id.
 *
 * Fails on the old code: the connector schema refused `fp.sprinkler_wet`
 * (`firm:`-or-bare ids only) and `member` (`z.enum(CONNECTOR_DOMAINS)`), so
 * the whole part type was unreadable.
 */
import { asElementId, partTypeDefinitionSchema, resolveConnectors, systemRules, systemStyle, type PartTypeDefinition, type SystemKind } from "../src";
import { plumbingAdapter } from "@permitzip/bim-pack-plumbing";
import { mechanicalAdapter } from "@permitzip/bim-pack-mechanical";
import { firstPartyServiceRegistry, serviceLabel, withFirmServices, withServiceRows } from "../src/services/registry";
import { DrainageBuilding } from "./drainage-fixtures";

/** In the schema's own key order, as the kernel stores a part type. */
const PACK_TYPE: PartTypeDefinition = {
  familyName: "Sprinkler riser",
  typeName: "4 in.",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [
    { id: "riser", label: "Riser", domain: "pipe", systemKind: "fp.sprinkler_wet" as SystemKind, position: [0, 0, 600], direction: [0, 0, 1], shape: "round", diameter: 101.6 },
    { id: "hanger", label: "Hanger", domain: "member" as "pipe", systemKind: "struct.gravity_load" as SystemKind, position: [0, 0, 0], direction: [0, 0, -1], shape: "none" },
  ],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [300, 300, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [300, 300] }],
  tagFields: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

describe("readers accept pack ids and a member connector", () => {
  it("the part type parses and round-trips byte for byte", () => {
    const json = JSON.stringify(PACK_TYPE);
    const parsed = partTypeDefinitionSchema.safeParse(JSON.parse(json));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? JSON.stringify(parsed.data) : null).toBe(json);
  });

  it("shows raw words, draws as Other, and no adapter walks it", () => {
    expect(serviceLabel("fp.sprinkler_wet")).toBe("Sprinkler wet");
    expect(systemRules("fp.sprinkler_wet").label).toBe("Sprinkler wet");
    expect(systemStyle({ systemKind: "fp.sprinkler_wet" as SystemKind })).toMatchObject({ colour: "#2ea86b", pattern: "solid" });
    const b = new DrainageBuilding();
    b.head = { ...b.head, elements: { ...b.head.elements, "type-fp": { kind: "part_type", id: asElementId("type-fp"), version: 1, authoredRev: {}, definition: PACK_TYPE } } };
    expect(b.try({ type: "place_part", partId: "fp-1", typeId: "type-fp", levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "FP-1", values: {} })).toBeNull();
    const part = b.head.elements["fp-1"];
    if (part?.kind !== "part") throw new Error("placed");
    expect(resolveConnectors(PACK_TYPE, {}).map((c) => c.domain)).toEqual(["pipe", "member"]);
    expect(plumbingAdapter.connectors(b.head.elements, part)).toEqual([]);
    expect(mechanicalAdapter.connectors(b.head.elements, part)).toEqual([]);
    expect(JSON.stringify(b.head.elements["type-fp"])).toContain('"domain":"member"');
  });

  it("writers still refuse ids and domains their registry doesn't hold, in plain words", () => {
    const b = new DrainageBuilding();
    expect(b.try({ type: "place_part", partId: "fp-2", typeId: "type-fp2", partType: PACK_TYPE, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "FP-2", values: {} })).toBe("Sprinkler riser 4 in.'s Hanger connects to \"member\", which this version of the model can't draw. Use a duct, pipe or electrical connection");
    const onlyRiser: PartTypeDefinition = { ...PACK_TYPE, connectors: [PACK_TYPE.connectors[0] ?? PACK_TYPE.connectors[1]].filter((c): c is NonNullable<typeof c> => c !== undefined) };
    const refused = b.try({ type: "place_part", partId: "fp-3", typeId: "type-fp3", partType: onlyRiser, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "FP-3", values: {} });
    expect(refused).toMatch(/^Sprinkler riser 4 in\. can't carry "Sprinkler wet": it isn't a system this version of the model knows\. Choose ".*"sanitary"/);
    expect(refused).not.toContain('"sprinkler wet"');
  });
});

describe("withServiceRows: firms and packs add rows, built-in ids are reserved", () => {
  const base = firstPartyServiceRegistry().rows.find((r) => r.id === "domestic_cold_water");
  if (!base) throw new Error("row");
  const row = (id: string) => ({ ...base, id, label: id });

  it("a pack row is namespaced, a firm row is firm:, and a bare id is refused for both", () => {
    expect(withServiceRows(firstPartyServiceRegistry(), [row("fp.sprinkler_wet")], { source: "pack" }).byId.has("fp.sprinkler_wet")).toBe(true);
    expect(withServiceRows(firstPartyServiceRegistry(), [row("firm:steam")], { source: "firm" }).byId.has("firm:steam")).toBe(true);
    expect(() => withServiceRows(firstPartyServiceRegistry(), [row("sprinkler_wet")], { source: "pack" })).toThrow(/would redefine a built-in service/);
    expect(() => withServiceRows(firstPartyServiceRegistry(), [row("firm:steam")], { source: "pack" })).toThrow(/namespaced id/);
    expect(() => withServiceRows(firstPartyServiceRegistry(), [row("fp.sprinkler_wet")], { source: "firm" })).toThrow(/firm: id/);
    expect(() => withFirmServices(firstPartyServiceRegistry(), [row("sanitary")])).toThrow(/would redefine a built-in service/);
  });
});
