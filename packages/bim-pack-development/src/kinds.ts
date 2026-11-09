import type { ElementKindItem, ElementKindValue } from "@permitzip/bim-pack/runtime";
import { DEVELOPMENT_KIND, DEVELOPMENT_VALUE } from "./ids";

/**
 * The Development add-on's record kinds (round 11, D3): what the owner
 * plans and assumes before anything is drawn. Intent records: values, no
 * geometry. Each value's confidence is the one basis every record carries
 * (`provenance.basis` / `valueBasis`), read with the kernel's `readBasis`;
 * these rows add no confidence field of their own. No row keeps money: the
 * money assumptions are rates in the reader's own cost source (ids.ts).
 */

const text = (key: string, label: string): ElementKindValue => ({ key, label, unit: "", authored: true });

export const PROGRAM_AREA_ROW: ElementKindItem = {
  kind: DEVELOPMENT_KIND.programArea,
  label: "Program area",
  nature: "intent",
  values: [{ key: DEVELOPMENT_VALUE.area, label: "Area", unit: "m2", authored: true, min: 0 }, text(DEVELOPMENT_VALUE.use, "Use"), { key: DEVELOPMENT_VALUE.rentableFraction, label: "Rentable share", unit: "1", authored: true, min: 0, max: 1 }],
  upgrade: { newForOlderPeers: true },
};

export const DEAL_ASSUMPTION_ROW: ElementKindItem = {
  kind: DEVELOPMENT_KIND.dealAssumption,
  label: "Deal assumption",
  nature: "intent",
  values: [{ key: DEVELOPMENT_VALUE.fraction, label: "Share", unit: "1", authored: true, min: 0, max: 1 }, text(DEVELOPMENT_VALUE.assumption, "Assumption")],
  upgrade: { newForOlderPeers: true },
};

export const DEVELOPMENT_KIND_ROWS: readonly ElementKindItem[] = [PROGRAM_AREA_ROW, DEAL_ASSUMPTION_ROW];
