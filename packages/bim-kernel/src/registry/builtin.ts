import type { ScheduleCategory } from "../documents";
import type { PartCategory } from "../parts";
import { firstPartyBaseRevision, installedFirstPartyPacks } from "../packs/set";
import { createRegistryBuilder, type PackClass, type RegistryOptions } from "./registry";
import type { ClassId, ObjectClass, Registry, RegistryBuilder, RelationshipPair } from "./types";

/**
 * The kernel's own registrations: today's element kinds and part categories
 * as classes (so every existing schedule maps 1:1), and the cross-discipline
 * relationship names. No fields and no resolvers: what a value reads, and how
 * a relationship walks, comes from the trade providers that own them.
 */

type BuiltinClass = Omit<ObjectClass, "source">;

/** `kernel.class` (registry/index.ts), named here so this module needn't import the point. */
const CLASS_POINT_ID = "kernel.class";
const ELEMENT_KIND_POINT_ID = "kernel.element_kind";

/**
 * The kernel's fallback class for its building kinds. The installed
 * add-ons' classes for them (walls, doors…) are listed just ahead of it, so
 * they win wherever both recognise an element; with the add-on off the
 * element still has a class. Never written by the upgrade on edit.
 */
export const BUILDING_FALLBACK_CLASS_ID = "gen.building_element";
export const BUILDING_FALLBACK_KINDS = ["wall", "slab", "opening", "room", "component", "ceiling"] as const;

/** A part category's class; `extra.recognize` replaces the category-only rule (legacy kinds that list with it). */
const category = (id: ClassId, label: string, discipline: ObjectClass["discipline"], cat: PartCategory, extra: Partial<BuiltinClass> = {}): BuiltinClass => ({
  ...extra,
  id,
  label,
  discipline,
  recognize: extra.recognize ?? { partCategories: [cat] },
});

export const BUILTIN_CLASSES: readonly BuiltinClass[] = [
  { id: "mep.equipment", label: "MEP equipment", discipline: "general", abstract: true, description: "Anything that draws or delivers a load: air handlers, water heaters, panels, pumps." },
  category("mep.mechanical_equipment", "Mechanical equipment", "mechanical", "mechanical_equipment", {
    parent: "mep.equipment",
    ifc: { entity: "IfcUnitaryEquipment", typeEntity: "IfcUnitaryEquipmentType" },
  }),
  category("mep.air_terminal", "Air terminals", "mechanical", "air_terminal", {
    ifc: { entity: "IfcAirTerminal", typeEntity: "IfcAirTerminalType" },
  }),
  category("mep.duct_accessory", "Duct accessories", "mechanical", "duct_accessory", { ifc: { entity: "IfcDamper", typeEntity: "IfcDamperType" } }),
  category("mep.pipe_accessory", "Pipe accessories", "plumbing", "pipe_accessory", { ifc: { entity: "IfcValve", typeEntity: "IfcValveType" } }),
  category("mep.plumbing_fixture", "Plumbing fixtures", "plumbing", "plumbing_fixture", { ifc: { entity: "IfcSanitaryTerminal", typeEntity: "IfcSanitaryTerminalType" } }),
  category("mep.electrical_equipment", "Electrical equipment", "electrical", "electrical_equipment", { parent: "mep.equipment", ifc: { entity: "IfcElectricDistributionBoard", typeEntity: "IfcElectricDistributionBoardType" } }),
  category("mep.electrical_device", "Electrical devices", "electrical", "electrical_device", { ifc: { entity: "IfcOutlet", typeEntity: "IfcOutletType" } }),
  category("mep.lighting_fixture", "Lighting fixtures", "electrical", "lighting_fixture", { ifc: { entity: "IfcLightFixture", typeEntity: "IfcLightFixtureType" } }),
  category("gen.generic_model", "Generic models", "general", "generic", { ifc: { entity: "IfcBuildingElementProxy", typeEntity: "IfcBuildingElementProxyType" } }),
  { id: "mep.duct", label: "Duct", discipline: "mechanical", ifc: { entity: "IfcDuctSegment", typeEntity: "IfcDuctSegmentType" }, recognize: { elementKinds: ["run_segment"], where: [{ path: "domain", op: "equals", value: "duct" }] } },
  { id: "mep.pipe", label: "Pipe", discipline: "plumbing", ifc: { entity: "IfcPipeSegment", typeEntity: "IfcPipeSegmentType" }, recognize: { elementKinds: ["run_segment"], where: [{ path: "domain", op: "equals", value: "pipe" }] } },
  { id: "mep.conduit", label: "Conduit", discipline: "electrical", ifc: { entity: "IfcCableCarrierSegment", typeEntity: "IfcCableCarrierSegmentType" }, recognize: { elementKinds: ["run_segment"], where: [{ path: "domain", op: "equals", value: "conduit" }] } },
  { id: "mep.run_fitting", label: "Fittings", discipline: "general", ifc: { entity: "IfcFlowFitting" }, recognize: { elementKinds: ["run_fitting"] } },
  { id: "mep.riser", label: "Risers", discipline: "general", ifc: { entity: "IfcFlowSegment" }, recognize: { elementKinds: ["riser_segment"] } },
  { id: "mep.system", label: "Systems", discipline: "general", ifc: { entity: "IfcDistributionSystem" }, recognize: { elementKinds: ["mep_system"] } },
  { id: "mep.service_link", label: "Circuits and feeders", discipline: "electrical", ifc: { entity: "IfcDistributionCircuit" }, recognize: { elementKinds: ["service_link"] } },
  { id: "mep.load_point", label: "Load points", discipline: "general", ifc: { entity: "IfcDistributionPort" }, recognize: { elementKinds: ["load_point"] } },
  {
    id: BUILDING_FALLBACK_CLASS_ID,
    label: "Building elements",
    discipline: "general",
    ifc: { entity: "IfcBuildingElementProxy" },
    recognize: { elementKinds: [...BUILDING_FALLBACK_KINDS] },
    description: "Walls, floors, doors, windows, rooms, components and ceilings while no add-on gives them a class of their own. They still draw, join, cut and bound rooms.",
  },
  { id: "civil.site", label: "Site", discipline: "civil", ifc: { entity: "IfcSite" }, recognize: { elementKinds: ["site"] } },
  { id: "gen.space", label: "Spaces", discipline: "general", ifc: { entity: "IfcSpace", predefinedType: "SPACE" }, recognize: { elementKinds: ["space"] }, description: "The engineers' own spaces: drawn, traced over a drawing, or made from rooms. Carry use, occupants and area loads." },
  { id: "gen.zone", label: "Zones", discipline: "general", ifc: { entity: "IfcZone" }, recognize: { elementKinds: ["zone"] }, description: "Spaces grouped for a purpose (thermal, ventilation, lighting control), optionally served by one piece of equipment." },
  { id: "doc.drawing_underlay", label: "Underlays", discipline: "documentation", recognize: { elementKinds: ["drawing_underlay"] }, description: "PDF pages, images and CAD files placed on a level to trace over." },
  { id: "gen.level", label: "Levels", discipline: "general", ifc: { entity: "IfcBuildingStorey" }, recognize: { elementKinds: ["level"] } },
  { id: "doc.view", label: "Views", discipline: "documentation", recognize: { elementKinds: ["view"] } },
  { id: "doc.sheet", label: "Sheets", discipline: "documentation", recognize: { elementKinds: ["sheet"], where: [{ path: "deleted", op: "not_equals", value: true }] } },
  { id: "gen.element_type", label: "Element types", discipline: "general", recognize: { elementKinds: ["element_type"] }, description: "Shared types for walls, beams, columns, slabs and components: a class, a name and type values." },
];

/** The class each v1 schedule category lists, so v1 definitions read through the registry unchanged. */
export const SCHEDULE_CATEGORY_CLASSES: Readonly<Record<ScheduleCategory, ClassId>> = {
  mechanical_equipment: "mep.mechanical_equipment",
  air_terminal: "mep.air_terminal",
  duct_accessory: "mep.duct_accessory",
  pipe_accessory: "mep.pipe_accessory",
  plumbing_fixture: "mep.plumbing_fixture",
  electrical_equipment: "mep.electrical_equipment",
  electrical_device: "mep.electrical_device",
  lighting_fixture: "mep.lighting_fixture",
  generic: "gen.generic_model",
  sheet_list: "doc.sheet",
  duct: "mep.duct",
  pipe: "mep.pipe",
};

/** The class each part category's parts are recognized as. */
export const PART_CATEGORY_CLASSES: Readonly<Record<PartCategory, ClassId>> = {
  mechanical_equipment: "mep.mechanical_equipment",
  air_terminal: "mep.air_terminal",
  duct_accessory: "mep.duct_accessory",
  pipe_accessory: "mep.pipe_accessory",
  plumbing_fixture: "mep.plumbing_fixture",
  electrical_equipment: "mep.electrical_equipment",
  electrical_device: "mep.electrical_device",
  lighting_fixture: "mep.lighting_fixture",
  generic: "gen.generic_model",
};

const pair = (
  forward: [id: string, label: string, cardinality: "one" | "many"],
  inverse: [id: string, label: string, cardinality: "one" | "many"],
  deps: RelationshipPair["deps"],
  traversal: "direct" | "path" = "direct",
  description?: string,
): RelationshipPair => ({
  forward: { id: forward[0], label: forward[1], cardinality: forward[2], from: "any", to: "any", traversal },
  inverse: { id: inverse[0], label: inverse[1], cardinality: inverse[2], from: "any", to: "any", traversal },
  deps,
  ...(description === undefined ? {} : { description }),
});

/** Built-in relationship names. Trade providers attach the resolvers (the existing walks). */
export const BUILTIN_RELATIONSHIPS: readonly RelationshipPair[] = [
  pair(["serves", "Serves", "many"], ["served_by", "Served by", "many"], { connections: true }, "direct", "Downstream connections: what an item supplies. Never summed into system totals."),
  pair(["fed_from", "Fed from", "one"], ["feeds", "Feeds", "many"], { connections: true }),
  pair(["on_circuit", "On circuit", "one"], ["circuit_loads", "Circuit loads", "many"], { connections: true }),
  pair(["in_system", "In system", "many"], ["system_members", "System members", "many"], { elementKinds: ["mep_system"], connections: true }),
  pair(["in_zone", "In zone", "many"], ["zone_members", "Zone members", "many"], { elementKinds: ["space", "zone", "room"] }, "direct", "The zones an item's space belongs to; a zone's members are its spaces."),
  pair(["in_space", "In space", "one"], ["space_members", "In this space", "many"], { elementKinds: ["space", "room", "level"] }, "direct", "The space an item stands in (its plan point), or the space a planned item names."),
  pair(["zone_served_by", "Zone served by", "one"], ["serves_zones", "Zones served", "many"], { elementKinds: ["zone"] }, "direct", "The equipment a zone names as its source (RTU-2 serves Zone 2 Kitchen)."),
  pair(["in_room", "In room", "one"], ["contains", "Contains", "many"], { elementKinds: ["room"] }),
  pair(["on_level", "On level", "one"], ["level_members", "On this level", "many"], { elementKinds: ["level"] }),
  pair(["hosted_by", "Hosted by", "one"], ["hosts", "Hosts", "many"], { elementKinds: ["wall", "slab", "mounting_plane"] }),
  pair(["connected_to", "Connected to", "many"], ["connected_to", "Connected to", "many"], { connections: true }),
  pair(["source", "Source", "one"], ["source_of", "Source of", "many"], { connections: true }, "path", "The path back to the feed: its name, developed length, zone and pressure."),
  pair(["supported_by", "Supported by", "many"], ["supports", "Supports", "many"], { elementKinds: ["beam", "column", "slab", "wall"] }, "path"),
  pair(["member_of_group", "In group", "many"], ["group_members", "Group members", "many"], { elementKinds: ["organization"] }),
  pair(["phase", "Phase", "one"], ["phase_members", "In this phase", "many"], { elementKinds: ["organization"] }),
];

function isPackClass(item: unknown): item is PackClass {
  return typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" && typeof (item as { label?: unknown }).label === "string";
}

/**
 * The classes the always-installed first-party add-ons contribute (walls,
 * doors… from the building add-on). Every peer of a release installs the same
 * ones, so recognition over them writes the same class on every peer; they
 * rank as built-in rows, as they did when the kernel carried them.
 */
export function firstPartyClasses(): PackClass[] {
  const { ahead, after } = firstPartyClassPlaces();
  return [...ahead, ...after];
}

const FALLBACK_KIND_SET: ReadonlySet<string> = new Set(BUILDING_FALLBACK_KINDS);

/**
 * Where each installed first-party add-on's classes sit around the fallback.
 * An add-on that classifies one of the fallback's kinds outright (no
 * condition) takes those kinds over: its classes go just ahead of the
 * fallback, which drops the kinds they recognise. Every other add-on's
 * classes go just after it and take nothing from it.
 */
function firstPartyClassPlaces(): { readonly ahead: readonly PackClass[]; readonly after: readonly PackClass[] } {
  const ahead: PackClass[] = [];
  const after: PackClass[] = [];
  for (const pack of installedFirstPartyPacks()) {
    const own: PackClass[] = [];
    for (const c of pack.contributions) if (c.pointId === CLASS_POINT_ID) for (const item of c.items) if (isPackClass(item)) own.push(item);
    const takesOver = own.some((c) => (c.recognize?.where?.length ?? 0) === 0 && (c.recognize?.elementKinds ?? []).some((k) => FALLBACK_KIND_SET.has(k)));
    (takesOver ? ahead : after).push(...own);
  }
  return { ahead, after };
}

/** An element-kind row's class face, read without the kind point (`ElementKindItem.classId`). */
export interface KindClassFace {
  readonly kind: string;
  readonly classId?: ClassId;
}

function isKindClassFace(item: unknown): item is KindClassFace {
  return typeof item === "object" && item !== null && typeof (item as { kind?: unknown }).kind === "string";
}

/** The element-kind rows of the installed first-party add-ons that name a built-in class their records are. */
export function firstPartyKindClassRows(): KindClassFace[] {
  const out: KindClassFace[] = [];
  for (const pack of installedFirstPartyPacks()) for (const c of pack.contributions) if (c.pointId === ELEMENT_KIND_POINT_ID) for (const item of c.items) if (isKindClassFace(item) && item.classId !== undefined) out.push(item);
  return out;
}

/** A built-in class with the element kinds whose rows name it joined to its recognition, ahead of its part categories; itself when none do. */
function withRowKinds(cls: BuiltinClass, rows: readonly KindClassFace[]): BuiltinClass {
  const kinds = rows.filter((r) => r.classId === cls.id).map((r) => r.kind);
  if (kinds.length === 0) return cls;
  const { elementKinds, ...rest } = cls.recognize ?? {};
  return { ...cls, recognize: { elementKinds: [...(elementKinds ?? []), ...kinds.filter((k) => !(elementKinds ?? []).includes(k))], ...rest } };
}

/**
 * A builder holding the kernel's classes, the installed first-party add-ons'
 * classes and the relationships, for a layer to extend. `kindRows`: the
 * element-kind rows whose records a built-in class recognises (default: the
 * installed first-party add-ons').
 */
export function builtinRegistryBuilder(opts: RegistryOptions = {}, kindRows: readonly KindClassFace[] = firstPartyKindClassRows()): RegistryBuilder {
  const b = createRegistryBuilder(opts);
  // The first-party classes take the places the kernel's own rows had, around the fallback, so recognition order is unchanged.
  for (const builtinCls of BUILTIN_CLASSES) {
    const cls = withRowKinds(builtinCls, kindRows);
    if (cls.id !== BUILDING_FALLBACK_CLASS_ID) {
      b.addClass({ ...cls, source: "builtin" });
      continue;
    }
    const { ahead, after } = firstPartyClassPlaces();
    for (const c of ahead) b.addClass({ ...c, source: "builtin" });
    // The fallback takes only the kinds no installed add-on classifies, so with the add-on on every answer is as before.
    const covered = new Set(ahead.flatMap((c) => c.recognize?.elementKinds ?? []));
    b.addClass({ ...cls, source: "builtin", recognize: { elementKinds: BUILDING_FALLBACK_KINDS.filter((k) => !covered.has(k)) } });
    for (const c of after) b.addClass({ ...c, source: "builtin" });
  }
  for (const rel of BUILTIN_RELATIONSHIPS) b.addRelationship(rel, "builtin");
  return b;
}

let builtin: { readonly revision: number; readonly registry: Registry } | undefined;

/** The kernel's registry with the installed first-party add-ons' classes: classes and relationship names, no fields. Rebuilt when the first-party install changes. */
export function builtinRegistry(): Registry {
  const revision = firstPartyBaseRevision();
  if (builtin?.revision !== revision) builtin = { revision, registry: builtinRegistryBuilder().build() };
  return builtin.registry;
}
