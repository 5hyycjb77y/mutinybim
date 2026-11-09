/**
 * The agent tools the Mechanical add-on declares (AGENT_TOOL_POINT) and the
 * reads they run (PACK_READ_POINT). None yet: the duct, airflow and
 * ventilation tools (bim_suggest_duct_size, bim_pressure_report,
 * bim_set_terminal_airflow, bim_run_calc's ventilation calcs) are generic
 * routing and calc tools in the host, and stay there.
 */
import type { AgentToolDescriptor } from "@permitzip/bim-pack/runtime";
import type { ModelState } from "@permitzip/bim-kernel";
import { RUN_PERFORMANCE_READ_ROW } from "./routing/performance-read";
import { DUCT_SIZE_READ_ROW } from "./routing/duct-size-read";

/** A read an agent tool runs (`kernel.pack_read` v1). A refusal is `{ refused: "<plain words>" }`. */
export interface MechanicalPackRead {
  readonly id: string;
  readonly label: string;
  run(model: ModelState, input: unknown): unknown;
}

export const MECHANICAL_AGENT_TOOLS: readonly AgentToolDescriptor[] = [];

export const MECHANICAL_PACK_READS: readonly MechanicalPackRead[] = [RUN_PERFORMANCE_READ_ROW, DUCT_SIZE_READ_ROW];
