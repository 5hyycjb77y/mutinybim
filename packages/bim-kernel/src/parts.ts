import { fromSI, isLegacyParamUnit, isUnitCode, kindsOfUnit, LEGACY_PARAM_UNIT_SUFFIXES, LEGACY_PARAM_UNITS, PARAM_UNIT_BINDINGS, toSI, UNITS, type Kind, type UnitBinding, type UnitCode } from "@permitzip/bim-units";
import { z } from "zod";
import type { ClassId, ParameterDef } from "./registry/types";
import type { Discipline, ParamValue, PartInstance, PartTypeElement, Vec2 } from "./types";
import { dimSchema, PARAM_NAME, type Dim } from "./part-dim";
import { evaluateFormula, FormulaError, formulaNames, parseFormula } from "./part-model/formula";
import { modelDims, resolvePartModel } from "./part-model/resolve";
import { anyPartModelSchema, isPartModel2 } from "./part-model/schema-2";
import { clearanceZoneIssues, clearanceZonesSchema, partPositionIssues, partPositionsSchema } from "./part-model/clearance";
import { INTAKE_KINDS, type IntakeKind } from "./part-model/intake-hood";
import { mountedGeometry } from "./part-mount";
import { BUILTIN_CONNECTOR_IDS, BUILTIN_SYSTEM_KIND_IDS } from "./services/builtin";
import { isRegistryIdShape, REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "./ids";

export { dimSchema, type Dim };

/**
 * Part types: any placeable family, in any discipline. A type carries its own
 * parameter schemas, connectors, parametric 3D primitives, plan symbol and tag
 * fields, so nothing in the kernel is specific to ducts, pipes or devices.
 * All lengths are millimetres in the part's local frame: x along the part's
 * facing direction, y to its left, z up from the insertion point.
 */

export const PART_CATEGORIES = [
  "mechanical_equipment",
  "air_terminal",
  "duct_accessory",
  "pipe_accessory",
  "plumbing_fixture",
  "electrical_equipment",
  "electrical_device",
  "lighting_fixture",
  "generic",
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

export const PART_CATEGORY_LABELS: Readonly<Record<PartCategory, string>> = {
  mechanical_equipment: "Mechanical equipment",
  air_terminal: "Air terminals",
  duct_accessory: "Duct accessories",
  pipe_accessory: "Pipe accessories",
  plumbing_fixture: "Plumbing fixtures",
  electrical_equipment: "Electrical equipment",
  electrical_device: "Electrical devices",
  lighting_fixture: "Lighting fixtures",
  generic: "Generic models",
};

const KNOWN_PART_CATEGORIES: ReadonlySet<string> = new Set(PART_CATEGORIES);

export function isKnownPartCategory(category: unknown): category is PartCategory {
  return typeof category === "string" && KNOWN_PART_CATEGORIES.has(category);
}

/**
 * A stored part category as readers take it: any registry-shaped id (a pack's
 * `struct.connection_plate`, a newer peer's `fire_alarm_device`) is kept as
 * stored and behaves as `generic` here (class `gen.generic_model`,
 * `elements/recognise.ts` `partCategoryClass`); `known` is null for it.
 * Writers still take only `PART_CATEGORIES` (`partTypeDefinitionSchema`).
 */
export function readPartCategory(raw: unknown): { readonly stored: string; readonly known: PartCategory | null; readonly behavesAs: PartCategory } | null {
  if (isKnownPartCategory(raw)) return { stored: raw, known: raw, behavesAs: raw };
  return isRegistryIdShape(raw) ? { stored: raw, known: null, behavesAs: "generic" } : null;
}

/** The discipline of a stored category, known or not. */
export function disciplineOfStoredCategory(raw: string): Discipline {
  return disciplineOfCategory(readPartCategory(raw)?.behavesAs ?? "generic");
}

export function disciplineOfCategory(category: PartCategory): Discipline {
  switch (category) {
    case "mechanical_equipment":
    case "air_terminal":
    case "duct_accessory":
      return "mechanical";
    case "pipe_accessory":
    case "plumbing_fixture":
      return "plumbing";
    case "electrical_equipment":
    case "electrical_device":
    case "lighting_fixture":
      return "electrical";
    case "generic":
      return "architecture";
  }
}

/**
 * The unit names v1 part parameters are stored with. The list lives in
 * `@permitzip/bim-units` (`LEGACY_PARAM_UNITS`, each bound 1:1 to a unit code
 * by `PARAM_UNIT_BINDINGS`).
 * @deprecated Read a parameter through `parameterOfParamDef` / `paramUnitBinding` (bim-units kind and unit). Stored records keep these names; never renamed on the wire.
 */
export const PARAM_UNITS = LEGACY_PARAM_UNITS;
/** @deprecated The stored v1 name; the meaning is `paramUnitBinding(unit)`. */
export type ParamUnit = (typeof PARAM_UNITS)[number];

const paramValueSchema = z.union([z.number().finite(), z.string().max(400), z.boolean()]);

export const paramDefSchema = z.object({
  name: z.string().regex(PARAM_NAME, "lower_snake_case, starting with a letter"),
  label: z.string().min(1).max(80),
  /** `length` values are millimetres; `angle` degrees; `number` values are in `unit`; `material` a material name. */
  kind: z.enum(["number", "length", "angle", "text", "boolean", "choice", "material"]),
  /**
   * A v1 unit name (`"kw"`, `"gpm"`; every stored record) or a bim-units unit
   * code (`"cfs"`, `"kW"`). Readers take either (`paramUnitBinding`); a unit
   * code is written only to peers advertising `PARTS_UNIT_CODES_FEATURE`
   * (part-model/unit-gate.ts) and only on a number parameter (`partTypeIssues`).
   */
  unit: z
    .string()
    .min(1)
    .max(24)
    .refine((u) => isLegacyParamUnit(u) || isUnitCode(u), { message: "a part parameter unit: one of the original unit names or a unit code (kW, L/s, …)" })
    .optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  choices: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
  required: z.boolean().optional(),
  default: paramValueSchema.optional(),
  /** Computed from other parameters (part-model/formula.ts); such a parameter can't be set by type or instance values. */
  formula: z.string().trim().min(1).max(400).optional(),
});
/**
 * A part parameter as stored in a part type (v1 shape, unchanged on the wire).
 * @deprecated For reading, resolve it to the one parameter definition with `parameterOfParamDef` (a `ParameterDef`: field system kind and unit from bim-units). Writers keep emitting this shape until the part@2 upgrade.
 */
export type ParamDef = z.infer<typeof paramDefSchema>;

/** A part parameter unit as a bim-units kind and unit: a stored v1 name (`"kw"`) or, read ahead of the part@2 upgrade, a unit code (`"kW"`). Null when it is neither. */
export function paramUnitBinding(unit: string | undefined): UnitBinding | null {
  if (unit === undefined) return PARAM_UNIT_BINDINGS.none;
  if (isLegacyParamUnit(unit)) return PARAM_UNIT_BINDINGS[unit];
  if (isUnitCode(unit)) {
    const kind = kindsOfUnit(unit)[0];
    return kind === undefined ? null : { kind, unit };
  }
  return null;
}

/**
 * A part parameter as the one parameter definition (`ParameterDef`, the field
 * system's `FieldDef` with a key and binding). Lengths are millimetres, angles
 * degrees, numbers in their stored unit (`storedUnit`), exactly as the model
 * holds them; display goes through bim-units. Kinds and units match the v2
 * schedule columns (`schedules/engine/fields.ts`).
 */
export function parameterOfParamDef(p: ParamDef, scope: "instance" | "type", classes: readonly ClassId[] = []): ParameterDef {
  const path = `param.${p.name}`;
  const base = {
    path,
    key: path,
    label: p.label,
    classes,
    binding: p.formula ? ("formula" as const) : scope,
    writer: p.formula ? { kind: "none" as const, reason: `Calculated by the part: ${p.formula}` } : { kind: "parameter" as const, scope, name: p.name },
    source: "builtin" as const,
    ...(p.min !== undefined || p.max !== undefined || p.choices ? { constraint: { ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.choices ? { choices: p.choices } : {}) } } : {}),
  };
  switch (p.kind) {
    case "length":
      return { ...base, valueType: "quantity", kind: "length", unit: "mm", storedUnit: "mm" };
    case "angle":
      return { ...base, valueType: "quantity", kind: "angle", unit: "deg", storedUnit: "deg" };
    case "number": {
      const b = paramUnitBinding(p.unit) ?? PARAM_UNIT_BINDINGS.none;
      return { ...base, valueType: "quantity", kind: b.kind, unit: b.unit, storedUnit: b.unit };
    }
    case "boolean":
      return { ...base, valueType: "boolean" };
    case "choice":
      return p.choices ? { ...base, valueType: "choice", choices: p.choices } : { ...base, valueType: "text" };
    case "text":
    case "material":
      return { ...base, valueType: "text" };
  }
}

/** Every parameter of a part type as `ParameterDef`s: type parameters, then instance parameters. */
export function partParameters(def: PartTypeDefinition, classes: readonly ClassId[] = []): ParameterDef[] {
  return [...def.typeParams.map((p) => parameterOfParamDef(p, "type", classes)), ...def.instanceParams.map((p) => parameterOfParamDef(p, "instance", classes))];
}

/**
 * The 1:1 storage conversion for the part@2 upgrade (f-wire's upgrade-on-edit,
 * MIGRATION-PLAN §5.3): a numeric v1 parameter stored in its own unit and the
 * same number in canonical SI. Null for non-numeric parameters. This module
 * never rewrites a stored value.
 */
export function paramStorageConversion(p: ParamDef): { readonly kind: Kind; readonly storedUnit: UnitCode; toSI(value: number): number; fromSI(si: number): number } | null {
  const q = parameterOfParamDef(p, "instance");
  if (q.valueType !== "quantity" || q.kind === undefined || q.storedUnit === undefined) return null;
  const storedUnit = q.storedUnit;
  return { kind: q.kind, storedUnit, toSI: (v) => toSI(v, storedUnit), fromSI: (si) => fromSI(si, storedUnit) };
}

const dim3Schema = z.tuple([dimSchema, dimSchema, dimSchema]);
const dim2Schema = z.tuple([dimSchema, dimSchema]);

export const primitiveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), center: dim3Schema, size: dim3Schema }),
  z.object({ kind: z.literal("cylinder"), center: dim3Schema, radius: dimSchema, height: dimSchema, axis: z.enum(["x", "y", "z"]) }),
  /** A plan profile pushed up from `z` by `height`. */
  z.object({ kind: z.literal("extrusion"), profile: z.array(dim2Schema).min(3).max(64), z: dimSchema, height: dimSchema }),
]);
export type PartPrimitive = z.infer<typeof primitiveSchema>;

export const symbolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), center: dim2Schema, size: dim2Schema }),
  z.object({ kind: z.literal("circle"), center: dim2Schema, radius: dimSchema }),
  z.object({ kind: z.literal("line"), from: dim2Schema, to: dim2Schema }),
  z.object({ kind: z.literal("polyline"), points: z.array(dim2Schema).min(2).max(64), closed: z.boolean() }),
  z.object({ kind: z.literal("text"), at: dim2Schema, text: z.string().min(1).max(40), heightMm: z.number().positive().max(1000) }),
]);
export type SymbolPrimitive = z.infer<typeof symbolSchema>;

/** What a port connects to: the connector view of the service registry (services/registry.ts). */
export const CONNECTOR_DOMAINS = BUILTIN_CONNECTOR_IDS;
export type ConnectorDomain = (typeof CONNECTOR_DOMAINS)[number];

/**
 * What a drawn system or a connector carries: the system kind view of the
 * service registry. The round-4 kinds keep their strings and order; the
 * registry's rows (grease waste, indirect waste, fire protection, chilled and
 * heating water) follow and are written only to peers that read them.
 */
export const SYSTEM_KINDS = BUILTIN_SYSTEM_KIND_IDS;
/** The kernel's own system kinds: what its tables (routing rules, graphics, fitting defaults) list exhaustively. */
export type KnownSystemKind = (typeof SYSTEM_KINDS)[number];
/**
 * A stored or written system kind: a built-in one, or any registry id a pack
 * or firm row adds (`civil.storm`). Code that tabulates kinds keys on
 * `KnownSystemKind` and reads an unknown kind through its service row.
 */
export type SystemKind = KnownSystemKind | (string & {});

/**
 * A stored system kind, as readers take it: any id in the registry grammar
 * (`ids.ts`: `grease_waste`, `firm:steam`, `fp.sprinkler_wet`), so a part type
 * saved by a newer peer, a firm or a pack still loads and round-trips; display
 * falls back to the id's raw words. Writers check the id against the registry
 * at command time (services/write-gate.ts).
 */
export const systemKindSchema = z.custom<SystemKind>(isRegistryIdShape, { message: "a system kind is a lower-case registry id (domestic_cold_water, sanitary, fp.sprinkler_wet, …)" });

/** A stored connector domain, read as tolerantly as a system kind (a structural `member` port must not make a part type unreadable). Writers check `connectorDomainIds()`. */
export const connectorDomainSchema = z.custom<ConnectorDomain>(isRegistryIdShape, { message: "a connector domain is a lower-case registry id (duct, pipe, electrical, …)" });

/**
 * Connector-level inputs by parameter key (`plumb.bowl_length`, `param.air_gap`):
 * the one place a new trade input on a port goes, never a new top-level field.
 * Written only to peers advertising `PARTS_CONNECTOR_VALUES_FEATURE`.
 */
export const connectorValuesSchema = z
  .record(z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a parameter key (plumb.bowl_length)"), paramValueSchema)
  .refine((v) => Object.keys(v).length <= 40, { message: "at most 40 connector values" });

export const connectorSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  domain: connectorDomainSchema,
  systemKind: systemKindSchema,
  position: dim3Schema,
  /** Outward direction in the local frame (need not be unit length). */
  direction: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  shape: z.enum(["rect", "round", "none"]),
  width: dimSchema.optional(),
  height: dimSchema.optional(),
  diameter: dimSchema.optional(),
  /** Design flow (CFM for duct, GPM for pipe, VA for electrical). */
  flow: dimSchema.optional(),
  /** Electrical only. */
  voltage: dimSchema.optional(),
  poles: z.number().int().min(1).max(3).optional(),
  /** Electrical only: the load class demand factors use ("lighting", "receptacle", "kitchen", "motor", "hvac", …). */
  loadClass: z.string().trim().min(1).max(40).optional(),
  /** Electrical only: the load runs 3 hours or more (sized at 125%). */
  continuous: z.boolean().optional(),
  /** Electrical only: a motor's horsepower, so its full-load current comes from the code tables when no load is given. */
  motorHp: dimSchema.optional(),
  /** Which way the system flows through it, seen from the part. */
  flowDirection: z.enum(["in", "out", "bidirectional"]).optional(),
  /** Rectangular connectors: the local direction of the width (square to `direction`), completing the connector frame. */
  widthAxis: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  /** Duct openings to outdoors: the weather hood, louver or screen this type ships with (part-model/intake-hood.ts). A placed part can change it. */
  intake: z.enum(INTAKE_KINDS).optional(),
  /** Connector-level inputs by parameter key (bowl dimensions, an air gap); see `connectorValuesSchema`. */
  values: connectorValuesSchema.optional(),
  /**
   * How the opening is made to join the next piece: an end type an add-on
   * declares (connections/end-types.ts). Read as stored when no add-on in
   * force knows it; written only to peers advertising `CONNECTOR_END_TYPES_FEATURE`.
   */
  endType: z.custom<string>(isRegistryIdShape, { message: "an end type is a lower-case registry id (<pack>.<name>)" }).optional(),
});
export type PartConnector = z.infer<typeof connectorSchema>;

export const partSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), libraryVersion: z.string().min(1).max(40) }),
  z.object({
    kind: z.literal("revit"),
    familyName: z.string().min(1).max(200),
    typeName: z.string().min(1).max(200),
    /** Revit category as the extractor reported it (e.g. "Air Terminals"). */
    revitCategory: z.string().min(1).max(120),
    /** Where the type came from (project number, file). Never client data in git. */
    origin: z.string().max(200).optional(),
    /** True when no real geometry was available and the box came from the type's bounding box. */
    boundingBoxGeometry: z.boolean(),
  }),
  /** Drafted from a manufacturer's cut sheet (a PDF on a project). */
  z.object({
    kind: z.literal("cut_sheet"),
    fileName: z.string().min(1).max(300),
    /** The project file it was read from, when it was one. */
    fileId: z.string().uuid().optional(),
  }),
  /**
   * Made by a library script (bim-script kit). `key` and `version` name the
   * saved script version that made it; a preview not yet saved has neither.
   * Written only to peers advertising `GEOMETRY_SOLID_PROGRAM_2_FEATURE`.
   */
  z.object({ kind: z.literal("script"), key: z.string().min(1).max(120).optional(), version: z.string().min(1).max(40).optional() }),
  /** Brought in from a linked IFC model (import/): the entity and type name it was, as a box of its extent. */
  z.object({ kind: z.literal("ifc"), entity: z.string().min(1).max(80), typeName: z.string().min(1).max(200), boundingBoxGeometry: z.literal(true) }),
]);

export const partTypeDefinitionSchema = z.object({
  familyName: z.string().min(1).max(200),
  typeName: z.string().min(1).max(200),
  category: z.enum(PART_CATEGORIES),
  description: z.string().max(400).optional(),
  typeParams: z.array(paramDefSchema).max(80),
  typeValues: z.record(z.string(), paramValueSchema),
  instanceParams: z.array(paramDefSchema).max(80),
  connectors: z.array(connectorSchema).max(24),
  /** Simple primitives. May be empty when `model` draws the part. */
  geometry: z.array(primitiveSchema).max(64),
  /** Plan symbol lines. May be empty when `model` draws the part in plans. */
  symbol: z.array(symbolSchema).max(64),
  /** What a tag on this part shows, in order: parameter names, or "mark" / "type_name". */
  tagFields: z.array(z.string().min(1).max(48)).max(8),
  source: partSourceSchema,
  /** A modeled part: the part editor's reference planes, sketches, features and types table (part-model/schema.ts). */
  model: anyPartModelSchema.optional(),
  /** Space the part needs kept clear (service, combustibles, economizer, NEC 110.26 working space); never solid (part-model/clearance.ts). */
  clearances: clearanceZonesSchema.optional(),
  /** Named positions of a part that moves (open, closed, travel) and the space each takes; read like clearances (part-model/clearance.ts). */
  positions: partPositionsSchema.optional(),
});
export type PartTypeDefinition = z.infer<typeof partTypeDefinitionSchema>;

/** For reading a stored definition (a firm part, a model's pinned type): the writer schema with any registry-shaped category kept (`readPartCategory`). */
export const storedPartTypeDefinitionSchema = partTypeDefinitionSchema.extend({
  category: z.custom<string>(isRegistryIdShape, { message: "a part category is a lower-case registry id (generic, plumbing_fixture, struct.connection_plate, …)" }),
});
export type StoredPartTypeDefinition = z.infer<typeof storedPartTypeDefinitionSchema>;

export { paramValueSchema };

// ------------------------------------------------------------------ checks

export interface PartIssue {
  readonly field: string;
  readonly message: string;
}

function dimParams(d: Dim, out: Set<string>): void {
  if (typeof d === "number") return;
  if ("param" in d) {
    out.add(d.param);
    return;
  }
  try {
    formulaNames(parseFormula(d.formula), out);
  } catch (err) {
    // Unparseable formulas are reported by partTypeIssues; here they read nothing.
    if (!(err instanceof FormulaError)) throw err;
  }
}

function referencedParams(def: PartTypeDefinition): Set<string> {
  const out = new Set<string>();
  const each = (dims: readonly Dim[]) => dims.forEach((d) => dimParams(d, out));
  for (const p of def.geometry) {
    if (p.kind === "box") each([...p.center, ...p.size]);
    else if (p.kind === "cylinder") each([...p.center, p.radius, p.height]);
    else each([...p.profile.flat(), p.z, p.height]);
  }
  for (const s of def.symbol) {
    if (s.kind === "rect") each([...s.center, ...s.size]);
    else if (s.kind === "circle") each([...s.center, s.radius]);
    else if (s.kind === "line") each([...s.from, ...s.to]);
    else if (s.kind === "polyline") each(s.points.flat());
    else each(s.at);
  }
  for (const c of def.connectors) {
    each([...c.position]);
    for (const d of [c.width, c.height, c.diameter, c.flow, c.voltage]) if (d !== undefined) dimParams(d, out);
  }
  if (def.model) each(modelDims(def.model));
  return out;
}

/** Every formula in a definition, with where it is, for checking. */
function definitionFormulas(def: PartTypeDefinition): Array<{ field: string; formula: string }> {
  const out: Array<{ field: string; formula: string }> = [];
  for (const p of [...def.typeParams, ...def.instanceParams]) if (p.formula) out.push({ field: p.name, formula: p.formula });
  const dims: Array<{ field: string; d: Dim }> = [];
  def.connectors.forEach((c) => {
    for (const d of [...c.position, c.width, c.height, c.diameter, c.flow, c.voltage]) if (d !== undefined) dims.push({ field: c.id, d });
  });
  if (def.model) for (const d of modelDims(def.model)) dims.push({ field: "model", d });
  for (const { field, d } of dims) if (typeof d !== "number" && "formula" in d) out.push({ field, formula: d.formula });
  return out;
}

/** A value that fits a parameter definition, or the plain reason it doesn't. */
export function checkParamValue(def: ParamDef, value: ParamValue): string | null {
  switch (def.kind) {
    case "number":
    case "length":
    case "angle":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${def.label} must be a number`;
      if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}`;
      return null;
    case "text":
    case "material":
      return typeof value === "string" ? null : `${def.label} must be text`;
    case "boolean":
      return typeof value === "boolean" ? null : `${def.label} must be yes or no`;
    case "choice":
      if (typeof value !== "string") return `${def.label} must be one of its choices`;
      return def.choices && !def.choices.includes(value) ? `${def.label} must be one of: ${def.choices.join(", ")}` : null;
  }
}

/** Everything wrong with a type definition, beyond its JSON shape. Empty when it is usable. */
export function partTypeIssues(def: PartTypeDefinition): PartIssue[] {
  const issues: PartIssue[] = [];
  const all = [...def.typeParams, ...def.instanceParams];
  const names = new Set<string>();
  for (const p of all) {
    if (names.has(p.name)) issues.push({ field: p.name, message: `Parameter ${p.name} is defined twice` });
    names.add(p.name);
    if (p.kind === "choice" && !p.choices) issues.push({ field: p.name, message: `${p.label} is a choice with no choices` });
    if (isUnitCodeOnly(p.unit) && p.kind !== "number") issues.push({ field: p.name, message: `${p.label} is a ${p.kind} parameter, so it can't take the unit ${p.unit}: only number parameters carry a unit (lengths are millimetres, angles degrees)` });
    if (p.default !== undefined) {
      const why = checkParamValue(p, p.default);
      if (why) issues.push({ field: p.name, message: `Default: ${why}` });
    }
  }
  const typeNames = new Map(def.typeParams.map((p) => [p.name, p]));
  for (const [name, value] of Object.entries(def.typeValues)) {
    const p = typeNames.get(name);
    if (!p) {
      issues.push({ field: name, message: `Type value ${name} has no type parameter` });
      continue;
    }
    const why = checkParamValue(p, value);
    if (why) issues.push({ field: name, message: why });
  }
  for (const p of def.typeParams) {
    if (p.required && def.typeValues[p.name] === undefined && p.default === undefined) {
      issues.push({ field: p.name, message: `${p.label} needs a value` });
    }
  }
  const numeric = new Set(all.filter((p) => p.kind === "number" || p.kind === "length" || p.kind === "angle" || p.kind === "boolean").map((p) => p.name));
  for (const name of referencedParams(def)) {
    if (!numeric.has(name)) issues.push({ field: name, message: names.has(name) ? `Geometry uses ${name}, which is not a number, length, angle or yes/no parameter` : `Geometry uses ${name}, which is not a parameter` });
  }
  for (const { field, formula } of definitionFormulas(def)) {
    try {
      parseFormula(formula);
    } catch (err) {
      issues.push({ field, message: `Formula "${formula}": ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const p of all) {
    if (!p.formula) continue;
    if (p.kind !== "number" && p.kind !== "length" && p.kind !== "angle") issues.push({ field: p.name, message: `${p.label} has a formula, so it must be a number, length or angle` });
    if (def.typeValues[p.name] !== undefined) issues.push({ field: p.name, message: `${p.label} comes from its formula; remove its type value` });
    const cycle = formulaCycle(def, p.name);
    if (cycle) issues.push({ field: p.name, message: `${p.label}'s formula depends on itself (${cycle.join(" → ")})` });
  }
  if (!def.model && def.geometry.length === 0) issues.push({ field: "geometry", message: "The part has no shape: add geometry or a model" });
  if (!def.model && def.symbol.length === 0) issues.push({ field: "symbol", message: "The part has no plan symbol" });
  if (def.model?.planDisplay === "symbol" && def.symbol.length === 0 && !(isPartModel2(def.model) && def.model.symbols.some((s) => s.view === "plan"))) issues.push({ field: "symbol", message: "Plans show only the symbol, but the part has no symbol lines" });
  if (def.model && issues.length === 0) issues.push(...modelIssues(def));
  issues.push(...clearanceZoneIssues(def.clearances));
  issues.push(...partPositionIssues(def.positions));
  for (const f of def.tagFields) {
    if (f !== "mark" && f !== "type_name" && !names.has(f)) issues.push({ field: f, message: `Tag field ${f} is not a parameter` });
  }
  const connectorIds = new Set<string>();
  for (const c of def.connectors) {
    if (connectorIds.has(c.id)) issues.push({ field: c.id, message: `Connector ${c.id} is defined twice` });
    connectorIds.add(c.id);
    if (c.shape === "rect" && (c.width === undefined || c.height === undefined)) issues.push({ field: c.id, message: `${c.label} is rectangular but has no width and height` });
    if (c.shape === "round" && c.diameter === undefined) issues.push({ field: c.id, message: `${c.label} is round but has no diameter` });
    if (c.intake && c.domain !== "duct") issues.push({ field: c.id, message: `${c.label} isn't a duct opening, so it can't have a ${c.intake}` });
  }
  return issues;
}

/** Instance values checked against the type's instance schema; unknown names and bad values are refused. */
/**
 * The electrical connection type a part names (a catalog designator such as
 * "E.05"; connections/catalog). Every part that can carry power accepts it
 * without declaring it, so cut-sheet and engineer-made parts can use the
 * catalog as built-in ones do.
 */
export const CONNECTION_TYPE_PARAM: ParamDef = { name: "connection_type", label: "Connection type", kind: "text" };

/**
 * The utility's available fault current and a transformer's nameplate %Z.
 * Every piece of electrical equipment accepts them without declaring them, so
 * models whose types are already pinned can hold the figures the fault-current
 * check reads (NEC 110.9).
 */
export const AVAILABLE_FAULT_CURRENT_PARAM: ParamDef = { name: "available_fault_current", label: "Available fault current", kind: "number", unit: "a", min: 0 };
export const IMPEDANCE_PCT_PARAM: ParamDef = { name: "impedance_pct", label: "Impedance (%Z)", kind: "number", unit: "percent", min: 0, max: 20 };

function undeclaredEquipmentParam(def: PartTypeDefinition, name: string): ParamDef | undefined {
  if (def.category !== "electrical_equipment") return undefined;
  if (name === AVAILABLE_FAULT_CURRENT_PARAM.name) return AVAILABLE_FAULT_CURRENT_PARAM;
  if (name === IMPEDANCE_PCT_PARAM.name) return IMPEDANCE_PCT_PARAM;
  return undefined;
}

const POWERED_CATEGORIES: ReadonlySet<PartCategory> = new Set(["mechanical_equipment", "air_terminal", "plumbing_fixture", "electrical_device", "lighting_fixture", "generic"]);

export function canNameConnectionType(def: PartTypeDefinition): boolean {
  return def.category !== "electrical_equipment" && (POWERED_CATEGORIES.has(def.category) || def.connectors.some((c) => c.domain === "electrical"));
}

export function instanceValueIssues(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>): PartIssue[] {
  const byName = new Map(def.instanceParams.map((p) => [p.name, p]));
  const issues: PartIssue[] = [];
  for (const [name, value] of Object.entries(values)) {
    // A pack parameter (`civil.invert_elevation`): checked against its definition when written (elements/commands.ts), kept as stored here.
    if (PACK_PARAMETER_KEY.test(name)) continue;
    const p = byName.get(name) ?? (name === CONNECTION_TYPE_PARAM.name && canNameConnectionType(def) ? CONNECTION_TYPE_PARAM : undefined) ?? undeclaredEquipmentParam(def, name);
    if (!p) {
      const isType = def.typeParams.some((t) => t.name === name);
      issues.push({ field: name, message: isType ? `${name} is a type parameter; change it with Edit type` : `${def.typeName} has no parameter ${name}` });
      continue;
    }
    if (p.formula) {
      issues.push({ field: name, message: `${p.label} comes from its formula and can't be set` });
      continue;
    }
    const why = checkParamValue(p, value);
    if (why) issues.push({ field: name, message: why });
  }
  for (const p of def.instanceParams) {
    if (p.required && values[p.name] === undefined && p.default === undefined) issues.push({ field: p.name, message: `${p.label} needs a value` });
  }
  return issues;
}

/** The chain of formula parameters that leads back to `start`, or null. */
function formulaCycle(def: PartTypeDefinition, start: string): string[] | null {
  const byName = new Map([...def.typeParams, ...def.instanceParams].map((p) => [p.name, p]));
  const walk = (name: string, path: string[]): string[] | null => {
    const p = byName.get(name);
    if (!p?.formula) return null;
    let reads: Set<string>;
    try {
      reads = formulaNames(parseFormula(p.formula));
    } catch (err) {
      if (err instanceof FormulaError) return null;
      throw err;
    }
    for (const r of reads) {
      if (r === start) return [...path, r];
      if (path.includes(r)) continue;
      const found = walk(r, [...path, r]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

/**
 * A modeled part checked for every row of its types table (or its own type
 * values when the table is empty): sketches solve, profiles close, features
 * have depth, formulas evaluate.
 */
function modelIssues(def: PartTypeDefinition): PartIssue[] {
  const model = def.model;
  if (!model) return [];
  const issues: PartIssue[] = [];
  const typeParams = new Map(def.typeParams.map((p) => [p.name, p]));
  const rows = model.types.length > 0 ? model.types : [{ name: def.typeName, values: def.typeValues }];
  for (const row of rows) {
    const label = model.types.length > 0 ? `Type ${row.name}: ` : "";
    let rowOk = true;
    for (const [name, value] of Object.entries(row.values)) {
      const p = typeParams.get(name);
      if (!p) {
        issues.push({ field: name, message: `${label}${name} is not a type parameter` });
        rowOk = false;
        continue;
      }
      const why = p.formula ? `${p.label} comes from its formula` : checkParamValue(p, value);
      if (why) {
        issues.push({ field: name, message: `${label}${why}` });
        rowOk = false;
      }
    }
    if (!rowOk) continue;
    const sized: PartTypeDefinition = { ...def, typeValues: { ...def.typeValues, ...row.values } };
    const resolved = resolvePartModel(model, (d) => resolveDim(sized, {}, d));
    for (const issue of resolved.issues) issues.push({ field: issue.field, message: `${label}${issue.message}` });
  }
  return issues;
}

// ------------------------------------------------------------------ evaluation

const formulaStack: string[] = [];

interface ParamIndex {
  readonly typeParams: readonly ParamDef[];
  readonly instanceParams: readonly ParamDef[];
  readonly typeCount: number;
  readonly instanceCount: number;
  readonly byName: ReadonlyMap<string, ParamDef>;
}

const paramIndexes = new WeakMap<PartTypeDefinition, ParamIndex>();

/**
 * A type's parameter by name (instance parameters win, first of a name wins),
 * a map lookup per type. Rebuilt when either list is replaced or changes
 * length, so a definition drafted in place (cut-sheet builder) never reads stale.
 */
export function paramNamed(def: PartTypeDefinition, name: string): ParamDef | undefined {
  let ix = paramIndexes.get(def);
  if (!ix || ix.typeParams !== def.typeParams || ix.instanceParams !== def.instanceParams || ix.typeCount !== def.typeParams.length || ix.instanceCount !== def.instanceParams.length) {
    const byName = new Map<string, ParamDef>();
    for (const p of def.instanceParams) if (!byName.has(p.name)) byName.set(p.name, p);
    for (const p of def.typeParams) if (!byName.has(p.name)) byName.set(p.name, p);
    ix = { typeParams: def.typeParams, instanceParams: def.instanceParams, typeCount: def.typeParams.length, instanceCount: def.instanceParams.length, byName };
    paramIndexes.set(def, ix);
  }
  return ix.byName.get(name);
}

/** A parameter's effective value: its formula, else instance, then type value, then default. */
export function paramValue(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, name: string): ParamValue | undefined {
  const p = paramNamed(def, name);
  if (p?.formula) {
    if (formulaStack.includes(name)) throw new FormulaError(`${p.label}'s formula depends on itself`);
    formulaStack.push(name);
    try {
      return evaluateFormula(parseFormula(p.formula), (n) => numericParam(def, values, n));
    } finally {
      formulaStack.pop();
    }
  }
  if (values[name] !== undefined) return values[name];
  if (def.typeValues[name] !== undefined) return def.typeValues[name];
  return p?.default;
}

/** A parameter as a number for formulas: yes/no read 1 and 0; text and missing values are errors. */
function numericParam(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, name: string): number {
  const v = paramValue(def, values, name);
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const known = [...def.typeParams, ...def.instanceParams].some((p) => p.name === name);
  throw new FormulaError(known ? (v === undefined ? `${name} has no value` : `${name} is text, not a number`) : `${name} is not a parameter`);
}

export function resolveDim(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, d: Dim): number {
  if (typeof d === "number") return d;
  if ("formula" in d) return evaluateFormula(parseFormula(d.formula), (n) => numericParam(def, values, n));
  const v = paramValue(def, values, d.param);
  const n = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
  return n * (d.scale ?? 1) + (d.add ?? 0);
}

export type Vec3 = readonly [number, number, number];

export type ResolvedPrimitive =
  | { readonly kind: "box"; readonly center: Vec3; readonly size: Vec3 }
  | { readonly kind: "cylinder"; readonly center: Vec3; readonly radius: number; readonly height: number; readonly axis: "x" | "y" | "z" }
  | { readonly kind: "extrusion"; readonly profile: readonly Vec2[]; readonly z: number; readonly height: number };

export type ResolvedSymbol =
  | { readonly kind: "rect"; readonly center: Vec2; readonly size: Vec2 }
  | { readonly kind: "circle"; readonly center: Vec2; readonly radius: number }
  | { readonly kind: "line"; readonly from: Vec2; readonly to: Vec2 }
  | { readonly kind: "polyline"; readonly points: readonly Vec2[]; readonly closed: boolean }
  | { readonly kind: "text"; readonly at: Vec2; readonly text: string; readonly heightMm: number };

export interface ResolvedConnector {
  readonly id: string;
  readonly label: string;
  readonly domain: ConnectorDomain;
  readonly systemKind: SystemKind;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly shape: "rect" | "round" | "none";
  readonly width?: number;
  readonly height?: number;
  readonly diameter?: number;
  readonly flow?: number;
  readonly voltage?: number;
  readonly poles?: number;
  readonly loadClass?: string;
  readonly continuous?: boolean;
  readonly motorHp?: number;
  readonly intake?: IntakeKind;
  /** The connector's stored `values`, as typed (not resolved through parameters). */
  readonly values?: Readonly<Record<string, ParamValue>>;
  /** Its end type as stored (connections/end-types.ts). */
  readonly endType?: string;
}

/**
 * The type's 3D primitives with every parameter resolved, in the local frame.
 * A modeled part answers with one box per solid feature (its bounds), so
 * footprints, snapping and picking work without the geometry engine; drawing
 * and rendering use the real mesh (part-model/engine.ts).
 */
export function resolveGeometry(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>> = {}): ResolvedPrimitive[] {
  if (def.model) {
    return resolvePartModel(def.model, (d) => resolveDim(def, values, d)).featureBounds.map((b) => ({
      kind: "box",
      center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
      size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    }));
  }
  const r = (d: Dim) => resolveDim(def, values, d);
  const v3 = (t: readonly [Dim, Dim, Dim]): Vec3 => [r(t[0]), r(t[1]), r(t[2])];
  return def.geometry.map((p): ResolvedPrimitive => {
    if (p.kind === "box") return { kind: "box", center: v3(p.center), size: v3(p.size) };
    if (p.kind === "cylinder") return { kind: "cylinder", center: v3(p.center), radius: r(p.radius), height: r(p.height), axis: p.axis };
    return { kind: "extrusion", profile: p.profile.map(([x, y]) => ({ x: r(x), y: r(y) })), z: r(p.z), height: r(p.height) };
  });
}

export function resolveSymbol(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>> = {}): ResolvedSymbol[] {
  const r = (d: Dim) => resolveDim(def, values, d);
  const v2 = (t: readonly [Dim, Dim]): Vec2 => ({ x: r(t[0]), y: r(t[1]) });
  return def.symbol.map((s): ResolvedSymbol => {
    switch (s.kind) {
      case "rect":
        return { kind: "rect", center: v2(s.center), size: v2(s.size) };
      case "circle":
        return { kind: "circle", center: v2(s.center), radius: r(s.radius) };
      case "line":
        return { kind: "line", from: v2(s.from), to: v2(s.to) };
      case "polyline":
        return { kind: "polyline", points: s.points.map(v2), closed: s.closed };
      case "text":
        return { kind: "text", at: v2(s.at), text: s.text, heightMm: s.heightMm };
    }
  });
}

export function resolveConnectors(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>> = {}): ResolvedConnector[] {
  const r = (d: Dim | undefined) => (d === undefined ? undefined : resolveDim(def, values, d));
  return def.connectors.map((c) => ({
    id: c.id,
    label: c.label,
    domain: c.domain,
    systemKind: c.systemKind,
    position: [resolveDim(def, values, c.position[0]), resolveDim(def, values, c.position[1]), resolveDim(def, values, c.position[2])],
    direction: c.direction,
    shape: c.shape,
    ...(c.width !== undefined ? { width: r(c.width) } : {}),
    ...(c.height !== undefined ? { height: r(c.height) } : {}),
    ...(c.diameter !== undefined ? { diameter: r(c.diameter) } : {}),
    ...(c.flow !== undefined ? { flow: r(c.flow) } : {}),
    ...(c.voltage !== undefined ? { voltage: r(c.voltage) } : {}),
    ...(c.poles !== undefined ? { poles: c.poles } : {}),
    ...(c.loadClass !== undefined ? { loadClass: c.loadClass } : {}),
    ...(c.continuous !== undefined ? { continuous: c.continuous } : {}),
    ...(c.motorHp !== undefined ? { motorHp: r(c.motorHp) } : {}),
    ...(c.intake !== undefined ? { intake: c.intake } : {}),
    ...(c.values !== undefined ? { values: c.values } : {}),
    ...(c.endType !== undefined ? { endType: c.endType } : {}),
  }));
}

export interface LocalBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Local bounding box of the 3D primitives. */
export function localBounds(prims: readonly ResolvedPrimitive[]): LocalBox {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number) => {
    min[0] = Math.min(min[0] ?? Infinity, x);
    min[1] = Math.min(min[1] ?? Infinity, y);
    min[2] = Math.min(min[2] ?? Infinity, z);
    max[0] = Math.max(max[0] ?? -Infinity, x);
    max[1] = Math.max(max[1] ?? -Infinity, y);
    max[2] = Math.max(max[2] ?? -Infinity, z);
  };
  for (const p of prims) {
    if (p.kind === "box") {
      grow(p.center[0] - p.size[0] / 2, p.center[1] - p.size[1] / 2, p.center[2] - p.size[2] / 2);
      grow(p.center[0] + p.size[0] / 2, p.center[1] + p.size[1] / 2, p.center[2] + p.size[2] / 2);
    } else if (p.kind === "cylinder") {
      const h = p.height / 2;
      const ext: Vec3 = p.axis === "x" ? [h, p.radius, p.radius] : p.axis === "y" ? [p.radius, h, p.radius] : [p.radius, p.radius, h];
      grow(p.center[0] - ext[0], p.center[1] - ext[1], p.center[2] - ext[2]);
      grow(p.center[0] + ext[0], p.center[1] + ext[1], p.center[2] + ext[2]);
    } else {
      for (const q of p.profile) {
        grow(q.x, q.y, p.z);
        grow(q.x, q.y, p.z + p.height);
      }
    }
  }
  if (!Number.isFinite(min[0] ?? Infinity)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0], max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0] };
}

/** Local plan point → world plan point for a placed part. */
export function partToWorld(part: Pick<PartInstance, "position" | "rotationDeg">, local: Vec2): Vec2 {
  const a = (part.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: part.position.x + local.x * c - local.y * s, y: part.position.y + local.x * s + local.y * c };
}

/** Plan footprint corners (world) of a placed part's 3D bounds, for snapping, picking and selection boxes. */
export function partFootprint(type: PartTypeElement, part: PartInstance): Vec2[] {
  const b = localBounds(mountedGeometry(resolveGeometry(type.definition, part.values), part.mount));
  return [
    { x: b.min[0], y: b.min[1] },
    { x: b.max[0], y: b.min[1] },
    { x: b.max[0], y: b.max[1] },
    { x: b.min[0], y: b.max[1] },
  ].map((p) => partToWorld(part, p));
}

/** What a tag on the part reads: its tag fields joined, falling back to mark then type name. */
export function partTagText(type: PartTypeElement, part: PartInstance): string {
  const def = type.definition;
  const parts = def.tagFields
    .map((f) => {
      if (f === "mark") return part.mark;
      if (f === "type_name") return def.typeName;
      const v = paramValue(def, part.values, f);
      if (v === undefined || v === "") return "";
      const p = [...def.instanceParams, ...def.typeParams].find((x) => x.name === f);
      return formatParam(p, v);
    })
    .filter((s) => s.length > 0);
  if (parts.length > 0) return parts.join(" ");
  return part.mark || def.typeName;
}

const UNIT_SUFFIX: Readonly<Record<ParamUnit, string>> = LEGACY_PARAM_UNIT_SUFFIXES;

/** A stored unit's suffix: the v1 suffix for a v1 name, " <symbol>" for a unit code, nothing for anything else. */
function unitSuffix(unit: string): string {
  if (isLegacyParamUnit(unit)) return UNIT_SUFFIX[unit];
  return isUnitCode(unit) ? ` ${UNITS[unit].symbol}` : "";
}

/**
 * A pack parameter key in a part's `values` (`<pack>.<name>`, a
 * `PARAMETER_SET_POINT` row): beside the type's instance parameters, never one
 * of them (those are bare names). Written only to peers advertising
 * `PARTS_PACK_VALUES_FEATURE`.
 */
export const PACK_PARAMETER_KEY = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_.]*$/;

/** The protocol feature for part `values` carrying pack parameter keys. */
export const PARTS_PACK_VALUES_FEATURE = "parts:pack_values";

/** The protocol feature for part parameters stored with a unit code (not a v1 unit name). */
export const PARTS_UNIT_CODES_FEATURE = "parts:unit_codes";

/** A stored unit that is a unit code and not a v1 name (what only `PARTS_UNIT_CODES_FEATURE` peers read). */
export function isUnitCodeOnly(unit: string | undefined): boolean {
  return unit !== undefined && !isLegacyParamUnit(unit) && isUnitCode(unit);
}

/** Human-readable parameter value (lengths in feet-inches; others with their unit). */
export function formatParam(def: ParamDef | undefined, value: ParamValue): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (def?.kind === "length") return formatLengthImperial(value);
  if (def?.kind === "angle") return `${Math.round(value * 100) / 100}°`;
  const unit = def?.unit ?? "none";
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return `${rounded}${unitSuffix(unit)}`;
}

export function formatLengthImperial(mm: number): string {
  const totalIn = mm / 25.4;
  const sign = totalIn < 0 ? "-" : "";
  const abs = Math.abs(totalIn);
  let ft = Math.floor(abs / 12);
  let inches = Math.round((abs - ft * 12) * 4) / 4;
  if (inches >= 12) {
    ft += 1;
    inches = 0;
  }
  if (ft === 0) return `${sign}${inches}"`;
  return inches === 0 ? `${sign}${ft}'-0"` : `${sign}${ft}'-${inches}"`;
}

/**
 * The definition's group name (the editor's "part name"; the type name is the
 * size). The schema field keeps a legacy name until its data migration; new
 * code reads and writes it only through these helpers.
 */
type LegacyGroupField = "familyName";
export type PartDefinitionFields = Omit<PartTypeDefinition, LegacyGroupField>;

/** A definition's fields without its group name (agents and the editor send the name separately). */
export const partDefinitionFieldsSchema = partTypeDefinitionSchema.omit({ familyName: true });

export function partGroupName(def: PartTypeDefinition): string {
  return def.familyName;
}

/** A definition from a group name and the rest of its fields. */
export function partDefinition(groupName: string, fields: PartDefinitionFields): PartTypeDefinition {
  return { ...fields, familyName: groupName };
}

/** A copy of a definition with a new group name. */
export function withPartGroupName(def: PartTypeDefinition, name: string): PartTypeDefinition {
  return { ...def, familyName: name };
}
