import { z } from "zod";
import { finish, guard, refuse, type ExecuteResult } from "../command-core";
import { roundVec } from "../geometry";
import { activeClassRegistry } from "../registry";
import { builtinRegistry } from "../registry/builtin";
import { recognizes } from "../registry/recognition";
import { withPackParameters } from "../fields/pack-parameters";
import { PACK_PARAMETER_KEY, PARTS_PACK_VALUES_FEATURE } from "../parts";
import "../part-model/unit-gate";
import "./discipline-gate";
import "./class-refresh";
import "../routing/pipe/materials";
import { REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import { TrackedReader } from "../model";
import type { GeometricPlacement } from "../placement/geometric";
import { areaOf, lineCentreline, pathEnd } from "../placement/geometric-math";
import { tiedHeightMm, topTieOf, topTieRow, withTiedHeight } from "../placement/top-tie";
import { surfaceBindingWords, surfaceBoundPlacement } from "../placement/surface-bind";
import "../placement/surface-follow";
import { starterElementType, starterTypeRecord } from "./starter-types";
import { WALLS_TOP_CONSTRAINT_FEATURE } from "../contract-features";
import { executeLineEndCommand, isLineEndCommand, lineEndCommandSchemas } from "../joins/end-commands";
import { currentSchemaVersion } from "../schema-version/registry";
import { draftElements } from "../store";
import { strictCommands } from "../strict-commands";
import { GLOBAL_PARTITION } from "../partition";
import { OPENING_SILL_KEY, openingSillProblem } from "../hosting/rows";
import { asElementId, KNOWN_LOCK_STATES, type BimElement, type ElementId, type ElementTypeElement, type ModelState, type ParamValue, type PartInstance, type Vec2 } from "../types";
import { coreElementName, ELEMENT_CORE_KINDS, ELEMENT_TYPES_FEATURE, elementCoreWritable, elementName, peerReads, isClassifiedElement, isCoreElement, type ClassifiedElement, type CoreElement, type ElementCoreKind } from "./feature";
import { CREATE_COMMAND_TYPES, checkSurfaceBindings, createCommandSchemas, executeCreateCommand, isCreateCommand, surfaceBindingSchema, toBinding } from "./create";
import { withLockChange } from "./lock";
import { upgradeToElementCore } from "./upgrade";
import { ELEMENTS_LINKED_COPY_FEATURE } from "../reference-geometry/linked-copy-feature";

/**
 * Typed-element commands: set an element's class, type, values or geometric
 * placement, and lock or unlock it. Building and structure kinds only (walls,
 * slabs, openings, rooms, grids, columns, beams, components); parts keep
 * their own commands. Each writes the record at the current schema version,
 * so the edit and the quiet upgrade land as one change, and refuses while the
 * model server doesn't store element-core fields yet.
 */

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const paramKey = z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a parameter key (zz.section, material.layer_set)");
const paramValue = z.union([z.number().finite(), z.string().max(400), z.boolean()]);
const MAX_IDS = 500;
const MAX_POINTS = 2000;

const lateral = z.enum(["left", "center", "right"]);
const vertical = z.enum(["top", "center", "bottom"]);
const offset = z.number().finite().min(-1_000_000).max(1_000_000);

export const geometricPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), levelId: idSchema, position: vec2Schema, offsetMm: offset, rotationDeg: z.number().finite().min(-3600).max(3600) }).strict(),
  z
    .object({
      kind: z.literal("line"),
      levelId: idSchema,
      start: vec2Schema,
      end: vec2Schema,
      startOffsetMm: offset,
      endOffsetMm: offset,
      lateral,
      vertical,
      rollDeg: z.number().finite().min(-360).max(360).optional(),
      topLevelId: idSchema.optional(),
      topOffsetMm: offset.optional(),
      /** The top runs to a surface over the line instead of a level (never with topLevelId). The height follows it. */
      topSurface: surfaceBindingSchema.optional(),
      /** The base stands on a surface under the line; the start and end offsets are then worked out from it. */
      baseSurface: surfaceBindingSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      levelId: idSchema,
      start: vec2Schema,
      segments: z
        .array(z.discriminatedUnion("kind", [z.object({ kind: z.literal("line"), to: vec2Schema }).strict(), z.object({ kind: z.literal("arc"), to: vec2Schema, bulge: z.number().finite().min(-1e3).max(1e3) }).strict()]))
        .min(1)
        .max(MAX_POINTS),
      startStationMm: z.number().finite().optional(),
      profile: z.array(z.object({ stationMm: z.number().finite(), elevationMm: offset }).strict()).max(MAX_POINTS).optional(),
      offsetMm: offset,
      lateral,
    })
    .strict(),
  z
    .object({
      kind: z.literal("area"),
      levelId: idSchema,
      outline: z.array(vec2Schema).min(3).max(MAX_POINTS),
      holes: z.array(z.array(vec2Schema).min(3).max(MAX_POINTS)).max(200).optional(),
      offsetMm: offset,
      vertical,
      spanDirectionDeg: z.number().finite().min(-360).max(360).optional(),
      slope: z.object({ directionDeg: z.number().finite(), rise: z.number().finite().min(-10).max(10) }).strict().optional(),
    })
    .strict(),
]);

export const elementCommandSchemas = strictCommands([
  z.object({
    type: z.literal("set_element_class"),
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
    /** A class id (`zz.partition`); null clears an explicit class so recognition answers again. */
    classId: z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a class id (arch.wall, zz.partition)").nullable(),
  }),
  z.object({
    type: z.literal("set_element_type"),
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
    /** A type element in this model; null clears it. */
    typeId: idSchema.nullable(),
  }),
  z.object({
    type: z.literal("set_element_values"),
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
    /** By parameter key; null removes the value. */
    values: z.record(paramKey, paramValue.nullable()).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 80, { message: "between 1 and 80 values" }),
  }),
  z.object({
    type: z.literal("set_element_placement"),
    elementId: idSchema,
    /** Null clears the placement; the flat fields stay where they are. */
    placement: geometricPlacementSchema.nullable(),
    /** A line-placed kind with a height (a wall): its height when the placement ties no top level. A tied top sets the height itself. */
    heightMm: z.number().positive().max(100_000).optional(),
  }),
  z.object({
    type: z.literal("set_element_thickness"),
    /** Floors (slabs) and walls. A floor's top stays on its level and its underside moves; what runs to that underside follows. */
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
    thicknessMm: z.number().positive().max(10_000),
  }),
  z.object({
    type: z.literal("lock_elements"),
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
    state: z.enum(KNOWN_LOCK_STATES),
    reason: z.string().trim().min(1).max(300),
  }),
  z.object({
    type: z.literal("unlock_elements"),
    elementIds: z.array(idSchema).min(1).max(MAX_IDS),
  }),
  z.object({
    type: z.literal("create_element_type"),
    /** Chosen by the sender so a retried request makes the same type. */
    typeId: idSchema,
    name: z.string().trim().min(1).max(120),
    classId: z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a class id (zz.partition)").optional(),
    /** Kinds it may type (ceilings take types too: an acoustic tile, gypsum board, a rated assembly). Absent: any building or structure kind. */
    forKinds: z.array(z.enum([...ELEMENT_CORE_KINDS, "ceiling"])).min(1).max(9).optional(),
    values: z.record(paramKey, paramValue).refine((v) => Object.keys(v).length <= 80, { message: "at most 80 values" }).optional(),
  }),
  z.object({
    type: z.literal("set_element_linked_copy"),
    /** Per element: where it was copied from (a linked model's element at a version), or null to stop keeping it in step. */
    stamps: z
      .array(
        z
          .object({
            elementId: idSchema,
            stamp: z.object({ linkId: idSchema, globalId: z.string().min(1).max(100), version: z.string().min(1).max(300), fingerprint: z.string().min(1).max(64) }).strict().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_IDS),
  }),
  ...createCommandSchemas,
  ...lineEndCommandSchemas,
]);

export type ElementCommand = z.infer<(typeof elementCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(["set_element_class", "set_element_type", "set_element_values", "set_element_placement", "set_element_thickness", "lock_elements", "unlock_elements", "create_element_type", ...CREATE_COMMAND_TYPES, "move_line_end", "set_element_linked_copy"]);

export function isElementCommand(command: { readonly type: string }): command is ElementCommand {
  return TYPES.has(command.type);
}

export interface ElementCommandContext {
  /** Who is asking (recorded on a lock). */
  readonly actorId?: string;
}

/** Placement kinds each element kind takes. Openings are hosted: they move by their offset along the wall. */
const PLACEMENT_KINDS: Readonly<Record<ElementCoreKind, readonly GeometricPlacement["kind"][]>> = {
  wall: ["line", "path"],
  beam: ["line", "path"],
  grid: ["line", "path"],
  column: ["point", "line"],
  slab: ["area"],
  room: ["area"],
  component: ["point", "line", "path", "area"],
  opening: [],
};

const OLDER_SERVER = "can't take a class, type, values, placement or lock yet: the model server this model is open on is an older version that doesn't store them. Try again once the server is updated";

function writable(el: CoreElement | ClassifiedElement): void {
  if (!elementCoreWritable()) refuse("invalid_value", `${elementName(el)} ${OLDER_SERVER}`, [el.id]);
}

/** A building or structure element (types, placements and locks are theirs alone). */
function coreTarget(reader: TrackedReader, id: string): CoreElement {
  const el = reader.get(asElementId(id));
  if (!isCoreElement(el)) refuse("wrong_kind", `${id} is a ${el.kind.replace(/_/g, " ")}; types, placements and locks are for walls, slabs, openings, rooms, grids, columns, beams and components`, [el.id]);
  writable(el);
  return el;
}

/** Anything that takes a class: the building kinds, zones, spaces, systems, run segments and parts. */
function classTarget(reader: TrackedReader, id: string): CoreElement | ClassifiedElement {
  const el = reader.get(asElementId(id));
  if (!isCoreElement(el) && !isClassifiedElement(el)) refuse("wrong_kind", `${id} is a ${el.kind.replace(/_/g, " ")}; classes are for building elements, zones, spaces, systems, run segments and parts`, [el.id]);
  writable(el);
  return el;
}

/** Anything that takes element-core values: the building kinds, zones, spaces, systems and run segments. Parts take theirs through their type's parameters. */
function valuesTarget(reader: TrackedReader, id: string): CoreElement | ClassifiedElement {
  return classTarget(reader, id);
}

/**
 * A part's `values` hold its type's instance parameters (set_parameters) and,
 * beside them, pack parameters (`PARAMETER_SET_POINT`) that apply to the
 * part's class: its explicit class, else what the class registry in force
 * recognises it as. Each value is checked against the parameter's
 * definition; written only to peers advertising `parts:pack_values`.
 */
function packPartValueRefusal(model: ModelState, part: PartInstance, key: string, value: ParamValue | null): string | null {
  if (!PACK_PARAMETER_KEY.test(key)) return `${key} is a parameter of ${elementName(part)}'s type; set it with set_parameters`;
  const registry = withPackParameters(builtinRegistry());
  const classes = part.classId !== undefined ? [part.classId] : registry.listClasses().filter((c) => recognizes(c, part, model.elements)).map((c) => c.id);
  const field = classes.map((c) => registry.field(c, key)).find((f) => f !== undefined);
  if (!field) return `${key} isn't a parameter of ${elementName(part)}'s class${classes.length > 0 ? ` (${classes.join(", ")})` : ""}; give the part a class the parameter's pack applies to, or add the pack that defines it`;
  if (value === null) return null;
  switch (field.valueType) {
    case "quantity":
      return typeof value === "number" && Number.isFinite(value) ? null : `${field.label} is a number${field.unit ? ` in ${field.unit}` : ""}`;
    case "boolean":
      return typeof value === "boolean" ? null : `${field.label} is yes or no`;
    case "choice":
      return typeof value === "string" && (field.choices ?? []).includes(value) ? null : `${field.label} is one of ${(field.choices ?? []).join(", ")}`;
    default:
      return typeof value === "string" ? null : `${field.label} is text`;
  }
}

/** The record as it is about to be written: upgraded (class recognised) and at the current version, so the edit and the upgrade are one change. */
function current<T extends CoreElement | ClassifiedElement>(el: T): T;
function current(el: CoreElement | ClassifiedElement): CoreElement | ClassifiedElement {
  // Classified kinds have no per-record upgrade (a stored recognised class would freeze a part's class against its type's category).
  if (!isCoreElement(el)) return el;
  const upgraded = upgradeToElementCore(el);
  const at = currentSchemaVersion(el.kind);
  const next = isCoreElement(upgraded) ? upgraded : el;
  return next.schemaVersion === at ? next : { ...next, schemaVersion: at };
}

type CoreField = "classId" | "typeId" | "values" | "placement" | "locked" | "classSource" | "provenance";

function without<T extends CoreElement | ClassifiedElement>(el: T, key: CoreField): T {
  const out: Record<string, unknown> = { ...el };
  delete out[key];
  return out as T; // the same record less one optional field
}

type PlacementInput = z.infer<typeof geometricPlacementSchema>;

/** The command's placement with its level ids as element ids. */
function toPlacement(p: PlacementInput): GeometricPlacement {
  const levelId = asElementId(p.levelId);
  switch (p.kind) {
    case "point":
      return { ...p, levelId };
    case "line": {
      const { topLevelId, topOffsetMm, topSurface, baseSurface, ...rest } = p;
      return {
        ...rest,
        levelId,
        ...(topLevelId !== undefined ? { topLevelId: asElementId(topLevelId), ...(topOffsetMm ? { topOffsetMm } : {}) } : {}),
        ...(topSurface ? { topSurface: toBinding(topSurface) } : {}),
        ...(baseSurface ? { baseSurface: toBinding(baseSurface) } : {}),
      };
    }
    case "path":
      return { ...p, levelId };
    case "area":
      return { ...p, levelId };
  }
}

/**
 * Why `classId` can't be set on `el`, or null when it can: it must be a class
 * of the registry in force (the kernel's plus the model's packs'), not a
 * grouping class, and one whose recognition admits the element's kind when it
 * names kinds. Firm classes (`firm:`) live in the host's library, not the pack
 * set, so they pass on shape.
 */
/** Namespaces only the kernel's own classes use: no pack adds to them. */
const KERNEL_CLASS_NAMESPACES: ReadonlySet<string> = new Set(["arch", "mep", "gen", "doc"]);

function classRefusal(classId: string, el: CoreElement | ClassifiedElement): string | null {
  if (classId.startsWith("firm:")) return null;
  const cls = activeClassRegistry().getClass(classId);
  if (!cls) {
    const ns = classId.includes(".") ? (classId.split(".")[0] ?? "") : null;
    if (ns === null) return `"${classId}" isn't a class: a class id has a namespace (arch.wall, zz.partition)`;
    if (KERNEL_CLASS_NAMESPACES.has(ns)) return `"${classId}" isn't one of the model's ${ns} classes`;
    return `"${classId}" isn't a class this model knows: add the pack that defines ${ns} classes to the model, or choose a class it has`;
  }
  if (cls.abstract) return `${cls.label} is a grouping of classes, not one to give an element; choose one of its classes`;
  const kinds = cls.recognize?.elementKinds ?? [];
  if (el.kind === "element_type") {
    // A type's class is its instances' class: it must admit the kinds the type is for.
    const admitted: ReadonlySet<string> = new Set(kinds);
    const outside = kinds.length > 0 ? (el.forKinds ?? []).filter((k) => !admitted.has(k)) : [];
    return outside.length > 0 ? `${cls.label} is a class of ${kinds.map((k) => `${k.replace(/_/g, " ")}s`).join(" and ")}; ${elementName(el)} is for ${outside.map((k) => `${k}s`).join(" and ")}` : null;
  }
  const forParts = el.kind === "part" && (cls.recognize?.partCategories?.length ?? 0) > 0;
  if (kinds.length > 0 && !kinds.includes(el.kind) && !forParts) return `${cls.label} is a class of ${kinds.map((k) => `${k.replace(/_/g, " ")}s`).join(" and ")}; ${elementName(el)} is a ${el.kind.replace(/_/g, " ")}`;
  return null;
}

const sameVec = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/** The element with `placement` written and its flat fields mirrored, so a reader that knows only the flat fields sees the same geometry. */
function placed(el: CoreElement, p: GeometricPlacement): CoreElement {
  const r = (v: Vec2): Vec2 => roundVec(v);
  switch (el.kind) {
    case "wall":
    case "beam":
    case "grid": {
      if (p.kind === "line") {
        // A wall's flat start and end are its centreline; beams and grids keep the placement line.
        const c = el.kind === "wall" ? lineCentreline(p, el.thickness) : null;
        const start = c ? { x: c.start.x, y: c.start.y } : p.start;
        const end = c ? { x: c.end.x, y: c.end.y } : p.end;
        return { ...el, placement: p, start: r(start), end: r(end) };
      }
      if (p.kind === "path") return { ...el, placement: p, start: r(p.start), end: r(pathEnd(p)) };
      return el;
    }
    case "column":
      return { ...el, placement: p, position: r(p.kind === "point" ? p.position : p.kind === "line" ? p.start : el.position) };
    case "slab":
      return p.kind === "area" ? { ...el, placement: p, outline: p.outline.map(r) } : el;
    case "room": {
      if (p.kind !== "area") return el;
      const area = areaOf(p).planAreaMm2;
      return { ...el, placement: p, outline: p.outline.map(r), areaSqM: Math.round((area / 1e6) * 100) / 100 };
    }
    case "component": {
      if (p.kind === "point") return { ...el, placement: p, position: r(p.position), rotationDeg: p.rotationDeg };
      if (p.kind === "line") return { ...el, placement: p, position: r({ x: (p.start.x + p.end.x) / 2, y: (p.start.y + p.end.y) / 2 }), rotationDeg: (Math.atan2(p.end.y - p.start.y, p.end.x - p.start.x) * 180) / Math.PI };
      if (p.kind === "path") return { ...el, placement: p, position: r(p.start) };
      const centroid = areaOf(p).centroid;
      return { ...el, placement: p, position: r(centroid ?? el.position) };
    }
    case "opening":
      return el;
  }
}

function checkPlacement(reader: TrackedReader, el: CoreElement, p: GeometricPlacement): void {
  const allowed = PLACEMENT_KINDS[el.kind];
  const name = coreElementName(el);
  if (allowed.length === 0) refuse("unsupported_geometry", `${name} sits in its wall; move it along the wall instead of placing it`, [el.id]);
  if (!allowed.includes(p.kind)) refuse("unsupported_geometry", `${name} can't be placed as ${p.kind === "area" ? "an area" : `a ${p.kind}`}; it takes ${allowed.map((k) => (k === "area" ? "an area" : `a ${k}`)).join(" or ")}`, [el.id]);
  const level = reader.find(asElementId(p.levelId));
  if (level?.kind !== "level") refuse("element_not_found", `${name} can't be placed on ${p.levelId}: it isn't a level in this model`, [el.id]);
  if (p.kind === "line" && p.topLevelId !== undefined && reader.find(asElementId(p.topLevelId))?.kind !== "level") refuse("element_not_found", `${name}'s top level ${p.topLevelId} isn't a level in this model`, [el.id]);
  if (p.kind === "line") checkSurfaceBindings(reader, el.kind, name, el.id, p);
  if (p.kind === "line" && sameVec(p.start, p.end)) refuse("invalid_value", `${name} would start and end at the same point`, [el.id]);
  if (p.kind === "path" && p.profile) {
    for (let i = 1; i < p.profile.length; i++) {
      const a = p.profile[i - 1];
      const b = p.profile[i];
      if (a && b && b.stationMm <= a.stationMm) refuse("invalid_value", `${name}'s profile stations must go up along the path (${b.stationMm} mm comes after ${a.stationMm} mm)`, [el.id]);
    }
  }
  if (p.kind === "area" && areaOf(p).planAreaMm2 <= 0) refuse("invalid_value", `${name}'s outline, less its holes, has no area`, [el.id]);
}

function levelName(reader: TrackedReader, id: ElementId): string {
  const l = reader.find(id);
  return l?.kind === "level" ? l.name : id;
}

/**
 * The placed element's body height: a tied top writes it from the two
 * levels (refused when the top isn't above the base); otherwise `heightMm`,
 * when given, is its own height.
 */
function withTopOrHeight(reader: TrackedReader, el: CoreElement, heightMm: number | undefined): CoreElement {
  const p = topTieOf(el);
  const row = topTieRow(el.kind);
  const name = coreElementName(el);
  const line = el.placement?.kind === "line" ? el.placement : null;
  if (line?.topSurface) {
    if (heightMm !== undefined) refuse("invalid_value", `${name}'s top follows ${surfaceBindingWords(line.topSurface)}; leave the height out, or give it a set height to type one`, [el.id]);
    // Its height is worked out from the surface when the edit finishes (`placement/surface-follow.ts`).
    return el;
  }
  if (p && p.topLevelId !== undefined) {
    if (!row) refuse("invalid_value", `${name} can't be tied to a level: its kind keeps no height to follow one`, [el.id]);
    if (heightMm !== undefined) refuse("invalid_value", `${name}'s top follows ${levelName(reader, p.topLevelId)}; leave the height out, or untie its top to type one`, [el.id]);
    const elevation = (id: ElementId) => {
      const l = reader.find(id);
      return l?.kind === "level" ? l.elevationMm : null;
    };
    const tied = withTiedHeight(el, elevation);
    if (tied === null && tiedHeightMm(p, elevation) === null) refuse("invalid_value", `${levelName(reader, p.topLevelId)} isn't above ${levelName(reader, p.levelId)}, so ${name} would have no height; pick a level above it`, [el.id]);
    const next = tied && isCoreElement(tied) ? tied : el;
    // A peer that doesn't store ties (`walls:top_constraint`) is sent the height it works out to.
    if (peerReads(WALLS_TOP_CONSTRAINT_FEATURE) || next.placement?.kind !== "line") return next;
    const { topLevelId: _top, topOffsetMm: _offset, ...untied } = next.placement;
    return { ...next, placement: untied };
  }
  if (heightMm === undefined) return el;
  if (!row) refuse("invalid_value", `${name} takes no height`, [el.id]);
  const next = row.withHeight(el, Math.round(heightMm));
  return isCoreElement(next) ? next : el;
}

function withoutProfile(el: Extract<CoreElement, { kind: "wall" }>): CoreElement {
  const { bodyProfile: _profile, ...rest } = el;
  return rest;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A new shared type for building and structure elements, gated on `elements:types`. */
function createElementType(reader: TrackedReader, working: Record<string, BimElement>, command: Extract<ElementCommand, { type: "create_element_type" }>): ExecuteResult {
  const id = asElementId(command.typeId);
  if (reader.find(id)) refuse("already_exists", `${command.typeId} already exists; choose a new id`, [id]);
  if (!peerReads(ELEMENT_TYPES_FEATURE)) refuse("invalid_value", `The type ${command.name} can't be saved yet: the model server this model is open on is an older version that doesn't store element types. Try again once the server is updated`);
  const type: ElementTypeElement = {
    id,
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    kind: "element_type",
    name: command.name,
    ...(command.forKinds ? { forKinds: command.forKinds } : {}),
    ...(command.values ? { values: command.values } : {}),
  };
  if (command.classId !== undefined) {
    const why = classRefusal(command.classId, type);
    if (why) refuse("invalid_value", why);
  }
  working[id] = command.classId !== undefined ? { ...type, classId: command.classId } : type;
  return finish(reader, working, [id], [], () => [], { summary: [`Made the type ${command.name}`] });
}

export function executeElementCommand(model: ModelState, command: ElementCommand, context: ElementCommandContext = {}): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const write = (el: CoreElement | ClassifiedElement, next: CoreElement | ClassifiedElement): void => {
      working[el.id] = next;
      touched.push(el.id);
    };
    if (command.type === "create_element_type") return createElementType(reader, working, command);
    if (isCreateCommand(command)) return executeCreateCommand(reader, working, command);
    if (isLineEndCommand(command)) return executeLineEndCommand(reader, working, command);
    if (command.type === "set_element_linked_copy") {
      if (!peerReads(ELEMENTS_LINKED_COPY_FEATURE)) refuse("invalid_value", "Copies of the linked model's elements can't be kept in step yet: the model server this model is open on is an older version. Try again once it is updated");
      for (const { elementId, stamp } of command.stamps) {
        const el = coreTarget(reader, elementId);
        const base = current(el);
        const { linkedCopy: _drop, ...rest } = base.provenance ?? {};
        const provenance = stamp ? { ...rest, ifcGlobalId: stamp.globalId, linkedCopy: stamp } : rest;
        write(el, Object.keys(provenance).length === 0 ? without(base, "provenance") : { ...base, provenance });
      }
      const n = command.stamps.length;
      const cleared = command.stamps.every((s) => s.stamp === null);
      return finish(reader, working, touched, [], () => [], { summary: [cleared ? `Stopped keeping ${plural(n, "element")} in step with the linked model` : `Kept ${plural(n, "element")} in step with the linked model`] });
    }
    const ids = command.type === "set_element_placement" ? [command.elementId] : [...new Set(command.elementIds)];
    const core = (): CoreElement[] => ids.map((id) => coreTarget(reader, id));
    let summary: string;
    switch (command.type) {
      case "set_element_class": {
        const targets = ids.map((id) => classTarget(reader, id));
        for (const el of targets) {
          const why = command.classId === null ? null : classRefusal(command.classId, el);
          if (why) refuse("invalid_value", why, [el.id]);
          const base = current(el);
          // An explicit class (or clearing one) is the person's: recognition never refreshes it.
          const plain = without(base, "classSource");
          write(el, command.classId === null ? without(plain, "classId") : { ...plain, classId: command.classId });
        }
        summary = command.classId === null ? `Cleared the class of ${plural(targets.length, "element")}` : `Set ${plural(targets.length, "element")} to class ${command.classId}`;
        break;
      }
      case "set_element_type": {
        const targets = core();
        let adopted: string | null = null;
        if (command.typeId !== null) {
          const existing = reader.find(asElementId(command.typeId));
          const starter = existing ? null : starterElementType(command.typeId);
          let found = existing;
          if (starter) {
            const wrongVariant = starter.variant === undefined ? undefined : targets.find((t) => t.kind === "opening" && t.openingType !== starter.variant);
            if (wrongVariant) refuse("invalid_value", `${starter.name} is a ${starter.variant?.replace(/_/g, " ")} type; ${coreElementName(wrongVariant)} isn't one`, [wrongVariant.id]);
            // A starter type the model doesn't have yet comes with the change, so one Undo takes both away.
            if (!peerReads(ELEMENT_TYPES_FEATURE)) refuse("invalid_value", `The type ${starter.name} can't be added yet: the model server this model is open on is an older version that doesn't store element types. Try again once the server is updated`);
            const record = starterTypeRecord(starter);
            working[record.id] = record;
            touched.push(record.id);
            found = record;
            adopted = `Added the type ${starter.name} (${starter.description}) from the starter list`;
          }
          const type = found;
          if (!type) refuse("element_not_found", `${command.typeId} isn't a type in this model`);
          const self = targets.find((t) => t.id === type.id);
          if (self) refuse("invalid_value", `${coreElementName(self)} can't be its own type`, [type.id]);
          if (type.kind === "element_type" && type.forKinds) {
            const wrong = targets.find((t) => !type.forKinds?.includes(t.kind));
            if (wrong) refuse("invalid_value", `${type.name} is a type for ${type.forKinds.map((k) => `${k}s`).join(" and ")}; ${coreElementName(wrong)} is a ${wrong.kind}`, [wrong.id]);
          }
        }
        for (const el of targets) {
          const base = current(el);
          write(el, command.typeId === null ? without(base, "typeId") : { ...base, typeId: asElementId(command.typeId) });
        }
        summary = command.typeId === null ? `Cleared the type of ${plural(targets.length, "element")}` : `Set the type of ${plural(targets.length, "element")}${adopted ? `. ${adopted}` : ""}`;
        break;
      }
      case "set_element_values": {
        const targets = ids.map((id) => valuesTarget(reader, id));
        for (const el of targets) {
          if (el.kind === "part") {
            for (const [k, v] of Object.entries(command.values)) {
              const why = packPartValueRefusal(model, el, k, v);
              if (why) refuse("invalid_value", why, [el.id]);
            }
            if (!peerReads(PARTS_PACK_VALUES_FEATURE)) refuse("invalid_value", `${elementName(el)} can't take pack parameters yet: the model server this model is open on is an older version that doesn't store them. Try again once the server is updated`, [el.id]);
            const values: Record<string, ParamValue> = { ...el.values };
            for (const [k, v] of Object.entries(command.values)) {
              if (v === null) delete values[k];
              else values[k] = v;
            }
            write(el, { ...el, values });
            continue;
          }
          const base = current(el);
          const values: Record<string, ParamValue> = { ...(base.values ?? {}) };
          for (const [k, v] of Object.entries(command.values)) {
            if (v === null) delete values[k];
            else values[k] = v;
          }
          // A door or window's sill has to leave it inside its wall.
          const sill = command.values[OPENING_SILL_KEY];
          if (base.kind === "opening" && sill !== undefined && sill !== null) {
            const host = reader.find(asElementId(base.hostId));
            const what = `${base.openingType.replace(/_/g, " ")}${base.mark ? ` ${base.mark}` : ""}`;
            const why = typeof sill === "number" ? openingSillProblem(what, sill, base.height, host && (isCoreElement(host) || isClassifiedElement(host)) ? elementName(host) : "its wall", host?.kind === "wall" ? host.height : null) : `The ${what}'s sill height is a length in mm`;
            if (why) refuse("invalid_value", why, [base.id]);
          }
          write(el, Object.keys(values).length === 0 ? without(base, "values") : { ...base, values });
        }
        summary = `Set ${plural(Object.keys(command.values).length, "value")} on ${plural(targets.length, "element")}`;
        break;
      }
      case "set_element_placement": {
        const el = core()[0];
        if (!el) refuse("element_not_found", `${command.elementId} doesn't exist`);
        const base = current(el);
        if (command.placement === null) {
          write(el, without(base, "placement"));
          summary = `Cleared the placement of ${coreElementName(el)}`;
          break;
        }
        const p = toPlacement(command.placement);
        checkPlacement(reader, el, p);
        const tied = withTopOrHeight(reader, placed(base, p), command.heightMm);
        // Unbound now: the body profile its surfaces gave goes with them.
        const next = tied.kind === "wall" && tied.bodyProfile !== undefined && !surfaceBoundPlacement(tied) ? withoutProfile(tied) : tied;
        write(el, next);
        summary = p.kind === "line" && p.topSurface ? `${coreElementName(el)}'s top now runs to ${surfaceBindingWords(p.topSurface)}` : p.kind === "line" && p.topLevelId !== undefined ? `${coreElementName(el)} now runs up to ${levelName(reader, p.topLevelId)}` : command.heightMm !== undefined ? `${coreElementName(el)} is now ${Math.round(command.heightMm)} mm tall, not tied to a level` : `Placed ${coreElementName(el)} as ${p.kind === "area" ? "an area" : `a ${p.kind}`}`;
        break;
      }
      case "set_element_thickness": {
        const targets = core();
        const t = Math.round(command.thicknessMm * 10) / 10;
        for (const el of targets) {
          const base = current(el);
          if (base.kind === "slab") write(el, { ...base, thickness: t });
          else if (base.kind === "wall") {
            const thick = { ...base, thickness: t };
            // A wall placed by a face keeps that face where it is; its centreline moves with the new thickness.
            write(el, thick.placement ? placed(thick, thick.placement) : thick);
          } else refuse("wrong_kind", `${coreElementName(el)} has no thickness to set; floors and walls do`, [el.id]);
        }
        summary = `Set ${plural(targets.length, "element")} to ${t} mm thick`;
        break;
      }
      case "lock_elements":
      case "unlock_elements": {
        const targets = core();
        for (const el of targets) {
          const base = current(el);
          if (command.type === "lock_elements") write(el, { ...base, locked: { state: command.state, reason: command.reason, ...(context.actorId !== undefined ? { by: context.actorId } : {}) } });
          else if (el.locked !== undefined) write(el, without(base, "locked"));
        }
        const first = targets[0];
        if (touched.length === 0) refuse("invalid_value", targets.length === 1 && first ? `${coreElementName(first)} isn't locked` : "None of those elements is locked");
        summary = command.type === "lock_elements" ? `Locked ${plural(targets.length, "element")} as ${command.state === "existing" ? "existing conditions" : "issued work"}` : `Unlocked ${plural(touched.length, "element")}`;
        return withLockChange(touched, () => finish(reader, working, touched, [], () => [], { summary: [summary] }));
      }
    }
    return finish(reader, working, touched, [], () => [], { summary: [summary] });
  });
}

/** For callers that hold a record, not a model: whether it carries any element-core field. */
export function hasElementCore(el: BimElement): boolean {
  return isCoreElement(el) && (el.classId !== undefined || el.typeId !== undefined || el.values !== undefined || el.placement !== undefined || el.locked !== undefined || el.provenance !== undefined);
}
