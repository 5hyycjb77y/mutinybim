import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { schemaOnce, schemaOnce2 } from "../support/edit-schemas";
import { elementsOfKind, type Command, type MepSystem, type ModelState } from "@permitzip/bim-kernel";
import { pipeTypeSchema, projectPlumbingSettings, PLUMBING_TOOL_ARGS, PLUMBING_TOOL_GROUPS, plumbingCatalog, stacksRead, type StacksRead } from "@permitzip/bim-pack-plumbing";
import { tradeBaseRevision as baseRevision, explain, failure, runEdit, tradeTarget as target, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { BIM_PLUMBING_DESIGN_EDIT_TOOL_NAMES, type BimPlumbingDesignEditToolName } from "../support/tool-names";
import { registerPackTools, type HostedPackTool } from "../calc/pack-tools";

export { plumbingCatalog, stacksRead, type StacksRead };

/**
 * The Plumbing tab's design choices for agents: each pipe system's look
 * (colour, line pattern, weight) and auto-sizing, the project's auto-sizing,
 * building type and demand curve, and pipe types. The edit sends the same
 * kernel command the tab's Systems and Pipe types dialogs send and pauses for
 * approval. Auto-sizing never turns itself on: an agent sets it only when the
 * person asks.
 */

export const PLUMBING_DESIGN_ARGS = { bim_plumbing_design: PLUMBING_TOOL_ARGS.bim_plumbing_design } as const satisfies Record<BimPlumbingDesignEditToolName, z.ZodRawShape>;

function findSystem(model: ModelState, key: string): MepSystem | null {
  const k = key.trim().toLowerCase();
  return elementsOfKind(model.elements, "mep_system").find((s) => s.domain === "pipe" && (s.id === key || s.name.toLowerCase() === k)) ?? null;
}

const pipeSystemNames = (model: ModelState) =>
  elementsOfKind(model.elements, "mep_system")
    .filter((s) => s.domain === "pipe")
    .map((s) => s.name)
    .join(", ") || "none yet";

/** The kernel command a plumbing design edit sends, or why not. */
export function plumbingDesignCommand(raw: unknown, model: ModelState): Command | string {
  const parsed = schemaOnce(PLUMBING_DESIGN_ARGS.bim_plumbing_design).safeParse(raw);
  if (!parsed.success) return `Those arguments don't fit bim_plumbing_design: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
  const a = parsed.data;
  switch (a.action) {
    case "system_look":
    case "system_sizing": {
      if (!a.system) return "Give system: the pipe system's id or name.";
      const sys = findSystem(model, a.system);
      if (!sys) return `No pipe system "${a.system}". Pipe systems here: ${pipeSystemNames(model)}.`;
      if (a.action === "system_look") {
        if (a.colour === undefined && a.pattern === undefined && a.weight === undefined) return "Give colour, pattern or weight to change.";
        return { type: "set_system_graphics", systemId: sys.id, ...(a.colour !== undefined ? { colour: a.colour === null ? null : a.colour.toLowerCase() } : {}), ...(a.pattern !== undefined ? { pattern: a.pattern } : {}), ...(a.weight !== undefined ? { weight: a.weight } : {}) };
      }
      if (a.sizing_mode === undefined && a.demand_curve === undefined) return "Give sizing_mode or demand_curve to change.";
      return { type: "set_system_design", systemId: sys.id, design: { pipe: { ...(a.sizing_mode !== undefined ? { sizingMode: a.sizing_mode } : {}), ...(a.demand_curve !== undefined ? { demandCurve: a.demand_curve } : {}) } } };
    }
    case "project": {
      if (a.sizing_mode === undefined && a.building_type === undefined && a.demand_curve === undefined && a.insulation_schedule === undefined && a.insulation_source === undefined) return "Give sizing_mode, building_type, demand_curve or insulation_schedule to change.";
      const now = projectPlumbingSettings(model.elements);
      const buildingType = a.building_type === undefined ? now.buildingType : (a.building_type ?? undefined);
      const demandCurve = a.demand_curve === undefined ? now.demandCurve : (a.demand_curve ?? undefined);
      const pipeInsulation = a.insulation_schedule === undefined ? now.pipeInsulation : a.insulation_schedule === null ? undefined : a.insulation_schedule.map((r) => ({ systemKinds: r.system_kinds, belowNominalIn: r.below_in, thicknessIn: r.thickness_in, ...(r.material ? { material: r.material } : {}) }));
      const pipeInsulationSource = a.insulation_source === undefined ? now.pipeInsulationSource : (a.insulation_source ?? undefined);
      return {
        type: "save_catalog_entry",
        entry: { type: "plumbing_settings", name: "Project", sizingMode: a.sizing_mode ?? now.sizingMode, ...(buildingType ? { buildingType } : {}), ...(demandCurve ? { demandCurve } : {}), ...(pipeInsulation ? { pipeInsulation } : {}), ...(pipeInsulationSource ? { pipeInsulationSource } : {}) },
      };
    }
    case "save_pipe_type": {
      if (!a.pipe_type) return "Give pipe_type: { name, material, … }.";
      const t = a.pipe_type;
      const entry = pipeTypeSchema.safeParse({
        type: "pipe_type",
        name: t.name,
        material: t.material,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.spec ? { spec: t.spec } : {}),
        ...(t.system_kinds ? { systemKinds: t.system_kinds } : {}),
        ...(t.min_in !== undefined ? { minIn: t.min_in } : {}),
        ...(t.max_in !== undefined ? { maxIn: t.max_in } : {}),
        ...(t.joint ? { joint: t.joint } : {}),
        ...(t.fittings ? { fittings: t.fittings } : {}),
        ...(t.note !== undefined ? { note: t.note } : {}),
      });
      if (!entry.success) return `Pipe type ${t.name}: ${entry.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
      return { type: "save_catalog_entry", entry: entry.data, ...(a.replaces ? { replaces: a.replaces } : {}) };
    }
    case "delete_pipe_type": {
      if (!a.name) return "Give name: the pipe type to delete.";
      return { type: "delete_catalog_entry", entryType: "pipe_type", name: a.name };
    }
  }
}

export function registerBimPlumbingDesignTools(server: McpServer, caller: ResolveBimCaller) {
  const design =
    (tool: BimPlumbingDesignEditToolName): HostedPackTool =>
    (copy) =>
      server.registerTool(tool, { ...copy, inputSchema: { ...target, ...baseRevision, ...PLUMBING_DESIGN_ARGS[tool] } }, async (raw: Record<string, unknown>, extra: Extra) => {
        const where = schemaOnce2(target, baseRevision).safeParse(raw);
        if (!where.success) return failure(`Those arguments don't fit ${tool}: ${where.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const args = where.data;
        let model: ModelState;
        try {
          const who = await caller(extra, args.project_id, false);
          model = await withSession(who, args.model_id, undefined, async (s) => s.model());
        } catch (err) {
          return explain(err, tool);
        }
        const command = plumbingDesignCommand(raw, model);
        if (typeof command === "string") return failure(command);
        return runEdit(caller, tool, extra, { ...args, base_revision: args.base_revision ?? model.revision }, command);
      });

  // The edit picks one of several commands from the model (a system's look, its sizing, the project's settings, a pipe type): hosted here.
  // bim_plumbing_catalog is the add-on's own read, run by the host.
  registerPackTools(server, caller, "plumbing_gas", {
    only: PLUMBING_TOOL_GROUPS.design,
    shapes: PLUMBING_TOOL_ARGS,
    hosted: Object.fromEntries(BIM_PLUMBING_DESIGN_EDIT_TOOL_NAMES.map((tool) => [tool, design(tool)])),
  });
}
