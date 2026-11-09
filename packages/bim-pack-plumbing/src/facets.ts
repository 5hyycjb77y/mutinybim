import type { LoadSectionRow, QuantityTotals } from "@permitzip/bim-kernel";

/**
 * Plumbing and gas's load sections (round 12 P12, E12's move handshake for
 * `requirements/facets.ts`): what a load's gas, water and drainage
 * quantities read under, contributed to `LOAD_SECTION_POINT`. Each equals
 * the kernel's transitional fallback row (`requirements/facet-fallback.ts`)
 * field for field (`p12-facet-rows-equal-fallback`) until the coordinator
 * deletes the fallback.
 */
export const PLUMBING_LOAD_SECTION_ROWS: readonly LoadSectionRow[] = [
  { id: "gas", label: "Gas", order: 20, quantities: ["mbh", "min_inlet_pressure"], trade: "gas", services: ["gas"], takesShared: (totals: QuantityTotals) => totals.mbh > 0 },
  { id: "water", label: "Water", order: 30, quantities: ["wsfu_cold", "wsfu_hot", "wsfu_total", "gpm_fixed", "gph_demand", "min_inlet_pressure"], trade: "plumbing", services: ["cold_water", "hot_water"], unclaimedLoads: true },
  { id: "drainage", label: "Drainage", order: 40, quantities: ["dfu"], trade: "plumbing", services: ["sanitary", "grease_waste"] },
];
