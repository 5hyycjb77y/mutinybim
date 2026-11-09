import { LIBRARY_ROW_SECTIONS, libraryRowsOf, type LibraryRowSection } from "@permitzip/bim-kernel";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import type { FileLibrarySource } from "../file-provider";
import { libraryBundleSchema, type LibraryBundleInput } from "../schema";
import { EQUIPMENT_LIST_TEMPLATE } from "./equipment-list";
import { baselineParameterFields } from "./parameter-sets";
import { mutinybimTitleBlockItems } from "./title-blocks";

/**
 * The built-in AEC library MutinyBIM ships (SCHEDULES-PLAN §3a): the classes the kernel can't infer from element kinds alone, and
 * the shared parameters each trade keeps on its elements. An add-on's own
 * classes and fields (Structural's footing and camber) arrive as its
 * `kernel.library_rows`, joined by `builtinLibraryBundle()`. Values a provider
 * reads from the model (mark, level, room, loads) are registered by the trade
 * providers, not here; MEP calculations and per-trade schedule templates are
 * added by those streams.
 */

export const BUILTIN_SCOPE = { id: "builtin", kind: "builtin", name: "Built-in" } as const;

/** Kept in the element's own `values` (then its element type's), written with `set_element_values`: the building kinds. */
const VALUES = { kind: "values" } as const;
const param = (name: string) => ({ kind: "parameter" as const, scope: "instance" as const, name });

export const AEC_LIBRARY: LibraryBundleInput = {
  format: "mutinybim-library",
  version: 1,
  id: "mutinybim-aec",
  name: "MutinyBIM built-in AEC library",
  publisher: "MutinyBIM",
  revision: 1,
  requires: { mutinybim: ">=0.1.0" },
  /** The built-in display profiles are `@permitzip/bim-units` BUILTIN_PROFILES, added here as items when that package merges. */
  units: [],
  classes: [
    {
      id: "aec:class:mep.water_heater",
      revision: 1,
      key: "mep.water_heater",
      label: "Water heaters",
      discipline: "plumbing",
      parent: "mep.equipment",
      ifc: { entity: "IfcBoiler", predefinedType: "WATER" },
      recognize: { partCategories: ["plumbing_fixture"], where: [{ path: "type.param.heater_kind", op: "present" }] },
    },
    {
      id: "aec:class:fp.sprinkler_head",
      revision: 1,
      key: "fp.sprinkler_head",
      label: "Sprinkler heads",
      discipline: "fire_protection",
      ifc: { entity: "IfcFireSuppressionTerminal", predefinedType: "SPRINKLER" },
      description: "No part category is a sprinkler yet; a firm library or the fire protection provider adds the recognition rule.",
    },
    { id: "aec:class:civil.structure", revision: 1, key: "civil.structure", label: "Civil structures", discipline: "civil", ifc: { entity: "IfcDistributionChamberElement" }, description: "Manholes, inlets, catch basins and headwalls." },
    { id: "aec:class:gc.takeoff_item", revision: 1, key: "gc.takeoff_item", label: "Takeoff items", discipline: "general_contracting", description: "A counted or measured line of a quantity takeoff." },
  ],
  fields: [
    { id: "aec:field:arch.door.fire_rating", revision: 3, key: "arch.fire_rating", label: "Fire rating", appliesTo: ["arch.door"], valueType: "text", group: "Life safety", editable: true, storage: VALUES },
    { id: "aec:field:arch.door.hardware_set", revision: 2, key: "arch.hardware_set", aliases: ["hardware_set"], label: "Hardware set", appliesTo: ["arch.door"], valueType: "text", group: "Identity", editable: true, storage: VALUES },
    { id: "aec:field:arch.room.occupancy_group", revision: 2, key: "arch.occupancy_group", aliases: ["occupancy_group"], label: "Occupancy group", appliesTo: ["arch.room"], valueType: "text", group: "Code", editable: true, storage: VALUES },
    { id: "aec:field:arch.room.area_per_occupant", revision: 2, key: "arch.area_per_occupant", aliases: ["area_per_occupant"], label: "Area per occupant", appliesTo: ["arch.room"], valueType: "quantity", kind: "area_per_occupant", unit: "ft2/occ", group: "Code", editable: true, storage: VALUES },
    { id: "aec:field:arch.wall.fire_resistance", revision: 1, key: "arch.fire_resistance", label: "Fire resistance", appliesTo: ["arch.wall"], valueType: "quantity", kind: "time", unit: "h", group: "Life safety", editable: true, storage: VALUES },
    { id: "aec:field:civil.structure.rim_elevation", revision: 1, key: "rim_elevation", label: "Rim elevation", appliesTo: ["civil.structure"], valueType: "quantity", kind: "length", unit: "ft", group: "Elevations", editable: true, storage: param("rim_elevation") },
    { id: "aec:field:civil.structure.invert_elevation", revision: 1, key: "invert_elevation", label: "Invert elevation", appliesTo: ["civil.structure"], valueType: "quantity", kind: "length", unit: "ft", group: "Elevations", editable: true, storage: param("invert_elevation") },
    { id: "aec:field:fp.sprinkler_head.k_factor", revision: 1, key: "k_factor", label: "K-factor", appliesTo: ["fp.sprinkler_head"], valueType: "quantity", kind: "k_factor", unit: "gpm/psi^0.5", group: "Performance", editable: true, storage: param("k_factor") },
    { id: "aec:field:fp.sprinkler_head.temperature_rating", revision: 1, key: "temperature_rating", label: "Temperature rating", appliesTo: ["fp.sprinkler_head"], valueType: "quantity", kind: "temperature", unit: "degF", group: "Performance", editable: true, storage: param("temperature_rating") },
    { id: "aec:field:fp.sprinkler_head.response", revision: 1, key: "response", label: "Response", appliesTo: ["fp.sprinkler_head"], valueType: "choice", choices: ["Standard", "Quick"], group: "Performance", editable: true, storage: param("response") },
    { id: "aec:field:gc.takeoff_item.cost_code", revision: 1, key: "cost_code", label: "Cost code", appliesTo: ["gc.takeoff_item"], valueType: "text", group: "Cost", editable: true, storage: param("cost_code") },
    { id: "aec:field:gc.takeoff_item.unit_cost", revision: 1, key: "unit_cost", label: "Unit cost", appliesTo: ["gc.takeoff_item"], valueType: "quantity", kind: "money", unit: "USD", group: "Cost", editable: true, storage: param("unit_cost") },
    // KERNEL-FOUNDATION §3.2: identity, electrical, gas, water, drainage, mechanical and structural baseline parameters.
    ...baselineParameterFields(),
  ],
  scheduleTemplates: [EQUIPMENT_LIST_TEMPLATE],
  titleBlocks: mutinybimTitleBlockItems(),
};

/** The built-in bundle with add-on rows joined: each row section may carry items the provider parses (an add-on's rows are plain JSON). */
export type BuiltinLibraryBundle = Omit<LibraryBundleInput, LibraryRowSection> & { readonly [K in LibraryRowSection]?: readonly unknown[] };

/**
 * The built-in AEC library with the rows of every add-on in the set in force
 * (`kernel.library_rows`, contract 1.12.0) joined after the kernel's own, add-on
 * by add-on in set order. Item ids are kept as stored. An add-on that is off
 * contributes nothing, so its rows are absent. A row that isn't a library item
 * is left out and logged, naming the add-on.
 */
/** The built-in library with the add-ons' rows in the set in force; one object per set, so providers can reuse its checked layer. */
export function builtinLibraryBundle(): BuiltinLibraryBundle {
  return activePackSet().memo("bim-library.builtin_bundle", joinAddonRows);
}

function joinAddonRows(): BuiltinLibraryBundle {
  const addOns = libraryRowsOf();
  if (addOns.length === 0) return AEC_LIBRARY;
  const joined: { [K in LibraryRowSection]?: unknown[] } = {};
  for (const section of LIBRARY_ROW_SECTIONS) {
    const own: readonly unknown[] = AEC_LIBRARY[section] ?? [];
    const rows: unknown[] = [];
    for (const addOn of addOns) {
      for (const row of addOn.rows) {
        if (row.section !== section) continue;
        // One add-on's unreadable row must not take the whole built-in library down with it.
        const parsed = libraryBundleSchema.shape[section].safeParse([row.item]);
        if (parsed.success) rows.push(row.item);
        else console.error("[bim-library/builtin] an add-on's library row isn't a library item; it is left out of the built-in library", { addOn: addOn.packId, section, id: row.item.id, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      }
    }
    if (rows.length > 0) joined[section] = [...own, ...rows];
  }
  return { ...AEC_LIBRARY, ...joined };
}

/** The built-in library (with the add-ons' rows in the set in force) as the lowest, read-only scope of a `FileLibraryProvider`. */
export function builtinLibrarySource(): FileLibrarySource {
  return { scope: BUILTIN_SCOPE, kind: "bundle", bundle: builtinLibraryBundle() };
}

export * from "./parameter-sets";
export * from "./equipment-list";
export * from "./title-blocks";
