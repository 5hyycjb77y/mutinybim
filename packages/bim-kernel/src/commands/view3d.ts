import { z } from "zod";
import { canonicalJson } from "../canonical";
import type { AuthoredWrite } from "../command-core";
import { DEFAULT_PLAN_SCALE, VIEW_PROJECTIONS, type ViewProps } from "../documents";
import { round } from "../geometry";
import { referenceDisplaySchema } from "../reference-display";
import { KernelError } from "../model";
import { asElementId, type BimElement, type ModelState, type Partition, type ViewElement } from "../types";
import {
  aabb3Schema,
  boxAroundAabb,
  boxForRegion,
  boxPlanRect,
  boxTurnedTo,
  camera3dSchema,
  cropBox3dSchema,
  defaultCamera,
  elementsAabb,
  modelAabb,
  normalizeBox,
  viewCropBox3d,
  workingViewOf,
  type Aabb3,
  type CropBox3d,
  type View3dCamera,
} from "../view3d";
import { workingAngleFromEdge, workingAngleOf } from "../work-frame";

/**
 * Saved 3D view commands. They run inside the views/sheets executor (so they
 * batch, preview, attribute, conflict-check and undo with
 * `restore_document_elements` like every document edit). Rename, duplicate and
 * delete are the ordinary view commands.
 */

const id = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(120);
const elementIds = z.array(id).min(1).max(5000);
const planPoint = z.object({ x: z.number().finite().min(-1e9).max(1e9), y: z.number().finite().min(-1e9).max(1e9) });

export const view3dCommandSchemas = [
  z.object({
    type: z.literal("create_3d_view"),
    viewId: id,
    name,
    /** Where it looks from; absent: from the south-west and above, at its crop box. */
    camera: camera3dSchema.optional(),
    projection: z.enum(VIEW_PROJECTIONS).optional(),
    /** Its crop box; absent: fitted to `fit`, else the whole model (`extent` when the caller knows the linked models too). */
    cropBox: cropBox3dSchema.optional(),
    /** Fit the box to these elements or this region, grown out to the levels and grid lines around them. */
    fit: z.object({ elementIds: elementIds.optional(), region: aabb3Schema.optional() }).strict().optional(),
    /** The whole model's bounds (including linked models), mm. */
    extent: aabb3Schema.optional(),
    /** Crop on. Absent: on. */
    cropView: z.boolean().optional(),
    /** Show the crop box while working. Absent: on. */
    showCropBox: z.boolean().optional(),
    /** Make this the user's working 3D view (one per person). */
    workingFor: id.optional(),
    /** How each linked model draws in it, per linked model id (`reference-display.ts`). */
    references: z.record(id, referenceDisplaySchema).optional(),
  }),
  z.object({ type: z.literal("set_3d_view_camera"), viewId: id, camera: camera3dSchema, projection: z.enum(VIEW_PROJECTIONS).optional() }),
  z.object({
    type: z.literal("set_3d_crop_box"),
    viewId: id,
    /** The box itself. */
    box: cropBox3dSchema.optional(),
    /** selection: fit to `elementIds` / `region`, grown out to the levels and grid lines around them. model: the whole model (`extent`). */
    fit: z.enum(["selection", "model"]).optional(),
    elementIds: elementIds.optional(),
    region: aabb3Schema.optional(),
    extent: aabb3Schema.optional(),
    /** Crop on or off (the view's Crop view switch). */
    enabled: z.boolean().optional(),
    /** Show or hide the box while working (never printed). */
    show: z.boolean().optional(),
    /**
     * Turn the box about its middle, its size kept: to the view's working
     * angle, or square to an edge given by two plan points. There is no
     * rotate handle on the box; this (or a typed `box`) is how it turns.
     */
    align: z.union([z.literal("working_angle"), z.object({ from: planPoint, to: planPoint }).strict()]).optional(),
  }),
] as const;

export type View3dCommand = z.infer<(typeof view3dCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(view3dCommandSchemas.map((s) => s.shape.type.value));

export function isView3dCommand(command: { readonly type: string }): command is View3dCommand {
  return TYPES.has(command.type);
}

/** What the views executor lends these commands. */
export interface View3dContext {
  readonly model: ModelState;
  readonly views: readonly ViewElement[];
  /** The live view by id (refuses when it is gone). */
  readonly view: (viewId: string) => ViewElement;
  readonly write: (el: BimElement) => void;
  readonly authored: AuthoredWrite[];
  readonly uniqueName: (wanted: string, except: string | null) => void;
  readonly partition: () => Partition;
  /** After a view's crop changed: its viewport on a sheet follows. */
  readonly follow: (before: ViewElement, after: ViewElement) => void;
}

function fail(message: string, ids: readonly string[], code: "invalid_value" | "already_exists" | "wrong_kind" = "invalid_value"): never {
  throw new KernelError(code, message, ids.map(asElementId));
}

const prop = (key: string) => `doc.props.${key}`;

function roundCamera(c: View3dCamera): View3dCamera {
  const r = (q: View3dCamera["eye"]) => ({ x: round(q.x), y: round(q.y), z: round(q.z) });
  const len = Math.hypot(c.up.x, c.up.y, c.up.z);
  if (len < 1e-9) fail("The camera's up direction can't be zero.", []);
  const dir = Math.hypot(c.target.x - c.eye.x, c.target.y - c.eye.y, c.target.z - c.eye.z);
  if (dir < 1) fail("The camera needs to stand somewhere other than the point it looks at.", []);
  return { eye: r(c.eye), target: r(c.target), up: { x: round(c.up.x / len, 6), y: round(c.up.y / len, 6), z: round(c.up.z / len, 6) }, fovDeg: round(c.fovDeg, 3), orthoHeightMm: round(c.orthoHeightMm) };
}

/** The box a fit asks for. */
function fittedBox(model: ModelState, fit: "selection" | "model", ids: readonly string[] | undefined, region: Aabb3 | undefined, extent: Aabb3 | undefined, viewId: string, angleDeg: number): CropBox3d {
  if (fit === "model") return boxAroundAabb(extent ?? modelAabb(model), angleDeg);
  const fromElements = ids ? elementsAabb(model, ids) : null;
  if (ids && !fromElements && !region) fail("None of those elements is in the model any more, or none has a size to fit the box to. Select something else.", [viewId, ...ids]);
  const parts = [fromElements, region ?? null].filter((x): x is Aabb3 => x !== null);
  if (parts.length === 0) fail("Fitting to a selection needs the elements (or the region) to fit to. Select something first.", [viewId]);
  const merged: Aabb3 = {
    min: { x: Math.min(...parts.map((b) => b.min.x)), y: Math.min(...parts.map((b) => b.min.y)), z: Math.min(...parts.map((b) => b.min.z)) },
    max: { x: Math.max(...parts.map((b) => b.max.x)), y: Math.max(...parts.map((b) => b.max.y)), z: Math.max(...parts.map((b) => b.max.z)) },
  };
  return boxForRegion(model, merged);
}

function threeD(ctx: View3dContext, viewId: string): ViewElement {
  const view = ctx.view(viewId);
  if (view.viewType !== "three_d") fail(`View "${view.name}" is not a 3D view. Its crop box is a rectangle; change it with set_view_crop.`, [view.id], "wrong_kind");
  return view;
}

export function executeView3dCommand(ctx: View3dContext, command: View3dCommand): void {
  const { model, write, authored } = ctx;
  switch (command.type) {
    case "create_3d_view": {
      if (model.elements[command.viewId]) fail(`${command.viewId} is already used by another element`, [command.viewId], "already_exists");
      ctx.uniqueName(command.name, null);
      if (command.workingFor) {
        const existing = workingViewOf(ctx.views, command.workingFor);
        if (existing) fail(`That person already has a working 3D view ("${existing.name}"). Change its crop box instead.`, [existing.id], "already_exists");
      }
      if (command.cropBox && command.fit) fail("Send a crop box or ask to fit it, not both.", [command.viewId]);
      const box = command.cropBox
        ? normalizeBox(command.cropBox)
        : command.fit
          ? fittedBox(model, "selection", command.fit.elementIds, command.fit.region, undefined, command.viewId, 0)
          : boxAroundAabb(command.extent ?? modelAabb(model), workingAngleOf(model));
      const props: ViewProps = {
        scale: DEFAULT_PLAN_SCALE,
        detailLevel: "medium",
        cropBox3d: box,
        camera3d: command.camera ? roundCamera(command.camera) : defaultCamera(box),
        ...(command.projection ? { projection: command.projection } : {}),
        ...(command.cropView === false ? { cropView: false } : {}),
        ...(command.showCropBox === false ? { showCropBox: false } : {}),
        ...(command.workingFor ? { workingFor: command.workingFor } : {}),
        ...(command.references && Object.keys(command.references).length > 0 ? { references: command.references } : {}),
      };
      const plan = boxPlanRect(box);
      write({ version: 0, authoredRev: {}, id: asElementId(command.viewId), kind: "view", name: command.name, viewType: "three_d", cropMin: plan.min, cropMax: plan.max, props, partition: ctx.partition() });
      return;
    }
    case "set_3d_view_camera": {
      const view = threeD(ctx, command.viewId);
      const camera = roundCamera(command.camera);
      const props: ViewProps = { ...view.props, camera3d: camera, ...(command.projection ? { projection: command.projection } : {}) };
      const next: ViewElement = { ...view, props };
      write(next);
      authored.push({ elementId: view.id, field: prop("camera3d"), value: canonicalJson(camera) });
      if (command.projection) authored.push({ elementId: view.id, field: prop("projection"), value: canonicalJson(command.projection) });
      // What the box looks like from the new camera sets the view's frame on its sheet.
      ctx.follow(view, next);
      return;
    }
    case "set_3d_crop_box": {
      const view = threeD(ctx, command.viewId);
      if (command.box && command.fit) fail("Send a crop box or ask to fit it, not both.", [view.id]);
      if (command.align && command.box) fail("Send a crop box or ask to align it, not both. A sent box already says how it is turned.", [view.id]);
      if (!command.fit && (command.elementIds || command.region || command.extent)) fail("Elements, a region or an extent only make sense with fit.", [view.id]);
      const before = viewCropBox3d(model, view);
      const sized = command.box ? normalizeBox(command.box) : command.fit ? fittedBox(model, command.fit, command.elementIds, command.region, command.extent, view.id, workingAngleOf(model, view)) : before;
      let box = sized;
      if (command.align && sized) {
        const angle = command.align === "working_angle" ? workingAngleOf(model, view) : workingAngleFromEdge(command.align.from, command.align.to);
        if (angle === null) fail("The two points are the same; pick a second point further along the edge.", [view.id]);
        if (!command.fit && Math.abs(angle - sized.rotationDeg) < 1e-6) fail(command.align === "working_angle" ? "The crop box is already square to the working angle." : "The crop box is already square to that edge.", [view.id]);
        box = boxTurnedTo(sized, angle);
      }
      let props: ViewProps = { ...view.props };
      if (box && (command.box || command.fit || command.align)) {
        props = { ...props, cropBox3d: box };
        authored.push({ elementId: view.id, field: prop("cropBox3d"), value: canonicalJson(box) });
      }
      if (command.enabled !== undefined) {
        props = { ...props, cropView: command.enabled };
        authored.push({ elementId: view.id, field: prop("cropView"), value: canonicalJson(command.enabled) });
      }
      if (command.show !== undefined) {
        props = { ...props, showCropBox: command.show };
        authored.push({ elementId: view.id, field: prop("showCropBox"), value: canonicalJson(command.show) });
      }
      if (!command.box && !command.fit && !command.align && command.enabled === undefined && command.show === undefined) fail("Nothing to change: send a box, a fit, an alignment, or turn crop or the box on or off.", [view.id]);
      const plan = props.cropBox3d ? boxPlanRect(props.cropBox3d) : { min: view.cropMin, max: view.cropMax };
      const next: ViewElement = { ...view, props, cropMin: plan.min, cropMax: plan.max };
      write(next);
      if (plan.min.x !== view.cropMin.x || plan.min.y !== view.cropMin.y || plan.max.x !== view.cropMax.x || plan.max.y !== view.cropMax.y) {
        authored.push({ elementId: view.id, field: "doc.crop", value: canonicalJson({ min: plan.min, max: plan.max }) });
      }
      ctx.follow(view, next);
      return;
    }
  }
}
