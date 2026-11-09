/**
 * The kernel's unit vocabulary is `@permitzip/bim-units`: one list of kinds
 * and unit codes for every trade. This module re-exports it under the names
 * the registry and library have always imported, so nothing that imports it
 * changes. It holds no table of its own.
 */

export { KIND_IDS, UNIT_CODES } from "@permitzip/bim-units";
export type { AggregationRule, DisplayProfile, Kind, KindDisplay, LabelPlacement, NumberFormat, Precision, UnitCode } from "@permitzip/bim-units";

import type { Kind, UnitCode } from "@permitzip/bim-units";

/**
 * The two unit questions the registry and library ask, injected so neither
 * holds a unit table. `@permitzip/bim-units` exports both with these exact
 * signatures (`unitAllowed`, `convert`), so a host passes them straight in.
 */
export interface UnitCatalog {
  /** True when `unit` is a code that can express `kind` (a unit may serve several kinds). */
  unitAllowed(kind: Kind, unit: string): boolean;
  /** `value` in `from`, expressed in `to`. Throws when they don't express the same kind. */
  convert(value: number, from: UnitCode, to: UnitCode): number;
}
