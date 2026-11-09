import type { ServiceRow } from "@permitzip/bim-kernel";

/**
 * The Electrical add-on's service rows (`SERVICE_POINT`, round 14 K14): power
 * and lighting circuits, data and fire alarm cabling. Ids are the stored
 * system-kind and load-service strings and never change; each row is round
 * 13's kernel row byte for byte (`k14-stand-ins-gone`, frozen bytes).
 */

const dist = (predefinedType: string) => ({ system: "IfcDistributionSystem" as const, predefinedType });

export const ELECTRICAL_SERVICE_ROWS: readonly ServiceRow[] = [
  { id: "power", label: "Power", discipline: "electrical", medium: "electric", regime: "electric", connector: "electrical", adapter: "electrical", quantities: ["load.va"], asSystem: true, asLoad: true, ifc: dist("ELECTRICAL"), graphics: { colour: "#d9a21b", pattern: "solid" }, flowUnit: "VA", solver: "nec_demand" },
  { id: "lighting", label: "Lighting", discipline: "electrical", medium: "electric", regime: "electric", connector: "electrical", adapter: "electrical", quantities: ["load.va"], asSystem: true, asLoad: false, ifc: dist("LIGHTING"), graphics: { colour: "#e0b23a", pattern: "solid" }, flowUnit: "VA", solver: "nec_demand" },
  { id: "data", label: "Data", discipline: "electrical", medium: "data", regime: "signal", connector: "electrical", quantities: [], asSystem: true, asLoad: false, ifc: dist("DATA"), graphics: { colour: "#607d8b", pattern: "solid" }, flowUnit: "" },
  { id: "fire_alarm", label: "Fire alarm", discipline: "electrical", medium: "signal", regime: "signal", connector: "electrical", quantities: [], asSystem: true, asLoad: false, ifc: dist("SIGNAL"), graphics: { colour: "#d8463b", pattern: "solid" }, flowUnit: "" },
];
