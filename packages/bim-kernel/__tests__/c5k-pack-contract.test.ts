/**
 * @jest-environment node
 *
 * The add-on contract core (packs/contract.ts, set.ts, scope.ts) and the
 * per-model pins reader. Fails on 5b: none of these exist, and
 * `readModelSettings` dropped every key it didn't know.
 */
import { BUILTIN_PACK_SET, PACK_CONTRACT_VERSION, PackDefinitionError, PackSet, PackSetError, activePackSet, bindModelPacks, contribute, defineExtensionPoint, definePack, resolvePackPins, satisfies, unbindModelPacks, withModelPacks, withPackSet, type Pack } from "@permitzip/bim-kernel/packs";
import { DEFAULT_SETTINGS, readModelSettings } from "@permitzip/bim-kernel";

interface Widget {
  readonly id: string;
  readonly size: number;
}

const BUILTIN_WIDGETS: readonly Widget[] = [{ id: "plain", size: 1 }];
const WIDGET_POINT = defineExtensionPoint<Widget>({ id: "test.widget", version: 1, label: "Widgets", idOf: (w) => w.id, builtins: () => BUILTIN_WIDGETS });
const WIDGET_POINT_V2 = defineExtensionPoint<Widget>({ id: "test.widget", version: 2, label: "Widgets", idOf: (w) => w.id });

const pack = (id: string, widgets: readonly Widget[], extra: Partial<Pack["manifest"]> = {}): Pack => definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: "^1.0.0", ...extra }, [contribute(WIDGET_POINT, widgets)]);

describe("semver subset", () => {
  it.each([
    ["1.0.0", "^1.0.0", true],
    ["1.9.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.5.0", ">=1.0.0 <2.0.0", true],
    ["1.0.0", "1.0.0", true],
    ["1.0.1", "1.0.0", false],
    ["3.1.4", "*", true],
    ["not-a-version", "*", false],
    ["1.0.0", "latest", false],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("this release satisfies the range packs are written for", () => {
    expect(satisfies(PACK_CONTRACT_VERSION, "^1.0.0")).toBe(true);
  });
});

describe("definePack", () => {
  it("lists every problem at once", () => {
    let caught: unknown;
    try {
      definePack({ id: "Firm", name: " ", version: "1", kernel: "whenever" }, [contribute(WIDGET_POINT, [{ id: "other.thing", size: 1 }, { id: "Bad Id", size: 2 }])]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PackDefinitionError);
    const problems = (caught as PackDefinitionError).problems.join("\n");
    expect(problems).toMatch(/pack id "Firm"/);
    expect(problems).toMatch(/name is empty/);
    expect(problems).toMatch(/not semver/);
    expect(problems).toMatch(/not a supported range/);
    expect(problems).toMatch(/"other.thing" must start with "Firm."/);
    expect(problems).toMatch(/"Bad Id" is not a registry id/);
  });

  it("refuses reserved namespaces", () => {
    expect(() => pack("firm", [])).toThrow(/reserved/);
    expect(() => pack("core", [])).toThrow(/reserved/);
  });

  it("accepts a namespaced pack", () => {
    expect(pack("struct", [{ id: "struct.beam", size: 3 }]).manifest.id).toBe("struct");
  });
});

describe("PackSet", () => {
  it("is built-ins only with no packs", () => {
    expect(BUILTIN_PACK_SET.items(WIDGET_POINT)).toEqual(BUILTIN_WIDGETS);
    expect(BUILTIN_PACK_SET.revision).toBe("builtins");
  });

  it("puts pack rows after built-in rows, in pack order", () => {
    const set = PackSet.create([pack("struct", [{ id: "struct.beam", size: 3 }]), pack("civil", [{ id: "civil.inlet", size: 4 }])]);
    expect(set.items(WIDGET_POINT).map((w) => w.id)).toEqual(["plain", "struct.beam", "civil.inlet"]);
    expect(set.pins()).toEqual([{ id: "struct", version: "1.0.0" }, { id: "civil", version: "1.0.0" }]);
    expect(set.contributors(WIDGET_POINT)).toEqual([
      { packId: "struct", packName: "STRUCT", version: "1.0.0", count: 1 },
      { packId: "civil", packName: "CIVIL", version: "1.0.0", count: 1 },
    ]);
  });

  it("refuses a broken set with every problem listed", () => {
    const wrongContract = pack("old", [], { kernel: "^0.1.0" });
    // Civil: an add-on this set doesn't use (Structural, used here before round 14, is first-party now).
    const needsMissing = pack("needy", [], { requires: [{ id: "civil", range: "^2.0.0" }] });
    const dupA = pack("dup", [{ id: "dup.x", size: 1 }]);
    const dupB = pack("dup", [{ id: "dup.x", size: 1 }]);
    let caught: unknown;
    try {
      PackSet.create([wrongContract, needsMissing, dupA, dupB]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PackSetError);
    const problems = (caught as PackSetError).problems.join("\n");
    expect(problems).toMatch(/pack old 1.0.0 was written for contract \^0.1.0/);
    expect(problems).toMatch(/needy needs pack civil \^2.0.0/);
    expect(problems).toMatch(/two packs use the namespace "dup"/);
    expect(problems).toMatch(/"dup.x" comes from both dup and dup/);
  });

  it("refuses packs written for different majors of one point", () => {
    const v1 = pack("one", [{ id: "one.a", size: 1 }]);
    const v2 = definePack({ id: "two", name: "Two", version: "1.0.0", kernel: "^1.0.0" }, [contribute(WIDGET_POINT_V2, [{ id: "two.a", size: 1 }])]);
    expect(() => PackSet.create([v1, v2])).toThrow(/different versions of Widgets/);
    expect(() => PackSet.create([v2]).items(WIDGET_POINT)).toThrow(/written for Widgets v2; this release reads v1/);
  });

  it("refuses a pack row that replaces a built-in row", () => {
    const sneaky = definePack({ id: "sneaky", name: "Sneaky", version: "1.0.0", kernel: "^1.0.0" }, [contribute(defineExtensionPoint<Widget>({ ...WIDGET_POINT, namespaced: false }), [{ id: "plain", size: 9 }])]);
    expect(() => PackSet.create([sneaky]).items(WIDGET_POINT)).toThrow(/"plain" is a built-in row/);
  });

  it("memoises derived tables per set", () => {
    const set = PackSet.create([pack("struct", [])]);
    let calls = 0;
    const a = set.memo("table", () => ({ n: ++calls }));
    const b = set.memo("table", () => ({ n: ++calls }));
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("resolves stored pins and reports the missing ones", () => {
    const zz = pack("zz", []);
    const { set, missing } = resolvePackPins([zz], [{ id: "zz", version: "1.0.0" }, { id: "civil", version: "1.0.0" }, { id: "zz", version: "9.9.9" }]);
    expect(set.pins()).toEqual([{ id: "zz", version: "1.0.0" }]);
    expect(missing).toEqual([{ id: "civil", version: "1.0.0" }, { id: "zz", version: "9.9.9" }]);
  });

  it("a pin for an installed first-party add-on is satisfied by the base, whatever version it names (round 14)", () => {
    const { set, missing } = resolvePackPins([], [{ id: "struct", version: "0.1.0" }, { id: "electrical", version: "9.9.9" }, { id: "civil", version: "1.0.0" }]);
    expect(set.pins()).toEqual([]);
    expect(missing).toEqual([{ id: "civil", version: "1.0.0" }]);
  });
});

describe("pack scope", () => {
  const struct = PackSet.create([pack("struct", [{ id: "struct.beam", size: 3 }])]);
  const civil = PackSet.create([pack("civil", [{ id: "civil.inlet", size: 4 }])]);
  const ids = () => activePackSet().items(WIDGET_POINT).map((w) => w.id);

  afterEach(() => {
    unbindModelPacks("m-struct");
    unbindModelPacks("m-civil");
  });

  it("is built-ins outside any scope", () => {
    expect(ids()).toEqual(["plain"]);
  });

  it("nests and restores", () => {
    const seen = withPackSet(struct, () => [ids(), withPackSet(civil, ids), ids()]);
    expect(seen).toEqual([["plain", "struct.beam"], ["plain", "civil.inlet"], ["plain", "struct.beam"]]);
    expect(ids()).toEqual(["plain"]);
  });

  it("restores after a throw", () => {
    expect(() => withPackSet(struct, () => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(ids()).toEqual(["plain"]);
  });

  it("refuses an async callback", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => withPackSet(struct, () => Promise.resolve(1))).toThrow(/synchronous/);
    expect(spy).toHaveBeenCalled();
    expect(ids()).toEqual(["plain"]);
  });

  it("keeps two models on one process apart", () => {
    bindModelPacks("m-struct", struct);
    bindModelPacks("m-civil", civil);
    expect(withModelPacks("m-struct", ids)).toEqual(["plain", "struct.beam"]);
    expect(withModelPacks("m-civil", ids)).toEqual(["plain", "civil.inlet"]);
    expect(withModelPacks("m-unbound", ids)).toEqual(["plain"]);
  });
});

describe("model settings keep pack pins", () => {
  it("reads pins and keeps ones this release lacks", () => {
    const settings = readModelSettings({ ...DEFAULT_SETTINGS, packs: [{ id: "struct", version: "1.2.0" }, { id: "fa", version: "0.1.0" }] });
    expect(settings.packs).toEqual([{ id: "struct", version: "1.2.0" }, { id: "fa", version: "0.1.0" }]);
  });

  it("reads old settings unchanged", () => {
    expect(readModelSettings({ ...DEFAULT_SETTINGS })).toEqual(DEFAULT_SETTINGS);
    expect(readModelSettings(JSON.stringify(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it("drops a value that isn't a list loudly", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(readModelSettings({ ...DEFAULT_SETTINGS, packs: { id: 3 } })).toEqual(DEFAULT_SETTINGS);
    expect(spy).toHaveBeenCalled();
  });

  it("leaves out an unreadable pin loudly and keeps the readable ones (round 11 A11)", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(readModelSettings({ ...DEFAULT_SETTINGS, packs: [{ id: 3 }, { id: "struct", version: "1.2.0" }] })).toEqual({ ...DEFAULT_SETTINGS, packs: [{ id: "struct", version: "1.2.0" }] });
    expect(spy).toHaveBeenCalled();
  });
});
