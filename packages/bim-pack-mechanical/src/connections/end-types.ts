import type { ConnectorEndTypeItem } from "@permitzip/bim-kernel";

/**
 * Duct end types (round 9 J9): how a duct opening is made to join the next
 * piece. Generic trade words, no manufacturer's system. A slip end and a
 * flanged end don't join directly; each joins its own kind, and the pairs
 * below join through the fitting named.
 */
export const MECHANICAL_END_TYPES: readonly ConnectorEndTypeItem[] = [
  { id: "mechanical.slip", label: "Slip", domains: ["duct"], joinsVia: [{ endType: "mechanical.flanged", fitting: "slip-to-flange adapter" }, { endType: "mechanical.formed_flange", fitting: "slip-to-flange adapter" }] },
  { id: "mechanical.flanged", label: "Flanged", domains: ["duct"], joinsVia: [{ endType: "mechanical.formed_flange", fitting: "companion flange" }] },
  { id: "mechanical.formed_flange", label: "Formed flange (TDC / TDF)", domains: ["duct"] },
];
