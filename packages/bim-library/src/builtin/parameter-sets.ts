import type { SharedFieldItem } from "../schema";

/**
 * Built-in baseline parameter sets (KERNEL-FOUNDATION §3.2): per class family,
 * the parameters an equipment list, Inspector or IFC export starts from.
 * Each set names two things:
 *
 * - `parameters`: shared-field items stored as part parameters. Each has a
 *   namespaced key (`core.`, `elec.`, `gas.`, `plumb.`, `mech.`, `struct.`;
 *   FOUNDATION adjustments D2) so two packs never collide on a bare name, and
 *   answers to `param.<name>` too (`parameterAliases`), the key every part
 *   parameter already had (`parameterOfParamDef`). The part still keeps the
 *   value under `<name>`, in the names and units the kernel's built-in parts
 *   already store (`voltage` in V, `mca` in A, `cooling_tons` in tons of
 *   refrigeration), so a set reads existing models with no conversion and no
 *   data change. New names (`sensible_heat_btuh`) are parameters a firm can
 *   fill in. Every parameter names its facet in `group`.
 * - `provided`: parameters the kernel's field providers already register
 *   (`mark`, `load.mbh`, `load.wsfu_cold`), referenced by key, never redefined.
 *
 * Every entry carries its IFC 4.3 home: a standard `Pset_*Common` property
 * where one exists, otherwise a `MutinyBIM_*` set (never a reserved prefix
 * for our own sets). The built-in AEC library loads every set's parameters
 * as shared fields (`baselineParameterFields`), so the Inspector, the
 * equipment list and the schedule builder offer them; a value is still only
 * stored when someone types one.
 */

export type ParameterSetIfc = { readonly pset: string; readonly property: string } | { readonly qto: string; readonly quantity: string };

export interface BaselineParameter {
  readonly field: SharedFieldItem;
  readonly ifc: ParameterSetIfc;
}

export interface ProvidedParameter {
  /** A field path a kernel provider registers. */
  readonly key: string;
  readonly ifc: ParameterSetIfc;
}

export interface BaselineParameterSet {
  readonly id: string;
  readonly label: string;
  /** Classes the set applies to (and their subclasses). */
  readonly classes: readonly string[];
  readonly parameters: readonly BaselineParameter[];
  readonly provided: readonly ProvidedParameter[];
}

const EQUIPMENT = ["mep.equipment"];
const POWERED = ["mep.equipment", "mep.electrical_device", "mep.lighting_fixture", "mep.plumbing_fixture", "mep.air_terminal"];
const PLUMBING = ["mep.plumbing_fixture", "mep.equipment"];

const param = (name: string, scope: "instance" | "type" = "type") => ({ kind: "parameter" as const, scope, name });

function quantity(set: string, key: string, name: string, label: string, appliesTo: readonly string[], kind: SharedFieldItem["kind"], unit: SharedFieldItem["unit"], group: string, ifc: ParameterSetIfc): BaselineParameter {
  return { field: { id: `baseline:${set}:${name}`, revision: 1, key, label, appliesTo: [...appliesTo], valueType: "quantity", kind, unit, group, editable: true, storage: param(name) }, ifc };
}

function flag(set: string, key: string, name: string, label: string, appliesTo: readonly string[], group: string, ifc: ParameterSetIfc): BaselineParameter {
  return { field: { id: `baseline:${set}:${name}`, revision: 1, key, label, appliesTo: [...appliesTo], valueType: "boolean", group, editable: true, storage: param(name) }, ifc };
}

function text(set: string, key: string, name: string, label: string, appliesTo: readonly string[], group: string, ifc: ParameterSetIfc): BaselineParameter {
  return { field: { id: `baseline:${set}:${name}`, revision: 1, key, label, appliesTo: [...appliesTo], valueType: "text", group, editable: true, storage: param(name) }, ifc };
}

const mutiny = (group: string, property: string): ParameterSetIfc => ({ pset: `MutinyBIM_${group}`, property });

export const BASELINE_PARAMETER_SETS: readonly BaselineParameterSet[] = [
  {
    id: "identity",
    label: "Identity",
    classes: POWERED,
    parameters: [text("identity", "core.manufacturer", "manufacturer", "Manufacturer", POWERED, "Identity", { pset: "Pset_ManufacturerTypeInformation", property: "Manufacturer" }), text("identity", "core.model", "model", "Model", POWERED, "Identity", { pset: "Pset_ManufacturerTypeInformation", property: "ModelLabel" })],
    provided: [
      { key: "mark", ifc: mutiny("Identity", "Mark") },
      { key: "type_name", ifc: mutiny("Identity", "TypeName") },
      { key: "count", ifc: { qto: "MutinyBIM_Quantities", quantity: "Count" } },
    ],
  },
  {
    id: "electrical",
    label: "Electrical",
    classes: POWERED,
    parameters: [
      quantity("electrical", "elec.voltage", "voltage", "Voltage", POWERED, "voltage", "V", "Electrical", { pset: "Pset_ElectricalDeviceCommon", property: "RatedVoltage" }),
      quantity("electrical", "elec.mca", "mca", "Minimum circuit ampacity", POWERED, "current", "A", "Electrical", mutiny("Electrical", "MinimumCircuitAmpacity")),
      quantity("electrical", "elec.mocp", "mocp", "Maximum overcurrent protection", POWERED, "current", "A", "Electrical", mutiny("Electrical", "MaximumOvercurrentProtection")),
    ],
    provided: [
      { key: "load", ifc: mutiny("Electrical", "ApparentPower") },
      { key: "load_class", ifc: mutiny("Electrical", "LoadClass") },
    ],
  },
  {
    id: "gas",
    label: "Gas",
    classes: ["mep.equipment", "mep.plumbing_fixture", "mep.load_point"],
    parameters: [],
    provided: [
      { key: "load.mbh", ifc: mutiny("Gas", "InputRating") },
      { key: "load.min_inlet_pressure", ifc: mutiny("Gas", "MinimumInletPressure") },
    ],
  },
  {
    id: "water",
    label: "Water",
    classes: PLUMBING,
    parameters: [],
    provided: [
      { key: "load.wsfu_cold", ifc: { qto: "MutinyBIM_FixtureUnits", quantity: "ColdWaterSupplyFixtureUnits" } },
      { key: "load.wsfu_hot", ifc: { qto: "MutinyBIM_FixtureUnits", quantity: "HotWaterSupplyFixtureUnits" } },
      { key: "load.gpm_fixed", ifc: mutiny("Water", "FixedFlow") },
    ],
  },
  {
    id: "drainage",
    label: "Drainage",
    classes: PLUMBING,
    parameters: [flag("drainage", "plumb.indirect_waste", "indirect_waste", "Indirect waste", PLUMBING, "Drainage", mutiny("Drainage", "IndirectWaste")), flag("drainage", "plumb.grease_waste", "grease_waste", "Grease waste", PLUMBING, "Drainage", mutiny("Drainage", "GreaseWaste"))],
    provided: [{ key: "load.dfu", ifc: { qto: "MutinyBIM_FixtureUnits", quantity: "DrainageFixtureUnits" } }],
  },
  {
    id: "mechanical",
    label: "Mechanical",
    classes: EQUIPMENT,
    parameters: [
      quantity("mechanical", "mech.airflow", "supply_cfm", "Supply airflow", EQUIPMENT, "flow_air", "cfm", "Mechanical", mutiny("Mechanical", "SupplyAirflow")),
      quantity("mechanical", "mech.sensible_heat", "sensible_heat_btuh", "Sensible heat to space", EQUIPMENT, "thermal_power", "Btu/h", "Mechanical", mutiny("Mechanical", "SensibleHeatGain")),
      quantity("mechanical", "mech.latent_heat", "latent_heat_btuh", "Latent heat to space", EQUIPMENT, "thermal_power", "Btu/h", "Mechanical", mutiny("Mechanical", "LatentHeatGain")),
      quantity("mechanical", "mech.cooling_capacity", "cooling_tons", "Nominal cooling", EQUIPMENT, "thermal_power", "ton_r", "Mechanical", mutiny("Mechanical", "NominalCoolingCapacity")),
      quantity("mechanical", "mech.heating_input", "heating_btuh", "Heating input", EQUIPMENT, "thermal_power", "Btu/h", "Mechanical", mutiny("Mechanical", "NominalHeatingCapacity")),
    ],
    provided: [],
  },
  {
    id: "structural",
    label: "Structural",
    classes: EQUIPMENT,
    parameters: [quantity("structural", "struct.operating_weight", "weight", "Operating weight", EQUIPMENT, "mass", "lb", "Structural", { qto: "MutinyBIM_Quantities", quantity: "OperatingWeight" })],
    provided: [],
  },
];

/** Every baseline set's own parameters as shared-field items, for the built-in library. Provided keys stay the providers'. */
export function baselineParameterFields(): SharedFieldItem[] {
  return BASELINE_PARAMETER_SETS.flatMap((set) => set.parameters.map((p) => p.field));
}

/**
 * The section a part's own parameter reads in when nothing names one (no
 * library field of that name, no group): by its quantity kind. Built-in
 * baseline data, the only place this guess lives (FOUNDATION adjustments D1);
 * values are facet ids.
 */
export const BASELINE_KIND_FACETS: Readonly<Record<string, string>> = {
  voltage: "electrical",
  current: "electrical",
  power_apparent: "electrical",
  power_real: "electrical",
  power_mechanical: "electrical",
  flow_gas_energy: "gas",
  flow_liquid: "water",
  flow_air: "mechanical",
  thermal_power: "mechanical",
  mass: "structural",
};
