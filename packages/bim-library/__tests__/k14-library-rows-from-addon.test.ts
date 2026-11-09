/**
 * @jest-environment node
 *
 * Round 14 lane K14 step 2: Structural's rows in the built-in library come
 * from the Structural add-on through `kernel.library_rows`. The built-in
 * bundle loads the kernel's own rows, then each add-on's; without Structural
 * (a fresh kernel with the other first-party add-ons: since step 3
 * Structural is first-party, so installed in every host) the beam's camber field and the
 * footing class item are absent, with it they are back with the same ids,
 * revisions and bytes.
 *
 * Fails on round 13's code: `aec.ts` held both rows itself, there was no
 * `builtinLibraryBundle()` and Structural contributed no library rows.
 */
import { withBaseFields, type Registry } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { STRUCT_LIBRARY_ROWS, STRUCTURAL_PACK } from "@permitzip/bim-pack-structural";
import { AEC_LIBRARY, FileLibraryProvider, builtinLibraryBundle, builtinLibrarySource, loadBundle } from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env = { formula: bimFormulaEngine, units: bimUnitsCatalog };

/** The two rows exactly as round 13's built-in bundle stored them. */
const ROUND_13_ROWS = [
  {
    section: "classes",
    item: {
      id: "aec:class:struct.footing",
      revision: 1,
      key: "struct.footing",
      replaces: true,
      label: "Footings",
      discipline: "structure",
      ifc: { entity: "IfcFooting" },
      recognize: { elementKinds: ["component"], where: [{ path: "category", op: "equals", value: "footing" }] },
    },
  },
  {
    section: "fields",
    item: { id: "aec:field:struct.beam.camber", revision: 2, key: "struct.camber", aliases: ["camber"], label: "Camber", appliesTo: ["struct.beam"], valueType: "quantity", kind: "length", unit: "in", group: "Dimensions", editable: true, storage: { kind: "values" } },
  },
];

const idsOf = (list: readonly unknown[] | undefined): string[] => (list ?? []).flatMap((i) => (typeof i === "object" && i !== null && "id" in i && typeof i.id === "string" ? [i.id] : []));

// On the kernel's built-in registry: over the field-provider registry, Architecture's provider and the
// bundle both define the door's fields (round 13's red `c5p3`, not this lane's).
function registryOf(bundle: unknown): Registry {
  const loaded = loadBundle(bundle, env);
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join("\n"));
  return withBaseFields(loaded.registry);
}

const structuralOn = PackSet.create([STRUCTURAL_PACK]);

describe("k14 library rows from the Structural add-on", () => {
  it("the kernel's own bundle names no structural row", () => {
    const ids = [...idsOf(AEC_LIBRARY.classes), ...idsOf(AEC_LIBRARY.fields)];
    expect(ids.filter((id) => /struct\./.test(id))).toEqual([]);
  });

  it("Structural's rows are round 13's, byte for byte", () => {
    expect(JSON.stringify(STRUCT_LIBRARY_ROWS)).toBe(JSON.stringify(ROUND_13_ROWS));
  });

  it("without Structural installed, the bundle loads and camber and the footing item are absent", async () => {
    await jest.isolateModulesAsync(async () => {
      const packs = await import("@permitzip/bim-kernel/packs");
      const firstParty = await import("@permitzip/bim-first-party");
      packs.installFirstPartyPacks(firstParty.FIRST_PARTY_ADDONS.filter((p) => p.manifest.id !== "struct"));
      const lib = await import("../src");
      expect(packs.installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("struct");
      const bundle = lib.builtinLibraryBundle();
      expect(idsOf(bundle.fields)).not.toContain("aec:field:struct.beam.camber");
      expect(idsOf(bundle.classes)).not.toContain("aec:class:struct.footing");
      const p = new lib.FileLibraryProvider({ env, sources: [lib.builtinLibrarySource()] });
      expect((await p.list("builtin", { type: "field" })).map((f) => f.id)).not.toContain("aec:field:struct.beam.camber");
    });
  });

  it("Structural is first-party, so the default bundle carries its rows", () => {
    const bundle = builtinLibraryBundle();
    expect(idsOf(bundle.fields)).toContain("aec:field:struct.beam.camber");
    expect(idsOf(bundle.classes)).toContain("aec:class:struct.footing");
  });

  it("with Structural pinned as well, its rows join once, after the kernel's own, and read as before", async () => {
    const { bundle, source } = withPackSet(structuralOn, () => ({ bundle: builtinLibraryBundle(), source: builtinLibrarySource() }));
    expect(idsOf(bundle.fields).filter((id) => id === "aec:field:struct.beam.camber")).toHaveLength(1);
    const fields = idsOf(bundle.fields);
    expect(fields.slice(0, idsOf(AEC_LIBRARY.fields).length)).toEqual(idsOf(AEC_LIBRARY.fields));
    expect(fields).toContain("aec:field:struct.beam.camber");
    expect(idsOf(bundle.classes)).toContain("aec:class:struct.footing");
    expect(registryOf(bundle).field("struct.beam", "camber")).toMatchObject({ key: "struct.camber", unit: "in", group: "Dimensions" });
    const p = new FileLibraryProvider({ env, sources: [source] });
    const camber = (await p.list("builtin", { type: "field" })).find((f) => f.id === "aec:field:struct.beam.camber");
    expect(camber?.key).toBe("struct.camber");
  });
});
