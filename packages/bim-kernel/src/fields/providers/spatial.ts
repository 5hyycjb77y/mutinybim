import { ALLOCATION_POLICY_LABELS, allocationPolicyOf } from "../../requirements/policy";
import type { ClassId, FieldProvider, FieldReader, FieldWriter, ObjectClass, Registry, RelationshipResolver } from "../../registry/types";
import { elementOrder, elementValues, elementsOfKind, isFrozenElements } from "../../store";
import { registerRevisionCarry } from "../../revision-carry";
import { spaceBasis } from "../../spaces/space-density";
import { isCalibrated, spaceLabel } from "../../spaces/space-geometry";
import { spaceMeasure, spaceOf, spacesOfZone, zonesOfSpace, zonesServedBy } from "../../spaces/space-index";
import { pinnedUse } from "../../spaces/space-use";
import type { DrawingUnderlay, Space, Zone } from "../../spaces/types";
import type { BimElement, ElementId, Room } from "../../types";
import { levelOf, roomOf } from "./level-room";
import { command, finite, locked, textOrNull, type ProviderField } from "./support";

/**
 * Base fields every discipline shares (mark, type, family, level, room,
 * count), the level and room relationships they read through, and the
 * site's and levels' own quantities. A class a firm library adds (a
 * sprinkler head, a takeoff item) gets the base fields by
 * `withBaseFields`, so fire protection and general contracting rows read the
 * same vocabulary as everything else without a provider of their own.
 */

type Elements = Readonly<Record<string, BimElement>>;


// ---------------------------------------------------------------- level and room

export { levelOf, roomOf } from "./level-room";

/** "101 Office". */
export function roomText(r: Room): string | null {
  return textOrNull([r.number, r.name].filter((s) => s.trim() !== "").join(" "));
}

/** Kinds whose edit can move another element's answer (a level, the rooms, an opening's wall, a load point's run): an edit touching one rebuilds the index. */
const SHAPING_KINDS: ReadonlySet<BimElement["kind"]> = new Set(["level", "room", "wall", "run_segment", "run_fitting"]);

type Inverse = ReadonlyMap<string, readonly ElementId[]>;

/**
 * Elements that point at `target` through `forward`, by target id, once per
 * model state, in model order. Carried to the next revision (the revision
 * carry, `revision-carry.ts`) when the edit touched none of `SHAPING_KINDS`:
 * then only the changed elements can have moved, and each is moved between
 * its old and new target's list at its place in model order.
 */
function inverseIndex(name: string, forward: (el: BimElement, elements: Elements) => string | null): (target: BimElement, elements: Elements) => readonly ElementId[] {
  const cache = new WeakMap<Elements, Inverse>();
  registerRevisionCarry(`spatial.${name}`, (from, to, changedIds) => {
    const index = cache.get(from);
    if (!index || cache.has(to) || !isFrozenElements(to)) return;
    const moves: Array<{ readonly id: ElementId; readonly was: string | null; readonly now: string | null }> = [];
    for (const id of changedIds) {
      const before = from[id];
      const after = to[id];
      if ((before && SHAPING_KINDS.has(before.kind)) || (after && SHAPING_KINDS.has(after.kind))) return;
      const el = after ?? before;
      if (!el) continue;
      const was = before ? forward(before, from) : null;
      const now = after ? forward(after, to) : null;
      if (was !== now) moves.push({ id: el.id, was, now });
    }
    if (moves.length === 0) {
      cache.set(to, index);
      return;
    }
    const order = elementOrder(to);
    const map = new Map(index);
    for (const { id, was, now } of moves) {
      if (was !== null) {
        const list = (map.get(was) ?? []).filter((x) => x !== id);
        if (list.length > 0) map.set(was, list);
        else map.delete(was);
      }
      if (now !== null) {
        const list = [...(map.get(now) ?? [])];
        const at = order.get(id) ?? Number.MAX_SAFE_INTEGER;
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((order.get(list[mid] ?? "") ?? Number.MAX_SAFE_INTEGER) < at) lo = mid + 1;
          else hi = mid;
        }
        list.splice(lo, 0, id);
        map.set(now, list);
      }
    }
    cache.set(to, map);
  });
  return (target, elements) => {
    let index = cache.get(elements);
    if (!index) {
      const map = new Map<string, ElementId[]>();
      for (const el of elementValues(elements)) {
        const to = forward(el, elements);
        if (to === null) continue;
        const list = map.get(to);
        if (list) list.push(el.id);
        else map.set(to, [el.id]);
      }
      index = map;
      cache.set(elements, index);
    }
    return index.get(target.id) ?? [];
  };
}

const levelMembers = inverseIndex("level_members", (el, elements) => levelOf(elements, el)?.id ?? null);
const roomMembers = inverseIndex("room_members", (el, elements) => roomOf(elements, el)?.id ?? null);

const onLevel: RelationshipResolver = (el, ctx) => {
  const l = levelOf(ctx.elements, el);
  return l ? [l.id] : [];
};
const inRoom: RelationshipResolver = (el, ctx) => {
  const r = roomOf(ctx.elements, el);
  return r ? [r.id] : [];
};

// ---------------------------------------------------------------- base fields

const markOf = (el: BimElement): string | null => ("mark" in el && typeof el.mark === "string" ? textOrNull(el.mark) : null);

function typeNameOf(elements: Elements, el: BimElement): string | null {
  if (el.kind === "part") {
    const t = elements[el.typeId];
    return t?.kind === "part_type" ? textOrNull(t.definition.typeName) : null;
  }
  if (el.kind === "wall") return textOrNull(el.wallType);
  if (el.kind === "beam") return textOrNull(el.sectionName);
  if ("typeName" in el && typeof el.typeName === "string") return textOrNull(el.typeName);
  return null;
}

function familyOf(elements: Elements, el: BimElement): string | null {
  if (el.kind !== "part") return null;
  const t = elements[el.typeId];
  return t?.kind === "part_type" ? textOrNull(t.definition.familyName) : null;
}

/** How a class's mark is typed in: parts through their parameters, load points through the point. */
function markWriter(registry: Registry, root: ClassId): FieldWriter {
  const recognized = registry.descendants(root).map((c) => registry.getClass(c)?.recognize);
  if (recognized.some((r) => (r?.partCategories?.length ?? 0) > 0)) return command("set_parameters", "mark");
  if (recognized.some((r) => r?.elementKinds?.includes("load_point"))) return command("edit_load_point", "mark");
  return locked("This kind of element has no mark to type in.");
}

const MOVE_LEVEL = "Move it to another level to change this.";
const ROOMS = "Worked out from the room it stands in.";

function baseFields(registry: Registry, roots: readonly ClassId[]): ProviderField[] {
  const out: ProviderField[] = [];
  for (const root of roots) {
    const classes = [root];
    const read = (f: (elements: Elements, el: BimElement) => string | null): FieldReader => (el, ctx) => f(ctx.elements, el);
    out.push(
      { path: "mark", label: "Mark", classes, valueType: "text", writer: markWriter(registry, root), group: "Identity", read: (el) => markOf(el) },
      { path: "type_name", label: "Type", classes, valueType: "text", writer: locked("Change its type to change this."), deps: { elementKinds: ["part_type"] }, group: "Identity", read: read(typeNameOf) },
      { path: "family", label: "Family", classes, valueType: "text", writer: locked("Change its type to change this."), deps: { elementKinds: ["part_type"] }, group: "Identity", read: read(familyOf) },
      { path: "level", label: "Level", classes, valueType: "text", writer: locked(MOVE_LEVEL), deps: { elementKinds: ["level"] }, group: "Location", read: read((els, el) => textOrNull(levelOf(els, el)?.name)) },
      {
        path: "room",
        label: "Room",
        classes,
        valueType: "text",
        writer: locked(ROOMS, "in_room"),
        deps: { elementKinds: ["room"] },
        group: "Location",
        read: read((els, el) => {
          const r = roomOf(els, el);
          return r ? roomText(r) : null;
        }),
      },
      { path: "count", label: "Count", classes, valueType: "quantity", kind: "count", unit: "ea", aggregation: "sum", writer: locked("Each row counts once."), group: "Quantities", read: () => 1 },
    );
  }
  return out;
}

/** Classes base fields never apply to: drawings and the containers other rows read through. */
const NOT_BASE = new Set<ClassId>(["gen.level", "mep.system"]);

const isBaseRoot = (cls: ObjectClass): boolean => cls.parent === undefined && cls.discipline !== "documentation" && !NOT_BASE.has(cls.id);

/** The base fields for every root class of `registry` that doesn't have them yet (a library's new classes). */
export function baseFieldProvider(registry: Registry): FieldProvider {
  const roots = registry
    .listClasses({ includeAbstract: true })
    .filter(isBaseRoot)
    .map((c) => c.id)
    .filter((id) => registry.field(id, "count") === undefined);
  return { id: `base:${roots.join(",") || "none"}`, fields: baseFields(registry, roots) };
}

/** `registry` with base fields on every class that lacks them. Run after layering a library's classes. */
export function withBaseFields(registry: Registry): Registry {
  const provider = baseFieldProvider(registry);
  return (provider.fields?.length ?? 0) === 0 ? registry : registry.extend().addProvider(provider).build();
}

// ---------------------------------------------------------------- site and levels (the building and structural classes' fields are their add-ons')

const buildingFields: ProviderField[] = [
  { path: "true_north", label: "True north", classes: ["civil.site"], valueType: "quantity", kind: "angle", unit: "deg", aggregation: "none", writer: locked("Set it in the project's coordinates."), group: "Coordinates", read: (el) => (el.kind === "site" ? finite(el.trueNorthDeg) : null) },
  { path: "name", label: "Level name", classes: ["gen.level"], valueType: "text", writer: locked("Rename the level in the model."), group: "Identity", read: (el) => (el.kind === "level" ? textOrNull(el.name) : null) },
  { path: "elevation", label: "Elevation", classes: ["gen.level"], valueType: "quantity", kind: "length", unit: "mm", aggregation: "none", writer: command("update_level", "elevationMm"), group: "Dimensions", read: (el) => (el.kind === "level" ? finite(el.elevationMm) : null) },
];

// ---------------------------------------------------------------- spaces, zones, underlays

const SPACE = ["gen.space"];
const ZONE = ["gen.zone"];
const UNDERLAY = ["doc.drawing_underlay"];
const AREA_FROM_GEOMETRY = "Area comes from the space's outline (or its rooms). Redraw it to change this.";

const asSpace = (el: BimElement): Space | null => (el.kind === "space" ? el : null);
const asZone = (el: BimElement): Zone | null => (el.kind === "zone" ? el : null);
const asUnderlay = (el: BimElement): DrawingUnderlay | null => (el.kind === "drawing_underlay" ? el : null);

function originText(elements: Elements, s: Space): string {
  const o = s.origin;
  switch (o.kind) {
    case "typed":
      return "Typed, not drawn yet";
    case "drawn":
      return "Drawn";
    case "traced": {
      const u = elements[o.underlayId];
      return `Traced over ${u?.kind === "drawing_underlay" ? u.source.name : "a drawing that was removed"}`;
    }
    case "from_room":
      return "From room";
    case "from_linked_room":
      return "From a linked model's room";
    case "detected":
      return o.accepted ? `Detected (${o.detector}), accepted` : `Proposed by ${o.detector}, not accepted yet`;
  }
}

function zoneNames(elements: Elements, s: Space): string | null {
  return textOrNull(zonesOfSpace(elements, s.id).map((z) => z.name).join(", "));
}

function serverMark(elements: Elements, id: ElementId | undefined): string | null {
  if (!id) return null;
  const el = elements[id];
  if (!el) return null;
  return "mark" in el && typeof el.mark === "string" && el.mark.trim() !== "" ? el.mark : id;
}

function zoneTotals(elements: Elements, z: Zone): { readonly areaM2: number; readonly occupants: number } {
  let areaM2 = 0;
  let occupants = 0;
  for (const s of spacesOfZone(elements, z.id)) {
    const b = spaceBasis(elements, s);
    areaM2 += b.areaM2 ?? 0;
    occupants += b.occupants ?? 0;
  }
  return { areaM2, occupants };
}

const spaceFields: ProviderField[] = [
  { path: "number", label: "Space number", classes: SPACE, valueType: "text", writer: command("edit_space", "number"), group: "Identity", read: (el) => textOrNull(asSpace(el)?.number) },
  { path: "name", label: "Space name", classes: SPACE, valueType: "text", writer: command("edit_space", "name"), group: "Identity", read: (el) => textOrNull(asSpace(el)?.name) },
  { path: "space_use", label: "Use", classes: SPACE, valueType: "text", writer: locked("Pick the use from the list in the Spaces panel; it brings its code rates with it."), group: "Use", read: (el) => { const s = asSpace(el); return s ? textOrNull(pinnedUse(s)?.name ?? null) : null; } },
  { path: "area", label: "Area", classes: SPACE, valueType: "quantity", kind: "area", unit: "m2", aggregation: "sum", writer: locked(AREA_FROM_GEOMETRY), deps: { elementKinds: ["room"] }, group: "Dimensions", read: (el, ctx) => (el.kind === "space" ? finite(spaceMeasure(ctx.elements, el.id)?.areaM2 ?? null) : null) },
  { path: "occupants", label: "Occupants", classes: SPACE, valueType: "quantity", kind: "occupants", unit: "occ", aggregation: "sum", writer: command("edit_space", "occupants"), deps: { elementKinds: ["room"] }, group: "Use", read: (el, ctx) => { const s = asSpace(el); return s ? finite(spaceBasis(ctx.elements, s).occupants) : null; } },
  { path: "occupants_basis", label: "Occupants from", classes: SPACE, valueType: "text", writer: locked("Type a number of occupants to override the use's default."), group: "Use", read: (el, ctx) => { const s = asSpace(el); if (!s) return null; const b = spaceBasis(ctx.elements, s).occupantsBasis; return b === "typed" ? "Typed" : b === "use_default" ? "Use default density" : null; } },
  { path: "ceiling_height", label: "Ceiling height", classes: SPACE, valueType: "quantity", kind: "length", unit: "mm", aggregation: "none", writer: command("edit_space", "ceilingHeightMm"), group: "Dimensions", read: (el) => finite(asSpace(el)?.ceilingHeightMm ?? null) },
  { path: "slab_to_slab", label: "Slab to slab", classes: SPACE, valueType: "quantity", kind: "length", unit: "mm", aggregation: "none", writer: command("edit_space", "slabToSlabMm"), group: "Dimensions", read: (el) => finite(asSpace(el)?.slabToSlabMm ?? null) },
  { path: "estimate_counting", label: "Estimates count", classes: SPACE, valueType: "text", writer: locked("Choose how estimates count in the space's Loads settings in the Spaces panel."), deps: { elementKinds: ["service_catalog"] }, group: "Use", description: "How the estimates on this space count once devices are placed in it: the space's own choice, else the model's.", read: (el, ctx) => { const s = asSpace(el); return s ? ALLOCATION_POLICY_LABELS[s.estimateCounting ?? allocationPolicyOf(ctx.elements)] : null; } },
  { path: "zones", label: "Zones", classes: SPACE, valueType: "text", writer: locked("Add the space to a zone in the Spaces panel."), deps: { elementKinds: ["zone"] }, group: "Location", read: (el, ctx) => { const s = asSpace(el); return s ? zoneNames(ctx.elements, s) : null; } },
  { path: "origin", label: "Made by", classes: SPACE, valueType: "text", writer: locked("How the outline was made; redraw or trace it to change this."), deps: { elementKinds: ["drawing_underlay"] }, group: "Identity", read: (el, ctx) => { const s = asSpace(el); return s ? originText(ctx.elements, s) : null; } },
  { path: "name", label: "Zone name", classes: ZONE, valueType: "text", writer: command("edit_zone", "name"), group: "Identity", read: (el) => textOrNull(asZone(el)?.name) },
  { path: "purpose", label: "Purpose", classes: ZONE, valueType: "text", writer: command("edit_zone", "purpose"), group: "Identity", read: (el) => { const z = asZone(el); return z ? z.purpose.replace(/^firm:/, "").replace(/_/g, " ") : null; } },
  { path: "space_count", label: "Spaces", classes: ZONE, valueType: "quantity", kind: "count", unit: "ea", aggregation: "sum", writer: locked("Add or remove spaces in the Spaces panel."), group: "Quantities", read: (el) => (el.kind === "zone" ? el.spaceIds.length : null) },
  { path: "area", label: "Area", classes: ZONE, valueType: "quantity", kind: "area", unit: "m2", aggregation: "sum", writer: locked("The sum of its spaces' areas."), deps: { elementKinds: ["space", "room"] }, group: "Dimensions", read: (el, ctx) => { const z = asZone(el); return z ? finite(zoneTotals(ctx.elements, z).areaM2) : null; } },
  { path: "occupants", label: "Occupants", classes: ZONE, valueType: "quantity", kind: "occupants", unit: "occ", aggregation: "sum", writer: locked("The sum of its spaces' occupants."), deps: { elementKinds: ["space", "room"] }, group: "Quantities", read: (el, ctx) => { const z = asZone(el); return z ? finite(zoneTotals(ctx.elements, z).occupants) : null; } },
  { path: "served_by", label: "Served by", classes: ZONE, valueType: "text", writer: locked("Assign the zone to equipment in the Spaces panel."), deps: { elementKinds: ["part"], sources: true }, group: "Service", read: (el, ctx) => { const z = asZone(el); return z ? serverMark(ctx.elements, z.servedBy) : null; } },
  { path: "name", label: "Drawing", classes: UNDERLAY, valueType: "text", writer: locked("Replace the underlay to change its file."), group: "Identity", read: (el) => textOrNull(asUnderlay(el)?.source.name) },
  { path: "calibrated", label: "Calibrated", classes: UNDERLAY, valueType: "boolean", writer: locked("Calibrate it on the plan: two points and a distance, or the printed scale."), group: "Identity", read: (el) => { const u = asUnderlay(el); return u ? isCalibrated(u) : null; } },
];

const inSpace: RelationshipResolver = (el, ctx) => {
  const s = spaceOf(ctx.elements, el.id);
  return s && s.id !== el.id ? [s.id] : [];
};

const spaceMembersOf = new WeakMap<Elements, ReadonlyMap<string, readonly ElementId[]>>();

/** Parts and loads by the space they are in, once per model state (parts and load points only, read by kind). */
function spaceMembers(target: BimElement, elements: Elements): readonly ElementId[] {
  if (target.kind !== "space") return [];
  let index = spaceMembersOf.get(elements);
  if (!index) {
    const map = new Map<string, ElementId[]>();
    for (const el of elementsOfKind(elements, "part", "load_point")) {
      const s = spaceOf(elements, el.id);
      if (!s) continue;
      const list = map.get(s.id);
      if (list) list.push(el.id);
      else map.set(s.id, [el.id]);
    }
    index = map;
    spaceMembersOf.set(elements, index);
  }
  return index.get(target.id) ?? [];
}

const inZone: RelationshipResolver = (el, ctx) => {
  const s = el.kind === "space" ? el : spaceOf(ctx.elements, el.id);
  return s ? zonesOfSpace(ctx.elements, s.id).map((z) => z.id) : [];
};

const zoneMembers: RelationshipResolver = (el, ctx) => (el.kind === "zone" ? spacesOfZone(ctx.elements, el.id).map((s) => s.id) : []);

/** "101 Kitchen". */
export function spaceText(s: Space): string {
  return spaceLabel(s);
}

export const SPATIAL_FIELD_PROVIDER: FieldProvider = {
  id: "base.spatial",
  fields: [...buildingFields, ...spaceFields],
  resolvers: {
    on_level: onLevel,
    in_space: inSpace,
    space_members: (el, ctx) => spaceMembers(el, ctx.elements),
    in_zone: inZone,
    zone_members: zoneMembers,
    zone_served_by: (el) => (el.kind === "zone" && el.servedBy ? [el.servedBy] : []),
    serves_zones: (el, ctx) => zonesServedBy(ctx.elements, el.id).map((z) => z.id),
    level_members: (el, ctx) => levelMembers(el, ctx.elements),
    in_room: inRoom,
    contains: (el, ctx) => roomMembers(el, ctx.elements),
  },
};
