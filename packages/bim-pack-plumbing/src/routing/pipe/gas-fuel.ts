import type { SystemLabelDef, MepSystem } from "@permitzip/bim-kernel";

/**
 * Which fuel a gas system carries, from the system's own design data
 * (`design.pipe.gasType`), never from its name. Every printed word for a gas
 * system (pipe labels, tags, schedules, riser text, refusals) reads it here,
 * so a propane system never prints "natural gas".
 *
 * The system kind stays `natural_gas` for both fuels: the kind says "fuel
 * gas piping" (fittings, colours, rules); the fuel is a property of the
 * system, like its pressure.
 */

export type GasFuel = "natural" | "propane";

export const GAS_FUEL_LABEL: Readonly<Record<GasFuel, string>> = { natural: "Natural gas", propane: "Propane" };
/** As tags and schedule headers abbreviate it. */
export const GAS_FUEL_SHORT: Readonly<Record<GasFuel, string>> = { natural: "NG", propane: "LP" };

/** Gas systems: the fuel the system's design names (natural when it names none). Null for other systems. */
export function gasFuelOf(system: MepSystem | null | undefined): GasFuel | null {
  if (!system || system.systemKind !== "natural_gas") return null;
  return system.design?.pipe?.gasType === "propane" ? "propane" : "natural";
}

/** Gas systems say their fuel ("Propane"), every printed word for them (`SYSTEM_LABEL_POINT`). */
export const GAS_FUEL_SYSTEM_LABEL: SystemLabelDef = {
  id: "gas_fuel",
  label(system) {
    const fuel = gasFuelOf(system);
    return fuel ? GAS_FUEL_LABEL[fuel] : null;
  },
};
