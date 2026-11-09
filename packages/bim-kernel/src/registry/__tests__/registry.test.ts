/**
 * @jest-environment node
 *
 * The class, field and relationship registry (SCHEDULES-PLAN §4): inheritance,
 * today's schedule categories as classes, relationship paths, refusals that
 * name the problem, and class recognition in one pass over the model.
 */
import { SCHEDULE_CATEGORIES } from "../../documents";
import { PART_CATEGORIES } from "../../parts";
import { asElementId } from "../../types";
import { BUILTIN_CLASSES, PART_CATEGORY_CLASSES, SCHEDULE_CATEGORY_CLASSES, builtinRegistry, builtinRegistryBuilder } from "../builtin";
import { buildClassIndex } from "../recognition";
import { createRegistryBuilder } from "../registry";
import { RegistryError, type FieldDef } from "../types";
import type { UnitCatalog } from "../units";


const field = (path: string, classes: string[], extra: Partial<FieldDef> = {}): FieldDef => ({
  path,
  label: path,
  classes,
  valueType: "text",
  writer: { kind: "none", reason: "test" },
  source: "provider:test",
  ...extra,
});

describe("class registry", () => {
  it("lists every v1 schedule category as a class, so every existing schedule maps 1:1", () => {
    const registry = builtinRegistry();
    for (const category of SCHEDULE_CATEGORIES) {
      const id = SCHEDULE_CATEGORY_CLASSES[category];
      expect(registry.getClass(id)).toBeDefined();
      expect(registry.listClasses().map((c) => c.id)).toContain(id);
    }
    for (const category of PART_CATEGORIES) {
      const cls = registry.getClass(PART_CATEGORY_CLASSES[category]);
      expect(cls?.recognize?.partCategories).toContain(category);
    }
  });

  it("gives a subclass its ancestors' fields, the nearer class winning on path", () => {
    const registry = builtinRegistryBuilder()
      .addClass({ id: "mep.water_heater", label: "Water heaters", discipline: "plumbing", parent: "mep.equipment", source: "library:wh@1" })
      .addField(field("own.mbh", ["mep.equipment"], { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH", label: "Input" }))
      .addField(field("served_from", ["mep.equipment"], { label: "Served from" }))
      .addField(field("served_from", ["mep.water_heater"], { label: "Fed by (heater)" }))
      .build();

    expect(registry.ancestors("mep.water_heater")).toEqual(["mep.water_heater", "mep.equipment"]);
    expect(registry.isA("mep.water_heater", "mep.equipment")).toBe(true);
    expect(registry.descendants("mep.equipment")).toEqual(expect.arrayContaining(["mep.water_heater", "mep.mechanical_equipment", "mep.electrical_equipment"]));
    const paths = registry.fieldsFor("mep.water_heater").map((f) => `${f.path}:${f.label}`);
    expect(paths).toEqual(expect.arrayContaining(["own.mbh:Input", "served_from:Fed by (heater)"]));
    expect(registry.fieldsFor("mep.mechanical_equipment").map((f) => f.label)).toContain("Served from");
    // The abstract parent is listed only when asked.
    expect(registry.listClasses().some((c) => c.id === "mep.equipment")).toBe(false);
    expect(registry.listClasses({ includeAbstract: true }).some((c) => c.id === "mep.equipment")).toBe(true);
  });

  it("reads field paths through relationships and says when a step reaches many", () => {
    const registry = builtinRegistryBuilder()
      .addField(field("mark", ["mep.plumbing_fixture", "mep.mechanical_equipment"], { label: "Mark" }))
      .addField(field("load.wsfu_total", ["mep.plumbing_fixture"], { valueType: "quantity", kind: "fixture_units_supply", unit: "WSFU" }))
      .addField(field("developed_length", ["mep.plumbing_fixture"], { valueType: "quantity", kind: "length", unit: "ft" }))
      .build();

    const servedBy = registry.describePath("mep.plumbing_fixture", "served_by.mark");
    expect(servedBy).toMatchObject({ ok: true, many: true, field: { path: "mark" } });
    if (servedBy.ok) expect(servedBy.steps.map((s) => s.id)).toEqual(["served_by"]);
    const total = registry.describePath("mep.mechanical_equipment", "serves.load.wsfu_total");
    expect(total).toMatchObject({ ok: true, many: true, field: { path: "load.wsfu_total", unit: "WSFU" } });
    const own = registry.describePath("mep.plumbing_fixture", "load.wsfu_total");
    expect(own).toMatchObject({ ok: true, many: false, steps: [] });
    expect(registry.describePath("mep.plumbing_fixture", "served_by.nonsense")).toEqual({ ok: false, message: expect.stringContaining('no field "served_by.nonsense"') });
    expect(registry.relationship("serves")?.inverse).toBe("served_by");
    expect(registry.relationship("served_by")?.inverse).toBe("serves");
    expect(registry.relationship("connected_to")?.inverse).toBe("connected_to");
  });

  it("refuses a bad registration whole, naming each problem in plain words", () => {
    const units: UnitCatalog = {
      unitAllowed: (kind, unit) => (kind === "length" && unit === "ft") || (kind === "pressure" && unit === "psi"),
      convert: () => {
        throw new Error("not used");
      },
    };
    const attempt = () =>
      createRegistryBuilder({ units })
        .addClass({ id: "a.one", label: "One", discipline: "general", parent: "a.two", source: "builtin" })
        .addClass({ id: "a.two", label: "Two", discipline: "general", parent: "a.one", source: "builtin" })
        .addClass({ id: "Bad Id", label: "Bad", discipline: "general", source: "builtin" })
        .addClass({ id: "a.three", label: "Three", discipline: "general", parent: "a.missing", source: "builtin" })
        .addField(field("pressure", ["a.one"], { valueType: "quantity", kind: "pressure", unit: "ft" }))
        .addField(field("orphan", ["a.nowhere"]))
        .build();
    expect(attempt).toThrow(RegistryError);
    let messages: string[] = [];
    try {
      attempt();
    } catch (err) {
      if (err instanceof RegistryError) messages = err.problems.map((p) => p.message);
    }
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("extend each other in a circle"),
        expect.stringContaining('"Bad Id" is not a class id'),
        expect.stringContaining("extends a.missing, which does not exist"),
        expect.stringContaining('is a pressure, and "ft" is not a pressure unit'),
        expect.stringContaining("applies to class a.nowhere, which does not exist"),
      ]),
    );
  });

  it("never changes a registry it was extended from", () => {
    const base = builtinRegistry();
    const before = base.fingerprint;
    const extended = base.extend().addClass({ id: "fp.sprinkler_head", label: "Sprinkler heads", discipline: "fire_protection", source: "library:fp@1" }).build();
    expect(base.getClass("fp.sprinkler_head")).toBeUndefined();
    expect(base.fingerprint).toBe(before);
    expect(extended.getClass("fp.sprinkler_head")?.discipline).toBe("fire_protection");
    expect(extended.fingerprint).not.toBe(before);
  });
});

describe("class recognition", () => {
  // The tower-14 recognition case moved to __tests__/m12-registry-tower-recognition.test.ts (round 12):
  // the load-test building is an add-on package's, and a test beside the registry may not import one.

  it("files a part under its type's category and any rule-matched subclass", () => {
    const registry = builtinRegistryBuilder()
      .addClass({
        id: "mep.water_heater",
        label: "Water heaters",
        discipline: "plumbing",
        parent: "mep.equipment",
        recognize: { partCategories: ["plumbing_fixture"], where: [{ path: "type.param.heater_kind", op: "present" }] },
        source: "library:wh@1",
      })
      .build();
    const partType = (id: string, heater: boolean) => ({
      id,
      kind: "part_type" as const,
      definition: {
        familyName: heater ? "Water heater, tank" : "Lavatory",
        typeName: "T",
        category: "plumbing_fixture" as const,
        typeParams: heater ? [{ name: "heater_kind", label: "Kind", kind: "text" as const }] : [],
        typeValues: heater ? { heater_kind: "tank" } : {},
        instanceParams: [],
      },
    });
    const part = (id: string, typeId: string) => ({ id, kind: "part" as const, typeId, levelId: "L1", position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: id, values: {} });
    const elements = Object.fromEntries(
      [partType("t-wh", true), partType("t-lav", false), part("WH-1", "t-wh"), part("L-1", "t-lav")].map((e) => [e.id, e]),
    ) as unknown as Parameters<typeof buildClassIndex>[1]["elements"];
    const index = buildClassIndex(registry, { elements });
    expect(index.classesOf(asElementId("WH-1"))).toEqual(["mep.plumbing_fixture", "mep.water_heater"]);
    expect(index.classesOf(asElementId("L-1"))).toEqual(["mep.plumbing_fixture"]);
    expect(index.elementsOf("mep.equipment").map((e) => e.id)).toEqual(["WH-1"]);
    expect(index.elementsOf("mep.plumbing_fixture").map((e) => e.id)).toEqual(["WH-1", "L-1"]);
  });

  it("keeps the kernel's built-in classes free of fields (fields come from providers and libraries)", () => {
    const registry = builtinRegistry();
    for (const cls of BUILTIN_CLASSES) expect(registry.fieldsFor(cls.id)).toEqual([]);
  });
});
