import { z } from "zod";
import type { DetailLevel } from "../documents";
import { dimSchema, PARAM_NAME } from "../part-dim";

export type { DetailLevel };

/**
 * A part model: the feature tree a person or agent draws in the part editor.
 * Reference planes position everything; sketches lie on planes; features turn
 * sketches into solids (join) or voids (cut, intersect) in order. All lengths
 * are millimetres in the part's local frame (x along the part's facing, y to
 * its left, z up from the insertion point); angles are degrees.
 */

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const idSchema = z.string().regex(ID, "starts with a letter; letters, digits, - and _ (48 at most)");
const nameSchema = z.string().trim().min(1).max(80);
const paramValueSchema = z.union([z.number().finite(), z.string().max(400), z.boolean()]);

export const PLANE_AXES = ["x", "y", "z"] as const;
export type PlaneAxis = (typeof PLANE_AXES)[number];

/** Built in to every model: the centre planes and the base (insertion level). */
export const BUILTIN_PLANES = [
  { id: "center_lr", name: "Centre (left/right)", axis: "x", offset: 0 },
  { id: "center_fb", name: "Centre (front/back)", axis: "y", offset: 0 },
  { id: "base", name: "Base", axis: "z", offset: 0 },
] as const;

export const referencePlaneSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** The plane is square to this axis: x = offset, y = offset or z = offset. */
  axis: z.enum(PLANE_AXES),
  offset: dimSchema,
});
export type ReferencePlane = z.infer<typeof referencePlaneSchema>;

export const sketchPointSchema = z.object({
  id: idSchema,
  /** Where it was drawn on the sketch plane; the solver starts here and keeps free directions here. */
  u: z.number().finite(),
  v: z.number().finite(),
});

export const sketchEntitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), id: idSchema, a: idSchema, b: idSchema, construction: z.boolean().optional() }),
  /** Counter-clockwise (seen from the sketch normal) from start to end around center. */
  z.object({ kind: z.literal("arc"), id: idSchema, center: idSchema, start: idSchema, end: idSchema }),
  z.object({ kind: z.literal("circle"), id: idSchema, center: idSchema, radius: dimSchema }),
  z.object({ kind: z.literal("polyline"), id: idSchema, points: z.array(idSchema).min(2).max(200), closed: z.boolean() }),
  /** Four corners in order; its sides stay horizontal and vertical. */
  z.object({ kind: z.literal("rectangle"), id: idSchema, corners: z.tuple([idSchema, idSchema, idSchema, idSchema]) }),
]);
export type SketchEntity = z.infer<typeof sketchEntitySchema>;

const DISTANCE_DIRECTIONS = ["aligned", "horizontal", "vertical"] as const;

export const sketchConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("coincident"), a: idSchema, b: idSchema }),
  z.object({ kind: z.literal("horizontal"), line: idSchema }),
  z.object({ kind: z.literal("vertical"), line: idSchema }),
  z.object({ kind: z.literal("parallel"), line1: idSchema, line2: idSchema }),
  z.object({ kind: z.literal("perpendicular"), line1: idSchema, line2: idSchema }),
  z.object({ kind: z.literal("equal_length"), line1: idSchema, line2: idSchema }),
  z.object({ kind: z.literal("equal_radius"), arc1: idSchema, arc2: idSchema }),
  z.object({ kind: z.literal("distance"), a: idSchema, b: idSchema, value: dimSchema, direction: z.enum(DISTANCE_DIRECTIONS).optional() }),
  z.object({ kind: z.literal("length"), line: idSchema, value: dimSchema }),
  z.object({ kind: z.literal("radius"), arc: idSchema, value: dimSchema }),
  z.object({ kind: z.literal("angle"), line1: idSchema, line2: idSchema, value: dimSchema }),
  /** The point lies on a reference plane square to the sketch (it moves with the plane). */
  z.object({ kind: z.literal("on_plane"), point: idSchema, plane: idSchema }),
  z.object({ kind: z.literal("fix"), point: idSchema, u: dimSchema.optional(), v: dimSchema.optional() }),
]);
export type SketchConstraint = z.infer<typeof sketchConstraintSchema>;

export const sketchSchema = z.object({
  id: idSchema,
  name: nameSchema,
  /** A reference plane id (built-in or the model's own). */
  plane: idSchema,
  points: z.array(sketchPointSchema).max(400),
  entities: z.array(sketchEntitySchema).max(400),
  constraints: z.array(sketchConstraintSchema).max(800),
});
export type Sketch = z.infer<typeof sketchSchema>;

export const DETAIL_LEVELS = ["coarse", "medium", "fine"] as const satisfies readonly DetailLevel[];

const featureBase = {
  id: idSchema,
  name: nameSchema,
  /** join: solid; cut: void (removes material); intersect: keeps only the overlap. */
  operation: z.enum(["join", "cut", "intersect"]),
  sketch: idSchema,
  /** Detail levels it shows at; absent: all. */
  visibility: z.array(z.enum(DETAIL_LEVELS)).min(1).max(3).optional(),
  material: z.string().trim().min(1).max(80).optional(),
};

export const featureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("extrude"),
    ...featureBase,
    /** Distances along the sketch plane's normal; end beyond start. */
    start: dimSchema,
    end: dimSchema,
  }),
  z.object({
    kind: z.literal("revolve"),
    ...featureBase,
    /** A line in the sketch (usually a construction line) to revolve about. */
    axis: idSchema,
    startAngle: dimSchema,
    endAngle: dimSchema,
  }),
]);
export type PartFeature = z.infer<typeof featureSchema>;

export const partTypeRowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  values: z.record(z.string().regex(PARAM_NAME), paramValueSchema),
});
export type PartTypeRow = z.infer<typeof partTypeRowSchema>;

export const partModelSchema = z.object({
  /** Groups the sizes of one definition (each saved type's id starts with it). */
  id: idSchema,
  referencePlanes: z.array(referencePlaneSchema).max(100),
  sketches: z.array(sketchSchema).max(100),
  features: z.array(featureSchema).max(200),
  /** What plans draw: the solid, only the symbol lines, or both. */
  planDisplay: z.enum(["model", "symbol", "both"]),
  /** The types table: named sizes of this definition. */
  types: z.array(partTypeRowSchema).max(200),
});
export type PartModel = z.infer<typeof partModelSchema>;
