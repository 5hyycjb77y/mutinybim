import { z } from "zod";
import { finish, refuse, type ExecuteResult } from "../command-core";
import { gridAxisFamily } from "../datums/rows";
import { nextGridLabel } from "../datums/grid-labels";
import type { ReferencePlane } from "../datums/reference-plane";
import { roundVec } from "../geometry";
import { REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import type { TrackedReader } from "../model";
import { OPENING_SILL_KEY, hostLineOf, openingSillProblem } from "../hosting/rows";
import { hostedIds } from "../qto/hosted";
import { SURFACE_BIND_TARGETS, type GeometricPlacement, type LinePlacement, type SurfaceBinding } from "../placement/geometric";
import { surfaceFaceRow } from "../surfaces/faces";
import { MIN_TIED_HEIGHT_MM, tiedHeightMm, topTieRow } from "../placement/top-tie";
import { areaOf } from "../placement/geometric-math";
import { activeClassRegistry } from "../registry";
import { builtinRegistry } from "../registry/builtin";
import { kindRowOf } from "../kinds/rows";
import { currentSchemaVersion } from "../schema-version/registry";
import { elementsOfKind } from "../store";
import { asElementId, type BimElement, type Beam, type Column, type ElementId, type ElementTypeElement, type GridLine, type Level, type Opening, type ParamValue, type Partition, type Slab, type Vec2, type Wall } from "../types";
import { ELEMENTS_CREATE_FEATURE } from "./create-feature";
import { ELEMENT_TYPES_FEATURE, isCoreElement, peerReads, type CoreElement } from "./feature";
import { starterElementType, starterTypeRecord } from "./starter-types";
import { WALLS_TOP_CONSTRAINT_FEATURE } from "../contract-features";
import { upgradeToElementCore } from "./upgrade";

/**
 * The create family (contract 1.11.0, feature `elements:create`): draw a
 * line-, area- or point-placed kind on a level (`create_element`), a chain of
 * line-placed elements whose ends meet (`create_elements`), or a kind hosted
 * in another element (`create_hosted`). Written only to peers advertising
 * `elements:create`; undo removes exactly what was made.
 */

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const kindSchema = z.string().min(1).max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "an element kind (wall, grid, reference_plane, a pack's zz.partition)");
const paramKey = z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "a parameter key (zz.section, material.layer_set)");
const valuesSchema = z
  .record(paramKey, z.union([z.number().finite(), z.string().max(400), z.boolean()]))
  .refine((v) => Object.keys(v).length <= 80, { message: "at most 80 values" });
const MAX_POINTS = 500;

/** Sizes a drawn element takes, in mm. Which apply depends on the kind (a wall's thickness and height, a column's width and depth). */
const sizeSchema = z
  .object({
    thicknessMm: z.number().positive().max(10_000).optional(),
    heightMm: z.number().positive().max(100_000).optional(),
    widthMm: z.number().positive().max(100_000).optional(),
    depthMm: z.number().positive().max(100_000).optional(),
  })
  .strict();

/** A top or base bound to a surface: the structure above, a ceiling, a roof, or the floor under it; one element's face when `elementId` is given. */
export const surfaceBindingSchema = z
  .object({
    /** structure: the underside of the slab, deck or roof over it; ceiling: a ceiling's underside; roof: a roof's underside; floor: the top of what it stands on. */
    to: z.enum(SURFACE_BIND_TARGETS),
    /** That one slab, ceiling or roof. Absent: whatever is found over (or under) the line. */
    elementId: idSchema.optional(),
    /** With elementId: its top or underside. Absent: top for floor, else underside. */
    face: z.enum(["top", "underside"]).optional(),
    /** mm above (negative: below) the face. */
    offsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
  })
  .strict();

/** A binding as stored: its element id typed, a zero offset left out. */
export function toBinding(b: z.infer<typeof surfaceBindingSchema>): SurfaceBinding {
  return { to: b.to, ...(b.elementId !== undefined ? { elementId: asElementId(b.elementId) } : {}), ...(b.face ? { face: b.face } : {}), ...(b.offsetMm ? { offsetMm: b.offsetMm } : {}) };
}

/** Refuses, in words, a top or base binding that can't be read: both a level and a surface, a face no element offers, a kind with no height. */
export function checkSurfaceBindings(reader: TrackedReader, kind: string, name: string, id: ElementId, p: { readonly topLevelId?: string; readonly topSurface?: SurfaceBinding; readonly baseSurface?: SurfaceBinding }): void {
  if (!p.topSurface && !p.baseSurface) return;
  if (!topTieRow(kind)) refuse("invalid_value", `${name} keeps no height, so its top and base can't follow a surface; leave them out`, [id]);
  if (p.topLevelId !== undefined && p.topSurface) refuse("invalid_value", `${name}'s top runs up to a level or to a surface, not both; leave one out`, [id]);
  if (p.topSurface?.to === "floor" && p.topSurface.elementId === undefined) refuse("invalid_value", `A top runs to the structure above, a ceiling or a roof; "floor" is for a base`, [id]);
  if (p.baseSurface && p.baseSurface.to !== "floor" && p.baseSurface.elementId === undefined) refuse("invalid_value", `A base stands on the floor under it ("floor"), or on one element's face; give its elementId`, [id]);
  for (const b of [p.topSurface, p.baseSurface]) {
    if (b?.elementId === undefined) continue;
    const found = reader.find(b.elementId);
    if (!found) refuse("element_not_found", `${b.elementId} isn't in this model, so ${name} can't run to it`, [id]);
    if (!surfaceFaceRow(found.kind)) refuse("invalid_value", `${b.elementId} is a ${found.kind.replace(/_/g, " ")}; it has no top or underside to run to (floors, ceilings and roofs do)`, [id, found.id]);
  }
}

const drawPlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("point"), position: vec2Schema, rotationDeg: z.number().finite().min(-3600).max(3600).optional() }).strict(),
  z.object({ kind: z.literal("line"), start: vec2Schema, end: vec2Schema }).strict(),
  z.object({ kind: z.literal("area"), outline: z.array(vec2Schema).min(3).max(2000), holes: z.array(z.array(vec2Schema).min(3).max(2000)).max(200).optional() }).strict(),
]);

const common = {
  kind: kindSchema,
  typeId: idSchema.optional(),
  values: valuesSchema.optional(),
  size: sizeSchema.optional(),
  /** A name or label (a grid's "A", a reference plane's "Face of slab edge"). Absent: a grid takes the next label. */
  label: z.string().trim().min(1).max(120).optional(),
  /** Line-drawn kinds with a height (a wall): the level the top runs up to, so the height follows both levels. Absent: `size.heightMm`. */
  topLevelId: idSchema.optional(),
  /** With `topLevelId`: how far above (negative: below) that level the top sits. */
  topOffsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
  /** Line-drawn kinds with a height: the top runs to a surface over the line instead of a level (the structure above, a ceiling, a roof). The height follows it. */
  topSurface: surfaceBindingSchema.optional(),
  /** Line-drawn kinds with a height: the base stands on the floor under the line (or one element's face). */
  baseSurface: surfaceBindingSchema.optional(),
  /** Line-drawn kinds with a height: how far above its level the base stands (never beside baseSurface, which carries its own offset). */
  baseOffsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
};

export const createCommandSchemas = [
  z.object({
    type: z.literal("create_element"),
    /** Chosen by the sender so a retried request makes the same element. */
    elementId: idSchema,
    levelId: idSchema,
    placement: drawPlacementSchema,
    ...common,
  }),
  z.object({
    type: z.literal("create_elements"),
    /** The elements are `<idPrefix>-1`, `<idPrefix>-2`… along the chain. */
    idPrefix: idSchema,
    levelId: idSchema,
    /** Corners in order; each element runs from one to the next, so neighbours share an end. */
    points: z.array(vec2Schema).min(2).max(MAX_POINTS),
    /** Join the last corner back to the first. */
    closed: z.boolean().optional(),
    ...common,
  }),
  z.object({
    type: z.literal("create_hosted"),
    elementId: idSchema,
    kind: kindSchema,
    hostId: idSchema,
    /** Centre distance along the host from its start, mm. */
    s: z.number().finite().min(0).max(1_000_000),
    /** Which side of the host it faces: 1 left of the host's direction, -1 right. */
    side: z.union([z.literal(1), z.literal(-1)]),
    typeId: idSchema.optional(),
    /** An opening's door or window. */
    openingType: z.string().trim().min(1).max(40).optional(),
    mark: z.string().trim().max(40).optional(),
    values: valuesSchema.optional(),
    size: sizeSchema.optional(),
  }),
] as const;

type CreateElement = z.infer<(typeof createCommandSchemas)[0]>;
type CreateElements = z.infer<(typeof createCommandSchemas)[1]>;
type CreateHosted = z.infer<(typeof createCommandSchemas)[2]>;
export type CreateCommand = CreateElement | CreateElements | CreateHosted;

export const CREATE_COMMAND_TYPES: readonly string[] = ["create_element", "create_elements", "create_hosted"];

type DrawPlacement = CreateElement["placement"];
type Common = Pick<CreateElement, "kind" | "typeId" | "values" | "size" | "label" | "topLevelId" | "topOffsetMm" | "topSurface" | "baseSurface" | "baseOffsetMm">;

/** How each kernel kind is drawn: on a line, an area or a point. Kinds missing here are made by their own commands. */
const DRAWN: Readonly<Record<string, "line" | "area" | "point">> = {
  wall: "line",
  beam: "line",
  grid: "line",
  reference_plane: "line",
  slab: "area",
  column: "point",
};

/** Kernel kinds with their own command, so the refusal can say which. */
const OWN_COMMAND: Readonly<Record<string, string>> = {
  level: "create_level",
  space: "create_space",
  zone: "create_zone",
  ceiling: "create_ceiling",
  element_type: "create_element_type",
  view: "create_view",
  sheet: "create_sheet",
  mounting_plane: "create_mounting_plane",
  load_point: "create_load_point",
  opening: "create_hosted",
};

/** Sizes a drawn element starts with when the command names none; its type's values and the inspector change them. */
const DEFAULTS = { wallThicknessMm: 150, wallHeightMm: 3048, slabThicknessMm: 200, columnSizeMm: 300, columnMaterial: "concrete" } as const;

function words(kind: string): string {
  return kindRowOf(kind)?.label ?? kind.replace(/_/g, " ");
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `An ${word.toLowerCase()}` : `A ${word.toLowerCase()}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word.toLowerCase()}${n === 1 ? "" : "s"}`;
}

/** The kernel kind as drawn here, or a refusal that says how it is made instead. */
function drawnAs(kind: string, as: "line" | "area" | "point" | "chain"): "line" | "area" | "point" {
  let drawn: "line" | "area" | "point" | undefined = DRAWN[kind];
  if (drawn === undefined) {
    const row = kindRowOf(kind);
    if (!row) refuse("invalid_value", `There is no "${kind}" kind in this model; draw a wall, grid, reference plane, beam, slab or column, or add the add-on that defines ${kind}`);
    const own = OWN_COMMAND[kind];
    if (own) refuse("invalid_value", `${row.label}s aren't drawn here; make one with ${own}`);
    const face = row.create;
    if (!face) refuse("invalid_value", `${row.label}s can't be drawn yet: the add-on that defines them doesn't say how to make one`);
    const wanted = as === "chain" ? "line" : as;
    if (!face.placements.includes(wanted)) {
      const ways = face.placements.map((p) => (p === "area" ? "as an area" : `on a ${p}`)).join(" or ");
      refuse("unsupported_geometry", as === "chain" ? `${row.label}s aren't drawn as a chain; they are drawn ${ways}` : `${article(row.label)} is drawn ${ways}, not ${as === "area" ? "as an area" : `on a ${as}`}`);
    }
    drawn = wanted;
    return drawn;
  }
  if (as === "chain" && drawn !== "line") refuse("unsupported_geometry", `${words(kind)}s aren't drawn as a chain; a chain is for elements drawn on a line (walls, beams, grid lines, reference planes)`);
  if (as !== "chain" && as !== drawn) refuse("unsupported_geometry", `${article(words(kind))} is drawn ${drawn === "area" ? "as an area" : `on a ${drawn}`}, not ${as === "area" ? "as an area" : `on a ${as}`}`);
  return drawn;
}

function gate(kind: string): void {
  if (!peerReads(ELEMENTS_CREATE_FEATURE)) refuse("invalid_value", `${article(words(kind))} can't be drawn yet: the model server this model is open on is an older version that doesn't take drawn elements. Try again once the server is updated`);
}

interface Draft {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  /** Grid labels drawn earlier in this command. */
  readonly gridLabels: string[];
  /** What the command added beside what it drew (a starter type), in words. */
  readonly notes: string[];
}

function fresh(d: Draft, id: string): ElementId {
  const eid = asElementId(id);
  if (d.working[eid] ?? d.reader.find(eid)) refuse("already_exists", `${id} already exists; choose a new id`, [eid]);
  return eid;
}

function levelOf(d: Draft, levelId: string, kind: string): Level {
  const el = d.reader.find(asElementId(levelId));
  if (el?.kind !== "level") refuse("element_not_found", `${article(words(kind))} can't go on ${levelId}: it isn't a level in this model`);
  return el;
}

function typeFor(d: Draft, typeId: string | undefined, kind: string, variant?: string): ElementTypeElement | null {
  if (typeId === undefined) return null;
  if (kind === "reference_plane") refuse("invalid_value", "A reference plane takes no type; leave the type out");
  const t = d.working[asElementId(typeId)] ?? d.reader.find(asElementId(typeId)) ?? adoptStarterType(d, typeId, kind, variant);
  if (t?.kind !== "element_type") refuse(t ? "wrong_kind" : "element_not_found", t ? `${typeId} is a ${t.kind.replace(/_/g, " ")}, not an element type` : `There is no element type ${typeId}; make the type first`);
  if (t.forKinds && !t.forKinds.includes(kind)) refuse("invalid_value", `${t.name} is a type for ${t.forKinds.map((k) => `${words(k).toLowerCase()}s`).join(" and ")}, not ${words(kind).toLowerCase()}s`, [t.id]);
  return t;
}

/**
 * A starter type (`kernel.starter_element_type`) named by a drawing command
 * while the model has none by that id: added in the same edit, so the
 * element is drawn with it and one Undo takes both away. Null when no add-on
 * in force ships that id.
 */
function adoptStarterType(d: Draft, typeId: string, kind: string, variant: string | undefined): ElementTypeElement | null {
  const row = starterElementType(typeId);
  if (!row) return null;
  if (!row.forKinds.includes(kind)) refuse("invalid_value", `${row.name} is a type for ${row.forKinds.map((k) => `${words(k).toLowerCase()}s`).join(" and ")}, not ${words(kind).toLowerCase()}s`);
  if (row.variant !== undefined && variant !== undefined && row.variant !== variant) refuse("invalid_value", `${row.name} is a ${row.variant.replace(/_/g, " ")} type, not a ${variant.replace(/_/g, " ")} type`);
  if (!peerReads(ELEMENT_TYPES_FEATURE)) refuse("invalid_value", `The type ${row.name} can't be added yet: the model server this model is open on is an older version that doesn't store element types. Try again once the server is updated, or draw without a type`);
  const record = starterTypeRecord(row);
  d.working[record.id] = record;
  d.touched.push(record.id);
  d.notes.push(`Added the type ${row.name} (${row.description}) from the starter list`);
  return record;
}

/** The partition a drawn element lives in: its level, and the discipline of the class it is recognised as. None when no class recognises it. */
function partitionOf(el: CoreElement, level: Level): Partition | undefined {
  const classId = el.classId;
  if (classId === undefined) return undefined;
  const cls = activeClassRegistry().getClass(classId) ?? builtinRegistry().getClass(classId);
  return cls ? { level: level.name, zone: "Z1", discipline: cls.discipline } : undefined;
}

/** The record as written: class recognised, at the current schema version, in its partition. */
function finished<T extends CoreElement>(el: T, level: Level): T;
function finished(el: CoreElement, level: Level): CoreElement {
  const upgraded = upgradeToElementCore(el);
  const next = isCoreElement(upgraded) ? upgraded : el;
  const partition = partitionOf(next, level);
  const at = currentSchemaVersion(next.kind);
  return { ...next, ...(partition ? { partition } : {}), schemaVersion: at };
}

function linePlacement(level: Level, start: Vec2, end: Vec2, top: TopLevel | null, input: Common): LinePlacement {
  return {
    kind: "line",
    levelId: level.id,
    start,
    end,
    startOffsetMm: input.baseOffsetMm ?? 0,
    endOffsetMm: input.baseOffsetMm ?? 0,
    lateral: "center",
    vertical: "bottom",
    ...(top?.stored ? { topLevelId: top.level.id, ...(top.offsetMm ? { topOffsetMm: top.offsetMm } : {}) } : {}),
    // Heights from bound surfaces are worked out when the edit finishes (`placement/surface-follow.ts`).
    ...(input.topSurface ? { topSurface: toBinding(input.topSurface) } : {}),
    ...(input.baseSurface ? { baseSurface: toBinding(input.baseSurface) } : {}),
  };
}

interface TopLevel {
  readonly level: Level;
  readonly offsetMm: number;
  /** The peer stores ties (`walls:top_constraint`); otherwise only the height it works out to is written. */
  readonly stored: boolean;
}

/** The level a drawn element's top runs up to, checked: a level of this model, above the one it stands on, on a kind that keeps a height. */
function topLevelFor(d: Draft, level: Level, input: Common): TopLevel | null {
  if (input.topLevelId === undefined) {
    if (input.topOffsetMm !== undefined) refuse("invalid_value", "A top offset needs the level the top runs up to; give topLevelId too");
    return null;
  }
  if (!topTieRow(input.kind)) refuse("invalid_value", `${article(words(input.kind))} keeps no height, so its top can't run up to a level; leave the top level out`);
  if (input.size?.heightMm !== undefined) refuse("invalid_value", `Give either a height or the level the top runs up to, not both`);
  const top = d.reader.find(asElementId(input.topLevelId));
  if (top?.kind !== "level") refuse("element_not_found", `${input.topLevelId} isn't a level in this model; pick the level the top runs up to`);
  const offsetMm = input.topOffsetMm ?? 0;
  if (top.elevationMm + offsetMm - level.elevationMm < MIN_TIED_HEIGHT_MM) refuse("invalid_value", `${top.name} isn't above ${level.name}, so the ${words(input.kind).toLowerCase()} would have no height; pick a level above it`, [top.id]);
  return { level: top, offsetMm, stored: peerReads(WALLS_TOP_CONSTRAINT_FEATURE) };
}

function gridLabelFor(d: Draft, given: string | undefined, start: Vec2, end: Vec2): string {
  const used = [...elementsOfKind(d.reader.model.elements, "grid").map((g) => g.label.trim()), ...d.gridLabels];
  // Lines running up the plan take numbers, lines running across take letters.
  const label = given ?? nextGridLabel(used, gridAxisFamily(start, end) === "U" ? "numbers" : "letters");
  if (given !== undefined && used.includes(given)) refuse("already_exists", `There is already a grid line ${given}; give this one another label, or leave the label out to take the next one`);
  d.gridLabels.push(label);
  return label;
}

const sameVec = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/** One drawn record, built and written. `start`/`end` for line kinds, the placement otherwise. */
function draw(d: Draft, id: string, level: Level, input: Common, placement: DrawPlacement): BimElement {
  const eid = fresh(d, id);
  const type = typeFor(d, input.typeId, input.kind);
  const base = { id: eid, version: 0, authoredRev: {} };
  const core = {
    ...(type ? { typeId: type.id } : {}),
    ...(input.values && Object.keys(input.values).length > 0 ? { values: input.values as Readonly<Record<string, ParamValue>> } : {}),
  };
  // A starter type's drawn size fills what the command leaves out.
  const size = { ...(type ? starterElementType(type.id)?.size : undefined), ...input.size };
  let el: BimElement;
  const face = DRAWN[input.kind] === undefined ? kindRowOf(input.kind)?.create : undefined;
  if ((input.topSurface || input.baseSurface || input.baseOffsetMm !== undefined) && (face || placement.kind !== "line")) refuse("invalid_value", `${article(words(input.kind))} keeps no height of its own here, so its top and base can't follow a surface; leave them out`);
  if (face) {
    if (input.topLevelId !== undefined) refuse("invalid_value", `${article(words(input.kind))}'s top is set by the add-on that defines it, not a top level here; leave the top level out`);
    const made = face.make(
      {
        id: eid,
        levelId: level.id,
        placement: placement.kind === "line" ? { kind: "line", start: roundVec(placement.start), end: roundVec(placement.end) } : placement.kind === "area" ? { kind: "area", outline: placement.outline.map(roundVec), holes: (placement.holes ?? []).map((h) => h.map(roundVec)) } : { kind: "point", position: roundVec(placement.position), rotationDeg: placement.rotationDeg ?? 0 },
        ...(type ? { typeId: type.id } : {}),
        ...(input.values ? { values: input.values } : {}),
        ...(input.size ? { size: input.size } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      d.working,
    );
    if ("refused" in made) refuse("invalid_value", made.refused);
    if (made.kind !== input.kind) refuse("invalid_value", `The add-on that defines ${words(input.kind).toLowerCase()}s made a ${made.kind.replace(/_/g, " ")} instead; nothing was drawn`);
    el = { ...made, id: eid, version: 0, authoredRev: {} };
  } else if (placement.kind === "line") {
    const start = roundVec(placement.start);
    const end = roundVec(placement.end);
    if (sameVec(start, end)) refuse("invalid_value", `${article(words(input.kind))} would start and end at the same point; click two different points`);
    checkSurfaceBindings(d.reader, input.kind, article(words(input.kind)), eid, {
      ...(input.topLevelId !== undefined ? { topLevelId: input.topLevelId } : {}),
      ...(input.topSurface ? { topSurface: toBinding(input.topSurface) } : {}),
      ...(input.baseSurface ? { baseSurface: toBinding(input.baseSurface) } : {}),
    });
    if (input.topSurface && input.size?.heightMm !== undefined) refuse("invalid_value", "Give either a height or the surface the top runs to, not both");
    if (input.baseOffsetMm !== undefined && !topTieRow(input.kind)) refuse("invalid_value", `${article(words(input.kind))} keeps no height, so its base can't be raised off its level; leave the base offset out`);
    if (input.baseOffsetMm !== undefined && input.baseSurface) refuse("invalid_value", "A base on the floor under it carries its own offset; give the offset there, not as a base offset");
    const top = topLevelFor(d, level, input);
    const p = linePlacement(level, start, end, top, input);
    const tiedHeight = top ? tiedHeightMm({ ...p, topLevelId: top.level.id, ...(top.offsetMm ? { topOffsetMm: top.offsetMm } : {}) }, (lid) => (lid === level.id ? level.elevationMm : lid === top.level.id ? top.level.elevationMm : null)) : null;
    switch (input.kind) {
      case "wall": {
        const wall: Wall = { ...base, ...core, kind: "wall", start, end, thickness: size.thicknessMm ?? DEFAULTS.wallThicknessMm, height: tiedHeight ?? size.heightMm ?? DEFAULTS.wallHeightMm, wallType: type?.name ?? "Wall", placement: p };
        el = finished(wall, level);
        break;
      }
      case "beam": {
        const beam: Beam = { ...base, ...core, kind: "beam", sectionName: type?.name ?? input.label ?? "Beam", start, end, placement: p };
        el = finished(beam, level);
        break;
      }
      case "grid": {
        const grid: GridLine = { ...base, ...core, kind: "grid", label: gridLabelFor(d, input.label, start, end), start, end, placement: p };
        el = finished(grid, level);
        break;
      }
      default: {
        if (input.values !== undefined) refuse("invalid_value", "A reference plane takes no values; leave them out");
        const plane: ReferencePlane = { ...base, kind: "reference_plane", levelId: level.id, start, end, ...(input.label !== undefined ? { name: input.label } : {}) };
        el = plane;
      }
    }
  } else if (placement.kind === "area") {
    const outline = placement.outline.map(roundVec);
    const holes = (placement.holes ?? []).map((h) => h.map(roundVec));
    const p: GeometricPlacement = { kind: "area", levelId: level.id, outline, ...(holes.length > 0 ? { holes } : {}), offsetMm: 0, vertical: "top" };
    if (areaOf(p).planAreaMm2 <= 0) refuse("invalid_value", `${article(words(input.kind))}'s outline, less its holes, has no area; click at least three corners that enclose something`);
    const slab: Slab = { ...base, ...core, kind: "slab", outline, thickness: size.thicknessMm ?? DEFAULTS.slabThicknessMm, placement: p };
    el = finished(slab, level);
  } else {
    const position = roundVec(placement.position);
    const p: GeometricPlacement = { kind: "point", levelId: level.id, position, offsetMm: 0, rotationDeg: placement.rotationDeg ?? 0 };
    const column: Column = { ...base, ...core, kind: "column", material: DEFAULTS.columnMaterial, position, size: { x: size.widthMm ?? DEFAULTS.columnSizeMm, y: size.depthMm ?? size.widthMm ?? DEFAULTS.columnSizeMm }, placement: p };
    el = finished(column, level);
  }
  d.working[eid] = el;
  d.touched.push(eid);
  return el;
}

function createOne(d: Draft, c: CreateElement): string {
  drawnAs(c.kind, c.placement.kind);
  gate(c.kind);
  const level = levelOf(d, c.levelId, c.kind);
  const el = draw(d, c.elementId, level, c, c.placement);
  return `Drew ${el.kind === "grid" ? `grid line ${el.label}` : `${words(c.kind).toLowerCase()} ${el.id}`} on ${level.name}`;
}

function createChain(d: Draft, c: CreateElements): string {
  drawnAs(c.kind, "chain");
  gate(c.kind);
  const level = levelOf(d, c.levelId, c.kind);
  const corners = c.points.map(roundVec);
  const n = c.closed ? corners.length : corners.length - 1;
  if (c.closed && corners.length < 3) refuse("invalid_value", "A closed chain needs at least three corners");
  if (c.closed && corners.length > 0 && sameVec(corners[0] as Vec2, corners[corners.length - 1] as Vec2)) refuse("invalid_value", "The last corner is the first one again; leave it out and close the chain instead");
  if (c.kind === "grid" && c.label !== undefined) refuse("invalid_value", "Grid lines in a chain take the next labels by themselves; leave the label out, or draw the grid line on its own");
  for (let i = 0; i < n; i++) {
    const start = corners[i] as Vec2;
    const end = corners[(i + 1) % corners.length] as Vec2;
    if (sameVec(start, end)) refuse("invalid_value", `Corners ${i + 1} and ${(i + 1) % corners.length + 1} are the same point; each ${words(c.kind).toLowerCase()} needs two different points`);
    draw(d, `${c.idPrefix}-${i + 1}`, level, c, { kind: "line", start, end });
  }
  return `Drew ${plural(n, words(c.kind))} on ${level.name}${c.closed ? ", closed" : ""}`;
}

function createHosted(d: Draft, c: CreateHosted): string {
  if (c.kind !== "opening") {
    const row = kindRowOf(c.kind);
    if (!row) refuse("invalid_value", `There is no "${c.kind}" kind in this model`);
    refuse("invalid_value", `${row.label}s aren't hosted in another element; draw one with create_element`);
  }
  const openingType = c.openingType;
  if (openingType === undefined) refuse("invalid_value", "Say what the opening is: a door or a window");
  const what = openingType.replace(/_/g, " ");
  gate(c.kind);
  const host = d.working[asElementId(c.hostId)] ?? d.reader.find(asElementId(c.hostId));
  const line = host ? hostLineOf(host, d.working) : null;
  if (!host || !line) refuse(host ? "wrong_kind" : "element_not_found", `${article(what)} needs a wall to sit in; click a wall`, host ? [host.id] : []);
  const starterSize = c.typeId !== undefined ? starterElementType(c.typeId)?.size : undefined;
  const width = c.size?.widthMm ?? starterSize?.widthMm;
  if (width === undefined) refuse("invalid_value", `Give the ${what}'s width`);
  const len = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
  if (c.s - width / 2 < 0 || c.s + width / 2 > len) refuse("invalid_value", `The ${what} is ${Math.round(width)} mm wide and doesn't fit there: the wall is ${Math.round(len)} mm long. Move it along the wall or make it narrower`, [host.id]);
  for (const id of hostedIds(d.reader.model.elements, host.id)) {
    const other = d.reader.model.elements[id];
    if (other?.kind !== "opening") continue;
    if (Math.abs(other.offset - c.s) < (other.width + width) / 2) refuse("invalid_value", `The ${what} would overlap ${other.mark ? `${other.openingType.replace(/_/g, " ")} ${other.mark}` : `the ${other.openingType.replace(/_/g, " ")} already there`} in this wall; move it along the wall`, [other.id]);
  }
  const eid = fresh(d, c.elementId);
  const type = typeFor(d, c.typeId, "opening", openingType);
  const values: Record<string, ParamValue> = { ...(c.values ?? {}) };
  if (c.side === -1) values["host.side"] = -1;
  const height = c.size?.heightMm ?? starterSize?.heightMm ?? (openingType === "window" ? 1219 : 2134);
  // A sill given on the command (the opening's `opening.sill_mm` value) has to leave the opening inside its wall.
  const sill = values[OPENING_SILL_KEY];
  if (sill !== undefined) {
    const hostName = `${words(host.kind).toLowerCase()} ${host.id}`;
    const why = typeof sill === "number" ? openingSillProblem(what, sill, height, hostName, host.kind === "wall" ? host.height : null) : `The ${what}'s sill height is a length in mm`;
    if (why) refuse("invalid_value", why, [host.id]);
  }
  const opening: Opening = {
    id: eid,
    version: 0,
    authoredRev: {},
    ...(host.partition ? { partition: host.partition } : {}),
    kind: "opening",
    openingType,
    mark: c.mark ?? "",
    hostId: host.id,
    offset: c.s,
    width,
    height,
    position: roundVec({ x: line.start.x + ((line.end.x - line.start.x) * c.s) / len, y: line.start.y + ((line.end.y - line.start.y) * c.s) / len }),
    ...(type ? { typeId: type.id } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  };
  const upgraded = upgradeToElementCore(opening);
  d.working[eid] = { ...(upgraded.kind === "opening" ? upgraded : opening), schemaVersion: currentSchemaVersion("opening") };
  d.touched.push(eid);
  return `Put ${what} ${c.mark || eid} in ${words(host.kind).toLowerCase()} ${host.id}`;
}

export function isCreateCommand(command: { readonly type: string }): command is CreateCommand {
  return CREATE_COMMAND_TYPES.includes(command.type);
}

export function executeCreateCommand(reader: TrackedReader, working: Record<string, BimElement>, command: CreateCommand): ExecuteResult {
  const d: Draft = { reader, working, touched: [], gridLabels: [], notes: [] };
  const summary = command.type === "create_element" ? createOne(d, command) : command.type === "create_elements" ? createChain(d, command) : createHosted(d, command);
  return finish(reader, working, d.touched, [], () => [], { summary: [summary, ...d.notes] });
}
