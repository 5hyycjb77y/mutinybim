import { SERVICES_REGISTRY_FEATURE, type ServiceRow } from "@permitzip/bim-kernel";

/**
 * The Mechanical add-on's service rows (`SERVICE_POINT`, round 13 K13 step
 * 5): what flows in air systems, the heat a space gains, and the hydronic,
 * chilled, heating, condensate and refrigerant piping a mechanical system
 * runs. Ids are the stored system-kind and load-service strings and never
 * change; each row equals the kernel's transitional fallback row byte for
 * byte (`k13-air-services-equal-fallback`) until the coordinator deletes it.
 */

const dist = (predefinedType: string, objectType?: string) => ({ system: "IfcDistributionSystem" as const, predefinedType, ...(objectType ? { objectType } : {}) });

const air = (id: string, label: string, predefinedType: string, colour: string, asLoad: boolean): ServiceRow => ({
  id,
  label,
  discipline: "mechanical",
  medium: "air",
  regime: "pressure",
  connector: "duct",
  adapter: "mechanical",
  quantities: ["load.cfm"],
  asSystem: true,
  asLoad,
  ifc: dist(predefinedType),
  graphics: { colour, pattern: "solid" },
  flowUnit: "CFM",
});

export const MECHANICAL_SERVICE_ROWS: readonly ServiceRow[] = [
  air("supply_air", "Supply air", "AIRCONDITIONING", "#2f7fd8", true),
  air("return_air", "Return air", "AIRCONDITIONING", "#b04fc8", false),
  air("exhaust_air", "Exhaust air", "EXHAUST", "#a0682a", true),
  air("outside_air", "Outside air", "VENTILATION", "#3fa34d", true),
  { id: "hydronic_supply", label: "Hydronic supply", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("USERDEFINED", "HydronicSupply"), graphics: { colour: "#c2185b", pattern: "solid" }, pipeFamily: "water", flowUnit: "GPM" },
  { id: "hydronic_return", label: "Hydronic return", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("USERDEFINED", "HydronicReturn"), graphics: { colour: "#7b1fa2", pattern: "solid" }, pipeFamily: "water", flowUnit: "GPM" },
  { id: "condensate", label: "Condensate", discipline: "mechanical", medium: "liquid", regime: "gravity", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("DRAINAGE"), graphics: { colour: "#26a69a", pattern: "dotted" }, pipeFamily: "drainage", flowUnit: "" },
  { id: "refrigerant", label: "Refrigerant", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: [], asSystem: true, asLoad: false, ifc: dist("REFRIGERATION"), graphics: { colour: "#0097a7", pattern: "solid" }, flowUnit: "" },
  { id: "heat_gain", label: "Heat gain", discipline: "mechanical", medium: "none", regime: "pressure", connector: "none", quantities: [], asSystem: false, asLoad: true, ifc: dist("NOTDEFINED") },
  { id: "chilled_water_supply", label: "Chilled water supply", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("CHILLEDWATER"), graphics: { colour: "#0277bd", pattern: "solid" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "water", flowUnit: "GPM" },
  { id: "chilled_water_return", label: "Chilled water return", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("CHILLEDWATER"), graphics: { colour: "#4fa3d8", pattern: "dashed" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "water", flowUnit: "GPM" },
  { id: "heating_water_supply", label: "Heating water supply", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("HEATING"), graphics: { colour: "#b71c1c", pattern: "solid" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "water", flowUnit: "GPM" },
  { id: "heating_water_return", label: "Heating water return", discipline: "mechanical", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("HEATING"), graphics: { colour: "#e57373", pattern: "dashed" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "water", flowUnit: "GPM" },
];
