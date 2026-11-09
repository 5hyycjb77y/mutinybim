import { z } from "zod";
import { CLASS_ID_PATTERN, ELEMENT_KINDS, FIELD_PATH_PATTERN, PART_CATEGORIES, RELATIONSHIP_ID_PATTERN, isRegistryIdShape } from "@permitzip/bim-kernel";
import { KIND_IDS, UNIT_CODES } from "@permitzip/bim-units";
import { CONTENT_HASH_PATTERN, ITEM_ID_PATTERN, itemBase, text } from "./item-base";
import { partTypeItemSchema, type PartTypeItem } from "./items/part-type";
import { scriptItemSchema, type ScriptItem } from "./items/script";
import { designLimitItemSchema, type DesignLimitItem } from "./items/design-limit";
import { lookupTableItemSchema, type LookupTableItem } from "./items/lookup-table";
import { elementTypeItemSchema, type ElementTypeItem } from "./items/element-type";
import { keynoteTableItemSchema, titleBlockItemSchema, type KeynoteTableItem, type TitleBlockItem } from "./items/sheet-items";

export { CONTENT_HASH_PATTERN, ITEM_ID_PATTERN };

/**
 * `mutinybim-library` v1 (SCHEDULES-PLAN §3a): a versioned bundle of display
 * profiles, object classes, shared fields, named calculations, relationships,
 * schedule templates and tag types. Plain JSON, so a firm can keep one in a
 * folder, a repository or a database and every host reads it the same way.
 *
 * Every item carries a stable `id` (a uuid, or any string that never changes
 * for that item), a `revision` that increases on every published change, and
 * a `contentHash` of its content (computed on load when a hand-written file
 * leaves it out; refused when present and wrong). `key` is the name the rest
 * of the model uses: a class id, a field path, a calculation's name.
 */

export const LIBRARY_FORMAT = "mutinybim-library";
export const LIBRARY_FORMAT_VERSION = 1;
/** The library engine version a bundle's `requires.mutinybim` is checked against. */
export const MUTINYBIM_LIBRARY_ENGINE_VERSION = "0.1.0";

/** `PZ.GasDemandBtuh`: a publisher prefix, a dot, a name. */
export const CALCULATION_KEY_PATTERN = /^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

const classId = z.string().regex(CLASS_ID_PATTERN, "a namespaced class id such as mep.water_heater");
const unitCode = z.enum(UNIT_CODES);
const kindName = z.enum(KIND_IDS);

/** A stored discipline id (registry shape); whether the model knows it is checked when a model uses the item. */
const disciplineId = z.string().refine(isRegistryIdShape, "a discipline id such as mechanical, fire_alarm or firm:low_voltage");

const scalar = z.union([z.string().max(400), z.number().finite(), z.boolean()]);

const labelPlacement = z.enum(["suffix", "heading", "none"]);

/** A units-library `DisplayProfile` as a library item (`key` is the profile's id). */
export const displayProfileItemSchema = z.object({
  ...itemBase,
  key: text(80),
  name: text(120),
  /** Per quantity kind: the unit it shows in and how. Kinds left out show in their default unit. */
  kinds: z.partialRecord(
    kindName,
    z.object({
      unit: unitCode,
      precision: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("decimals"), digits: z.number().int().min(0).max(10) }),
        z.object({ kind: z.literal("fraction"), denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]) }),
      ]),
      format: z.enum(["decimal", "feet_inches", "inches_fraction", "station"]).optional(),
      label: labelPlacement.optional(),
    }),
  ),
  label: labelPlacement,
  thousands: z.enum([",", ".", " ", ""]),
  decimal: z.enum([".", ","]),
});

const recognitionSchema = z.object({
  elementKinds: z.array(z.enum(ELEMENT_KINDS)).max(20).optional(),
  partCategories: z.array(z.enum(PART_CATEGORIES)).max(20).optional(),
  where: z
    .array(
      z.object({
        path: text(80),
        op: z.enum(["present", "absent", "equals", "not_equals", "contains", "in"]),
        value: z.union([scalar, z.array(scalar).max(50)]).optional(),
      }),
    )
    .max(10)
    .optional(),
});

export const classItemSchema = z.object({
  ...itemBase,
  key: classId,
  label: text(80),
  /** A registered discipline id: a built-in or add-on row (`mechanical`, `fire_alarm`) or the firm's own (`firm:low_voltage`). */
  discipline: disciplineId,
  parent: classId.optional(),
  abstract: z.boolean().optional(),
  ifc: z.object({ entity: text(80), predefinedType: text(80).optional(), objectType: text(80).optional(), typeEntity: text(80).optional(), schema: text(40).optional() }).optional(),
  recognize: recognitionSchema.optional(),
  /** The category its instances draw under (`electrical_devices`, another class). Absent: the kernel's mapping, then its parent. */
  drawsUnder: z.string().refine(isRegistryIdShape, "a category id such as electrical_devices or fp.sprinkler_head").optional(),
  /** The symbol its instances draw in plans (a symbol registry row id). */
  symbolId: z.string().refine(isRegistryIdShape, "a symbol id such as elec_receptacle or firm:smoke_detector").optional(),
  /** True: this item knowingly replaces a class a lower layer (or the kernel) defines with the same key. */
  replaces: z.boolean().optional(),
});

export const sharedFieldItemSchema = z.object({
  ...itemBase,
  /** The field path, e.g. `k_factor` or `seismic_restraint_required`. */
  key: z.string().regex(FIELD_PATH_PATTERN, "a lower_snake_case field path"),
  label: text(80),
  appliesTo: z.array(classId).min(1).max(50),
  valueType: z.enum(["quantity", "text", "boolean", "choice"]),
  kind: kindName.optional(),
  unit: unitCode.optional(),
  choices: z.array(text(80)).min(1).max(100).optional(),
  default: scalar.optional(),
  group: text(60).optional(),
  editable: z.boolean(),
  /**
   * Where the value lives: a part parameter (`parameter`), a field provider
   * reads it (`provided`), or the element's own `values` under the key, over
   * its element type's (`values`: walls, rooms, beams and the other building
   * kinds, written with `set_element_values`).
   */
  storage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("parameter"), scope: z.enum(["instance", "type"]), name: z.string().regex(/^[a-z][a-z0-9_]*$/) }),
    z.object({ kind: z.literal("provided") }),
    z.object({ kind: z.literal("values") }),
  ]),
  /** Other keys the same value was stored or referenced under (a bare key before it was namespaced). Readers resolve them; writers store `key`. */
  aliases: z.array(z.string().regex(FIELD_PATH_PATTERN)).max(5).optional(),
});

const exampleValueSchema = z.union([scalar, z.object({ value: z.number().finite(), unit: unitCode })]);

const operandTypeSchema = z.discriminatedUnion("valueType", [
  z.object({ valueType: z.literal("quantity"), kind: kindName, unit: unitCode }),
  z.object({ valueType: z.literal("text") }),
  z.object({ valueType: z.literal("boolean") }),
]);

export const calculationItemSchema = z.object({
  ...itemBase,
  key: z.string().regex(CALCULATION_KEY_PATTERN, "a name such as PZ.GasDemandBtuh"),
  name: text(120),
  expression: text(4000),
  /** Named inputs, read bare by name in the expression (`mbh * 0.8`, the formula engine's syntax). `{path}` is always a field of the classes it applies to. */
  params: z
    .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), type: operandTypeSchema }))
    .max(20)
    .optional(),
  result: operandTypeSchema,
  appliesTo: z.array(classId).max(50),
  /** Run as tests on load and on publish; one failure refuses the whole bundle. */
  examples: z
    .array(
      z.object({
        inputs: z.record(z.string().max(120), exampleValueSchema),
        expected: exampleValueSchema,
        /** Relative. Absent: 1e-9. */
        tolerance: z.number().min(0).max(1).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export const relationshipItemSchema = z.object({
  ...itemBase,
  key: z.string().regex(RELATIONSHIP_ID_PATTERN),
  label: text(80),
  inverseKey: z.string().regex(RELATIONSHIP_ID_PATTERN),
  inverseLabel: text(80),
  from: z.union([z.literal("any"), z.array(classId).min(1).max(50)]),
  to: z.union([z.literal("any"), z.array(classId).min(1).max(50)]),
  cardinality: z.enum(["one", "many"]),
  inverseCardinality: z.enum(["one", "many"]),
  traversal: z.enum(["direct", "path"]),
});

/** A schedule type. `definition` is ScheduleDefinition v2 minus model-bound ids; the schedule engine validates it. */
export const scheduleTemplateItemSchema = z.object({
  ...itemBase,
  key: text(120),
  name: text(120),
  discipline: disciplineId.optional(),
  definition: z.record(z.string(), z.unknown()),
});

/**
 * A firm's own discipline (contract 1.5.0 `kernel.discipline`): `firm:<slug>`,
 * optionally under a registered parent (`firm:low_voltage` under
 * `electrical`). Its default responsible role only suggests whom to name.
 */
export const disciplineItemSchema = z.object({
  ...itemBase,
  key: z.string().regex(/^firm:[a-z0-9][a-z0-9_]*$/, "a firm discipline id such as firm:low_voltage"),
  label: text(80),
  parent: disciplineId.optional(),
  group: z.object({ id: z.string().refine(isRegistryIdShape, "a group id such as mep"), label: text(60) }).optional(),
  colour: z.string().regex(/^#[0-9a-f]{6}$/, "a colour as #rrggbb"),
  icon: text(60).optional(),
  defaultResponsibleRole: text(120).optional(),
});

/** A tag type; `definition` is the tag engine's (same field and formula model). */
export const tagTypeItemSchema = z.object({
  ...itemBase,
  key: text(120),
  name: text(120),
  appliesTo: z.array(classId).max(50),
  definition: z.record(z.string(), z.unknown()),
});

export const libraryBundleSchema = z.object({
  format: z.literal(LIBRARY_FORMAT),
  version: z.literal(LIBRARY_FORMAT_VERSION),
  id: z.string().regex(ITEM_ID_PATTERN),
  name: text(120),
  publisher: text(120),
  revision: z.number().int().positive(),
  requires: z.object({ mutinybim: text(40) }).optional(),
  units: z.array(displayProfileItemSchema).max(100).default([]),
  classes: z.array(classItemSchema).max(2000).default([]),
  fields: z.array(sharedFieldItemSchema).max(10000).default([]),
  formulas: z.array(calculationItemSchema).max(5000).default([]),
  relationships: z.array(relationshipItemSchema).max(200).default([]),
  scheduleTemplates: z.array(scheduleTemplateItemSchema).max(2000).default([]),
  tagTypes: z.array(tagTypeItemSchema).max(2000).default([]),
  disciplines: z.array(disciplineItemSchema).max(200).default([]),
  /** Part types (round 11): the kernel's definition, with provenance when a script made it. */
  partTypes: z.array(partTypeItemSchema).max(5000).default([]),
  /** Scripts (round 11): source, manifest, licence and authors. */
  scripts: z.array(scriptItemSchema).max(500).default([]),
  /** Design limits (round 12 S12): the firm's or project's design rules of thumb, each with its source. */
  designLimits: z.array(designLimitItemSchema).max(2000).default([]),
  /** Lookup tables (round 13): a firm's tables, rows by columns with units and a citation. */
  lookupTables: z.array(lookupTableItemSchema).max(500).default([]),
  /** Element types (round 13): a firm's wall, door, window and other types for any kind an add-on draws. */
  elementTypes: z.array(elementTypeItemSchema).max(5000).default([]),
  /** Title blocks (round 15): a firm's title block for the paper sizes it fits. */
  titleBlocks: z.array(titleBlockItemSchema).max(200).default([]),
  /** Keynote tables (round 15): a firm's keynotes by key. */
  keynoteTables: z.array(keynoteTableItemSchema).max(500).default([]),
});

export type DisplayProfileItem = z.infer<typeof displayProfileItemSchema>;
export type ClassItem = z.infer<typeof classItemSchema>;
export type SharedFieldItem = z.infer<typeof sharedFieldItemSchema>;
export type CalculationItem = z.infer<typeof calculationItemSchema>;
export type RelationshipItem = z.infer<typeof relationshipItemSchema>;
export type ScheduleTemplateItem = z.infer<typeof scheduleTemplateItemSchema>;
export type TagTypeItem = z.infer<typeof tagTypeItemSchema>;
export type DisciplineItem = z.infer<typeof disciplineItemSchema>;
export type ExampleValue = z.infer<typeof exampleValueSchema>;
export type OperandType = z.infer<typeof operandTypeSchema>;
/** A bundle as written in a file (sections optional). */
export type LibraryBundleInput = z.input<typeof libraryBundleSchema>;
/** A parsed bundle (every section present). */
export type LibraryBundle = z.infer<typeof libraryBundleSchema>;

/** Each bundle section, by the item type it holds. */
export const ITEM_SECTIONS = {
  unit_profile: "units",
  class: "classes",
  field: "fields",
  formula: "formulas",
  relationship: "relationships",
  schedule_template: "scheduleTemplates",
  tag_type: "tagTypes",
  discipline: "disciplines",
  part_type: "partTypes",
  script: "scripts",
  design_limit: "designLimits",
  lookup_table: "lookupTables",
  element_type: "elementTypes",
  title_block: "titleBlocks",
  keynote_table: "keynoteTables",
} as const satisfies Record<string, keyof LibraryBundle>;

export type LibraryItemType = keyof typeof ITEM_SECTIONS;
export const LIBRARY_ITEM_TYPES = Object.keys(ITEM_SECTIONS) as LibraryItemType[];

export interface ItemBodyByType {
  readonly unit_profile: DisplayProfileItem;
  readonly class: ClassItem;
  readonly field: SharedFieldItem;
  readonly formula: CalculationItem;
  readonly relationship: RelationshipItem;
  readonly schedule_template: ScheduleTemplateItem;
  readonly tag_type: TagTypeItem;
  readonly discipline: DisciplineItem;
  readonly part_type: PartTypeItem;
  readonly script: ScriptItem;
  readonly design_limit: DesignLimitItem;
  readonly lookup_table: LookupTableItem;
  readonly element_type: ElementTypeItem;
  readonly title_block: TitleBlockItem;
  readonly keynote_table: KeynoteTableItem;
}

/** One item with its type: what providers return and what pins hold. */
export type LibraryItem = { [T in LibraryItemType]: { readonly type: T; readonly body: ItemBodyByType[T] } }[LibraryItemType];

export const ITEM_TYPE_LABELS: Readonly<Record<LibraryItemType, string>> = {
  unit_profile: "Display profile",
  class: "Object class",
  field: "Shared field",
  formula: "Calculation",
  relationship: "Relationship",
  schedule_template: "Schedule template",
  tag_type: "Tag type",
  discipline: "Discipline",
  part_type: "Part type",
  script: "Script",
  design_limit: "Design limit",
  lookup_table: "Lookup table",
  element_type: "Element type",
  title_block: "Title block",
  keynote_table: "Keynote table",
};

const ITEM_SCHEMAS = {
  unit_profile: displayProfileItemSchema,
  class: classItemSchema,
  field: sharedFieldItemSchema,
  formula: calculationItemSchema,
  relationship: relationshipItemSchema,
  schedule_template: scheduleTemplateItemSchema,
  tag_type: tagTypeItemSchema,
  discipline: disciplineItemSchema,
  part_type: partTypeItemSchema,
  script: scriptItemSchema,
  design_limit: designLimitItemSchema,
  lookup_table: lookupTableItemSchema,
  element_type: elementTypeItemSchema,
  title_block: titleBlockItemSchema,
  keynote_table: keynoteTableItemSchema,
} as const;

/** Pairs a body with its type. (TypeScript can't correlate a generic key with the union it indexes, hence the one assertion.) */
export function makeItem<T extends LibraryItemType>(type: T, body: ItemBodyByType[T]): LibraryItem {
  return { type, body } as LibraryItem;
}

/** Parses one item of a known type (a publish), with the same rules as a bundle. */
export function parseItem(item: { readonly type: LibraryItemType; readonly body: unknown }): { ok: true; item: LibraryItem } | { ok: false; issues: z.core.$ZodIssue[] } {
  const parsed = ITEM_SCHEMAS[item.type].safeParse(item.body);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, item: makeItem(item.type, parsed.data) };
}
