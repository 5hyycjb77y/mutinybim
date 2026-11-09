import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INTERNAL_ORIGIN, describeWorkingAngle, documentIndex, modelToShared, siteMapConversion, siteOf, siteWorkingAngleDeg, workingAngleFromEdge, type Command, type ModelState, type SharedCoordinates, type SitePoint } from "@permitzip/bim-kernel";
import { BIM_COORDINATE_EDIT_TOOL_NAMES, type BimCoordinateEditToolName } from "../support/tool-names";
import type { BuiltCommand, PartToolHelpers } from "../parts/parts";
import { findView } from "../views/views";

/**
 * Coordinates tools: read where the model sits (project base point, survey
 * point, internal origin, true north, the working angle) and change it with
 * the same kernel commands the Coordinates dialog sends. Edits pause for approval in Cmd+J;
 * bim_preview_coordinates_edit shows what an edit would do without saving.
 */

const MM_PER_FT = 304.8;
const ft = (v: number) => v * MM_PER_FT;
const toFt = (mm: number) => Math.round((mm / MM_PER_FT) * 1000) / 1000;

const coordFt = z.number().finite().min(-300_000_000).max(300_000_000);
const modelPointFt = z.object({ x_ft: coordFt, y_ft: coordFt, z_ft: coordFt.optional() }).describe("A model position in feet: x east, y plan north, z elevation (default 0).");
const sharedFt = z.object({ east_west_ft: coordFt, north_south_ft: coordFt, elevation_ft: coordFt }).describe("Shared (site) coordinates in feet.");

export const COORDINATE_EDIT_ARGS = {
  bim_set_project_origin: z.object({
    mode: z
      .enum(["move_point", "relocate_project"])
      .describe("move_point: only the base point moves on the model; nothing's site coordinates change. relocate_project: the building moves on the site; every element's site coordinates change, geometry stays put."),
    position: modelPointFt.optional().describe("New model position of the base point (feet). Needed for move_point."),
    shared: sharedFt.optional().describe("The base point's new site coordinates (relocate_project only)."),
  }),
  bim_set_survey_point: z.object({
    mode: z
      .enum(["move_point", "relocate_project"])
      .describe("move_point: only the survey point marker moves on the model; nothing's site coordinates change. relocate_project: the site moves under the building so the survey point (here, or at position) reads the shared coordinates you give; every element's site coordinates change, geometry stays put."),
    position: modelPointFt.optional().describe("New model position of the survey point (feet). Needed for move_point."),
    shared: sharedFt.optional().describe("The survey point's site coordinates (relocate_project only), e.g. the benchmark from the civil drawings."),
  }),
  bim_set_true_north: z.object({
    angle_deg: z.number().min(-360).max(360).optional().describe("Degrees clockwise from plan north (up on a plan-north plan) to true north."),
    from_ft: z.object({ x_ft: coordFt, y_ft: coordFt }).optional().describe("Or two plan points: true north runs from here…"),
    to_ft: z.object({ x_ft: coordFt, y_ft: coordFt }).optional().describe("…toward here."),
  }),
  bim_set_working_angle: z.object({
    angle_deg: z.number().min(-3600).max(3600).optional().describe("Degrees counter-clockwise from model east to the direction people draw in (a building's walls). Kept in (-45, 45]; 0 puts it back square to the model."),
    from_ft: z.object({ x_ft: coordFt, y_ft: coordFt }).optional().describe("Or two plan points along a building edge (a wall, a slab edge, a grid line): the axes turn square to it. From here…"),
    to_ft: z.object({ x_ft: coordFt, y_ft: coordFt }).optional().describe("…to here."),
    view: z.string().min(1).max(200).optional().describe("Set it for one view only (id or exact name) instead of the whole model."),
    use_model_angle: z.literal(true).optional().describe("With view: drop the view's own angle so it follows the model's again."),
  }),
} as const satisfies Record<BimCoordinateEditToolName, z.ZodTypeAny>;

const point = (p: { x_ft: number; y_ft: number; z_ft?: number }): SitePoint => ({ x: ft(p.x_ft), y: ft(p.y_ft), z: ft(p.z_ft ?? 0) });
const shared = (s: { east_west_ft: number; north_south_ft: number; elevation_ft: number }): SharedCoordinates => ({ eastWest: ft(s.east_west_ft), northSouth: ft(s.north_south_ft), elevation: ft(s.elevation_ft) });

/** The kernel command a coordinates tool sends, or the plain reason it can't be built. */
export function buildCoordinateCommand(tool: BimCoordinateEditToolName, raw: unknown, model?: ModelState): BuiltCommand {
  switch (tool) {
    case "bim_set_project_origin": {
      const a = COORDINATE_EDIT_ARGS.bim_set_project_origin.parse(raw);
      if (a.mode === "move_point" && !a.position) return { ok: false, message: "move_point needs position (where the base point goes on the model, in feet)." };
      if (a.mode === "move_point" && a.shared) return { ok: false, message: "move_point keeps the site where it is, so it takes no site coordinates. Use relocate_project to type new site coordinates." };
      if (a.mode === "relocate_project" && !a.position && !a.shared) return { ok: false, message: "relocate_project needs shared (new site coordinates), position, or both." };
      const command: Command = { type: "set_project_origin", mode: a.mode, ...(a.position ? { position: point(a.position) } : {}), ...(a.shared ? { shared: shared(a.shared) } : {}) };
      return { ok: true, command };
    }
    case "bim_set_survey_point": {
      const a = COORDINATE_EDIT_ARGS.bim_set_survey_point.parse(raw);
      if (a.mode === "move_point" && !a.position) return { ok: false, message: "move_point needs position (where the survey point goes on the model, in feet)." };
      if (a.mode === "move_point" && a.shared) return { ok: false, message: "move_point keeps the site where it is, so it takes no site coordinates. Use relocate_project to give the survey point new site coordinates." };
      if (a.mode === "relocate_project" && !a.shared) return { ok: false, message: "relocate_project needs shared: the site coordinates the survey point should read." };
      const command: Command = { type: "set_survey_point", mode: a.mode, ...(a.position ? { position: point(a.position) } : {}), ...(a.shared ? { shared: shared(a.shared) } : {}) };
      return { ok: true, command };
    }
    case "bim_set_true_north": {
      const a = COORDINATE_EDIT_ARGS.bim_set_true_north.parse(raw);
      const picked = a.from_ft || a.to_ft;
      if (picked && a.angle_deg !== undefined) return { ok: false, message: "Give angle_deg or from_ft/to_ft, not both." };
      if (picked) {
        if (!a.from_ft || !a.to_ft) return { ok: false, message: "Two-point true north needs both from_ft and to_ft." };
        return { ok: true, command: { type: "set_true_north", from: { x: ft(a.from_ft.x_ft), y: ft(a.from_ft.y_ft) }, to: { x: ft(a.to_ft.x_ft), y: ft(a.to_ft.y_ft) } } };
      }
      if (a.angle_deg === undefined) return { ok: false, message: "Give angle_deg (clockwise from plan north) or from_ft and to_ft." };
      return { ok: true, command: { type: "set_true_north", angleDeg: a.angle_deg } };
    }
    case "bim_set_working_angle": {
      const a = COORDINATE_EDIT_ARGS.bim_set_working_angle.parse(raw);
      const picked = a.from_ft || a.to_ft;
      if (a.use_model_angle && !a.view) return { ok: false, message: "use_model_angle needs view: it drops that view's own angle." };
      if (a.use_model_angle && (picked || a.angle_deg !== undefined)) return { ok: false, message: "Give use_model_angle on its own, or an angle, not both." };
      if (picked && a.angle_deg !== undefined) return { ok: false, message: "Give angle_deg or from_ft/to_ft, not both." };
      if (picked && (!a.from_ft || !a.to_ft)) return { ok: false, message: "Two-point alignment needs both from_ft and to_ft." };
      if (!a.use_model_angle && !picked && a.angle_deg === undefined) return { ok: false, message: "Give angle_deg, or from_ft and to_ft along a building edge." };
      const from = a.from_ft ? { x: ft(a.from_ft.x_ft), y: ft(a.from_ft.y_ft) } : null;
      const to = a.to_ft ? { x: ft(a.to_ft.x_ft), y: ft(a.to_ft.y_ft) } : null;
      if (!a.view) return { ok: true, command: from && to ? { type: "set_working_angle", from, to } : { type: "set_working_angle", angleDeg: a.angle_deg ?? 0 } };
      const viewId = model ? findView(model, a.view) : null;
      if (!viewId) return { ok: false, message: `No view named "${a.view}". List views and sheets first.` };
      if (a.use_model_angle) return { ok: true, command: { type: "set_view_properties", viewId, props: { workingAngleDeg: null } } };
      const deg = from && to ? workingAngleFromEdge(from, to) : (a.angle_deg ?? 0);
      if (deg === null) return { ok: false, message: "The two points are the same; give a second point further along the edge." };
      return { ok: true, command: { type: "set_view_properties", viewId, props: { workingAngleDeg: deg } } };
    }
  }
}

function pointFacts(model: ModelState, p: SitePoint) {
  const s = modelToShared(siteOf(model), p);
  return {
    model_ft: { x: toFt(p.x), y: toFt(p.y), z: toFt(p.z) },
    shared_ft: { north_south: toFt(s.northSouth), east_west: toFt(s.eastWest), elevation: toFt(s.elevation) },
  };
}

/** Where the model sits, as an agent reads it. */
export function readCoordinates(model: ModelState) {
  const site = siteOf(model);
  const mc = siteMapConversion(site);
  return {
    revision: model.revision,
    true_north_deg: site.trueNorthDeg,
    true_north_means: "degrees clockwise from plan north (model +Y, up on a plan-north plan) to true north",
    working_angle_deg: siteWorkingAngleDeg(site),
    working_angle_means: `${describeWorkingAngle(siteWorkingAngleDeg(site))}. Degrees counter-clockwise from model east to the direction people draw in; route snaps, the placement grid, drafting ortho and new 3D crop boxes follow it. Never moves geometry or changes site coordinates.`,
    views_with_own_working_angle: documentIndex(model).views.filter((v) => v.props?.workingAngleDeg !== undefined).map((v) => ({ view_id: v.id, name: v.name, working_angle_deg: v.props?.workingAngleDeg ?? 0 })),
    project_base_point: pointFacts(model, site.basePoint),
    survey_point: pointFacts(model, site.surveyPoint),
    internal_origin: pointFacts(model, INTERNAL_ORIGIN),
    export_map_conversion_m: mc,
    note: "Model coordinates are where geometry and linked models are placed; changing coordinates never moves them, only what they read on the site.",
  };
}

const DESCRIPTIONS: Readonly<Record<BimCoordinateEditToolName, { title: string; description: string }>> = {
  bim_set_project_origin: {
    title: "Move the project base point",
    description:
      "Either move only the base point on the model (move_point: everything keeps its site coordinates) or relocate the project on the site (relocate_project: geometry stays put, every element's site coordinates change by the same move, the survey point stays on the site). Feet.",
  },
  bim_set_survey_point: {
    title: "Move or set the survey point",
    description:
      "The same two moves as the Coordinates dialog's survey point: move only its marker on the model (move_point: nobody's site coordinates change), or give it the site coordinates it should read (relocate_project: the site moves under the building, every element's site coordinates change, geometry and linked models stay put). Feet. Read bim_read_coordinates first.",
  },
  bim_set_true_north: {
    title: "Set true north",
    description: "Set the angle from plan north to true north (degrees clockwise), or give two plan points along true north. Turns the building on the site about the project base point; geometry and plans drawn plan-north do not move.",
  },
  bim_set_working_angle: {
    title: "Set the working angle",
    description:
      "Turn the directions people draw in to match a skewed building: give angle_deg, or two plan points along a building edge (from_ft, to_ft) and the axes turn square to it. Route snaps (square and 45°), the placement grid, drafting ortho/polar and new 3D crop boxes follow it; plans set to orientation 'working_angle' draw turned to it. With view, it applies to that view only (use_model_angle drops the view's own). Never moves geometry, linked models, site coordinates or true north.",
  },
};

export function registerBimCoordinateTools(server: McpServer, helpers: PartToolHelpers): void {
  const { target, baseRevision } = helpers;
  const common = z.object({ ...target, ...baseRevision });

  server.registerTool(
    "bim_read_coordinates",
    {
      title: "Read the project coordinates",
      description:
        "Where the model sits: the project base point and survey point (model feet and site N/S, E/W, elevation in feet), the internal origin, true north (degrees clockwise from plan north), the working angle (the model's and any view's own) and the placement an IFC export carries. Read before changing coordinates.",
      inputSchema: { ...target },
    },
    async (args, extra) => helpers.read("bim_read_coordinates", extra, args, (s) => readCoordinates(s.model())),
  );

  server.registerTool(
    "bim_preview_coordinates_edit",
    {
      title: "Preview a coordinates change",
      description: "Dry run of bim_set_project_origin, bim_set_survey_point, bim_set_true_north or bim_set_working_angle at the latest revision: what would change, or the reason it would be refused. Saves nothing and needs no approval.",
      inputSchema: { ...target, tool: z.enum(BIM_COORDINATE_EDIT_TOOL_NAMES), args: z.record(z.string(), z.unknown()).describe("The same arguments the edit tool takes, without project_id / model_id / base_revision.") },
    },
    async (input, extra) => {
      const parsed = COORDINATE_EDIT_ARGS[input.tool].safeParse(input.args);
      if (!parsed.success) return { content: [{ type: "text" as const, text: `Those arguments don't fit ${input.tool}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      return helpers.read("bim_preview_coordinates_edit", extra, input, (s) => {
        const model = s.model();
        const built = buildCoordinateCommand(input.tool, parsed.data, model);
        if (!built.ok) return { status: "would_refuse", revision: model.revision, message: built.message };
        return { ...s.preview(built.command), command: built.command, coordinates_now: readCoordinates(model) };
      });
    },
  );

  for (const tool of BIM_COORDINATE_EDIT_TOOL_NAMES) {
    const schema: z.ZodObject<z.ZodRawShape> = COORDINATE_EDIT_ARGS[tool];
    const inputSchema: z.ZodRawShape = { ...target, ...baseRevision, ...schema.shape };
    server.registerTool(tool, { title: DESCRIPTIONS[tool].title, description: DESCRIPTIONS[tool].description, inputSchema }, async (args: unknown, extra: unknown) => {
      const where = common.safeParse(args);
      const own = schema.safeParse(args);
      if (!where.success || !own.success) {
        const issues = [...(where.success ? [] : where.error.issues), ...(own.success ? [] : own.error.issues)];
        return { content: [{ type: "text" as const, text: `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      }
      return helpers.edit(tool, extra, where.data, own.data, (model) => buildCoordinateCommand(tool, own.data, model));
    });
  }
}
