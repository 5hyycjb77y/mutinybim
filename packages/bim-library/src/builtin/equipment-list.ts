import { BUILTIN_FACET_REGISTRY, facetLabel, facetOfGroup, groupParametersByFacet, isRegistryIdShape, unknownGroupId, type FacetRegistry, type ScheduleColumnDef, type ScheduleDefinitionV2 } from "@permitzip/bim-kernel";
import type { ScheduleTemplateItem, SharedFieldItem } from "../schema";
import { BASELINE_PARAMETER_SETS } from "./parameter-sets";

/**
 * The equipment list as a schedule template (NEXT-BATCH 5b-2, MIGRATION-PLAN
 * §6): an ordinary v2 schedule over equipment and fixtures whose columns are
 * parameters, in one column group per facet. Today's thirteen columns (the
 * eleven a vendor sheet pastes into, plus placement, load class and circuit)
 * are the default columns, with the same ids, headings and order; the
 * baseline parameter sets add theirs, hidden until a row has a value; firm
 * and project fields add theirs to the facet their group names, matched in a
 * facet registry (data, FOUNDATION adjustments D1). Each column group is
 * known by its facet id (`equipmentListColumnGroups`), never a guess.
 *
 * A column names the part parameter by its storage name (`mca`), which every
 * host reads straight off the part type the model holds, with no library
 * (the in-app grid and the model server open the list over the kernel's
 * fields). The parameter's key (`elec.mca`) and its alias (`param.mca`) are
 * the library's names for the same value (apply.ts).
 */

export const EQUIPMENT_LIST_CLASSES = ["mep.mechanical_equipment", "mep.plumbing_fixture"] as const;

/** The columns a pasted vendor sheet fills, in the paste grid's order. */
export const EQUIPMENT_DRAFT_FIELDS = ["mark", "description", "quantity", "voltage", "phase", "load", "gasMbh", "coldWater", "hotWater", "waste", "connection"] as const;
export type EquipmentDraftField = (typeof EQUIPMENT_DRAFT_FIELDS)[number];

/**
 * The default mapping: which parameter each pasted column fills. `parameter`
 * is the part parameter name the listed item stores; `quantity` makes one
 * planned item per unit instead of a value, and `load` is read (kW, VA, A or
 * hp) into `load_va`.
 */
export const EQUIPMENT_DRAFT_PARAMETERS: Readonly<Record<EquipmentDraftField, { readonly key: string; readonly parameter: string | null; readonly label: string }>> = {
  mark: { key: "core.mark", parameter: null, label: "Mark" },
  description: { key: "core.description", parameter: "description", label: "Description" },
  quantity: { key: "core.count", parameter: null, label: "Qty" },
  voltage: { key: "elec.voltage", parameter: "voltage", label: "Volts" },
  phase: { key: "elec.phases", parameter: "phases", label: "Phase" },
  load: { key: "elec.load_va", parameter: "load_va", label: "Load (kW, VA, A or hp)" },
  gasMbh: { key: "gas.input_mbh", parameter: "input_mbh", label: "Gas MBH" },
  coldWater: { key: "plumb.cw_size", parameter: "cw_size", label: "CW" },
  hotWater: { key: "plumb.hw_size", parameter: "hw_size", label: "HW" },
  waste: { key: "plumb.waste_size", parameter: "waste_size", label: "Waste" },
  connection: { key: "core.connection", parameter: "connection", label: "Connection" },
};

/** A column of the equipment list and the column group it sits in. */
export interface EquipmentListColumn {
  /** The group's stored id: a facet id (`electrical`), `other:<words>` for a group the registry doesn't know, `other:other` for none. */
  readonly facet: string;
  readonly column: ScheduleColumnDef;
}

/** A column before it has a group id: the group it names (a facet id or label; absent: ungrouped). */
interface Grouped {
  readonly group?: string;
  readonly column: ScheduleColumnDef;
}

const field = (id: string, heading: string, group: string): Grouped => ({ group, column: { id, kind: "field", path: id, heading } });
const param = (id: string, heading: string, group: string): Grouped => ({ group, column: { id, kind: "parameter", path: id, heading, hideWhenEmpty: true } });

/** Today's thirteen columns, as the Equipment list has always printed them, each naming its facet by id. Connection (how it hooks up) is ungrouped, read last. */
const DEFAULT_COLUMNS: readonly Grouped[] = [
  field("mark", "MARK", "identity"),
  param("description", "DESCRIPTION", "identity"),
  field("placement", "PLACEMENT", "identity"),
  param("voltage", "ELEC VOLTS", "electrical"),
  param("phases", "ELEC PHASE", "electrical"),
  param("load_va", "ELEC LOAD (VA)", "electrical"),
  param("load_class", "ELEC CLASS", "electrical"),
  param("circuit", "ELEC CIRCUIT", "electrical"),
  param("input_mbh", "GAS MBH", "gas"),
  param("cw_size", "CW", "water"),
  param("hw_size", "HW", "water"),
  param("waste_size", "WASTE", "drainage"),
  { column: { id: "connection", kind: "parameter", path: "connection", heading: "CONNECTION", hideWhenEmpty: true } },
];

/** The stored group id of a group name, under a facet registry. */
function groupIdOf(group: string | undefined, facets: FacetRegistry): string {
  return facetOfGroup(group, facets)?.id ?? unknownGroupId(group?.trim() || "Other");
}

export const EQUIPMENT_DEFAULT_COLUMNS: readonly EquipmentListColumn[] = DEFAULT_COLUMNS.map((c) => ({ facet: groupIdOf(c.group, BUILTIN_FACET_REGISTRY), column: c.column }));

/** A library field the list can show: a part parameter (by its storage name) with a label and group. */
export interface EquipmentFieldColumn {
  readonly name: string;
  readonly label: string;
  readonly group?: string;
  readonly key?: string;
}

/** A shared-field library item as an equipment list column, or null when it isn't stored as a part parameter. */
export function equipmentFieldColumn(item: Pick<SharedFieldItem, "key" | "label" | "group" | "storage">): EquipmentFieldColumn | null {
  if (item.storage.kind !== "parameter") return null;
  return { name: item.storage.name, label: item.label, key: item.key, ...(item.group === undefined ? {} : { group: item.group }) };
}

/** The baseline parameter sets' own parameters that apply to equipment or fixtures, as columns. */
export function baselineEquipmentFields(): EquipmentFieldColumn[] {
  const out: EquipmentFieldColumn[] = [];
  for (const set of BASELINE_PARAMETER_SETS) {
    for (const { field: f } of set.parameters) {
      if (!f.appliesTo.some((c) => c === "mep.equipment" || (EQUIPMENT_LIST_CLASSES as readonly string[]).includes(c))) continue;
      const col = equipmentFieldColumn(f);
      if (col) out.push(col);
    }
  }
  return out;
}

function groupedFor(f: EquipmentFieldColumn): Grouped {
  return { ...(f.group === undefined ? {} : { group: f.group }), column: { id: f.name, kind: "parameter", path: f.name, heading: f.label.toUpperCase(), hideWhenEmpty: true } };
}

/**
 * The columns in column-group order (facet registry order, then the firm's
 * own groups, then ungrouped): defaults first in each group, then the added
 * fields in the order given. A field whose parameter a column already shows
 * is not added twice.
 */
export function equipmentListColumns(extra: readonly EquipmentFieldColumn[] = baselineEquipmentFields(), facets: FacetRegistry = BUILTIN_FACET_REGISTRY): EquipmentListColumn[] {
  const taken = new Set(DEFAULT_COLUMNS.map((c) => c.column.id));
  const added: Grouped[] = [];
  for (const f of extra) {
    if (taken.has(f.name)) continue;
    taken.add(f.name);
    added.push(groupedFor(f));
  }
  return groupParametersByFacet([...DEFAULT_COLUMNS, ...added], facets).flatMap((g) => g.items.map((c) => ({ facet: g.id, column: c.column })));
}

/** A column group as a template stores it: the facet id and the columns in it, in order. */
export interface EquipmentColumnGroup {
  readonly facet: string;
  readonly columns: readonly string[];
}

/** The column groups of a column list, in order (what a template stores per group). */
export function equipmentListColumnGroups(columns: readonly EquipmentListColumn[]): EquipmentColumnGroup[] {
  const out: { facet: string; columns: string[] }[] = [];
  for (const c of columns) {
    const last = out[out.length - 1];
    if (last && last.facet === c.facet) last.columns.push(c.column.id);
    else out.push({ facet: c.facet, columns: [c.column.id] });
  }
  return out;
}

/** A stored column group's heading: the facet's label, else the stored id's raw words (a newer peer's facet, a firm group). */
export function columnGroupLabel(facet: string, facets: FacetRegistry = BUILTIN_FACET_REGISTRY): string {
  return facetLabel(facet, facets);
}

/**
 * Column groups read back from a stored definition: tolerant (any id of the
 * registry id shape is kept as stored, known or not); anything malformed is
 * left out. Null when the definition stores none.
 */
export function readColumnGroups(value: unknown): EquipmentColumnGroup[] | null {
  if (!Array.isArray(value)) return null;
  const out: EquipmentColumnGroup[] = [];
  for (const g of value) {
    if (typeof g !== "object" || g === null || !("facet" in g) || !("columns" in g)) continue;
    const { facet, columns } = g;
    if (!isRegistryIdShape(facet) || !Array.isArray(columns)) continue;
    out.push({ facet, columns: columns.filter((c): c is string => typeof c === "string") });
  }
  return out;
}

/** The equipment list definition: the baseline columns plus any firm and project fields. */
export function equipmentListDefinition(extra: readonly EquipmentFieldColumn[] = [], facets: FacetRegistry = BUILTIN_FACET_REGISTRY): ScheduleDefinitionV2 {
  return {
    name: "Equipment list",
    source: { kind: "classes", classes: [...EQUIPMENT_LIST_CLASSES], includeSubclasses: true },
    columns: equipmentListColumns([...baselineEquipmentFields(), ...extra], facets).map((c) => c.column),
    filters: [],
    sort: [{ path: "mark", direction: "asc" }],
    groups: [],
    grandTotals: false,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.5, emptyText: "NONE" },
  };
}

/**
 * A schedule that already exists with one more field column, placed after
 * the last column of the field's group (or of an earlier group). Each
 * existing column's group comes from the groups the definition stores, else
 * from the built-in columns' own groups; a column neither knows, and a
 * person's own order, stay where they are. Null when the column is already
 * there.
 */
export function withEquipmentColumn(def: ScheduleDefinitionV2, f: EquipmentFieldColumn, facets: FacetRegistry = BUILTIN_FACET_REGISTRY): ScheduleDefinitionV2 | null {
  if (def.columns.some((c) => c.id === f.name || ((c.kind === "parameter" || c.kind === "field") && c.path === f.name))) return null;
  const all = equipmentListColumns([...baselineEquipmentFields(), f], facets);
  const order = new Map<string, number>();
  for (const c of all) if (!order.has(c.facet)) order.set(c.facet, order.size);
  const stored = readColumnGroups("columnGroups" in def ? def.columnGroups : undefined);
  const groupOf = new Map<string, string>(all.map((c) => [c.column.id, c.facet]));
  for (const g of stored ?? []) for (const id of g.columns) groupOf.set(id, g.facet);
  const mine = groupIdOf(f.group, facets);
  const rank = (facet: string | undefined): number | undefined => (facet === undefined ? undefined : order.get(facet));
  const want = rank(mine) ?? Number.POSITIVE_INFINITY;
  let at = def.columns.length;
  for (let i = def.columns.length - 1; i >= 0; i--) {
    const id = def.columns[i]?.id;
    const r = rank(id === undefined ? undefined : groupOf.get(id));
    if (r !== undefined && r <= want) {
      at = i + 1;
      break;
    }
  }
  const column = groupedFor(f).column;
  return { ...def, columns: [...def.columns.slice(0, at), column, ...def.columns.slice(at)] };
}

/** The equipment list as a built-in schedule template item (New schedule… and the library browser list it). */
export const EQUIPMENT_LIST_TEMPLATE: ScheduleTemplateItem = {
  id: "aec:schedule_template:equipment_list",
  revision: 1,
  key: "equipment_list",
  name: "Equipment list",
  description: "Every piece of equipment and fixture, planned and placed, in one column group per facet: identity, electrical, gas, water, drainage, mechanical, structural, then the firm's and the project's own fields.",
  definition: { ...equipmentListDefinition() },
};
