import type { PartCategory } from "../parts";
import type { BimElement, ElementId, ElementKind } from "../types";
import type { AggregationRule, Kind, UnitCode } from "./units";

/**
 * The cross-discipline vocabulary every schedule, tag, diagram and agent reads
 * through (SCHEDULES-PLAN §4): object classes, typed directional relationships
 * and fields with a kind and unit. This module is machinery only. What a door,
 * a beam or a water heater is comes from registrations: the kernel's built-in
 * element kinds and part categories (builtin.ts), field providers (one thin
 * module per trade) and firm libraries (`@permitzip/bim-library`).
 */

/** Namespaced, lower snake case: `mep.water_heater`, `arch.door`, `fp.sprinkler_head`. */
export type ClassId = string;
export const CLASS_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** A relationship id, lower snake case: `serves`, `fed_from`, `in_room`. */
export type RelationshipId = string;
export const RELATIONSHIP_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A field's own path (no relationship steps): `mark`, `param.gas_input`, `load.wsfu_total`. */
export const FIELD_PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

/**
 * The ten class disciplines stored before the registry (frozen ids). Each is
 * a registered row now: the kernel's shared rows (`disciplines/types.ts`)
 * and the first-party add-ons' own. A class may name any registered
 * discipline (`ClassDiscipline` is open); readers label it from the registry.
 */
export const CLASS_DISCIPLINES = [
  "architecture",
  "structure",
  "civil",
  "mechanical",
  "plumbing",
  "electrical",
  "fire_protection",
  "general_contracting",
  "documentation",
  "general",
] as const;
export type ClassDiscipline = (typeof CLASS_DISCIPLINES)[number] | (string & {});

/** Where a registration came from: the kernel or a provider (`builtin`), or a library item at a revision. */
export type RegistrySource = "builtin" | `provider:${string}` | `library:${string}@${number}`;

/** One test a recognized element must pass. Data, so a library file can carry it. */
export interface RecognitionCondition {
  /**
   * What to read: `type.param.<name>` (a part's type value), `param.<name>`
   * (instance value, falling back to the type's), `family`, `type` (a part
   * type's names), or a top-level scalar property of the element (`domain`,
   * `openingType`, `service`).
   */
  readonly path: string;
  readonly op: "present" | "absent" | "equals" | "not_equals" | "contains" | "in";
  readonly value?: string | number | boolean | readonly (string | number | boolean)[];
}

/**
 * How instances of a class are recognized: an element kind, or a part whose
 * type is in a category, and every condition holds. Compiled once per
 * registry into the one-pass class index.
 */
export interface Recognition {
  /** The kernel's kinds, or an add-on's own (`zz.partition`): open, so a pack can classify its own kinds. */
  readonly elementKinds?: readonly (ElementKind | (string & {}))[];
  /** Parts only, by their type's category. */
  readonly partCategories?: readonly PartCategory[];
  readonly where?: readonly RecognitionCondition[];
}

/**
 * A class's IFC home (KERNEL-FOUNDATION §3.1). `entity` is the occurrence
 * entity; `predefinedType` a member of its enumeration, or `USERDEFINED`
 * with `objectType`; `typeEntity` the matching `IfcTypeProduct` (absent:
 * `<entity>Type`); `schema` the release the names are from (absent:
 * IFC4X3_ADD2). Readers ignore fields they do not know.
 */
export interface ObjectClassIfc {
  readonly entity: string;
  readonly predefinedType?: string;
  readonly objectType?: string;
  readonly typeEntity?: string;
  readonly schema?: string;
  /** How instances come in from IFC: a rule on `kernel.ifc_import_rule` and its options. Absent: the rule for the kind the class recognises (`import/`). */
  readonly import?: { readonly rule: string; readonly options?: Readonly<Record<string, string | number | boolean>> };
}

export interface ObjectClass {
  readonly id: ClassId;
  readonly label: string;
  readonly discipline: ClassDiscipline;
  /** Single inheritance: a subclass has every field of its ancestors. */
  readonly parent?: ClassId;
  /** Has no instances of its own; lists through its subclasses. */
  readonly abstract?: boolean;
  /** IFC mapping for import and export, e.g. `IfcFireSuppressionTerminal` / `SPRINKLER`. */
  readonly ifc?: ObjectClassIfc;
  readonly recognize?: Recognition;
  readonly description?: string;
  readonly source: RegistrySource;
  /** The category its instances draw under in Visibility/Graphics (a view category such as `electrical_devices`, or another class). Absent: the kernel's built-in mapping, then its parent class. */
  readonly drawsUnder?: string;
  /** The symbol registry row its instances draw in plans, in place of their type's own symbol lines. */
  readonly symbolId?: string;
}

export type FieldValueType = "quantity" | "text" | "boolean" | "choice" | "element";

/** How a cell edit reaches the model. Every editable field names one; a calculated one says why it can't be typed into. */
export type FieldWriter =
  | {
      readonly kind: "none";
      /** Plain words for the locked cell, e.g. "Calculated from the fixtures it serves". */
      readonly reason: string;
      /** What "Go to source" opens: a field path or `formula:<id>`. */
      readonly sourceRef?: string;
    }
  | { readonly kind: "parameter"; readonly scope: "instance" | "type"; readonly name: string }
  | { readonly kind: "command"; readonly command: string; readonly argument: string };

/** A field's value as read from the model. Quantities are numbers in the field's unit. */
export type FieldValue = number | string | boolean | null | readonly ElementId[];

export interface FieldReadContext {
  readonly elements: Readonly<Record<string, BimElement>>;
}

export type FieldReader = (element: BimElement, ctx: FieldReadContext) => FieldValue;

/** What invalidates a cached value (incremental row engine, SCHEDULES-PLAN §6). */
export interface DependencySignature {
  /** Edits to elements of these kinds. */
  readonly elementKinds?: readonly ElementKind[];
  /** Edits to records of the kinds that start a tree (their row's `connectorEnds.root`): a source's mark, read by what it serves. */
  readonly sources?: boolean;
  /** Any change to connections or service links. */
  readonly connections?: boolean;
  /** Other fields of the same element this one reads. */
  readonly fields?: readonly string[];
}

export interface FieldDef {
  readonly path: string;
  readonly label: string;
  /** Applies to these classes and their subclasses. */
  readonly classes: readonly ClassId[];
  readonly valueType: FieldValueType;
  /** Required for quantities. */
  readonly kind?: Kind;
  /** The unit values are read and written in. Required for quantities. */
  readonly unit?: UnitCode;
  readonly choices?: readonly string[];
  readonly writer: FieldWriter;
  readonly deps?: DependencySignature;
  /** Absent: the kind's rule. */
  readonly aggregation?: AggregationRule;
  /** Builder grouping, e.g. "Identity", "Electrical". */
  readonly group?: string;
  readonly description?: string;
  readonly source: RegistrySource;
  /** Supplied by the field provider that owns the value. Absent: declared vocabulary with no reader yet. */
  readonly read?: FieldReader;
  /**
   * Parameter identity (KERNEL-FOUNDATION §3.2): the namespaced key a part
   * parameter, a load quantity and a library field share (`param.mca`,
   * `load.wsfu_total`, `firm:permitzip.kitchen_hood_id`). Absent: the field is
   * not a parameter (a walk, a relationship read).
   */
  readonly key?: string;
  /** Other keys that name the same parameter (`param.voltage` for `elec.voltage`); readers resolve them, writers store `key`. */
  readonly aliases?: readonly string[];
  /** Where a parameter's value is held. */
  readonly binding?: ParameterBinding;
  /**
   * The unit the model stores this parameter's numbers in, when that is not
   * the kind's SI base unit: v1 part parameters keep their own unit
   * (`PARAM_UNITS`), load bags theirs. Absent on a quantity: stored SI.
   */
  readonly storedUnit?: UnitCode;
  readonly constraint?: ParameterConstraint;
  readonly ifc?: ParameterIfc;
}

/**
 * `instance` / `type`: a value set on the element or its type. `derived`: a
 * provider reads it from the model. `formula`: computed from other parameters.
 */
export type ParameterBinding = "instance" | "type" | "derived" | "formula";

/** Limits on a parameter's value, in its stored unit (the part editor's min / max / choices). */
export interface ParameterConstraint {
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly string[];
}

/** IFC 4.3 home of a parameter: a property in a set, or a quantity in a quantity set. Never a reserved `Pset_` / `Qto_` name for our own sets. */
export type ParameterIfc = { readonly pset: string; readonly property: string } | { readonly qto: string; readonly quantity: string };

/**
 * The one parameter definition: a field that is a parameter. Part parameters
 * (`ParamDef`), load quantities and library fields all resolve to this.
 */
export type ParameterDef = FieldDef & { readonly key: string; readonly binding: ParameterBinding };

export type RelationshipResolver = (element: BimElement, ctx: FieldReadContext) => readonly ElementId[];

export interface RelationshipDef {
  readonly id: RelationshipId;
  readonly label: string;
  /** Read in the other direction: `serves` ↔ `served_by`. */
  readonly inverse: RelationshipId;
  /** Classes it starts from; "any": every class. */
  readonly from: readonly ClassId[] | "any";
  readonly to: readonly ClassId[] | "any";
  /** How many targets one element has. */
  readonly cardinality: "one" | "many";
  /** `path`: a walk with a developed length (source of, supported by), not a single hop. */
  readonly traversal: "direct" | "path";
  readonly deps: DependencySignature;
  readonly description?: string;
  readonly source: RegistrySource;
  /** Supplied by the trade's provider (the existing walks). Absent: declared, not yet resolvable. */
  readonly resolve?: RelationshipResolver;
}

/** One side of a relationship pair, as registered. */
export type RelationshipSide = Omit<RelationshipDef, "inverse" | "source" | "deps">;

export interface RelationshipPair {
  readonly forward: RelationshipSide;
  readonly inverse: RelationshipSide;
  readonly deps: DependencySignature;
  readonly description?: string;
}

/** The only discipline-specific code: a thin module adding fields (and readers) to the shared registry. */
export interface FieldProvider {
  readonly id: string;
  readonly fields?: readonly Omit<FieldDef, "source">[];
  readonly relationships?: readonly RelationshipPair[];
  /** Readers / resolvers for relationships declared elsewhere (the kernel's built-in names). */
  readonly resolvers?: Readonly<Record<RelationshipId, RelationshipResolver>>;
}

/** A field path read from a class, through zero or more relationships: `served_by.mark`, `source.developed_length`. */
export type PathDescription =
  | {
      readonly ok: true;
      readonly steps: readonly RelationshipDef[];
      readonly field: FieldDef;
      /** True when any step can reach more than one element (a list or an aggregate, not one value). */
      readonly many: boolean;
    }
  | { readonly ok: false; readonly message: string };

export interface ClassFilter {
  readonly discipline?: ClassDiscipline;
  /** Absent: false. */
  readonly includeAbstract?: boolean;
}

/** A frozen registry. Extend it to add a layer; the original never changes. */
export interface Registry {
  /** Changes whenever any registration does: a cache key for compiled indexes. */
  readonly fingerprint: string;
  listClasses(filter?: ClassFilter): readonly ObjectClass[];
  getClass(id: ClassId): ObjectClass | undefined;
  /** The class and its ancestors, nearest first. */
  ancestors(id: ClassId): readonly ClassId[];
  /** The class and every subclass. */
  descendants(id: ClassId): readonly ClassId[];
  isA(id: ClassId, ancestor: ClassId): boolean;
  /** Its own fields and its ancestors'; a nearer class's field wins on path. */
  fieldsFor(id: ClassId): readonly FieldDef[];
  field(classId: ClassId, path: string): FieldDef | undefined;
  relationship(id: RelationshipId): RelationshipDef | undefined;
  listRelationships(): readonly RelationshipDef[];
  /** Relationships whose `from` includes the class or an ancestor. */
  relationshipsFor(id: ClassId): readonly RelationshipDef[];
  describePath(classId: ClassId, path: string): PathDescription;
  extend(): RegistryBuilder;
}

export interface RegistryBuilder {
  addClass(cls: ObjectClass): RegistryBuilder;
  /** Replace an existing class's label, IFC mapping, recognition or description (a library override). */
  replaceClass(cls: ObjectClass): RegistryBuilder;
  addField(field: FieldDef): RegistryBuilder;
  addRelationship(pair: RelationshipPair, source: RegistrySource): RegistryBuilder;
  addProvider(provider: FieldProvider): RegistryBuilder;
  /** Throws `RegistryError` naming every problem, never a half-built registry. */
  build(): Registry;
}

export type RegistryErrorCode =
  | "invalid_id"
  | "duplicate_class"
  | "unknown_class"
  | "unknown_parent"
  | "inheritance_cycle"
  | "duplicate_field"
  | "invalid_field"
  | "duplicate_relationship"
  | "unknown_relationship"
  | "unit_kind_mismatch";

export interface RegistryProblem {
  readonly code: RegistryErrorCode;
  readonly message: string;
}

export class RegistryError extends Error {
  readonly problems: readonly RegistryProblem[];
  constructor(problems: readonly RegistryProblem[]) {
    super(problems.map((p) => p.message).join("\n"));
    this.name = "RegistryError";
    this.problems = problems;
  }
}

/** Elements by class, from one pass over the model. */
export interface ClassIndex {
  readonly fingerprint: string;
  /** Classes the element was recognized as directly (not their ancestors). */
  classesOf(id: ElementId): readonly ClassId[];
  /** Instances of the class; with subclasses (the default) also every subclass's, each element once, in model order. */
  elementsOf(id: ClassId, opts?: { readonly includeSubclasses?: boolean }): readonly BimElement[];
}
