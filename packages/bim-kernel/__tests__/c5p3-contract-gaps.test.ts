/**
 * @jest-environment node
 *
 * Batch 5c round 3, lane A3: the contract gaps closed in the kernel. Each
 * case fails on the code before: `across` didn't exist (a beam's load
 * reached both supports whole), incremental totals had one parent per node,
 * there was no built-in footing class, recognition couldn't read a run's
 * system, built-in fire protection rows named an adapter nobody ships, a
 * pinned use couldn't hold an add-on's rates, and a network-only pack item
 * had no looped solve.
 */
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { NETWORK_ADAPTER_POINT, adapterForService, serviceNetworkTotals } from "../src/connections/model";
import type { NetworkQuantities } from "../src/connections/adapter";
import { IncrementalTotals, networkTotals, type NetworkAdapter } from "../src/connections/network";
import { sumMonoid } from "../src/connections/aggregate";
import { solveNetwork } from "../src/connections/solve";
import { SERVICE_POINT, firstPartyServiceRegistry } from "../src/services/registry";
import type { ServiceRow } from "../src/services/builtin";
import { BUILTIN_CLASSES, CLASS_POINT, buildClassIndex, builtinRegistry, carryClassIndexes, packClassRegistry } from "../src/registry";
import { SPACES_PARAMETER_RATES_FEATURE, densityFingerprint, evaluateParameterRates, pinnedUse } from "../src/spaces/space-use";
import { executeSpaceDesignCommand } from "../src/spaces/space-commands";
import { asElementId, withUpgradePolicy } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import type { BimElement, ModelState } from "../src/types";

// A simply supported beam B on two columns C1, C2 (beam ends are ports: `B@start`, `B@end`), columns on footing F.
// The beam carries 900 lbf: a point load at one third of its span, so 2/3 reaches the start and 1/3 the end.
const OWN: Readonly<Record<string, number>> = { B: 900, C1: 100, C2: 100, F: 0 };
const KIDS: Readonly<Record<string, readonly string[]>> = { F: ["C1", "C2"], C1: ["B"], C2: ["B"] };
const SHARE: Readonly<Record<string, number>> = { C1: 2 / 3, C2: 1 / 3 };
const frame: NetworkAdapter<string, number> = {
  roots: () => ["F"],
  children: (n) => KIDS[n] ?? [],
  ownQuantities: (n) => OWN[n],
  across: (child, parent, total) => (child === "B" ? total * (SHARE[parent] ?? 1) : total),
};

describe("c5p3 S-14: what reaches each parent (`across`)", () => {
  it("networkTotals splits a shared child by parent, and leaves every adapter without `across` as before", () => {
    const t = networkTotals(frame, sumMonoid);
    expect(t.get("C1")).toBeCloseTo(700, 9);
    expect(t.get("C2")).toBeCloseTo(400, 9);
    expect(t.get("F")).toBeCloseTo(1100, 9);
    const { across: _ignored, ...plain } = frame;
    expect(networkTotals(plain, sumMonoid).get("F")).toBe(2000);
  });

  it("incremental totals follow both paths through `across`, deepest first", () => {
    const inc = IncrementalTotals.build(frame, new Map<string, string | null | readonly string[]>([["F", null], ["C1", "F"], ["C2", "F"], ["B", ["C1", "C2"]]]));
    expect(inc.totalOf("F")).toBeCloseTo(1100, 9);
    const changed = inc.setOwn("B", 1800);
    expect(changed[0]).toBe("B");
    expect(changed.at(-1)).toBe("F");
    expect(inc.totalOf("C1")).toBeCloseTo(1300, 6);
    expect(inc.totalOf("C2")).toBeCloseTo(700, 6);
    expect(inc.totalOf("F")).toBeCloseTo(2000, 6);
  });

  it("serviceNetworkTotals passes `across` through; nodes may be `<elementId>@<port>`", () => {
    const service: ServiceRow = { id: "zz.gravity", label: "Gravity", discipline: "structure", medium: "structural", regime: "structural", connector: "member", adapter: "zz.frame", quantities: ["zz.dead"], asSystem: true, asLoad: false, ifc: { system: "IfcStructuralAnalysisModel", predefinedType: "LOADING_3D" } };
    const kids: Readonly<Record<string, readonly string[]>> = { F: ["C1"], C1: ["B@start"] };
    const network: NetworkAdapter<string, NetworkQuantities> = {
      roots: () => ["F"],
      children: (n) => kids[n] ?? [],
      ownQuantities: (n) => (n === "B@start" ? { "zz.dead": 600 } : { "zz.dead": 0 }),
      across: (_c, _p, t) => ({ "zz.dead": (t["zz.dead"] ?? 0) * 0.5 }),
    };
    const pack = definePack({ id: "zz", name: "Z", version: "1.0.0", kernel: "^1.2.0" }, [contribute(SERVICE_POINT, [service]), contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.frame", aggregation: { quantities: ["zz.dead"], direction: "downward", over: ["physical"], network: () => network } }])]);
    const empty: ModelState = { ...createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3" }), elements: {} };
    const r = withPackSet(PackSet.create([pack]), () => serviceNetworkTotals(empty, "zz.gravity"));
    expect(r.ok && r.totals.get("F")).toEqual({ "zz.dead": 150 });
  });
});

describe("c5p3 S-15: a built-in footing class", () => {
  it("comes from the Structural add-on (first-party since round 14), listed with its classes after the fallback; a footing component is a footing (and still a component)", () => {
    expect(BUILTIN_CLASSES.map((c) => c.id)).not.toContain("struct.footing");
    const ids = builtinRegistry().listClasses({ includeAbstract: true }).map((c) => c.id);
    expect(ids.slice(ids.indexOf("gen.building_element"), ids.indexOf("gen.building_element") + 5)).toEqual(["gen.building_element", "struct.grid", "struct.column", "struct.beam", "struct.footing"]);
    expect(builtinRegistry().getClass("struct.footing")?.ifc).toEqual({ entity: "IfcFooting" });
    const base = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-footing" });
    // A component record with only the fields recognition reads; the rest of the shape isn't read here.
    const footing = { id: asElementId("c5p3-footing"), kind: "component", category: "footing" } as unknown as BimElement;
    const index = buildClassIndex(builtinRegistry(), { elements: { ...base.elements, [footing.id]: footing } });
    expect(index.classesOf(footing.id)).toEqual(expect.arrayContaining(["struct.footing", "arch.component"]));
  });
});

describe("c5p3 civil D: recognised through a run's system", () => {
  const base = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-system" });
  // Records with only the fields recognition reads (kind, id, systemId, systemKind, domain); the rest of their shapes isn't read here.
  const system = { id: asElementId("sys-1"), kind: "mep_system", systemKind: "sanitary", name: "S-1" } as unknown as BimElement;
  const segment = { id: asElementId("seg-1"), kind: "run_segment", systemId: "sys-1", domain: "pipe" } as unknown as BimElement;
  const elementsWith = (sys: BimElement) => ({ ...base.elements, [sys.id]: sys, [segment.id]: segment });
  const stormPipe = definePack({ id: "zy", name: "Storm", version: "1.0.0", kernel: "^1.2.0" }, [
    contribute(CLASS_POINT, [{ id: "zy.storm_pipe", label: "Storm pipe", discipline: "civil", recognize: { elementKinds: ["run_segment"], where: [{ path: "system.systemKind", op: "equals", value: "zy.storm" }] } }]),
  ]);
  const registry = packClassRegistry(builtinRegistry(), PackSet.create([stormPipe]));

  it("a segment on a storm system is a storm pipe; on any other system it isn't", () => {
    expect(buildClassIndex(registry, { elements: elementsWith(system) }).elementsOf("zy.storm_pipe")).toEqual([]);
    const storm = { ...system, systemKind: "zy.storm" } as BimElement;
    expect(buildClassIndex(registry, { elements: elementsWith(storm) }).elementsOf("zy.storm_pipe").map((e) => e.id)).toEqual([segment.id]);
    expect(buildClassIndex(registry, { elements: elementsWith(storm) }).classesOf(segment.id)).toEqual(expect.arrayContaining(["zy.storm_pipe", "mep.pipe"]));
  });

  it("carried: editing only the system re-lists its runs", () => {
    const before = elementsWith(system);
    expect(buildClassIndex(registry, { elements: before }).elementsOf("zy.storm_pipe")).toEqual([]);
    const after = { ...before, [system.id]: { ...system, systemKind: "zy.storm" } as BimElement };
    carryClassIndexes(before, after, [system.id]);
    expect(buildClassIndex(registry, { elements: after }).elementsOf("zy.storm_pipe").map((e) => e.id)).toEqual([segment.id]);
  });
});

describe("c5p3 civil G: no bare adapter word nobody ships", () => {
  it("no built-in row names an adapter this release doesn't register", () => {
    const named = firstPartyServiceRegistry().rows.filter((r) => !/[.:]/.test(r.id)).flatMap((r) => (r.adapter ? [r.adapter] : []));
    expect([...new Set(named)].sort()).toEqual(["electrical", "mechanical", "plumbing"]);
    expect(adapterForService("fire_protection_wet")).toBeNull();
    expect(firstPartyServiceRegistry().byId.get("fire_protection_wet")?.adapter).toBeUndefined();
  });
});

describe("c5p3 pinned add-on rates on a space", () => {
  const live = [{ key: "zz.live_load_total", per: "area" as const, value: 538.196 }];
  const use = { libraryId: "builtin:space-uses", useId: "office_space", name: "Office space", revision: 1, rates: [], parameterRates: live };

  it("a reader keeps them and totals them by parameter; the density fingerprint of a space without them is unchanged", () => {
    expect(pinnedUse({ use })?.parameterRates).toEqual(live);
    expect(evaluateParameterRates({ use }, { areaM2: 10, occupants: null }).values).toEqual({ "zz.live_load_total": 5381.96 });
    const plain = { ...use, parameterRates: undefined };
    expect(densityFingerprint({ use: plain }, 10)).toBe(JSON.stringify([10_000_000, null, null, []]));
  });

  it("a writer pins them only for a peer advertising spaces:parameter_rates", () => {
    const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-space" });
    const command = { type: "create_space" as const, spaces: [{ spaceId: "s-1", number: "101", name: "Office", use }] };
    const refused = executeSpaceDesignCommand(m, command);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toMatch(/can't store yet/);
    const ok = withUpgradePolicy((f) => f === SPACES_PARAMETER_RATES_FEATURE, () => executeSpaceDesignCommand(m, command));
    if (!ok.ok) throw new Error(ok.error.message);
    const space = ok.model.elements["s-1"];
    if (space?.kind !== "space") throw new Error("no space");
    expect(pinnedUse(space)?.parameterRates).toEqual(live);
    const { parameterRates: _rates, ...plainUse } = use;
    const without = executeSpaceDesignCommand(m, { ...command, spaces: [{ spaceId: "s-1", number: "101", name: "Office", use: plainUse }] });
    expect(without.ok).toBe(true);
  });
});

describe("c5p3 looped solve for a network-only pack item", () => {
  it("solveNetwork uses the aggregation's solve when the service has no link rules", () => {
    const ring: ServiceRow = { id: "zz.ring", label: "Ring", discipline: "civil", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "zz.ring_net", quantities: [], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem", predefinedType: "WATERSUPPLY" } };
    const drop = (_e: unknown, flow: number) => ({ drop: flow * Math.abs(flow), slope: 2 * Math.abs(flow) + 1e-9 });
    const pack = definePack({ id: "zz", name: "Z", version: "1.0.0", kernel: "^1.2.0" }, [
      contribute(SERVICE_POINT, [ring]),
      contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.ring_net", aggregation: { quantities: [], direction: "downstream", over: ["physical"], network: () => null, solve: () => ({ nodes: [{ id: "a", demand: -2 }, { id: "b", demand: 1 }, { id: "c", demand: 1 }], edges: [{ id: "ab", from: "a", to: "b" }, { id: "bc", from: "b", to: "c" }, { id: "ca", from: "c", to: "a" }], drop }) } }]),
    ]);
    const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-ring" });
    const r = withPackSet(PackSet.create([pack]), () => solveNetwork(m, "zz.ring"));
    expect(r.status).toBe("converged");
    expect(solveNetwork(m, "zz.ring").status).toBe("unknown_service");
  });
});

describe("c5p3 S-8b: param.<key> reads a building element's values and its element type", () => {
  const base = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-param" });
  const beam = Object.values(base.elements).find((e): e is Extract<BimElement, { kind: "beam" }> => e.kind === "beam");
  if (!beam) throw new Error("the XS model has no beam");
  // An element type with only the fields a reader uses; ModelElementBase fields are copied from the beam.
  const typeOf = (grade: string) => ({ ...beam, id: asElementId("et-w"), kind: "element_type", name: "W18x35", values: { "zy.grade": grade } }) as unknown as BimElement;
  const typed = { ...beam, typeId: asElementId("et-w") } as BimElement;
  const steel = definePack({ id: "zy", name: "Steel", version: "1.0.0", kernel: "^1.2.0" }, [
    contribute(CLASS_POINT, [{ id: "zy.a992_beam", label: "A992 beams", discipline: "structure", recognize: { elementKinds: ["beam"], where: [{ path: "param.zy.grade", op: "equals", value: "A992" }] } }]),
  ]);
  const registry = packClassRegistry(builtinRegistry(), PackSet.create([steel]));

  it("a beam's type value counts, and its own value wins over the type's", () => {
    const elements = { ...base.elements, [typed.id]: typed, "et-w": typeOf("A992") };
    expect(buildClassIndex(registry, { elements }).elementsOf("zy.a992_beam").map((e) => e.id)).toEqual([beam.id]);
    const own = { ...typed, values: { "zy.grade": "A36" } } as BimElement;
    expect(buildClassIndex(registry, { elements: { ...elements, [beam.id]: own } }).elementsOf("zy.a992_beam")).toEqual([]);
  });

  it("carried: editing only the element type re-lists its elements", () => {
    const before = { ...base.elements, [typed.id]: typed, "et-w": typeOf("A36") };
    expect(buildClassIndex(registry, { elements: before }).elementsOf("zy.a992_beam")).toEqual([]);
    const after = { ...before, "et-w": typeOf("A992") };
    carryClassIndexes(before, after, ["et-w"]);
    expect(buildClassIndex(registry, { elements: after }).elementsOf("zy.a992_beam").map((e) => e.id)).toEqual([beam.id]);
  });

  it("gen.element_type is the last built-in class", () => {
    expect(BUILTIN_CLASSES.at(-1)?.id).toBe("gen.element_type");
    expect(BUILTIN_CLASSES.at(-2)?.id).toBe("doc.sheet");
  });
});
