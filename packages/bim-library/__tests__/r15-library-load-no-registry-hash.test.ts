/**
 * @jest-environment node
 *
 * Round 15: building a class registry hashed the whole registry (classes,
 * fields, relationships as canonical JSON) every time, and a library load
 * builds one per layer: the built-in MEP library, the built-in starters and
 * title blocks, then the firm's own. Under Jest that was ~2 s of the first
 * load, enough to time out a Properties test on CI. Nothing in a load reads
 * the fingerprint, so it is now hashed on first read.
 *
 * Fails on the eager registry: building one, or loading the built-in layers,
 * hashes registries.
 */
type Canonical = typeof import("../../bim-kernel/src/canonical");
type KernelRegistry = typeof import("../../bim-kernel/src/registry/registry");
type KernelFields = typeof import("../../bim-kernel/src/fields/providers");
type Library = typeof import("../src");
type LibraryFormula = typeof import("../src/bim-formula");

const isRegistryHash = (value: unknown): boolean => typeof value === "object" && value !== null && "classes" in value && "fields" in value && "relationships" in value;

/** Loads the modules fresh with canonical JSON counted, so every registry hash is seen. */
function withCountedHashing(run: (mods: { registry: KernelRegistry; fields: KernelFields; library: Library; formula: LibraryFormula }, hashed: () => number) => Promise<void> | void): Promise<void> {
  const seen: unknown[] = [];
  let pending: Promise<void> | void = undefined;
  jest.isolateModules(() => {
    jest.doMock("../../bim-kernel/src/canonical", () => {
      const actual: Canonical = jest.requireActual("../../bim-kernel/src/canonical");
      return {
        ...actual,
        canonicalJson: (value: unknown) => {
          seen.push(value);
          return actual.canonicalJson(value);
        },
      };
    });
    (require("../../bim-first-party/src") as typeof import("../../bim-first-party/src")).installFirstPartyAddOns();
    const mods = {
      registry: require("../../bim-kernel/src/registry/registry") as KernelRegistry,
      fields: require("../../bim-kernel/src/fields/providers") as KernelFields,
      library: require("../src") as Library,
      formula: require("../src/bim-formula") as LibraryFormula,
    };
    pending = run(mods, () => seen.filter(isRegistryHash).length);
  });
  return Promise.resolve(pending);
}

describe("r15: a library load never hashes the registries it builds", () => {
  it("builds a registry without hashing it, hashes once on first read, and the same registry hashes the same", () =>
    withCountedHashing(({ registry }, hashed) => {
      const build = () => registry.createRegistryBuilder().addClass({ id: "mep.r15_probe", label: "Probe", discipline: "mechanical", source: "library:r15@1" }).build();
      const r = build();
      expect(hashed()).toBe(0);
      const first = r.fingerprint;
      expect(r.fingerprint).toBe(first);
      expect(hashed()).toBe(1);
      expect(build().fingerprint).toBe(first);
      expect(registry.createRegistryBuilder().build().fingerprint).not.toBe(first);
    }));

  it("loads the built-in library layers without hashing a registry", () =>
    withCountedHashing(async ({ fields, library, formula }, hashed) => {
      const provider = new library.FileLibraryProvider({ sources: [library.builtinMepLibrarySource(), library.builtinLibrarySource()], env: { formula: formula.bimFormulaEngine, units: formula.bimUnitsCatalog, registry: fields.fieldProviderRegistry() } });
      await provider.load();
      expect((await provider.scopes()).length).toBe(2);
      expect(hashed()).toBe(0);
    }));
});
