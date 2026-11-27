import type { ConnectorEndTypeItem } from "@permitzip/bim-kernel";

/**
 * Mechanical connector end types (round 9 J9): duct openings (slip, flanged,
 * formed flange) and brazed copper refrigerant / hydronic piping ends. Generic
 * trade words, no manufacturer's system. Each joins its own kind, and the
 * pairs below join through the fitting named.
 */
export const MECHANICAL_END_TYPES: readonly ConnectorEndTypeItem[] = [
  { id: "mechanical.slip", label: "Slip", domains: ["duct"], joinsVia: [{ endType: "mechanical.flanged", fitting: "slip-to-flange adapter" }, { endType: "mechanical.formed_flange", fitting: "slip-to-flange adapter" }] },
  { id: "mechanical.flanged", label: "Flanged", domains: ["duct"], joinsVia: [{ endType: "mechanical.formed_flange", fitting: "companion flange" }] },
  { id: "mechanical.formed_flange", label: "Formed flange (TDC / TDF)", domains: ["duct"] },
  {
    id: "mechanical.brazed",
    label: "Brazed",
    domains: ["pipe"],
    joinsVia: [
      { endType: "plumbing_gas.flare", fitting: "braze-to-flare adapter" },
      { endType: "plumbing_gas.threaded", fitting: "braze-to-thread adapter" },
    ],
  },
];
