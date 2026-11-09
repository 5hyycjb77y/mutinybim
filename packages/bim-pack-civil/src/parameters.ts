import type { PackParameterSet } from "@permitzip/bim-pack/runtime";
import { CIVIL_CLASS, CIVIL_PARAM } from "./ids";
import { RUNOFF_COEFFICIENTS } from "./runoff";

/**
 * The pack's parameter sets: what a catchment zone, a storm system and a storm
 * pipe carry in `values`, with kind, stored unit and IFC home, so the
 * Inspector, schedules, agent tools and IFC export read them with no host
 * code. Structures carry theirs on the classed part (`set_element_values`),
 * beside their type's own parameters.
 */
const STRUCTURES = [CIVIL_CLASS.stormInlet, CIVIL_CLASS.manhole, CIVIL_CLASS.outfall];

export const CIVIL_PARAMETER_SETS: readonly PackParameterSet[] = [
  {
    id: "civil.structure",
    label: "Storm structure",
    parameters: [
      { key: CIVIL_PARAM.rimElevation, label: "Rim elevation", classes: STRUCTURES, valueType: "quantity", kind: "length", unit: "mm", group: "Drainage", ifc: { pset: "MutinyBIM_StormStructure", property: "RimElevation" } },
      { key: CIVIL_PARAM.invertElevation, label: "Invert elevation", classes: STRUCTURES, valueType: "quantity", kind: "length", unit: "mm", group: "Drainage", ifc: { pset: "MutinyBIM_StormStructure", property: "InvertElevation" } },
      { key: CIVIL_PARAM.inletCapacity, label: "Inlet capacity", classes: [CIVIL_CLASS.stormInlet], valueType: "quantity", kind: "flow_liquid", unit: "cfs", group: "Drainage", ifc: { pset: "MutinyBIM_StormStructure", property: "InletCapacity" } },
    ],
  },
  {
    id: "civil.catchment",
    label: "Catchment",
    parameters: [
      { key: CIVIL_PARAM.surface, label: "Surface", classes: [CIVIL_CLASS.catchment], valueType: "choice", choices: RUNOFF_COEFFICIENTS.map((r) => r.id), group: "Drainage", ifc: { pset: "MutinyBIM_Catchment", property: "Surface" } },
      { key: CIVIL_PARAM.runoffCoefficient, label: "Runoff coefficient (C)", classes: [CIVIL_CLASS.catchment], valueType: "quantity", kind: "ratio", unit: "1", group: "Drainage", description: "Rational-method C; wins over the surface's design value", ifc: { pset: "MutinyBIM_Catchment", property: "RunoffCoefficient" } },
    ],
  },
  {
    id: "civil.storm_system",
    label: "Storm system",
    parameters: [
      { key: CIVIL_PARAM.designIntensity, label: "Design rainfall intensity", classes: [CIVIL_CLASS.stormSystem], valueType: "quantity", kind: "rainfall_intensity", unit: "in/h", group: "Drainage", ifc: { pset: "MutinyBIM_StormSystem", property: "DesignIntensity" } },
      { key: CIVIL_PARAM.minSlope, label: "Minimum pipe slope", classes: [CIVIL_CLASS.stormSystem], valueType: "quantity", kind: "slope", unit: "%", group: "Drainage", ifc: { pset: "MutinyBIM_StormSystem", property: "MinimumSlope" } },
    ],
  },
  {
    id: "civil.storm_pipe",
    label: "Storm pipe",
    parameters: [{ key: CIVIL_PARAM.manningN, label: "Manning's n", classes: [CIVIL_CLASS.stormPipe], valueType: "quantity", kind: "dimensionless", unit: "1", group: "Drainage", ifc: { pset: "MutinyBIM_StormPipe", property: "ManningN" } }],
  },
];
