import { z } from "zod";
import { dimSchema } from "../part-dim";
import { DETAIL_LEVELS, PLANE_AXES, partModelSchema, partTypeRowSchema, referencePlaneSchema, sketchSchema, type PartModel } from "./schema";

/**
 * Part model schema 2: the solid program (contract 1.13.0). One description
 * of a part's body that the screen, sheets, clash and export all read.
 *
 * - **Profiles** are closed loops of a sketch's lines and arcs (circles,
 *   polylines and rectangles count as their edges): one outer loop and any
 *   number of holes.
 * - **Body features** make solid from profiles: extrude, revolve, sweep along
 *   a path, loft between profiles, or an imported body (a vendor's model,
 *   pinned by its content hash). Each joins (adds), cuts (removes) or
 *   intersects (keeps only the overlap), in order.
 * - **Repeat features** repeat earlier features: a pattern (in a line or
 *   around an axis) or a mirror about a reference plane. Each copy keeps its
 *   feature's operation.
 * - **Symbols** are the lines drawings use instead of (or with) the cut
 *   solid, per detail level and per view direction.
 *
 * Schema 1 (no `schema` field) still reads unchanged through
 * `anyPartModelSchema`; nothing upgrades a stored part. Lane G15 builds the
 * engine; peers that read schema 2 advertise the feature.
 */
export const GEOMETRY_SOLID_PROGRAM_2_FEATURE = "geometry:solid_program_2";

export const PART_MODEL_SCHEMA_2 = 2;

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const idSchema = z.string().regex(ID, "starts with a letter; letters, digits, - and _ (48 at most)");
const nameSchema = z.string().trim().min(1).max(80);

/** Edges of one sketch, end to end, closing on themselves. */
export const profileLoopSchema = z.object({ edges: z.array(idSchema).min(1).max(400) });
export type ProfileLoop = z.infer<typeof profileLoopSchema>;

export const partProfileSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** The sketch whose entities the loops name. */
  sketch: idSchema,
  outer: profileLoopSchema,
  /** Loops inside the outer one, cut through the profile. */
  holes: z.array(profileLoopSchema).max(100).optional(),
});
export type PartProfile = z.infer<typeof partProfileSchema>;

/** An open or closed chain of a sketch's edges a sweep follows. */
export const sweepPathSchema = z.object({ sketch: idSchema, edges: z.array(idSchema).min(1).max(400) });

/** File formats an imported body may be read from. Stored as written, so a newer reader's format is kept; a reader that can't open one says so. */
export const IMPORTED_BODY_FORMATS = ["gltf", "glb", "obj"] as const;

/** A body made elsewhere, pinned so the part never changes behind its back. */
export const importedBodyRefSchema = z.object({
  /** Where the host keeps the file (a firm library or project file id). */
  fileId: z.string().min(1).max(200),
  format: z.string().regex(/^[a-z0-9]{2,10}$/, "a file format such as gltf or obj"),
  contentHash: z.string().min(1).max(100),
  /** Millimetres per file unit (25.4 for a file drawn in inches). */
  mmPerUnit: z.number().positive().max(1e6),
  /** The file's up axis; absent: z. */
  upAxis: z.enum(["y", "z"]).optional(),
});
export type ImportedBodyRef = z.infer<typeof importedBodyRefSchema>;

const point3Schema = z.object({ x: dimSchema, y: dimSchema, z: dimSchema });

const bodyBase = {
  id: idSchema,
  name: nameSchema,
  /** join: solid; cut: void (removes material); intersect: keeps only the overlap. */
  operation: z.enum(["join", "cut", "intersect"]),
  /** Detail levels it shows at; absent: all. */
  visibility: z.array(z.enum(DETAIL_LEVELS)).min(1).max(3).optional(),
  material: z.string().trim().min(1).max(80).optional(),
};

const repeatBase = {
  id: idSchema,
  name: nameSchema,
  /** Earlier features it repeats (body or repeat features). */
  features: z.array(idSchema).min(1).max(200),
};

export const featureSchema2 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("extrude"),
    ...bodyBase,
    profile: idSchema,
    /** Distances along the profile sketch plane's normal; end beyond start. */
    start: dimSchema,
    end: dimSchema,
  }),
  z.object({
    kind: z.literal("revolve"),
    ...bodyBase,
    profile: idSchema,
    /** A line in the profile's sketch (usually a construction line) to revolve about. */
    axis: idSchema,
    startAngle: dimSchema,
    endAngle: dimSchema,
  }),
  z.object({
    kind: z.literal("sweep"),
    ...bodyBase,
    profile: idSchema,
    path: sweepPathSchema,
  }),
  z.object({
    kind: z.literal("loft"),
    ...bodyBase,
    /** Two or more profiles on different planes, in order along the loft. */
    profiles: z.array(idSchema).min(2).max(20),
    /** Straight faces between profiles instead of smooth ones. */
    ruled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("imported"),
    ...bodyBase,
    body: importedBodyRefSchema,
    /** Where the file's origin goes in the part's frame. */
    at: point3Schema,
    /** Turn about z, degrees. */
    rotationDeg: dimSchema.optional(),
  }),
  z.object({
    kind: z.literal("pattern"),
    ...repeatBase,
    arrangement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("linear"), axis: z.enum(PLANE_AXES), count: dimSchema, spacing: dimSchema }),
      /** Around an axis parallel to `axis` through `center`; `angle` is the whole spread (360 for a full turn). */
      z.object({ kind: z.literal("circular"), axis: z.enum(PLANE_AXES), center: point3Schema, count: dimSchema, angle: dimSchema }),
    ]),
  }),
  z.object({
    kind: z.literal("mirror"),
    ...repeatBase,
    /** A reference plane (built-in or the model's own). */
    plane: idSchema,
  }),
]);
export type PartFeature2 = z.infer<typeof featureSchema2>;

/** Directions a symbol is drawn for: from above (plans), from below (reflected ceiling plans), and the four sides. */
export const PART_SYMBOL_VIEWS = ["plan", "below", "front", "back", "left", "right"] as const;
export type PartSymbolView = (typeof PART_SYMBOL_VIEWS)[number];

export const partSymbolSchema = z.object({
  id: idSchema,
  name: nameSchema,
  view: z.enum(PART_SYMBOL_VIEWS),
  /** Detail levels it is drawn at. */
  detailLevels: z.array(z.enum(DETAIL_LEVELS)).min(1).max(3),
  /** The sketch whose lines are the symbol (on a plane square to the view). */
  sketch: idSchema,
});
export type PartSymbol = z.infer<typeof partSymbolSchema>;

export const partModelSchema2 = z.object({
  schema: z.literal(PART_MODEL_SCHEMA_2),
  /** Groups the sizes of one definition (each saved type's id starts with it). */
  id: idSchema,
  referencePlanes: z.array(referencePlaneSchema).max(100),
  sketches: z.array(sketchSchema).max(200),
  profiles: z.array(partProfileSchema).max(200),
  features: z.array(featureSchema2).max(400),
  symbols: z.array(partSymbolSchema).max(100),
  /** What plans draw: the solid, only the symbol lines, or both. */
  planDisplay: z.enum(["model", "symbol", "both"]),
  /** The types table: named sizes of this definition. */
  types: z.array(partTypeRowSchema).max(200),
});
export type PartModel2 = z.infer<typeof partModelSchema2>;

/** Any stored part model: schema 2, or schema 1 read exactly as before. */
export const anyPartModelSchema = z.union([partModelSchema2, partModelSchema]);
export type AnyPartModel = PartModel | PartModel2;

export function isPartModel2(model: AnyPartModel): model is PartModel2 {
  return "schema" in model && model.schema === PART_MODEL_SCHEMA_2;
}

/** Which schema a stored part model is written in. */
export function partModelSchemaVersion(model: AnyPartModel): 1 | 2 {
  return isPartModel2(model) ? 2 : 1;
}
