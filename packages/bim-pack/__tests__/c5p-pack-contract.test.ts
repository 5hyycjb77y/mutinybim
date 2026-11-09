/**
 * @jest-environment node
 *
 * Batch 5c lane A: the pack contract as a pack author meets it through
 * `@permitzip/bim-pack`. Every refusal lists every problem (not the first),
 * so a pack author fixes a pack in one pass; the scope nests, restores and
 * refuses a promise; outside any scope only built-ins are in force.
 */
import {
  BUILTIN_PACK_SET,
  NETWORK_ADAPTER_POINT,
  PACK_CONTRACT_VERSION,
  PackDefinitionError,
  PackSet,
  PackSetError,
  SERVICE_POINT,
  activePackSet,
  contribute,
  defineExtensionPoint,
  definePack,
  resolvePackPins,
  withPackSet,
  type Pack,
  type ServiceRow,
  type TradeAdapter,
} from "../src";

const adapter: TradeAdapter = { trade: "mechanical", source: () => null, connectors: () => [], positionsNeeded: () => null, refusal: () => null, positionsRefusal: () => null };

function pack(id: string, extra: Partial<Pack["manifest"]> = {}, contributions: Pack["contributions"] = []): Pack {
  return definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: "^1.0.0", ...extra }, contributions);
}

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof PackDefinitionError || err instanceof PackSetError) return err.problems;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("c5p definePack refusals list every problem", () => {
  it("a bad manifest and bad ids, all at once", () => {
    const problems = problemsOf(() =>
      definePack({ id: "Firm", name: " ", version: "one", kernel: "^one", requires: [{ id: "X", range: "soon" }] }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "other.flow", adapter }, { id: "Bad Id", adapter }])]),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('pack id "Firm" must be'),
        expect.stringContaining("name is empty"),
        expect.stringContaining('version "one" is not semver'),
        expect.stringContaining('kernel range "^one"'),
        expect.stringContaining('requires "X"'),
        expect.stringContaining('requires X "soon"'),
        expect.stringContaining('"other.flow" must start with "Firm."'),
        expect.stringContaining('"Bad Id" is not a registry id'),
      ]),
    );
    expect(problems.length).toBeGreaterThanOrEqual(8);
  });

  it("a reserved namespace and an id contributed twice", () => {
    const problems = problemsOf(() => definePack({ id: "firm", name: "Firm", version: "1.0.0", kernel: "^1.0.0" }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "firm.a", adapter }, { id: "firm.a", adapter }])]));
    expect(problems).toEqual([expect.stringContaining('"firm" is reserved'), expect.stringContaining('"firm.a" is contributed twice')]);
  });
});

describe("c5p PackSet refusals list every problem", () => {
  it("duplicate namespace, unmet requires, wrong contract range, all at once", () => {
    const a = pack("aa");
    const a2 = pack("aa", { version: "2.0.0" });
    const needsB = pack("cc", { requires: [{ id: "bb", range: "^1.0.0" }] });
    const old = pack("dd", { kernel: "^0.9.0" });
    const problems = problemsOf(() => PackSet.create([a, a2, needsB, old]));
    expect(problems).toEqual(
      expect.arrayContaining([
        'two packs use the namespace "aa"',
        expect.stringContaining("pack cc needs pack bb ^1.0.0, which this model doesn't use"),
        expect.stringContaining(`pack dd 1.0.0 was written for contract ^0.9.0; this release is ${PACK_CONTRACT_VERSION}`),
      ]),
    );
  });

  it("a required pack at the wrong version", () => {
    expect(problemsOf(() => PackSet.create([pack("bb", { version: "2.1.0" }), pack("cc", { requires: [{ id: "bb", range: "^1.0.0" }] })]))).toEqual([expect.stringContaining("pack cc needs bb ^1.0.0; this model uses 2.1.0")]);
  });

  it("two packs written for different majors of one point", () => {
    const v2 = defineExtensionPoint<{ readonly id: string }>({ id: "kernel.network_adapter", version: 2, label: "Network adapters", idOf: (x) => x.id });
    const p1 = pack("ee", {}, [contribute(NETWORK_ADAPTER_POINT, [{ id: "ee.a", adapter }])]);
    const p2 = pack("ff", {}, [contribute(v2, [{ id: "ff.a" }])]);
    expect(problemsOf(() => PackSet.create([p1, p2]))).toEqual([expect.stringContaining("written for different versions of Network adapters (v1, v2)")]);
  });

  it("a set refuses reading a point at another major than the pack's", () => {
    const v2 = defineExtensionPoint<{ readonly id: string }>({ id: "kernel.network_adapter", version: 2, label: "Network adapters", idOf: (x) => x.id });
    const s = PackSet.create([pack("ee", {}, [contribute(NETWORK_ADAPTER_POINT, [{ id: "ee.a", adapter }])])]);
    expect(problemsOf(() => s.packItems(v2))).toEqual([expect.stringContaining("v1; this release reads v2")]);
  });

  it("the same id from two packs: refused, naming both", () => {
    // Ids must carry each pack's own namespace, so a clash needs a point that isn't namespaced.
    const open = defineExtensionPoint<{ readonly id: string }>({ id: "test.open", version: 1, label: "Open rows", idOf: (x) => x.id, namespaced: false });
    expect(problemsOf(() => PackSet.create([pack("gg", {}, [contribute(open, [{ id: "shared" }])]), pack("hh", {}, [contribute(open, [{ id: "shared" }])])]))).toEqual(['Open rows "shared" comes from both gg and hh']);
  });

  it("a pack row equal to a built-in row", () => {
    const sanitary: ServiceRow = { id: "sanitary", label: "Mine", discipline: "plumbing", medium: "liquid", regime: "gravity", connector: "pipe", quantities: [], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem", predefinedType: "WASTEWATER" } };
    // The real point refuses a bare id at definePack; an un-namespaced copy lets the row reach the set's built-in check.
    const open = defineExtensionPoint<ServiceRow>({ ...SERVICE_POINT, namespaced: false });
    const s = PackSet.create([pack("ii", {}, [contribute(open, [sanitary])])]);
    expect(problemsOf(() => s.items(open))).toEqual(['Services "sanitary" is a first-party row; a pack may not replace it']);
  });

  it("pins resolve exactly, and a missing pin is reported, never dropped", () => {
    const s1 = pack("jj");
    const { set, missing } = resolvePackPins([s1], [{ id: "jj", version: "1.0.0" }, { id: "jj", version: "1.1.0" }, { id: "kk", version: "1.0.0" }]);
    expect(set.pins()).toEqual([{ id: "jj", version: "1.0.0" }]);
    expect(missing).toEqual([{ id: "jj", version: "1.1.0" }, { id: "kk", version: "1.0.0" }]);
  });
});

describe("c5p pack scope", () => {
  const outer = PackSet.create([pack("ll")]);
  const inner = PackSet.create([pack("mm")]);

  it("outside any scope the built-in set is in force", () => {
    expect(activePackSet()).toBe(BUILTIN_PACK_SET);
  });

  it("nests and restores, also when the callback throws", () => {
    withPackSet(outer, () => {
      expect(activePackSet()).toBe(outer);
      withPackSet(inner, () => expect(activePackSet()).toBe(inner));
      expect(activePackSet()).toBe(outer);
      expect(() => withPackSet(inner, () => { throw new Error("boom"); })).toThrow("boom");
      expect(activePackSet()).toBe(outer);
    });
    expect(activePackSet()).toBe(BUILTIN_PACK_SET);
  });

  it("refuses a callback that returns a promise, and restores", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => withPackSet(outer, () => Promise.resolve(1))).toThrow("the pack scope is synchronous");
    expect(spy).toHaveBeenCalled();
    expect(activePackSet()).toBe(BUILTIN_PACK_SET);
  });
});
