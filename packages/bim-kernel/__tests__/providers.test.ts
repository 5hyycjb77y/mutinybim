/**
 * @jest-environment node
 *
 * Discipline field providers (SCHEDULES-PLAN §4, Stream F): every field the
 * kernel registers has a kind and unit or is text, every field says how a
 * cell edit reaches the model (or why it can't), the resolver's tag
 * vocabulary is all registered, and a class a library adds (a sprinkler head)
 * reads mark, level and room like every other class.
 */
import { unitAllowed } from "@permitzip/bim-units";
import {
  fieldPaths,
  asElementId,
  buildClassIndex,
  commandSchema,
  fieldProviderRegistry,
  withBaseFields,
  type BimElement,
  type FieldPathInfo,
  type PartInstance,
  type PartTypeElement,
  type Registry,
  type Room,
} from "../src";

const FT = 304.8;

/** Every command name with the top-level keys its input takes. */
const COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  commandSchema.options.map((o) => [String(o.shape.type.value), new Set(Object.keys(o.shape))] as const),
);

function everyField(registry: Registry) {
  const seen = new Set<string>();
  const out: Array<{ cls: string; field: ReturnType<Registry["fieldsFor"]>[number] }> = [];
  for (const cls of registry.listClasses({ includeAbstract: true })) {
    for (const field of registry.fieldsFor(cls.id)) {
      const key = `${field.source}\u0000${field.path}\u0000${field.classes.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ cls: cls.id, field });
    }
  }
  return out;
}

describe("kernel field providers", () => {
  const registry = fieldProviderRegistry();
  const fields = everyField(registry).filter(({ field }) => field.source.startsWith("provider:"));

  it("registers trade fields on the kernel's classes", () => {
    expect(fields.length).toBeGreaterThan(150);
    expect(new Set(fields.map((f) => f.field.source))).toEqual(
      new Set(["provider:base.spatial", "provider:mep.electrical", "provider:mep.plumbing", "provider:mep.gas", "provider:mep.mechanical", "provider:placement", "provider:loads", "provider:mep.ventilation", "provider:qto", "provider:pack:architecture", "provider:architecture.building", "provider:pack:struct", "provider:struct.members", expect.stringMatching(/^provider:base:/)]),
    );
  });

  it("gives every field a kind and unit, or makes it text, a choice or a boolean", () => {
    const bad: string[] = [];
    for (const { field } of fields) {
      if (field.valueType === "quantity") {
        if (!field.kind || !field.unit || !unitAllowed(field.kind, field.unit)) bad.push(`${field.path}: ${field.kind}/${field.unit}`);
      } else if (field.kind !== undefined || field.unit !== undefined) {
        bad.push(`${field.path} is ${field.valueType} but carries ${field.kind}/${field.unit}`);
      }
      if (!field.read) bad.push(`${field.path} has no reader`);
    }
    expect(bad).toEqual([]);
  });

  it("gives every editable field a writer the kernel accepts, and every locked one a reason", () => {
    const bad: string[] = [];
    for (const { field } of fields) {
      const w = field.writer;
      if (w.kind === "none") {
        if (w.reason.trim().length < 10) bad.push(`${field.path}: locked without a reason`);
      } else if (w.kind === "parameter") {
        if (!/^[a-z][a-z0-9_]*$/.test(w.name)) bad.push(`${field.path}: parameter "${w.name}"`);
      } else {
        const keys = COMMANDS.get(w.command);
        // A pack parameter is written as one key of `set_element_values`' values (its argument is the parameter key).
        const head = w.command === "set_element_values" ? "values" : (w.argument.split(".")[0] ?? "");
        if (!keys) bad.push(`${field.path}: no command ${w.command}`);
        else if (!keys.has(head)) bad.push(`${field.path}: ${w.command} has no "${head}"`);
      }
    }
    expect(bad).toEqual([]);
    // What a person types into: marks, load point values, nameplate parameters, the feeder a circuit leaves on.
    const writerOf = (cls: string, path: string) => registry.field(cls, path)?.writer.kind;
    expect(writerOf("mep.mechanical_equipment", "mark")).toBe("command");
    expect(writerOf("mep.load_point", "mark")).toBe("command");
    expect(writerOf("mep.load_point", "load.wsfu_total")).toBe("command");
    expect(writerOf("mep.mechanical_equipment", "own.mca")).toBe("parameter");
    expect(writerOf("mep.plumbing_fixture", "own.mbh")).toBe("parameter");
    expect(writerOf("mep.service_link", "rating_a")).toBe("command");
    // The first-party Architecture add-on's type parameters are fields here, written through set_element_values.
    expect(registry.field("arch.wall", "architecture.wall_function")?.writer).toEqual({ kind: "command", command: "set_element_values", argument: "architecture.wall_function" });
    // Calculated values explain themselves.
    expect(registry.field("mep.electrical_equipment", "demand_kva")?.writer).toMatchObject({ kind: "none", reason: expect.stringContaining("circuits") });
    expect(registry.field("mep.plumbing_fixture", "source.developed_length")?.writer).toMatchObject({ kind: "none", reason: expect.stringContaining("gas pipe") });
  });

  it("registers the whole tag vocabulary of the shared resolver", () => {
    const on: Readonly<Record<FieldPathInfo["on"], string>> = {
      any: "mep.mechanical_equipment",
      device: "mep.electrical_device",
      panel: "mep.electrical_equipment",
      circuit: "mep.service_link",
      feeder: "mep.service_link",
      load_point: "mep.load_point",
      pipe: "mep.pipe",
    };
    const missing = fieldPaths().filter((p) => p.path !== "type_name" && !registry.field(on[p.on], p.path)).map((p) => `${p.path} on ${on[p.on]}`);
    expect(missing).toEqual([]);
    expect(registry.field("mep.mechanical_equipment", "type_name")?.source).toMatch(/^provider:base:/);
  });

  it("types the values: a panel's demand in kVA, a fixture's units in WSFU, a gas run in feet", () => {
    expect(registry.field("mep.electrical_equipment", "demand_kva")).toMatchObject({ kind: "power_apparent", unit: "kVA" });
    expect(registry.field("mep.load_point", "load.wsfu_total")).toMatchObject({ kind: "fixture_units_supply", unit: "WSFU", aggregation: "sum" });
    expect(registry.field("mep.load_point", "load.dfu")).toMatchObject({ kind: "fixture_units_drainage", unit: "DFU" });
    expect(registry.field("mep.pipe", "gas.from_source")).toMatchObject({ kind: "length", unit: "ft" });
    // Carried values already include everything below: totalling them is refused at the field.
    expect(registry.field("mep.pipe", "pipe.carries.dfu")?.aggregation).toBe("none");
    expect(registry.describePath("mep.plumbing_fixture", "source.developed_length")).toMatchObject({ ok: true, steps: [], field: { unit: "ft" } });
    expect(registry.describePath("mep.plumbing_fixture", "source.mark")).toMatchObject({ ok: true, many: false, field: { path: "mark" } });
    expect(registry.describePath("mep.equipment", "serves.load.wsfu_total")).toMatchObject({ ok: true, many: true, field: { unit: "WSFU" } });
  });
});

describe("base fields on a class a library adds", () => {
  const level: BimElement = { id: asElementId("lvl-1"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const room: Room = {
    id: asElementId("room-101"),
    kind: "room",
    version: 1,
    authoredRev: {},
    partition: { level: "Level 1", zone: "Z1", discipline: "architecture" },
    number: "101",
    name: "Office",
    outline: [
      { x: 0, y: 0 },
      { x: 20 * FT, y: 0 },
      { x: 20 * FT, y: 15 * FT },
      { x: 0, y: 15 * FT },
    ],
    areaSqM: 27.87,
  };
  const type: PartTypeElement = {
    id: asElementId("t-sprk"),
    kind: "part_type",
    version: 1,
    authoredRev: {},
    definition: {
      familyName: "Sprinkler, pendent",
      typeName: "K5.6 155F",
      category: "generic",
      typeParams: [],
      typeValues: {},
      instanceParams: [],
      connectors: [],
      geometry: [{ kind: "box", center: [0, 0, 0], size: [50, 50, 50] }],
      symbol: [{ kind: "rect", center: [0, 0], size: [50, 50] }],
      tagFields: ["mark"],
      source: { kind: "builtin", libraryVersion: "test" },
    },
  };
  const head = (id: string, mark: string, x: number): PartInstance => ({ id: asElementId(id), kind: "part", version: 1, authoredRev: {}, typeId: type.id, levelId: level.id, position: { x, y: 5 * FT }, offsetMm: 2700, rotationDeg: 0, mark, values: {} });
  const elements: Record<string, BimElement> = { [level.id]: level, [room.id]: room, [type.id]: type, sp1: head("sp1", "SP-1", 5 * FT), sp2: head("sp2", "SP-2", 40 * FT) };

  const registry = withBaseFields(
    fieldProviderRegistry()
      .extend()
      .addClass({
        id: "fp.sprinkler_head",
        label: "Sprinkler heads",
        discipline: "fire_protection",
        ifc: { entity: "IfcFireSuppressionTerminal", predefinedType: "SPRINKLER" },
        recognize: { partCategories: ["generic"], where: [{ path: "family", op: "contains", value: "Sprinkler" }] },
        source: "library:fp@1",
      })
      .build(),
  );

  it("recognizes the heads and reads mark, type, level and room through the base fields", () => {
    const heads = buildClassIndex(registry, { elements }).elementsOf("fp.sprinkler_head");
    expect(heads.map((h) => h.id)).toEqual(["sp1", "sp2"]);
    const read = (id: string, path: string) => {
      const f = registry.field("fp.sprinkler_head", path);
      const el = elements[id];
      return f?.read && el ? f.read(el, { elements }) : undefined;
    };
    expect(["mark", "type_name", "family", "level", "room", "count"].map((p) => read("sp1", p))).toEqual(["SP-1", "K5.6 155F", "Sprinkler, pendent", "Level 1", "101 Office", 1]);
    // The second head is outside the room's outline.
    expect(read("sp2", "room")).toBeNull();
    expect(registry.field("fp.sprinkler_head", "mark")?.writer).toEqual({ kind: "command", command: "set_parameters", argument: "mark" });
  });

  it("walks to the room and the level as relationships", () => {
    const inRoom = registry.relationship("in_room");
    const contains = registry.relationship("contains");
    const sp1 = elements.sp1;
    if (!sp1) throw new Error("no sp1");
    expect(inRoom?.resolve?.(sp1, { elements })).toEqual(["room-101"]);
    expect(contains?.resolve?.(room, { elements })).toEqual(["sp1"]);
    expect(registry.relationship("on_level")?.resolve?.(sp1, { elements })).toEqual(["lvl-1"]);
    expect(registry.describePath("fp.sprinkler_head", "in_room.number")).toMatchObject({ ok: true, field: { path: "number" } });
  });
});
