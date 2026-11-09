/**
 * `@permitzip/bim-pack-mechanical`: the Mechanical add-on and everything it
 * moved out of the kernel and `@permitzip/bim-calc` in round 6 (air networks,
 * duct insulation commands and sizing, outdoor air, pressurization and makeup
 * air). The stored shapes every host reads (insulation, insulation commands,
 * table specs, the outdoor-air reader and pressure-target contracts) stay in
 * the kernel.
 */
export * from "./pack";
export { MECHANICAL_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
export { MECHANICAL_LINKED_REFERENCE } from "./linked-reference";
export * from "./kinds";
export * from "./legacy-commands";
export * from "./measure";
export * from "./agent-tools";
export * from "./balance/makeup-air";
export * from "./balance/pressurization";
export * from "./blocks/ventilation-table";
export * from "./blocks/pressurization-table";
export * from "./connections/adapter";
export * from "./connections/tree";
export * from "./connections/translate";
export * from "./fields/mechanical";
export * from "./fields/pressurization";
export * from "./fields/ventilation";
export * from "./routing/duct-design-commands";
export * from "./routing/duct-sizing";
export * from "./calc/mechanical/plugins";
export * from "./calc/mechanical/makeup-air";
export * from "./calc/mechanical/pressurization";
export * from "./calc/ventilation";
export * from "./lint/balance";
export { MECHANICAL_END_TYPES } from "./connections/end-types";
// Plain data for host screens (tab ids, labels, slots); a host imports `ADDON_UI` under its own name.
export { ADDON_UI } from "./ui";
export * from "./kind-shapes";
export * from "./routing/pressure";
export * from "./types";
export { MECHANICAL_SERVICE_ROWS } from "./services/rows";
export { MECHANICAL_AIR_LOAD_SECTION } from "./facets/air";
// Round 13 M13: rated-wall and ceiling route rules; kitchen equipment heat per space.
export * from "./constraints/rated-crossings";
export * from "./heat-gain/kitchen";
// Round 14 M14: route checks on the Checklist, kitchen heat on the room, top / bottom taps.
export * from "./lint/route-crossings";
export * from "./facets/heat-gain-row";
export * from "./connections/taps-faces";
export * from "./diagrams/air-schematic";
export { MECHANICAL_DESIGN_LIMIT_DEFAULTS, DUCT_CEILING_CLEARANCE_LIMIT_ID } from "./design-limits";
// Round 15 M15: Connect › To duct, Size ducts on a whole air system, equipment and air device schedules.
export * from "./connect/terminals";
export * from "./routing/size-system";
export * from "./schedules/templates";
export * from "./fields/vendor";
