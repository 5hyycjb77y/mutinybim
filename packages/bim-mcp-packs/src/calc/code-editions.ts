import { z } from "zod";
import { IFGC_EDITIONS, IPC_EDITIONS, NEC_EDITIONS, type RunRequest } from "@permitzip/bim-calc";

/**
 * The code-edition fields every calc tool takes, one shape, so what a tool
 * advertises and what a calc's refusal asks for ("give fuel_gas_edition:
 * \"2021\"", registry.ts resolveModelCode) are the same field names. Each
 * wins over the project's Code Study; state is used when neither names it.
 */
export const CODE_EDITION_ARGS = {
  nec_edition: z.enum(NEC_EDITIONS).optional().describe("Run under this NEC edition instead of the project's adopted one."),
  plumbing_edition: z.enum(IPC_EDITIONS).optional().describe("Plumbing code (IPC family) when Code Study names none."),
  fuel_gas_edition: z.enum(IFGC_EDITIONS).optional().describe("Fuel gas code (IFGC family) when Code Study names none."),
  state: z.string().trim().length(2).optional().describe("Two-letter state, used when neither an edition nor the project's Code Study names the code."),
} as const;

export interface CodeEditionArgs {
  readonly nec_edition?: (typeof NEC_EDITIONS)[number];
  readonly plumbing_edition?: (typeof IPC_EDITIONS)[number];
  readonly fuel_gas_edition?: (typeof IFGC_EDITIONS)[number];
  readonly state?: string;
}

/** The registry request fields for the editions given. */
export function codeEditionRequest(a: CodeEditionArgs): Pick<RunRequest, "necEdition" | "plumbingEdition" | "fuelGasEdition" | "state"> {
  return {
    ...(a.nec_edition ? { necEdition: a.nec_edition } : {}),
    ...(a.plumbing_edition ? { plumbingEdition: a.plumbing_edition } : {}),
    ...(a.fuel_gas_edition ? { fuelGasEdition: a.fuel_gas_edition } : {}),
    ...(a.state ? { state: a.state } : {}),
  };
}
