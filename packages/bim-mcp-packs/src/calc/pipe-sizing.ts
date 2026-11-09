import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { builtinCalcRegistry, type ProjectCodeAdoption } from "@permitzip/bim-calc";
import { type GasSystemSizing, PLUMBING_TOOL_ARGS, PLUMBING_TOOL_GROUPS } from "@permitzip/bim-pack-plumbing";
import { serviceOf, type ModelState } from "@permitzip/bim-kernel";
import { buildWaterDrainSizeCommand } from "./plumbing-sizing";
import { codeEditionRequest } from "./code-editions";
import { registerPackTools } from "./pack-tools";
import { tradeBaseRevision, tradeTarget } from "../runtime";
import type { BuiltCommand, PartToolHelpers } from "../parts/parts";
import type { ProjectFuelGasLookup, ProjectPlumbingLookup } from "./capabilities";
import { noAdoptedFuelGasCode, noAdoptedPlumbingCode } from "./local";

/**
 * Apply a pipe system's sizing proposal (gas today): the sizes
 * bim_run_calc plumbing.gas_system shows, recomputed from the model at the
 * revision the person approves, so the agent never supplies sizes. One edit
 * (set_pipe_sizes), behind an approval card; reducers go where sizes change.
 * The project's fuel gas code comes from its Code Study (whatever discipline
 * it was filed under), else fuel_gas_edition / state; with none it asks.
 */

const registry = builtinCalcRegistry();

/** bim_size_pipes' arguments, as the Plumbing and gas add-on declares them. */
export const PIPE_SIZING_ARGS = {
  bim_size_pipes: z.object(PLUMBING_TOOL_ARGS.bim_size_pipes),
} as const;

/** The target half of bim_size_pipes' arguments, built once per process. */
const SIZE_PIPES_WHERE = z.object({ project_id: z.string().uuid(), model_id: z.string().min(1).max(200), base_revision: z.number().int().min(0).optional() });

export type { ProjectFuelGasLookup } from "./capabilities";

type SizeArgs = z.output<(typeof PIPE_SIZING_ARGS)["bim_size_pipes"]>;

/** The set_pipe_sizes command for the proposal at this model, or why there is nothing to apply. */
export function buildSizePipesCommand(model: ModelState, a: SizeArgs, adoption: ProjectCodeAdoption | null, key: string): BuiltCommand {
  const r = registry.run({
    calc: "plumbing.gas_system",
    inputs: { system_id: a.system_id, ...(a.method ? { method: a.method } : {}) },
    model,
    ...codeEditionRequest({ fuel_gas_edition: a.fuel_gas_edition, state: a.state }),
    projectAdoptions: { fuel_gas: adoption },
  });
  if (!r.ok) return { ok: false, message: r.reason };
  const sizing = r.run.detail as GasSystemSizing | null;
  if (!sizing) return { ok: false, message: r.run.issues.map((i) => i.message).join(" ") || `Couldn't size ${a.system_id}.` };
  const changes = sizing.proposals.filter((p) => p.change === "up" || (a.allow_smaller && p.change === "down"));
  const tables = [...new Set(sizing.zones.map((z) => z.table).filter((t): t is string => t !== null))].join(", ");
  if (changes.length === 0) {
    const down = sizing.proposals.filter((p) => p.change === "down").length;
    return { ok: false, message: `Nothing to resize on ${sizing.systemName}: every pipe carries its load at its zone's pressure (${tables || "402.4 equation"}).${down > 0 ? ` ${down} pipe${down === 1 ? " is" : "s are"} larger than needed; give allow_smaller to reduce ${down === 1 ? "it" : "them"}.` : ""}` };
  }
  return {
    ok: true,
    command: {
      type: "set_pipe_sizes",
      idPrefix: `size-${key.replace(/^agent-/, "").slice(0, 16)}`,
      systemId: sizing.systemId,
      label: `Sized ${changes.length} pipe${changes.length === 1 ? "" : "s"} on ${sizing.systemName} from ${tables || "the 402.4 equation"}`.slice(0, 160),
      sizes: changes.map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn })),
    },
  };
}

export function registerBimPipeSizingTools(server: McpServer, helpers: PartToolHelpers, options: { fuelGas?: ProjectFuelGasLookup; plumbing?: ProjectPlumbingLookup } = {}): void {
  // bim_size_pipes keeps the trade tools' frozen argument words (c6a-trade-tools-snapshot.test.ts).
  const target = tradeTarget;
  const baseRevision = tradeBaseRevision;
  // A host with no record of adopted codes answers none; sizing then takes the edition or state given, or asks.
  const lookup = options.fuelGas ?? noAdoptedFuelGasCode;
  const plumbingLookup = options.plumbing ?? noAdoptedPlumbingCode;
  const schema = PIPE_SIZING_ARGS.bim_size_pipes;
  // Needs the project's adopted fuel gas and plumbing codes and builds the sizes from the open model: hosted here.
  registerPackTools(server, null, "plumbing_gas", {
    only: PLUMBING_TOOL_GROUPS.sizing,
    hosted: {
      bim_size_pipes: (copy) =>
        server.registerTool("bim_size_pipes", { ...copy, inputSchema: { ...target, ...baseRevision, ...schema.shape } }, async (args, extra) => {
      const where = SIZE_PIPES_WHERE.safeParse(args);
      const own = schema.safeParse(args);
      if (!where.success || !own.success) {
        const issues = [...(where.success ? [] : where.error.issues), ...(own.success ? [] : own.error.issues)];
        return { content: [{ type: "text" as const, text: `Those arguments don't fit bim_size_pipes: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      }
      let plumbing: ProjectCodeAdoption | null = null;
      if (!own.data.plumbing_edition) {
        try {
          plumbing = await plumbingLookup(extra, where.data.project_id);
        } catch (err) {
          return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      }
      let adoption: ProjectCodeAdoption | null = null;
      if (!own.data.fuel_gas_edition) {
        try {
          adoption = await lookup(extra, where.data.project_id);
        } catch (err) {
          return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      }
      return helpers.edit("bim_size_pipes", extra, where.data, own.data, (model, key) => {
        const sys = model.elements[own.data.system_id];
        return sys?.kind === "mep_system" && serviceOf(sys.systemKind) !== "gas" ? buildWaterDrainSizeCommand(model, own.data, plumbing, key) : buildSizePipesCommand(model, own.data, adoption, key);
      });
        }),
    },
  });
}
