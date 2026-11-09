/**
 * @jest-environment node
 *
 * Round 11 R11-pre: the field registry is built in one pass per pack set.
 * Opening a model with an outside data add-on pinned built it three times
 * (the providers, then `withPackClasses`, then the parameter layer), which is
 * what kept `authority.boot.with_outside_packs.ratio` at 111.5 against 105.
 *
 * Fails on the old code: `fieldProviderRegistry()` ran two more builds than
 * the bare provider builder, and `withPackParameters` two builds, not one.
 * The registries built in one pass equal the three-pass ones (fingerprint
 * and every class's fields) for first-party sets and an outside add-on.
 */
import { builtinRegistry, fieldProviderRegistry, fieldProviderRegistryBuilder, packClassRegistry, packParameterField, PARAMETER_SET_POINT, withPackParameters, type Registry } from "@permitzip/bim-kernel";
import { PackSet, withPackSet, type Pack } from "@permitzip/bim-kernel/packs";
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";
import { STRUCTURAL_PACK } from "@permitzip/bim-pack-structural";
import { CIVIL_PACK } from "@permitzip/bim-pack-civil";
import { buildDataAddon } from "../src/install";
import { doorAddon } from "./fixtures/a11-outside";

function outsidePack(): Pack {
  const built = buildDataAddon(doorAddon({ classes: 5 }));
  if (!built.ok) throw new Error(built.problems.join("; "));
  return built.pack;
}

/** Round 10's composition: the provider registry, then the classes, then the parameters, each built. */
function threePass(set: PackSet): Registry {
  return withPackSet(set, () => {
    const withClasses = packClassRegistry(fieldProviderRegistryBuilder().build(), set);
    const sets = set.packItems(PARAMETER_SET_POINT);
    if (sets.length === 0) return withClasses;
    const b = withClasses.extend();
    for (const s of sets) {
      const source = `provider:pack:${s.id.slice(0, Math.max(0, s.id.indexOf(".")))}` as const;
      for (const p of s.parameters) b.addField({ ...packParameterField(p), source });
    }
    return b.build();
  });
}

function fieldsOf(r: Registry): string {
  return JSON.stringify(
    r.listClasses({ includeAbstract: true }).map((c) => [c.id, c.source, r.fieldsFor(c.id).map(({ read, ...decl }) => ({ ...decl, read: read !== undefined }))]),
  );
}

/** Counts `RegistryBuilder.build()` calls made inside `fn`. */
function builds<T>(fn: () => T): { value: T; count: number } {
  const proto: { build: () => Registry } = Object.getPrototypeOf(builtinRegistry().extend());
  const spy = jest.spyOn(proto, "build");
  try {
    const value = fn();
    return { value, count: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

const SETS: ReadonlyArray<readonly [string, () => PackSet]> = [
  ["first-party add-ons", () => PackSet.create(FIRST_PARTY_ADDONS)],
  // Structural is one of the first-party add-ons since round 14.
  ["first-party (Structural among them) + Civil", () => PackSet.create([...FIRST_PARTY_ADDONS, CIVIL_PACK])],
  ["first-party + an outside data add-on", () => PackSet.create([...FIRST_PARTY_ADDONS, outsidePack()])],
  ["Structural + Civil + an outside data add-on", () => PackSet.create([STRUCTURAL_PACK, CIVIL_PACK, outsidePack()])],
];

describe("r11-pre one-pass field registry", () => {
  it.each(SETS)("%s: one pass equals the three-pass registry (fingerprint and every class's fields)", (_name, make) => {
    const set = make();
    const one = withPackSet(set, () => fieldProviderRegistry());
    const three = threePass(set);
    expect(one.fingerprint).toBe(three.fingerprint);
    expect(fieldsOf(one)).toBe(fieldsOf(three));
  });

  it("an outside add-on's classes and parameters reach the registry", () => {
    const set = PackSet.create([...FIRST_PARTY_ADDONS, outsidePack()]);
    const r = withPackSet(set, () => fieldProviderRegistry());
    expect(r.getClass("acme.door_1")?.source).toBe("provider:pack:acme");
    expect(r.field("acme.door_1", "acme.hardware_set")).toMatchObject({ label: "Hardware set", source: "provider:pack:acme" });
  });

  it("opening with an outside add-on costs no registry build beyond the providers' own", () => {
    const set = PackSet.create([...FIRST_PARTY_ADDONS, outsidePack()]);
    const bare = withPackSet(set, () => builds(() => fieldProviderRegistryBuilder().build())).count;
    const full = withPackSet(set, () => builds(() => fieldProviderRegistry())).count;
    expect(full).toBe(bare);
  });

  it("withPackParameters joins classes and parameters in one build", () => {
    const set = PackSet.create([STRUCTURAL_PACK, CIVIL_PACK, outsidePack()]);
    const { value, count } = builds(() => withPackParameters(builtinRegistry(), set));
    expect(count).toBe(1);
    expect(value.fingerprint).toBe(withPackSet(set, () => {
      const withClasses = packClassRegistry(builtinRegistry(), set);
      const b = withClasses.extend();
      for (const s of set.packItems(PARAMETER_SET_POINT)) for (const p of s.parameters) b.addField({ ...packParameterField(p), source: `provider:pack:${s.id.slice(0, s.id.indexOf("."))}` });
      return b.build();
    }).fingerprint);
    // Same set and base: the same registry object.
    expect(withPackParameters(builtinRegistry(), set)).toBe(value);
  });
});
