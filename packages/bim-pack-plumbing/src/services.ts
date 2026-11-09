import { SERVICES_REGISTRY_FEATURE, type ServiceRow } from "@permitzip/bim-kernel";

/**
 * Plumbing and gas's service rows (round 12 P12 move handshake): what flows in
 * water, drainage, vent, storm and fuel gas systems, contributed to the
 * kernel's `SERVICE_POINT`. Ids are the stored system-kind and load-service
 * strings and never change; each row equals the kernel's transitional
 * fallback row byte for byte (`p12-services-from-addons`) until the
 * coordinator deletes the fallback.
 */

const dist = (predefinedType: string, objectType?: string) => ({ system: "IfcDistributionSystem" as const, predefinedType, ...(objectType ? { objectType } : {}) });

export const PLUMBING_SERVICE_ROWS: readonly ServiceRow[] = [
  { id: "domestic_cold_water", label: "Domestic cold water", discipline: "plumbing", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.wsfu_cold"], asSystem: true, asLoad: false, ifc: dist("DOMESTICCOLDWATER"), graphics: { colour: "#1f6fd1", pattern: "dash_dot" }, pipeFamily: "water", flowUnit: "WFU", sourceRoles: ["water_meter"], solver: "hunter" },
  { id: "domestic_hot_water", label: "Domestic hot water", discipline: "plumbing", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.wsfu_hot"], asSystem: true, asLoad: false, ifc: dist("DOMESTICHOTWATER"), graphics: { colour: "#d1351f", pattern: "dash_dot_dot" }, pipeFamily: "water", flowUnit: "WFU", sourceRoles: ["water_heater"], solver: "hunter" },
  { id: "domestic_hot_water_return", label: "Domestic hot water return", discipline: "plumbing", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.wsfu_hot"], asSystem: true, asLoad: false, ifc: dist("DOMESTICHOTWATER"), graphics: { colour: "#e57b2a", pattern: "dash_dot_dot_dot" }, pipeFamily: "water", flowUnit: "GPM" },
  { id: "sanitary", label: "Sanitary", discipline: "plumbing", medium: "liquid", regime: "gravity", connector: "pipe", adapter: "plumbing", quantities: ["load.dfu"], asSystem: true, asLoad: true, ifc: dist("WASTEWATER"), graphics: { colour: "#8a5a2b", pattern: "solid" }, pipeFamily: "drainage", flowUnit: "DFU", sourceRoles: ["grease_interceptor", "sewer_connection", "sewage_pump", "backwater_valve"], solver: "dfu" },
  { id: "vent", label: "Vent", discipline: "plumbing", medium: "air", regime: "gravity", connector: "pipe", quantities: [], asSystem: true, asLoad: false, ifc: dist("VENT"), graphics: { colour: "#5f8f1f", pattern: "dashed" }, pipeFamily: "vent", flowUnit: "DFU", solver: "vent_dfu" },
  { id: "storm", label: "Storm", discipline: "plumbing", medium: "liquid", regime: "gravity", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("STORMWATER"), graphics: { colour: "#1f9a91", pattern: "solid" }, pipeFamily: "drainage", flowUnit: "GPM", solver: "storm_gpm" },
  { id: "natural_gas", label: "Natural gas", discipline: "plumbing", medium: "gas", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.mbh"], asSystem: true, asLoad: false, ifc: dist("GAS"), graphics: { colour: "#d9a800", pattern: "long_dash" }, pipeFamily: "gas", flowUnit: "MBH", sourceRoles: ["gas_meter"], solver: "gas_longest_length" },
  { id: "cold_water", label: "Cold water", discipline: "plumbing", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.wsfu_cold", "load.wsfu_total", "load.gph_demand"], asSystem: false, asLoad: true, carriedBy: "domestic_cold_water", ifc: dist("DOMESTICCOLDWATER") },
  { id: "hot_water", label: "Hot water", discipline: "plumbing", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.wsfu_hot", "load.wsfu_total", "load.gph_demand"], asSystem: false, asLoad: true, carriedBy: "domestic_hot_water", ifc: dist("DOMESTICHOTWATER") },
  { id: "gas", label: "Gas", discipline: "plumbing", medium: "gas", regime: "pressure", connector: "pipe", adapter: "plumbing", quantities: ["load.mbh"], asSystem: false, asLoad: true, carriedBy: "natural_gas", ifc: dist("GAS") },
  { id: "grease_waste", label: "Grease waste", discipline: "plumbing", medium: "liquid", regime: "gravity", connector: "pipe", adapter: "plumbing", quantities: ["load.dfu"], asSystem: true, asLoad: true, ifc: dist("USERDEFINED", "GreaseWaste"), graphics: { colour: "#6d4c1f", pattern: "solid", weight: "heavy" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "drainage", flowUnit: "DFU", sourceRoles: ["grease_interceptor"], solver: "dfu" },
  { id: "indirect_waste", label: "Indirect waste", discipline: "plumbing", medium: "liquid", regime: "gravity", connector: "pipe", adapter: "plumbing", quantities: ["load.dfu"], asSystem: true, asLoad: false, ifc: dist("USERDEFINED", "IndirectWaste"), graphics: { colour: "#a1795a", pattern: "dashed" }, feature: SERVICES_REGISTRY_FEATURE, pipeFamily: "drainage", flowUnit: "DFU", solver: "dfu" },
];
