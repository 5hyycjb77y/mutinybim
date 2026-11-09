/**
 * @jest-environment node
 *
 * Round 9 lane A9: element kinds are an add-on point (`ELEMENT_KIND_POINT`,
 * `kernel.element_kind` v1). A test add-on registers a kind the kernel's
 * union doesn't name, with a value and a check, and needs no kernel edit;
 * Mechanical owns its five kinds the same way. Fails on round 8b's code: the
 * point, `elementKindsInForce`, `KERNEL_ELEMENT_KINDS` and `kindValue` don't
 * exist, and the duct checks were kernel code.
 */
import {
  ADDON_HOSTED_ELEMENT_KINDS,
  ELEMENT_KIND_POINT,
  ELEMENT_KINDS,
  KERNEL_ELEMENT_KINDS,
  asElementId,
  elementKindRowProblems,
  elementKindTable,
  elementKindsInForce,
  executeCommand,
  freezeElements,
  kindValue,
  recomputeDerived,
  validateModel,
  withKindValue,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type ValidationIssue,
} from "@permitzip/bim-kernel";
import { PackSet, bindModelPacks, contribute, definePack, PACK_CONTRACT_VERSION, unbindModelPacks, withPackSet } from "../src/packs";
import { MECHANICAL_KINDS } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

/** A vertical-transport add-on's elevator car: a kind of its own, with its rated load and a check. */
const CAR: ElementKindItem = {
  kind: "a9vt.car",
  label: "Elevator car",
  values: [{ key: "a9vt.rated_load", label: "Rated load", unit: "lb", authored: true, min: 0, max: 20000 }],
  check(el, _settings, issues) {
    const load = kindValue(el, "a9vt.rated_load");
    if (load !== null && load < 1000) issues.push({ code: "invalid_value", message: `${el.id} is rated below 1000 lb`, elementIds: [el.id] });
  },
};
const VT_PACK = definePack({ id: "a9vt", name: "Vertical transport (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [CAR])]);
const WITH_VT = PackSet.create([VT_PACK]);

/** A stored record of the add-on's kind, as any peer keeps one: a kind string the kernel's types don't name. */
function carRecord(load: number): BimElement {
  const raw: Record<string, unknown> = { id: "car-1", version: 1, authoredRev: {}, kind: "a9vt.car", values: { "a9vt.rated_load": load } };
  return raw as unknown as BimElement;
}

function withCar(load: number): ModelState {
  const base = recomputeDerived(createDemoModel("a9-kinds")).model;
  return { ...base, elements: freezeElements({ ...base.elements, "car-1": carRecord(load) }) };
}

describe("a9 add-on-owned element kinds", () => {
  it("the kernel's own kinds name no add-on kind; the static list keeps every stored kind parseable", () => {
    expect(KERNEL_ELEMENT_KINDS as readonly string[]).not.toContain("a9vt.car");
    for (const k of ADDON_HOSTED_ELEMENT_KINDS) expect(KERNEL_ELEMENT_KINDS as readonly string[]).not.toContain(k);
    expect([...ELEMENT_KINDS].sort()).toEqual([...KERNEL_ELEMENT_KINDS, ...ADDON_HOSTED_ELEMENT_KINDS].sort());
  });

  it("Mechanical owns its five kinds through the point, not the kernel", () => {
    expect(MECHANICAL_KINDS.map((r) => r.kind).sort()).toEqual([...ADDON_HOSTED_ELEMENT_KINDS].sort());
    const table = elementKindTable();
    for (const k of ADDON_HOSTED_ELEMENT_KINDS) expect(table.row(k)?.label).toBeTruthy();
    expect(elementKindsInForce()).toEqual(expect.arrayContaining([...ADDON_HOSTED_ELEMENT_KINDS]));
  });

  it("a test add-on registers a kind of its own: in force under its set, absent without it", () => {
    expect(elementKindsInForce(WITH_VT)).toContain("a9vt.car");
    expect(elementKindsInForce(PackSet.create([]))).not.toContain("a9vt.car");
    withPackSet(WITH_VT, () => {
      expect(elementKindTable().row("a9vt.car")?.label).toBe("Elevator car");
      expect(kindValue(carRecord(2500), "a9vt.rated_load")).toBe(2500);
      const next = withKindValue(carRecord(2500), "a9vt.rated_load", 3000);
      expect(kindValue(next, "a9vt.rated_load")).toBe(3000);
    });
  });

  it("its own check runs in validation under its set, with no kernel edit", () => {
    const model = withCar(500);
    const issues = (set: PackSet | null) => withPackSet(set, () => validateModel(model)).filter((i: ValidationIssue) => i.elementIds.includes(asElementId("car-1")));
    expect(issues(WITH_VT).map((i) => i.message)).toEqual(["car-1 is rated below 1000 lb"]);
    expect(issues(null)).toEqual([]);
  });

  it("a stored record of a kind the set doesn't know is kept as stored through an edit of something else", () => {
    const model = withCar(2500);
    bindModelPacks(model.modelId, PackSet.create([]));
    try {
      const r = executeCommand(model, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 360 });
      if (!r.ok) throw new Error(r.error.message);
      expect(r.model.elements["car-1"]).toEqual(carRecord(2500));
    } finally {
      unbindModelPacks(model.modelId);
    }
  });

  it("conformance: a row may not take a kernel kind, and its value keys are namespaced", () => {
    const kernel = new Set<string>(KERNEL_ELEMENT_KINDS);
    expect(elementKindRowProblems([CAR, ...MECHANICAL_KINDS], kernel)).toEqual([]);
    expect(elementKindRowProblems([{ kind: "wall", label: "Wall" }], kernel)).toEqual(["element kind wall is one of the kernel's own kinds; an add-on registers a kind of its own"]);
    expect(elementKindRowProblems([{ kind: "a9vt.x", label: "X", values: [{ key: "load", label: "Load", unit: "lb", authored: true }] }], kernel)).toEqual(['element kind a9vt.x: value key "load" must be "<pack>.<name>"']);
  });

  it("another add-on can't take a kind it doesn't own: a kind's id carries its add-on's name", () => {
    expect(() => definePack({ id: "a9twin", name: "Twin", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [{ ...CAR, kind: "a9vt.car" }])])).toThrow('Element kinds id "a9vt.car" must start with "a9twin."');
  });
});
