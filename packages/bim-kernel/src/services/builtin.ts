import type { ServiceDef } from "./types";

/**
 * The built-in service ids (KERNEL-FOUNDATION §3.5): the stored system kinds
 * and load services every deployed reader knows, in their frozen order, and the
 * kernel's one row of its own (Other). The rows behind the other ids come from
 * the first-party add-ons.
 *
 * Plain data only; this module imports nothing at runtime but the contract, so
 * the schema layer (`parts.ts`) can read it without reaching any domain.
 */

/** The system kinds every deployed reader knows (round 4 and before), in their original order. Never reorder or remove. */
export const LEGACY_SYSTEM_KIND_IDS = [
  "supply_air",
  "return_air",
  "exhaust_air",
  "outside_air",
  "domestic_cold_water",
  "domestic_hot_water",
  "domestic_hot_water_return",
  "sanitary",
  "vent",
  "storm",
  "natural_gas",
  "hydronic_supply",
  "hydronic_return",
  "condensate",
  "refrigerant",
  "power",
  "lighting",
  "data",
  "fire_alarm",
  "other",
] as const;

/** System kinds the registry adds. A writer emits one only when its peer advertises `SERVICES_REGISTRY_FEATURE`. */
export const REGISTRY_SYSTEM_KIND_IDS = [
  "grease_waste",
  "indirect_waste",
  "fire_protection_wet",
  "fire_protection_dry",
  "chilled_water_supply",
  "chilled_water_return",
  "heating_water_supply",
  "heating_water_return",
] as const;

/** The system kind view of the built-in rows: the legacy kinds in their order, then the registry's. */
export const BUILTIN_SYSTEM_KIND_IDS = [...LEGACY_SYSTEM_KIND_IDS, ...REGISTRY_SYSTEM_KIND_IDS] as const;

/** The load service view, in the order `LOAD_SERVICES` always had. Every one is legacy: old readers accept them all. */
export const BUILTIN_LOAD_SERVICE_IDS = ["power", "cold_water", "hot_water", "sanitary", "grease_waste", "gas", "supply_air", "outside_air", "exhaust_air", "heat_gain"] as const;

/** The connector domain view: what a port carrying a drawn service connects to. */
export const BUILTIN_CONNECTOR_IDS = ["duct", "pipe", "electrical"] as const;

/** A pipe service's hydraulics family (`routing/pipe/design.ts` `serviceOf`). Built-in data, not the contract: a pack names its method in `solver`. */
export type ServicePipeFamily = "water" | "drainage" | "gas" | "vent";

/** What a run's loads count in, as drawings print it (`routing/rules.ts` `SystemRules.flowUnit`). Built-in data; the contract derives a flow unit from `quantities[0]`. */
export type ServiceFlowUnit = "CFM" | "WFU" | "DFU" | "GPM" | "VA" | "MBH" | "";

/** Built-in-only row data the kernel's own trades read; a firm or pack row leaves them out (then: not sized as a pipe family, no flow unit). */
export interface BuiltinServiceExtras {
  readonly pipeFamily?: ServicePipeFamily;
  readonly flowUnit?: ServiceFlowUnit;
}

/** A service row as the registry holds it: the contract plus the built-in extras. */
export type ServiceRow = ServiceDef & BuiltinServiceExtras;

/**
 * The kernel's own rows: only Other, the kind a reader falls back to. Every
 * trade's rows are its first-party add-on's `SERVICE_POINT` rows, under the
 * same stored ids.
 */
export const BUILTIN_SERVICES: readonly ServiceRow[] = [
  { id: "other", label: "Other", discipline: "general", medium: "none", regime: "pressure", connector: "pipe", quantities: [], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem", predefinedType: "NOTDEFINED" }, graphics: { colour: "#2ea86b", pattern: "solid" }, flowUnit: "" },
];
