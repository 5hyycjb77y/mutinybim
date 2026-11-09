/**
 * @jest-environment node
 *
 * Batch 5c round 3, Gap W: the built-in library's building-class fields are
 * kept in the element's own `values` (then its element type's), not as part
 * parameters. On the old library a room's, door's or beam's field read only
 * parts, so a value stored with `set_element_values` never showed in the field
 * registry or a schedule column, and walls had no quantity at all.
 */
import { fieldProviderRegistry, withBaseFields, type BimElement, type Registry, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import { openSchedule } from "@permitzip/bim-kernel/schedules";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { STRUCTURAL_PACK } from "@permitzip/bim-pack-structural";
import { builtinLibraryBundle, loadBundle } from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

function libraryRegistry(): Registry {
  const base = fieldProviderRegistry();
  // Round 14: the beam's camber field comes from the Structural add-on's library rows.
  const bundle = withPackSet(PackSet.create([STRUCTURAL_PACK]), () => builtinLibraryBundle());
  const loaded = loadBundle(bundle, { formula: bimFormulaEngine, units: bimUnitsCatalog, registry: base });
  if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join("\n"));
  return withBaseFields(loaded.registry);
}

const registry = libraryRegistry();
const model = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-gap-w" });
const room = Object.values(model.elements).find((e) => e.kind === "room");
const wall = Object.values(model.elements).find((e) => e.kind === "wall");
if (!room || !wall) throw new Error("the XS model needs a room and a wall");

describe("c5p3 Gap W: building fields read the element's values", () => {
  it("a room's stored area per occupant reads through its namespaced field, written with set_element_values", () => {
    const field = registry.field("arch.room", "arch.area_per_occupant");
    expect(field).toMatchObject({ key: "arch.area_per_occupant", unit: "ft2/occ", storedUnit: "ft2/occ", writer: { kind: "command", command: "set_element_values", argument: "arch.area_per_occupant" } });
    const stored = { ...room, values: { "arch.area_per_occupant": 15 } } as BimElement;
    expect(field?.read?.(stored, { elements: model.elements })).toBe(15);
    expect(field?.read?.(room, { elements: model.elements })).toBeNull();
  });

  it("the old bare key is an alias: a value stored under it, and a reference to it, still read", () => {
    const old = { ...room, values: { area_per_occupant: 15 } } as BimElement;
    expect(registry.field("arch.room", "arch.area_per_occupant")?.read?.(old, { elements: model.elements })).toBe(15);
    expect(registry.field("arch.room", "area_per_occupant")?.read?.(old, { elements: model.elements })).toBe(15);
    expect(registry.fieldsFor("arch.door").map((f) => f.path)).toEqual(expect.arrayContaining(["arch.fire_rating", "fire_rating", "arch.hardware_set", "hardware_set"]));
    expect(registry.field("struct.beam", "camber")?.key).toBe("struct.camber");
  });

  it("a wall's fire resistance is a time in hours, read from the wall or its element type", () => {
    const field = registry.field("arch.wall", "arch.fire_resistance");
    expect(field).toMatchObject({ valueType: "quantity", kind: "time", unit: "h", group: "Life safety" });
    const type = { ...wall, id: "et-2hr", kind: "element_type", name: "2-hour wall", values: { "arch.fire_resistance": 2 } } as unknown as BimElement;
    const typed = { ...wall, typeId: "et-2hr" } as BimElement;
    const elements = { ...model.elements, [typed.id]: typed, "et-2hr": type };
    expect(field?.read?.(typed, { elements })).toBe(2);
    expect(field?.read?.({ ...typed, values: { "arch.fire_resistance": 1 } } as BimElement, { elements })).toBe(1);
  });

  it("a schedule column shows the room's stored value, converted from the field's unit", () => {
    const stored = { ...room, values: { "arch.area_per_occupant": 15 } } as BimElement;
    const elements = { ...model.elements, [stored.id]: stored };
    const def: ScheduleDefinitionV2 = {
      name: "Rooms",
      source: { kind: "classes", classes: ["arch.room"], includeSubclasses: true },
      columns: [{ id: "apo", kind: "field", path: "arch.area_per_occupant" }],
      filters: [],
      sort: [],
      groups: [],
      grandTotals: false,
      itemize: true,
      presentation: { kind: "list" },
      display: { textSizeMm: 2.5, emptyText: "" },
    };
    const rows = openSchedule({ elements, connections: [] }, def, { viewId: "v-rooms", revision: 1, registry }).rows();
    const at = rows.elementIds.indexOf(stored.id);
    const col = rows.values.get("apo");
    expect(rows.columns[0]).toMatchObject({ unit: "ft2/occ", writer: expect.anything() });
    // 15 ft²/occ in SI (m² per occupant).
    expect(col?.type === "quantity" ? col.values[at] : null).toBeCloseTo(1.3935456, 6);
  });
});
