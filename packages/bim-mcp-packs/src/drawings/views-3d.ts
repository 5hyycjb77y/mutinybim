import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LOOK_FROM,
  cameraLookingFrom,
  executeCommand,
  viewCropBox3d,
  type Aabb3,
  type Command,
  type CropBox3d,
  type View3dCamera,
} from "@permitzip/bim-kernel";
import { baseRevision, target, type ResolveBimCaller } from "../runtime";
import { editWithModel, findSheet, findView, pointFt, scaleInput, stableId } from "../views/views";

/**
 * Saved 3D views for agents, in feet: make a 3D view of some elements or a
 * region (pre-cropped to its storey and grid bay), turn its camera, size or
 * fit its 3D crop box, and put it on a sheet in the same approval. Each is
 * one kernel command (or a batch), previewed and approved like every other
 * views/sheets edit.
 */

const FT = 304.8;
const point3Ft = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const mm3 = (q: { x: number; y: number; z: number }) => ({ x: q.x * FT, y: q.y * FT, z: q.z * FT });

const boxFt = z
  .object({
    center: point3Ft.describe("Box centre, feet (x east, y plan north, z elevation above project zero)."),
    size: z.object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() }).describe("Box size in feet along its own axes (x east-west and y north-south before turning; z height)."),
    turn_deg: z.number().min(-360).max(360).optional().describe("Turn about the vertical, degrees counter-clockwise."),
  })
  .describe("An explicit 3D crop box.");

const regionFt = z.object({ min: point3Ft, max: point3Ft }).describe("A region in feet (opposite corners), e.g. a mechanical room; the box grows out to the levels and grid lines around it.");

const lookFrom = z.enum(LOOK_FROM).describe("Where the camera looks from: south_west / south_east / north_west / north_east (isometric corners, from above), south / north / east / west (elevations), or top (plan, north up).");

function boxFromFt(b: z.infer<typeof boxFt>): CropBox3d {
  return { center: mm3(b.center), halfSize: { x: (b.size.x * FT) / 2, y: (b.size.y * FT) / 2, z: (b.size.z * FT) / 2 }, rotationDeg: b.turn_deg ?? 0 };
}

function regionFromFt(r: z.infer<typeof regionFt>): Aabb3 {
  return { min: mm3({ x: Math.min(r.min.x, r.max.x), y: Math.min(r.min.y, r.max.y), z: Math.min(r.min.z, r.max.z) }), max: mm3({ x: Math.max(r.min.x, r.max.x), y: Math.max(r.min.y, r.max.y), z: Math.max(r.min.z, r.max.z) }) };
}

function cameraFromFt(eye: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }, box: CropBox3d | null): View3dCamera {
  const e = mm3(eye);
  const t = mm3(at);
  const diag = box ? 2 * Math.hypot(box.halfSize.x, box.halfSize.y, box.halfSize.z) : Math.hypot(e.x - t.x, e.y - t.y, e.z - t.z);
  const straightDown = Math.abs(e.x - t.x) < 1 && Math.abs(e.y - t.y) < 1;
  return { eye: e, target: t, up: straightDown ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 }, fovDeg: 45, orthoHeightMm: Math.max(1000, diag * 0.9) };
}

export function registerBim3dViewTools(server: McpServer, caller: ResolveBimCaller) {
  server.registerTool(
    "bim_create_3d_view",
    {
      title: "Create a 3D view",
      description:
        "Create a saved 3D view, pre-cropped: of_elements (or region_ft) fits its 3D crop box to them, grown out to the floor and next level and the grid lines around them (a storey and bay, never a tight box); box_ft sets the box exactly; neither crops to the whole model. look_from picks the camera (default south_west isometric). place_on puts it on a sheet in the same approval, e.g. an isometric of a mechanical room. On sheets it prints as vector hidden-line from its camera, cropped to the whole box. Returns the new view id.",
      inputSchema: {
        ...target,
        ...baseRevision,
        name: z.string().trim().min(1).max(120),
        of_elements: z.array(z.string().min(1).max(200)).min(1).max(5000).optional().describe("Element ids to frame and crop to."),
        region_ft: regionFt.optional(),
        box_ft: boxFt.optional(),
        look_from: lookFrom.optional(),
        projection: z.enum(["perspective", "orthographic"]).optional().describe("How the live 3D view draws depth (default orthographic for drawing-set views). Sheets print orthographic either way."),
        place_on: z.object({ sheet: z.string().min(1).max(200).describe("Sheet id or number."), center_in: pointFt.describe("Viewport centre, inches from the sheet's top-left."), scale: scaleInput }).optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_create_3d_view", extra, args, (model): Command | string => {
        if (args.box_ft && (args.of_elements || args.region_ft)) return "Give box_ft, or of_elements / region_ft to fit to, not both.";
        const viewId = stableId("view", extra, { ...args, base_revision: undefined });
        const fit = args.of_elements || args.region_ft ? { ...(args.of_elements ? { elementIds: args.of_elements } : {}), ...(args.region_ft ? { region: regionFromFt(args.region_ft) } : {}) } : undefined;
        const draft: Command = { type: "create_3d_view", viewId, name: args.name, ...(args.box_ft ? { cropBox: boxFromFt(args.box_ft) } : {}), ...(fit ? { fit } : {}) };
        // Fit first, so the camera is aimed at the box that results (the saved command names both exactly).
        // A retry of the same call finds its view already made: send the identical command, and the model server answers as before.
        const earlier = model.elements[viewId];
        const tried = earlier ? null : executeCommand(model, draft);
        if (tried && !tried.ok) return tried.error.message;
        const made = earlier ?? tried?.model.elements[viewId];
        const box = made?.kind === "view" ? made.props?.cropBox3d : undefined;
        if (!box) return "The 3D view couldn't be sized. Check the elements or region you gave.";
        const create: Command = { type: "create_3d_view", viewId, name: args.name, cropBox: box, camera: cameraLookingFrom(box, args.look_from ?? "south_west"), projection: args.projection ?? "orthographic" };
        if (!args.place_on) return create;
        const sheetId = findSheet(model, args.place_on.sheet);
        if (!sheetId) return `No sheet "${args.place_on.sheet}". Create it first or list views and sheets.`;
        return {
          type: "batch_documents",
          label: `3D view ${args.name} on sheet ${args.place_on.sheet}`,
          commands: [create, { type: "place_viewport", viewportId: stableId("vp", extra, { sheetId, viewId }), sheetId, viewId, center: { x: args.place_on.center_in.x * 25.4, y: args.place_on.center_in.y * 25.4 }, ...(args.place_on.scale ? { scale: args.place_on.scale } : {}) }],
        };
      }),
  );

  server.registerTool(
    "bim_set_3d_view_camera",
    {
      title: "Turn a 3D view's camera",
      description:
        "Point a saved 3D view's camera: look_from a named direction at its crop box, or eye_ft and target_ft exactly (feet). Optionally switch projection. The view opens from here and prints from here; a placed viewport's frame resizes to the box as seen from the new camera.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: z.string().min(1).max(200).describe("3D view id or exact name."),
        look_from: lookFrom.optional(),
        eye_ft: point3Ft.optional(),
        target_ft: point3Ft.optional(),
        projection: z.enum(["perspective", "orthographic"]).optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_3d_view_camera", extra, args, (model): Command | string => {
        const viewId = findView(model, args.view);
        const view = viewId ? model.elements[viewId] : undefined;
        if (!view || view.kind !== "view") return `No view named "${args.view}". List views and sheets first.`;
        if (view.viewType !== "three_d") return `"${view.name}" is not a 3D view.`;
        if ((args.eye_ft === undefined) !== (args.target_ft === undefined)) return "Give both eye_ft and target_ft, or look_from instead.";
        if (args.look_from && args.eye_ft) return "Give look_from, or eye_ft and target_ft, not both.";
        const box = viewCropBox3d(model, view);
        const camera = args.eye_ft && args.target_ft ? cameraFromFt(args.eye_ft, args.target_ft, box) : box && args.look_from ? cameraLookingFrom(box, args.look_from) : null;
        if (!camera) return "Say where to look from: look_from, or eye_ft and target_ft.";
        return { type: "set_3d_view_camera", viewId: view.id, camera, ...(args.projection ? { projection: args.projection } : {}) };
      }),
  );

  server.registerTool(
    "bim_set_3d_crop_box",
    {
      title: "Set a 3D view's crop box",
      description:
        "Size, fit, or switch a saved 3D view's 3D crop box: box_ft sets it exactly; fit 'selection' with element_ids (or region_ft) grows it to the storey and grid bay around them; fit 'model' puts it back around the whole model (square to the working angle). align 'working_angle' turns the box about its middle to the view's working angle, or align with from_ft/to_ft turns it square to a building edge; its size is kept (there is no rotate handle on the box; this is how it turns). crop_on false shows everything (the box is kept); show_box only changes what people editing see (it never prints). It crops live and on sheets, heights included; a placed viewport's frame follows.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: z.string().min(1).max(200).describe("3D view id or exact name."),
        box_ft: boxFt.optional(),
        fit: z.enum(["selection", "model"]).optional(),
        element_ids: z.array(z.string().min(1).max(200)).min(1).max(5000).optional(),
        region_ft: regionFt.optional(),
        crop_on: z.boolean().optional(),
        show_box: z.boolean().optional(),
        align: z
          .union([z.literal("working_angle"), z.object({ from_ft: pointFt, to_ft: pointFt }).strict()])
          .optional()
          .describe("Turn the box about its middle, size kept: to the working angle, or square to the edge through two plan points (feet)."),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_3d_crop_box", extra, args, (model): Command | string => {
        const viewId = findView(model, args.view);
        const view = viewId ? model.elements[viewId] : undefined;
        if (!view || view.kind !== "view") return `No view named "${args.view}". List views and sheets first.`;
        if (args.fit === "selection" && !args.element_ids && !args.region_ft) return "Fitting to a selection needs element_ids or region_ft.";
        return {
          type: "set_3d_crop_box",
          viewId: view.id,
          ...(args.box_ft ? { box: boxFromFt(args.box_ft) } : {}),
          ...(args.fit ? { fit: args.fit } : {}),
          ...(args.fit === "selection" && args.element_ids ? { elementIds: args.element_ids } : {}),
          ...(args.fit === "selection" && args.region_ft ? { region: regionFromFt(args.region_ft) } : {}),
          ...(args.crop_on !== undefined ? { enabled: args.crop_on } : {}),
          ...(args.show_box !== undefined ? { show: args.show_box } : {}),
          ...(args.align === "working_angle" ? { align: "working_angle" as const } : args.align ? { align: { from: { x: args.align.from_ft.x * FT, y: args.align.from_ft.y * FT }, to: { x: args.align.to_ft.x * FT, y: args.align.to_ft.y * FT } } } : {}),
        };
      }),
  );
}
