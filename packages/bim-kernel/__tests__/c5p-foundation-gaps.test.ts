/**
 * @jest-environment node
 *
 * Batch 5c lane A, round 2: the contract gaps the structural and civil proof
 * packs found, closed in the kernel. Each case fails on the code before it:
 * a pack network couldn't be walked by the kernel (the adapter point took
 * served-from link rules only), there was no parameter point, the class index
 * ignored an explicit `classId`, and a pack zone purpose couldn't be written.
 */
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { NETWORK_ADAPTER_POINT, adapterForService, networkForService, serviceNetworkTotals, tradeAdapter } from "../src/connections/model";
import { plumbingAdapter } from "@permitzip/bim-pack-plumbing";
import type { NetworkQuantities } from "../src/connections/adapter";
import type { NetworkAdapter } from "../src/connections/network";
import { SERVICE_POINT } from "../src/services/registry";
import type { ServiceRow } from "../src/services/builtin";
import { CLASS_POINT, buildClassIndex, builtinRegistry, carryClassIndexes, packClassRegistry } from "../src/registry";
import { PARAMETER_SET_POINT, fieldProviderRegistry, withBaseFields } from "../src/fields";
import { ZONE_PURPOSE_POINT } from "../src/spaces/types";
import { spaceCommandSchema } from "../src/spaces/space-commands";
import { asElementId } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import type { BimElement, ModelState } from "../src/types";

/** A load path: two beams bearing on a column bearing on a footing (element ids), loads in lbf. */
const LOADS: Readonly<Record<string, NetworkQuantities>> = { b1: { "zz.dead": 1000 }, b2: { "zz.dead": 500, "zz.ignored": 7 }, c1: { "zz.dead": 200 }, f1: {} };
const BELOW: Readonly<Record<string, readonly string[]>> = { f1: ["c1"], c1: ["b1", "b2"] };
const loadPath: NetworkAdapter<string, NetworkQuantities> = { roots: () => ["f1"], children: (n) => BELOW[n] ?? [], ownQuantities: (n) => LOADS[n] };

const gravityLoad: ServiceRow = { id: "zz.gravity_load", label: "Gravity load", discipline: "structure", medium: "structural", regime: "structural", connector: "member", adapter: "zz.load_path", quantities: ["zz.dead"], asSystem: true, asLoad: false, ifc: { system: "IfcStructuralAnalysisModel", predefinedType: "LOADING_3D" } };

const zz = definePack({ id: "zz", name: "Test structure", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.load_path", aggregation: { quantities: ["zz.dead"], direction: "downward", over: ["physical"], network: (m: ModelState) => (m.elements.wall ? null : loadPath) } }]),
  contribute(SERVICE_POINT, [gravityLoad]),
  contribute(CLASS_POINT, [{ id: "zz.wall_shear", label: "Shear wall", discipline: "structure", parent: "arch.wall" }]),
  contribute(PARAMETER_SET_POINT, [{ id: "zz.framing", label: "Framing", parameters: [{ key: "zz.section", label: "Section", classes: ["zz.wall_shear"], valueType: "text", group: "Structural" }, { key: "zz.capacity", label: "Capacity", classes: ["zz.wall_shear"], valueType: "quantity", kind: "force", unit: "lbf", ifc: { pset: "ZZ_Framing", property: "Capacity" } }] }]),
  contribute(ZONE_PURPOSE_POINT, [{ id: "zz.tributary", label: "Tributary area", ifc: { entity: "IfcSpatialZone", predefinedType: "USERDEFINED", objectType: "TRIBUTARY" } }]),
]);
const set = PackSet.create([zz]);
const empty: ModelState = { ...createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p-gaps" }), elements: {} };

describe("c5p a pack's physical network is walked and totalled by the kernel", () => {
  it("serviceNetworkTotals sums each declared quantity from the leaves to the root", () => {
    const r = withPackSet(set, () => serviceNetworkTotals(empty, "zz.gravity_load"));
    if (!r.ok) throw new Error(r.reason);
    expect(r.direction).toBe("downward");
    expect(r.totals.get("f1")).toEqual({ "zz.dead": 1700 });
    expect(r.totals.get("c1")).toEqual({ "zz.dead": 1700 });
    expect(r.totals.get("b2")).toEqual({ "zz.dead": 500 });
  });

  it("a network-only adapter has no link rules, and the built-in walks are untouched", () => {
    withPackSet(set, () => {
      expect(networkForService("zz.gravity_load")?.id).toBe("zz.load_path");
      expect(tradeAdapter("zz.load_path")).toBeNull();
      expect(adapterForService("sanitary")).toBe(plumbingAdapter);
    });
  });

  it("outside the scope the service is unknown; a model with no such network says so", () => {
    expect(serviceNetworkTotals(empty, "zz.gravity_load")).toEqual({ ok: false, reason: '"zz.gravity_load" isn\'t a service this model knows' });
    // The test network answers null whenever the model holds an element named "wall"; its shape isn't read.
    const withWall = { ...empty, elements: { wall: {} as BimElement } };
    expect(withPackSet(set, () => serviceNetworkTotals(withWall, "zz.gravity_load"))).toEqual({ ok: false, reason: "This model has no gravity load network to total" });
    expect(withPackSet(set, () => serviceNetworkTotals(empty, "sanitary")).ok).toBe(false);
  });
});

describe("c5p a pack's parameters join the field registry", () => {
  it("outside any scope the field registry is the same object as before", () => {
    expect(fieldProviderRegistry()).toBe(fieldProviderRegistry());
    expect(fieldProviderRegistry().getClass("zz.wall_shear")).toBeUndefined();
  });

  it("inside the scope the pack's classes and parameters are fields with a reader, a writer and an IFC home", () => {
    const registry = withPackSet(set, () => withBaseFields(fieldProviderRegistry()));
    const capacity = registry.field("zz.wall_shear", "zz.capacity");
    expect(capacity).toMatchObject({ key: "zz.capacity", valueType: "quantity", kind: "force", unit: "lbf", storedUnit: "lbf", ifc: { pset: "ZZ_Framing", property: "Capacity" }, writer: { kind: "command", command: "set_element_values", argument: "zz.capacity" } });
    expect(registry.field("zz.wall_shear", "zz.section")?.group).toBe("Structural");
    // A stored-shape fixture: the readers look at `values` only.
    const wall = { id: "w", kind: "wall", values: { "zz.capacity": 12000, "zz.section": "W8" } } as unknown as BimElement;
    expect(capacity?.read?.(wall, { elements: {} })).toBe(12000);
    expect(registry.field("zz.wall_shear", "zz.section")?.read?.(wall, { elements: {} })).toBe("W8");
    expect(registry.field("zz.wall_shear", "mark")).toBeDefined();
  });

  it("a quantity in a unit its kind doesn't have is refused by the registry", () => {
    const bad = definePack({ id: "zy", name: "Bad", version: "1.0.0", kernel: "^1.0.0" }, [contribute(PARAMETER_SET_POINT, [{ id: "zy.s", label: "S", parameters: [{ key: "zy.p", label: "P", classes: ["arch.wall"], valueType: "quantity", kind: "force", unit: "ft" }] }])]);
    expect(() => withPackSet(PackSet.create([bad]), () => fieldProviderRegistry())).toThrow(/not a force unit|force/);
  });
});

describe("c5p the class index honours an explicit classId", () => {
  const base = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p-class" });
  const wall = Object.values(base.elements).find((e) => e.kind === "wall");
  if (!wall || wall.kind !== "wall") throw new Error("the XS model has no wall");
  const registry = packClassRegistry(builtinRegistry(), set);

  it("an element naming a registry class is in it (and its ancestors); one naming an unknown class is left to recognition", () => {
    const named: BimElement = { ...wall, classId: "zz.wall_shear" };
    const other: BimElement = { ...wall, id: asElementId("c5p-other-wall"), classId: "nobody.knows" };
    const elements = { ...base.elements, [named.id]: named, [other.id]: other };
    const index = buildClassIndex(registry, { elements });
    expect(index.elementsOf("zz.wall_shear").map((e) => e.id)).toEqual([named.id]);
    expect(index.classesOf(named.id)[0]).toBe("zz.wall_shear");
    expect(index.elementsOf("arch.wall").map((e) => e.id)).toEqual(expect.arrayContaining([named.id, other.id]));
    expect(index.classesOf(other.id)).not.toContain("nobody.knows");
  });

  it("carried across an edit that names the class", () => {
    const before = base.elements;
    const index = buildClassIndex(registry, { elements: before });
    expect(index.elementsOf("zz.wall_shear")).toEqual([]);
    const after = { ...before, [wall.id]: { ...wall, classId: "zz.wall_shear" } };
    carryClassIndexes(before, after, [wall.id]);
    expect(buildClassIndex(registry, { elements: after }).elementsOf("zz.wall_shear").map((e) => e.id)).toEqual([wall.id]);
  });

  it("without a classId nothing changes", () => {
    const index = buildClassIndex(registry, { elements: base.elements });
    const plain = buildClassIndex(builtinRegistry(), { elements: base.elements });
    expect(index.elementsOf("arch.wall").map((e) => e.id)).toEqual(plain.elementsOf("arch.wall").map((e) => e.id));
  });
});

describe("c5p a pack's zone purpose is writable in its model", () => {
  const create = { type: "create_zone", zoneId: "z1", name: "T", purpose: "zz.tributary", spaceIds: [] };
  it("refused outside the scope, accepted inside", () => {
    expect(spaceCommandSchema.safeParse(create).success).toBe(false);
    expect(withPackSet(set, () => spaceCommandSchema.safeParse(create).success)).toBe(true);
    expect(withPackSet(set, () => spaceCommandSchema.safeParse({ ...create, purpose: "zz.unknown" }).success)).toBe(false);
  });
});
