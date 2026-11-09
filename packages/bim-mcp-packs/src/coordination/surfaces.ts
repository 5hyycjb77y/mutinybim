import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asElementId, resolveModelLevel, surfacesAt, type LinkedSurfaceSource, type ModelState, type SurfaceAt, type SurfacesAtResult, type SurfacesTarget } from "@permitzip/bim-kernel";
import { convert, type UnitCode } from "@permitzip/bim-units";
import type { LinkedSurfaceSources } from "./capabilities";
import { explain, failure, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";

/**
 * bim_surfaces_at: the floor or roof under a part or point, the ceiling and
 * roof over it, and the structure above, each with its height and where it
 * came from (kernel surfaces/). Read only, under model read access (the
 * caller checks it). Linked models' slabs, roofs and ceilings come from the
 * host's linked models, read as the caller; if they can't be read the answer
 * says so and uses this model alone. Gated by the `mutinybim` core skill.
 */

export const BIM_SURFACES_AT_TOOL = "bim_surfaces_at";

export const bimSurfacesAtDescription =
  "Floor (or roof) under a placed part or a point, and the ceiling, roof and structure over it, each with its height and source (stated host, space ceiling height, our slabs, linked slabs/roofs/ceilings). Give element_id, or x_ft, y_ft and level.";

/** Built on first use, as the other packs' inputs are read at registration. */
export function bimSurfacesAtInput() {
  return {
    ...target,
    ...surfacesPointInput,
  };
}

const surfacesPointInput = {
  element_id: z.string().min(1).max(200).optional().describe("A placed part (RTU-1's id)."),
  x_ft: z.number().finite().optional(),
  y_ft: z.number().finite().optional(),
  level: z.string().min(1).max(80).optional().describe("Level name or id, with x_ft and y_ft."),
};

export type BimSurfacesAtArgs = z.infer<z.ZodObject<ReturnType<typeof bimSurfacesAtInput>>>;

/** A height as the 5c agent vocabulary has it: a number and its bim-units unit code. */
type Quantity = { readonly value: number; readonly unit: UnitCode };

const LENGTH_UNIT: UnitCode = "ft";
/** Feet in, model mm out, to a thousandth of a millimetre (no float residue from the SI round trip). */
const toMm = (v: number): number => Math.round(convert(v, LENGTH_UNIT, "mm") * 1000) / 1000;
const ft = (mm: number): Quantity => ({ value: Math.round(convert(mm, "mm", LENGTH_UNIT) * 100) / 100, unit: LENGTH_UNIT });

function sourceLine(s: SurfaceAt["source"]): string {
  switch (s.kind) {
    case "level":
      return `level ${s.name}`;
    case "slab":
      return s.name;
    case "space":
      return `space ${s.name} (its ceiling height)`;
    case "ceiling":
      return `${s.name} (a ${s.form.replace(/_/g, " ")} ceiling drawn in the model)`;
    case "element":
      return `${s.name} (drawn in the model)`;
    case "host":
      return `${s.name} (the host it is stood on)`;
    case "linked":
      return `${s.name} (${s.ifcClass}, linked ${s.modelLabel})`;
  }
}

function surface(s: SurfaceAt | null) {
  if (!s) return null;
  return { height: ft(s.elevationMm), ...(s.aboveFloorMm !== null ? { above_floor: ft(s.aboveFloorMm) } : {}), source: sourceLine(s.source) };
}

/** The agent's answer: heights as `{ value, unit }` in feet, each with its source in words. */
export function surfacesAnswer(result: Extract<SurfacesAtResult, { ok: true }>, linkedNote: string | null) {
  return {
    at: { x: ft(result.point.x), y: ft(result.point.y), elevation: ft(result.probeMm), level: result.level?.name ?? null },
    floor: surface(result.floor),
    ceiling: surface(result.ceiling),
    roof: surface(result.roof),
    structure_above: surface(result.structureAbove),
    notes: linkedNote ? [linkedNote, ...result.notes] : result.notes,
  };
}

/** What the agent asked about, as a kernel target; a string is a plain refusal. */
export function surfacesTarget(model: ModelState, args: Pick<BimSurfacesAtArgs, "element_id" | "x_ft" | "y_ft" | "level">): SurfacesTarget | string {
  if (args.element_id) {
    if (args.x_ft !== undefined || args.y_ft !== undefined) return "Give element_id or a point (x_ft, y_ft, level), not both";
    return { elementId: asElementId(args.element_id) };
  }
  if (args.x_ft === undefined || args.y_ft === undefined || !args.level) return "Give element_id, or x_ft, y_ft and level";
  const level = resolveModelLevel(model, args.level);
  if (!level.ok) return level.message;
  if (!level.level) return `${args.level} has elements on it but no level with an elevation yet; bim_list_levels shows the model's levels`;
  return { point: { x: toMm(args.x_ft), y: toMm(args.y_ft) }, levelId: level.level.id };
}

/** The project's linked models as surface sources; a note in words when they couldn't all be read. */
async function linkedSources(read: LinkedSurfaceSources, extra: Extra, projectId: string): Promise<{ sources: readonly LinkedSurfaceSource[]; note: string | null }> {
  try {
    return await read(extra, projectId);
  } catch (err) {
    console.error("[bim_surfaces_at] linked models unreadable; answering from this model only", { projectId, err });
    return { sources: [], note: `The linked models couldn't be read (${err instanceof Error ? err.message : "unknown error"}), so roofs and ceilings come only from this model.` };
  }
}

export async function bimSurfacesAtHandler(caller: ResolveBimCaller, linkedSurfaces: LinkedSurfaceSources, args: BimSurfacesAtArgs, extra: Extra) {
  try {
    const who = await caller(extra, args.project_id, false);
    const linked = await linkedSources(linkedSurfaces, extra, args.project_id);
    return await withSession(who, args.model_id, undefined, async (s) => {
      const model = s.model();
      const t = surfacesTarget(model, args);
      if (typeof t === "string") return failure(t);
      const result = surfacesAt(model, t, linked.sources);
      if (!result.ok) return failure(result.reason);
      return text(surfacesAnswer(result, linked.note));
    });
  } catch (err) {
    return explain(err, BIM_SURFACES_AT_TOOL);
  }
}

export function registerBimSurfacesTools(server: McpServer, caller: ResolveBimCaller, linkedSurfaces: LinkedSurfaceSources): void {
  server.registerTool(
    BIM_SURFACES_AT_TOOL,
    { title: "Floor, ceiling and roof at a point", description: bimSurfacesAtDescription, inputSchema: bimSurfacesAtInput() },
    async (args, extra) => bimSurfacesAtHandler(caller, linkedSurfaces, args, extra),
  );
}
