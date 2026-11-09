import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Profile } from "@permitzip/bim-kernel";
import { area, baseRevision, failure, runEdit, target, type ResolveBimCaller } from "../runtime";
import { runSizeArgs, runSizeFrom } from "../parts/run-size";

/**
 * The model edits every trade uses: slide a branch, set a terminal's airflow,
 * resize a run or a riser, move equipment or a wall, change a tag's text.
 * Each is one kernel command sent through the authority as the caller, and
 * pauses for approval like every other edit.
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;

function profileFrom(input: { width_in?: number; height_in?: number; diameter_in?: number }): Profile | null {
  if (input.diameter_in !== undefined) return { shape: "round", diameter: input.diameter_in * MM_PER_IN };
  if (input.width_in !== undefined && input.height_in !== undefined) {
    return { shape: "rect", width: input.width_in * MM_PER_IN, height: input.height_in * MM_PER_IN };
  }
  return null;
}

const profileInput = {
  width_in: z.number().positive().max(240).optional().describe("Rectangular width in inches."),
  height_in: z.number().positive().max(240).optional().describe("Rectangular height in inches."),
  diameter_in: z.number().positive().max(240).optional().describe("Round diameter in inches (instead of width/height)."),
};

export function registerBimModelEditTools(server: McpServer, caller: ResolveBimCaller): void {
  server.registerTool(
    "bim_slide_branch",
    {
      title: "Slide a branch along its trunk",
      description:
        "Move a branch takeoff (a duct tap, or a routed tap, tee or wye on duct or pipe) to a new distance along its trunk. The trunk stays whole; connected pieces follow and parts stay put; if that is impossible you get the reason and nothing changes.",
      inputSchema: { ...target, ...area, ...baseRevision, tap_id: z.string().min(1).max(200), distance_ft: z.number().min(0).max(5000).describe("Distance from the start of the host duct, in feet.") },
    },
    async (args, extra) => runEdit(caller, "bim_slide_branch", extra, args, { type: "slide_branch", tapId: args.tap_id, s: args.distance_ft * MM_PER_FT }),
  );

  server.registerTool(
    "bim_set_terminal_airflow",
    {
      title: "Set an air terminal's airflow",
      description: "Set a diffuser or grille's design airflow (CFM). Totals up the system recompute.",
      inputSchema: { ...target, ...area, ...baseRevision, terminal_id: z.string().min(1).max(200), cfm: z.number().min(0).max(20000) },
    },
    async (args, extra) => runEdit(caller, "bim_set_terminal_airflow", extra, args, { type: "set_terminal_cfm", terminalId: args.terminal_id, cfm: args.cfm }),
  );

  server.registerTool(
    "bim_resize_run",
    {
      title: "Resize a duct or pipe run",
      description:
        "Change a run's size: rectangular, round or flat oval duct, or pipe (nominal size + material). The connected segments and elbows of the same size follow; transitions and branch takeoffs on the edge take the new size; a size a connector or fitting cannot take is refused with the reason.",
      inputSchema: { ...target, ...area, ...baseRevision, segment_id: z.string().min(1).max(200), ...runSizeArgs },
    },
    async (args, extra) => {
      const profile = runSizeFrom(args);
      if (typeof profile === "string") return failure(profile);
      return runEdit(caller, "bim_resize_run", extra, args, { type: "resize_run", segmentId: args.segment_id, profile });
    },
  );

  server.registerTool(
    "bim_move_equipment",
    {
      title: "Move equipment",
      description: "Move a unit by an offset in feet. Its connected ducts follow where they can.",
      inputSchema: { ...target, ...area, ...baseRevision, equipment_id: z.string().min(1).max(200), dx_ft: z.number().min(-1000).max(1000), dy_ft: z.number().min(-1000).max(1000) },
    },
    async (args, extra) =>
      runEdit(caller, "bim_move_equipment", extra, args, { type: "move_equipment", equipmentId: args.equipment_id, delta: { x: args.dx_ft * MM_PER_FT, y: args.dy_ft * MM_PER_FT } }),
  );

  server.registerTool(
    "bim_move_wall",
    {
      title: "Move a wall",
      description: "Move a wall by an offset in feet. The walls joined to it follow (their ends at its corners move with it, and walls teed into it stretch to stay on its face), so corners stay closed; its doors, windows, tags and room dimensions follow. disjoin: true leaves the joined walls where they are (Revit's Disjoin).",
      inputSchema: {
        ...target,
        ...area,
        ...baseRevision,
        wall_id: z.string().min(1).max(200),
        dx_ft: z.number().min(-1000).max(1000),
        dy_ft: z.number().min(-1000).max(1000),
        disjoin: z.boolean().optional().describe("Leave the walls joined to it where they are instead of carrying their ends"),
      },
    },
    async (args, extra) => runEdit(caller, "bim_move_wall", extra, args, { type: "move_wall", wallId: args.wall_id, delta: { x: args.dx_ft * MM_PER_FT, y: args.dy_ft * MM_PER_FT }, ...(args.disjoin === true ? { disjoin: true } : {}) }),
  );

  server.registerTool(
    "bim_resize_riser",
    {
      title: "Resize a riser",
      description: "Resize a riser through every level it crosses, as one change.",
      inputSchema: { ...target, ...baseRevision, riser_id: z.string().min(1).max(200), ...profileInput },
    },
    async (args, extra) => {
      const profile = profileFrom(args);
      if (!profile) return failure("Give width_in and height_in, or diameter_in.");
      return runEdit(caller, "bim_resize_riser", extra, args, { type: "resize_riser", riserId: args.riser_id, profile });
    },
  );

  server.registerTool(
    "bim_set_tag_text",
    {
      title: "Change a tag's text",
      description: "Replace the text of a model-linked tag.",
      inputSchema: { ...target, ...area, ...baseRevision, tag_id: z.string().min(1).max(200), text: z.string().min(1).max(200) },
    },
    async (args, extra) => runEdit(caller, "bim_set_tag_text", extra, args, { type: "set_tag_text", tagId: args.tag_id, text: args.text }),
  );
}
