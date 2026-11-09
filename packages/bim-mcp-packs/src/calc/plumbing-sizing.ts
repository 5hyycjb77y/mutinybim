import { builtinCalcRegistry, type ProjectCodeAdoption } from "@permitzip/bim-calc";
import { pipeSizeCommandFrom, type PipeSystemSizing } from "@permitzip/bim-pack-plumbing";
import type { ModelState } from "@permitzip/bim-kernel";
import type { BuiltCommand } from "../runtime";

/**
 * Pipe sizing for bim_size_pipes: the sizes bim_run_calc
 * plumbing.size_system proposes, recomputed from the model at the revision
 * the person approves, as one set_pipe_sizes edit (the add-on builds it). The agent never supplies
 * sizes. The project's plumbing code comes from its Code Study, else
 * plumbing_edition / state; with none it asks.
 */

const registry = builtinCalcRegistry();

export type { ProjectPlumbingLookup } from "./capabilities";

interface WaterDrainArgs {
  readonly system_id: string;
  readonly allow_smaller: boolean;
  readonly plumbing_edition?: "2021";
  readonly state?: string;
}

/** The set_pipe_sizes command for a system's proposal at this model, or why there is nothing to apply. */
export function buildWaterDrainSizeCommand(model: ModelState, a: WaterDrainArgs, adoption: ProjectCodeAdoption | null, key: string): BuiltCommand {
  const r = registry.run({ calc: "plumbing.size_system", inputs: { system_id: a.system_id }, model, ...(a.plumbing_edition ? { plumbingEdition: a.plumbing_edition } : {}), ...(a.state ? { state: a.state } : {}), projectAdoptions: { plumbing: adoption } });
  if (!r.ok) return { ok: false, message: r.reason };
  const sizing = r.run.detail as PipeSystemSizing | null;
  if (!sizing) return { ok: false, message: r.run.issues.map((i) => i.message).join(" ") || `Couldn't size ${a.system_id}.` };
  return pipeSizeCommandFrom(sizing, a.allow_smaller, key);
}
