import type { LoadSectionRow } from "@permitzip/bim-kernel";

/**
 * Mechanical's load section (`LOAD_SECTION_POINT`, round 13 K13 step 5): a
 * load's airflow reads under "Air" and counts in the mechanical trade, for
 * the air services and the heat a space gains. Equal to the kernel's
 * transitional fallback row (`m12-air-facet-equals-fallback`).
 */
export const MECHANICAL_AIR_LOAD_SECTION: LoadSectionRow = { id: "air", label: "Air", order: 50, quantities: ["cfm"], trade: "mechanical", services: ["supply_air", "outside_air", "exhaust_air", "heat_gain"] };
