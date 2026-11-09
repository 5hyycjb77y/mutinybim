import type { AggregationRule, DemandRuleId, Kind, UnitCode } from "./types";

/**
 * Bridges from the three older unit vocabularies to unit codes. Stored
 * models keep their numbers as they are (part parameters in their own unit,
 * lengths in millimetres); these tables say what those numbers mean, so the
 * kernel (Streams E and F) can attach kinds without migrating data.
 */

export interface UnitBinding {
  readonly kind: Kind;
  readonly unit: UnitCode;
}

/** `PARAM_UNITS` in packages/bim-kernel/src/parts.ts → kind and unit. */
export const PARAM_UNIT_BINDINGS = {
  none: { kind: "dimensionless", unit: "1" },
  mm: { kind: "length", unit: "mm" },
  cfm: { kind: "flow_air", unit: "cfm" },
  gpm: { kind: "flow_liquid", unit: "gpm" },
  w: { kind: "power_real", unit: "W" },
  kw: { kind: "power_real", unit: "kW" },
  va: { kind: "power_apparent", unit: "VA" },
  v: { kind: "voltage", unit: "V" },
  a: { kind: "current", unit: "A" },
  hp: { kind: "power_mechanical", unit: "hp" },
  btuh: { kind: "thermal_power", unit: "Btu/h" },
  tons: { kind: "thermal_power", unit: "ton_r" },
  in_wc: { kind: "pressure", unit: "in_wc" },
  psi: { kind: "pressure", unit: "psi" },
  lb: { kind: "mass", unit: "lb" },
  percent: { kind: "ratio", unit: "%" },
  lumens: { kind: "luminous_flux", unit: "lm" },
  count: { kind: "count", unit: "ea" },
} as const satisfies Readonly<Record<string, UnitBinding>>;

export type LegacyParamUnit = keyof typeof PARAM_UNIT_BINDINGS;

/** The legacy part-parameter names, in their stored order (`PARAM_UNITS` in parts.ts reads this list). */
export const LEGACY_PARAM_UNITS = ["none", "mm", "cfm", "gpm", "w", "kw", "va", "v", "a", "hp", "btuh", "tons", "in_wc", "psi", "lb", "percent", "lumens", "count"] as const satisfies readonly LegacyParamUnit[];

/**
 * What v1 part parameters print after a number (`formatParam`): " GPM", " HP",
 * "%" with no space, nothing for counts. Kept as printed so no sheet or
 * schedule changes; new display goes through a profile and `formatter`.
 */
export const LEGACY_PARAM_UNIT_SUFFIXES: Readonly<Record<LegacyParamUnit, string>> = {
  none: "",
  mm: " mm",
  cfm: " CFM",
  gpm: " GPM",
  w: " W",
  kw: " kW",
  va: " VA",
  v: " V",
  a: " A",
  hp: " HP",
  btuh: " Btu/h",
  tons: " tons",
  in_wc: " in. w.c.",
  psi: " psi",
  lb: " lb",
  percent: "%",
  lumens: " lm",
  count: "",
};

/** True for a legacy part-parameter unit name (`"kw"`, `"btuh"`). */
export function isLegacyParamUnit(value: string): value is LegacyParamUnit {
  return Object.prototype.hasOwnProperty.call(PARAM_UNIT_BINDINGS, value);
}

export interface QuantityBinding extends UnitBinding {
  readonly aggregation: AggregationRule;
  readonly demand: DemandRuleId | null;
}

/**
 * `QUANTITIES` in packages/bim-kernel/src/quantities/index.ts → kind, unit
 * and how it totals. `add` carries over as the aggregation rule unchanged;
 * the kind's allowed rules accept every one of them.
 */
export const QUANTITY_BINDINGS = {
  wsfu_cold: { kind: "fixture_units_supply", unit: "WSFU", aggregation: "sum", demand: "water_supply" },
  wsfu_hot: { kind: "fixture_units_supply", unit: "WSFU", aggregation: "sum", demand: "water_supply" },
  wsfu_total: { kind: "fixture_units_supply", unit: "WSFU", aggregation: "sum", demand: "water_supply" },
  dfu: { kind: "fixture_units_drainage", unit: "DFU", aggregation: "sum", demand: "drainage" },
  gpm_fixed: { kind: "flow_liquid", unit: "gpm", aggregation: "sum", demand: null },
  gph_demand: { kind: "flow_liquid", unit: "gph", aggregation: "sum", demand: null },
  mbh: { kind: "flow_gas_energy", unit: "MBH", aggregation: "sum", demand: null },
  min_inlet_pressure: { kind: "pressure", unit: "psi", aggregation: "max", demand: null },
  cfm: { kind: "flow_air", unit: "cfm", aggregation: "sum", demand: null },
  va: { kind: "power_apparent", unit: "VA", aggregation: "sum", demand: null },
} as const satisfies Readonly<Record<string, QuantityBinding>>;

export type LegacyQuantityKey = keyof typeof QUANTITY_BINDINGS;

/** The quantity-bag keys in their stored order (`QUANTITY_KEYS` in the kernel reads this list). */
export const LEGACY_QUANTITY_KEYS = ["wsfu_cold", "wsfu_hot", "wsfu_total", "dfu", "gpm_fixed", "gph_demand", "mbh", "min_inlet_pressure", "cfm", "va"] as const satisfies readonly LegacyQuantityKey[];

/** What a quantity-bag total prints after its number ("43.25 WSFU", "2 gal/h", "400 CFM"), as printed today. */
export const LEGACY_QUANTITY_UNIT_LABELS: Readonly<Record<LegacyQuantityKey, string>> = {
  wsfu_cold: "WSFU",
  wsfu_hot: "WSFU",
  wsfu_total: "WSFU",
  dfu: "DFU",
  gpm_fixed: "gpm",
  gph_demand: "gal/h",
  mbh: "MBH",
  min_inlet_pressure: "psi",
  cfm: "CFM",
  va: "VA",
};

/**
 * bim-calc's compile-time `Unit` names → unit codes. bim-calc keeps its names;
 * `Quantity<"in_wc">` there is `InUnit<"in_wc">` here, so a value computed by
 * a calc pack crosses into the unit library without a cast. `in_wc_gas` (gas
 * pressure in inches of water) is the same unit as `in_wc`.
 */
export const BIM_CALC_UNIT_CODES = {
  A: "A",
  V: "V",
  VA: "VA",
  ft: "ft",
  degC: "degC",
  pct: "%",
  ratio: "1",
  ohm_per_kft: "ohm/kft",
  in2: "in2",
  cmil: "cmil",
  Pa: "Pa",
  in_wc: "in_wc",
  in_wc_per_100ft: "in_wc/100ft",
  cfm: "cfm",
  fpm: "ft/min",
  in: "in",
  gpm: "gpm",
  fps: "ft/s",
  psi: "psi",
  psi_per_100ft: "psi/100ft",
  in_wc_gas: "in_wc",
  wsfu: "WSFU",
  dfu: "DFU",
  gph: "gph",
  gal: "gal",
  lb: "lb",
  degF: "degF",
  mbh: "MBH",
  cfh: "cfh",
  in_per_ft: "in/ft",
} as const satisfies Readonly<Record<string, UnitCode>>;

export type BimCalcUnit = keyof typeof BIM_CALC_UNIT_CODES;
