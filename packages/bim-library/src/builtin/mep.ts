import type { FileLibrarySource } from "../file-provider";
import type { LibraryBundleInput } from "../schema";
import { BUILTIN_SCOPE } from "./aec";

/**
 * The built-in MEP calculations (SCHEDULES-PLAN §3a, §5d): named formulas a
 * schedule column, tag or agent calls by key. They read only fields the
 * kernel's MEP providers register (`own.*`, `load*`, `serves`), so they load
 * over `fieldProviderRegistry()` and evaluate the same everywhere. Firms copy
 * and change them in their own library; a model uses pinned copies.
 */

const POWERED = ["mep.equipment", "mep.electrical_device", "mep.lighting_fixture", "mep.plumbing_fixture", "mep.air_terminal"];
const GAS_OUTLETS = ["mep.equipment", "mep.plumbing_fixture", "mep.load_point"];

export const MEP_LIBRARY: LibraryBundleInput = {
  format: "mutinybim-library",
  version: 1,
  id: "mutinybim-mep",
  name: "MutinyBIM built-in MEP calculations",
  publisher: "MutinyBIM",
  revision: 1,
  requires: { mutinybim: ">=0.1.0" },
  units: [],
  classes: [],
  fields: [],
  formulas: [
    {
      id: "mep:formula:gas_demand_btuh",
      revision: 1,
      key: "PZ.GasDemandBtuh",
      name: "Gas demand",
      description: "What an appliance burns, in Btu/h, for gas connection schedules and the meter's total.",
      expression: "{own.mbh}",
      result: { valueType: "quantity", kind: "flow_gas_energy", unit: "Btu/h" },
      appliesTo: GAS_OUTLETS,
      examples: [{ inputs: { "own.mbh": { value: 199, unit: "MBH" } }, expected: { value: 199_000, unit: "Btu/h" } }],
    },
    {
      id: "mep:formula:connected_load_kva",
      revision: 1,
      key: "PZ.ConnectedLoadKva",
      name: "Connected load",
      description: "The item's electrical load as connected, in kVA.",
      expression: "{load}",
      result: { valueType: "quantity", kind: "power_apparent", unit: "kVA" },
      appliesTo: POWERED,
      examples: [{ inputs: { load: { value: 24_000, unit: "VA" } }, expected: { value: 24, unit: "kVA" } }],
    },
    {
      id: "mep:formula:demand_load_va",
      revision: 1,
      key: "PZ.DemandLoadVa",
      name: "Demand load",
      description: "A motor load at 125% (NEC 430.24 for the largest motor), any other load as connected. Panels read their own demand under the code rules.",
      expression: 'if({load_class} = "Motor", {load} * 1.25, {load})',
      result: { valueType: "quantity", kind: "power_apparent", unit: "VA" },
      appliesTo: POWERED,
      examples: [
        { inputs: { load_class: "Motor", load: { value: 1000, unit: "VA" } }, expected: { value: 1250, unit: "VA" } },
        { inputs: { load_class: "Lighting", load: { value: 1000, unit: "VA" } }, expected: { value: 1000, unit: "VA" } },
      ],
    },
    {
      id: "mep:formula:pump_served_gpm",
      revision: 1,
      key: "PZ.PumpServedGpm",
      name: "Flow a pump serves",
      description: "The fixed flow of every connection beyond the pump's discharge (circulators, booster and process pumps).",
      expression: "sum(serves, {load.gpm_fixed})",
      result: { valueType: "quantity", kind: "flow_liquid", unit: "gpm" },
      appliesTo: ["mep.equipment"],
    },
  ],
};

/** The built-in MEP calculations as a read-only scope, layered over the AEC library. */
export function builtinMepLibrarySource(): FileLibrarySource {
  return { scope: { ...BUILTIN_SCOPE, id: "builtin:mep", name: "Built-in MEP" }, kind: "bundle", bundle: MEP_LIBRARY };
}
