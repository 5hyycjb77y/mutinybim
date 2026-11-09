/**
 * Everything a linked IFC knows about one element, grouped the way Revit
 * shows it: the element's own property sets (instance values), its type's
 * property sets (type values), quantity sets, the systems it belongs to and
 * its connection ports. Reads Fragments item data; no three.js here.
 */
import type { ItemAttribute, ItemData, ItemsDataConfig } from "@thatopen/fragments";

export interface PropertyRow {
  readonly name: string;
  readonly value: string;
}

export interface PropertyGroup {
  readonly name: string;
  /** "instance" = set on this element; "type" = shared by every element of its type. */
  readonly source: "instance" | "type";
  readonly kind: "properties" | "quantities";
  readonly rows: readonly PropertyRow[];
}

export interface ReferenceItemProperties {
  readonly name: string | null;
  readonly ifcClass: string | null;
  /** The element's own IFC attributes (GlobalId, Tag, ObjectType, PredefinedType...). */
  readonly attributes: readonly PropertyRow[];
  readonly typeName: string | null;
  readonly typeClass: string | null;
  readonly groups: readonly PropertyGroup[];
  readonly systems: readonly string[];
  readonly ports: readonly PropertyRow[];
  /** The space or level that contains the element. */
  readonly container: string | null;
}

/** Fragments' getItemsData, sync (single-threaded model) or async (worker-backed model). */
export type ItemsDataReader = (ids: number[], config: Partial<ItemsDataConfig>) => ItemData[] | Promise<ItemData[]>;

const LEAF = { attributes: true, relations: false } as const;

/**
 * Fragments lets a relation missing from the config inherit its parent's
 * setting, so following a type object recursively also follows its link back
 * to every element of that type (465 pipe segments on 7301). Every query here
 * reads one level with leaf relations only, and the reader walks the levels.
 */
function leafQuery(...relations: string[]): Partial<ItemsDataConfig> {
  return {
    attributesDefault: true,
    relationsDefault: { attributes: false, relations: false },
    relations: Object.fromEntries(relations.map((r) => [r, LEAF])),
  };
}

const ELEMENT_QUERY = leafQuery("IsDefinedBy", "IsTypedBy", "IsNestedBy", "HasAssignments", "ContainedInStructure");
const MEMBER_RELATIONS = ["HasPropertySets", "HasProperties", "Quantities", "HasQuantities"] as const;
const SET_QUERY = leafQuery(...MEMBER_RELATIONS, "ConnectedTo", "ConnectedFrom");
/** Containers whose members live one level further down (type -> set -> complex property -> ...). */
const CONTAINER_CLASSES = new Set(["IFCPROPERTYSET", "IFCELEMENTQUANTITY", "IFCCOMPLEXPROPERTY", "IFCPHYSICALCOMPLEXQUANTITY"]);
const MAX_DEPTH = 5;

const OWN_ATTRIBUTES = ["GlobalId", "Tag", "ObjectType", "PredefinedType", "Description"] as const;
/** IFC4 and 4.3 group entities an element can be assigned to; `IFCBUILTSYSTEM` is 4.3's name for `IFCBUILDINGSYSTEM`. */
export const SYSTEM_CLASSES: ReadonlySet<string> = new Set(["IFCDISTRIBUTIONSYSTEM", "IFCDISTRIBUTIONCIRCUIT", "IFCSYSTEM", "IFCBUILDINGSYSTEM", "IFCBUILTSYSTEM", "IFCZONE", "IFCSPATIALZONE"]);
const VALUE_KEYS = [
  "NominalValue",
  "EnumerationValues",
  "ListValues",
  "LengthValue",
  "AreaValue",
  "VolumeValue",
  "CountValue",
  "WeightValue",
  "TimeValue",
] as const;

const EMPTY: ReferenceItemProperties = {
  name: null,
  ifcClass: null,
  attributes: [],
  typeName: null,
  typeClass: null,
  groups: [],
  systems: [],
  ports: [],
  container: null,
};

/** Read one linked element's properties, walking property sets, type sets, quantities and ports level by level. */
export async function readReferenceItem(read: ItemsDataReader, localId: number): Promise<ReferenceItemProperties> {
  const [element] = await read([localId], ELEMENT_QUERY);
  if (!element || category(element) === null) return EMPTY;

  const expanded = new Map<number, ItemData>();
  let frontier = uniqueIds([...linked(element, "IsDefinedBy"), ...linked(element, "IsTypedBy"), ...linked(element, "IsNestedBy")]);
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const items = await read(frontier, SET_QUERY);
    const next: ItemData[] = [];
    items.forEach((item, i) => {
      const id = frontier[i];
      if (id === undefined) return;
      expanded.set(id, item);
      for (const rel of MEMBER_RELATIONS) next.push(...linked(item, rel).filter((m) => CONTAINER_CLASSES.has(category(m) ?? "")));
    });
    frontier = uniqueIds(next).filter((id) => !expanded.has(id));
  }

  return assemble(element, (item, rel) => linked(item, rel).map((child) => expanded.get(localIdOf(child) ?? -1) ?? child));
}

type Related = (item: ItemData, relation: string) => ItemData[];

function assemble(item: ItemData, related: Related): ReferenceItemProperties {
  const groups: PropertyGroup[] = [];
  let typeItem: ItemData | null = null;
  for (const def of [...related(item, "IsDefinedBy"), ...related(item, "IsTypedBy")]) {
    const cls = category(def);
    if (cls === "IFCPROPERTYSET" || cls === "IFCELEMENTQUANTITY") {
      const group = toGroup(def, "instance", related);
      if (group) groups.push(group);
    } else if (cls?.endsWith("TYPE") || related(def, "HasPropertySets").length > 0) {
      typeItem = def;
    }
  }
  if (typeItem) {
    for (const set of related(typeItem, "HasPropertySets")) {
      const group = toGroup(set, "type", related);
      if (group) groups.push(group);
    }
  }
  groups.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === "instance" ? -1 : 1));

  const attributes: PropertyRow[] = [];
  for (const key of OWN_ATTRIBUTES) {
    const value = text(item, key);
    if (value !== null) attributes.push({ name: key, value });
  }

  const systems = related(item, "HasAssignments")
    .filter((g) => SYSTEM_CLASSES.has(category(g) ?? ""))
    .map((g) => [text(g, "Name"), text(g, "ObjectType")].filter((s): s is string => !!s).join(" · "))
    .filter((s) => s.length > 0);

  const ports = related(item, "IsNestedBy")
    .filter((p) => category(p) === "IFCDISTRIBUTIONPORT")
    .map((p) => {
      const connected = linked(p, "ConnectedTo").length + linked(p, "ConnectedFrom").length > 0;
      const detail = [text(p, "FlowDirection"), text(p, "PredefinedType"), text(p, "SystemType")]
        .filter((s): s is string => !!s && s !== "NOTDEFINED")
        .map((s) => s.toLowerCase())
        .join(" ");
      return { name: text(p, "Name") ?? "Port", value: `${detail}${detail ? " · " : ""}${connected ? "connected" : "not connected"}` };
    });

  return {
    name: text(item, "Name"),
    ifcClass: category(item),
    attributes,
    typeName: typeItem ? text(typeItem, "Name") : null,
    typeClass: typeItem ? category(typeItem) : null,
    groups,
    systems,
    ports,
    container: describeContainer(related(item, "ContainedInStructure")[0]),
  };
}

function describeContainer(container: ItemData | undefined): string | null {
  if (!container) return null;
  const name = text(container, "Name");
  if (category(container) === "IFCSPACE") {
    const label = [name, text(container, "LongName")].filter((s): s is string => !!s).join(" · ");
    return label ? `Space ${label}` : "Space";
  }
  if (category(container) === "IFCSPATIALZONE") return name ? `Zone ${name}` : "Zone";
  return name;
}

function toGroup(set: ItemData, source: PropertyGroup["source"], related: Related): PropertyGroup | null {
  const cls = category(set);
  const kind = cls === "IFCELEMENTQUANTITY" ? "quantities" : cls === "IFCPROPERTYSET" ? "properties" : null;
  if (!kind) return null;
  const members = kind === "quantities" ? related(set, "Quantities") : related(set, "HasProperties");
  const rows = members.flatMap((m) => rowsOf(m, "", related));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { name: text(set, "Name") ?? "(unnamed set)", source, kind, rows };
}

function rowsOf(member: ItemData, prefix: string, related: Related): PropertyRow[] {
  // A link to an entity the conversion did not keep arrives with no attributes at all.
  if (category(member) === null && text(member, "Name") === null) return [];
  const name = `${prefix}${text(member, "Name") ?? "(unnamed)"}`;
  const nested = [...related(member, "HasProperties"), ...related(member, "HasQuantities")];
  if (nested.length > 0) return nested.flatMap((n) => rowsOf(n, `${name} / `, related));
  const lower = text(member, "LowerBoundValue");
  const upper = text(member, "UpperBoundValue");
  if (lower !== null || upper !== null) return [{ name, value: `${lower ?? "…"} – ${upper ?? "…"}` }];
  const defining = values(member, "DefiningValues");
  const defined = values(member, "DefinedValues");
  if (defining.length > 0) return [{ name, value: defining.map((d, i) => `${d} → ${defined[i] ?? ""}`).join("; ") }];
  for (const key of VALUE_KEYS) {
    const value = text(member, key);
    if (value !== null) return [{ name, value }];
  }
  return [{ name, value: "" }];
}

function linked(item: ItemData, relation: string): ItemData[] {
  const value = item[relation];
  return Array.isArray(value) ? value : [];
}

function uniqueIds(items: readonly ItemData[]): number[] {
  return [...new Set(items.map(localIdOf).filter((id): id is number => id !== null))];
}

function attribute(item: ItemData, key: string): ItemAttribute | null {
  const value = item[key];
  if (value === undefined || Array.isArray(value)) return null;
  return value;
}

function localIdOf(item: ItemData): number | null {
  const value = attribute(item, "_localId")?.value;
  return typeof value === "number" ? value : null;
}

function category(item: ItemData): string | null {
  const value = attribute(item, "_category")?.value;
  return typeof value === "string" ? value.toUpperCase() : null;
}

function values(item: ItemData, key: string): string[] {
  const attr = attribute(item, key);
  const raw: unknown = attr?.value;
  if (raw === null || raw === undefined) return [];
  const logical = /BOOLEAN|LOGICAL/i.test(attr?.type ?? "");
  return (Array.isArray(raw) ? raw : [raw]).map((v) => format(v, logical)).filter((s): s is string => s !== null);
}

function text(item: ItemData, key: string): string | null {
  const parts = values(item, key);
  return parts.length > 0 ? parts.join(", ") : null;
}

function format(value: unknown, logical: boolean): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
  if (typeof value === "string") {
    if (logical && (value === "T" || value === "F")) return value === "T" ? "Yes" : "No";
    return value;
  }
  if (typeof value === "object" && "value" in value) return format(Reflect.get(value, "value"), logical);
  return null;
}
