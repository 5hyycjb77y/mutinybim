/**
 * Public contracts of @permitzip/bim-units (milestone M1). Formula, library,
 * registry, schedule and grid code import these; the registry, conversion
 * and formatting that implement them live beside this file.
 */

import type { KIND_IDS, KIND_UNITS, UNIT_CODES } from "./codes";

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * SI base dimensions plus three pseudo-dimensions that physics calls
 * dimensionless but a model must not mix: plane angle (`A`), counted items
 * (`C`) and currency (`$`). `Th` is thermodynamic temperature (Θ).
 */
export const BASE_DIMENSIONS = ["L", "M", "T", "I", "Th", "N", "J", "A", "C", "$"] as const;
export type BaseDimension = (typeof BASE_DIMENSIONS)[number];

/** Exponent per base dimension. Exponents may be fractional (a sprinkler K-factor is flow / pressure^½). */
export type Dimension = Readonly<Record<BaseDimension, number>>;

// ---------------------------------------------------------------------------
// Kinds and units
// ---------------------------------------------------------------------------

/**
 * What a number means, on top of its dimension. WSFU and DFU are both
 * dimensionless and inches of water and psi are both pressure, but a model
 * never adds supply fixture units to drainage fixture units; kinds make that
 * a type error and a refused formula.
 */
export type Kind = (typeof KIND_IDS)[number];

export type UnitCode = (typeof UNIT_CODES)[number];

/** The units a kind may be written in. */
export type UnitFor<K extends Kind> = (typeof KIND_UNITS)[K][number];

/** The unit a kind displays in when no profile says otherwise. */
export type DefaultUnit<K extends Kind> = (typeof KIND_UNITS)[K][0];

declare const kindBrand: unique symbol;
declare const unitBrand: unique symbol;

/**
 * A number of kind `K`, held in coherent SI for its dimension (metres,
 * pascals, m³/s, watts, kelvin; 1 for fixture units, counts and dollars).
 * A plain number at runtime: conversion is one multiply-add and storage is
 * free. Build one with `qty(kind, value, unit)` and read it with
 * `to(quantity, unit)`.
 */
export type Quantity<K extends Kind> = number & { readonly [kindBrand]: K };

/**
 * A number tagged with the unit it is written in, for code that computes in
 * a fixed unit (the bim-calc packs compute in amps, feet, psi). Convert to a
 * `Quantity<K>` at module boundaries.
 */
export type InUnit<U extends UnitCode> = number & { readonly [unitBrand]: U };

/**
 * A quantity whose kind is only known at runtime (a schedule cell, a formula
 * operand, a library field default). Operations on measures check kinds and
 * refuse mismatches with a `UnitError`.
 */
export interface Measure {
  readonly kind: Kind;
  /** Value in coherent SI, as in `Quantity<K>`. */
  readonly value: number;
}

/** How values of a kind combine when rows, loads or connections are totalled. */
export type AggregationRule = "sum" | "max" | "min" | "none";

/**
 * A total that is not a sum: fixture units become a flow through a demand
 * curve chosen by a code pack (bim-calc), never through a table here.
 */
export type DemandRuleId = "water_supply" | "drainage";

export interface KindAggregation {
  /** What a total does by default. */
  readonly default: AggregationRule;
  /** What a field or column of this kind may choose instead. Summing absolute temperatures, for example, is not allowed. */
  readonly allowed: readonly AggregationRule[];
  /** Present when a summed total turns into a flow through a demand rule. */
  readonly demand?: DemandRuleId;
}

export type Discipline = "architecture" | "structural" | "civil" | "mechanical" | "electrical" | "plumbing" | "fire_protection" | "general";

export interface KindDefinition {
  readonly id: Kind;
  readonly label: string;
  readonly dimension: Dimension;
  readonly aggregation: KindAggregation;
  /** Trades that use the kind most, for grouping in pickers. */
  readonly disciplines: readonly Discipline[];
}

/** IFC 4 unit type (IfcUnitEnum / IfcDerivedUnitEnum, or USERDEFINED). */
export type IfcUnitType =
  | "LENGTHUNIT"
  | "AREAUNIT"
  | "VOLUMEUNIT"
  | "MASSUNIT"
  | "TIMEUNIT"
  | "PLANEANGLEUNIT"
  | "FORCEUNIT"
  | "PRESSUREUNIT"
  | "ENERGYUNIT"
  | "POWERUNIT"
  | "ELECTRICCURRENTUNIT"
  | "ELECTRICVOLTAGEUNIT"
  | "ELECTRICRESISTANCEUNIT"
  | "FREQUENCYUNIT"
  | "THERMODYNAMICTEMPERATUREUNIT"
  | "LUMINOUSFLUXUNIT"
  | "ILLUMINANCEUNIT"
  | "LUMINOUSINTENSITYUNIT"
  | "COUNTUNIT"
  | "VOLUMETRICFLOWRATEUNIT"
  | "MASSFLOWRATEUNIT"
  | "LINEARVELOCITYUNIT"
  | "MASSDENSITYUNIT"
  | "TORQUEUNIT"
  | "LINEARFORCEUNIT"
  | "PLANARFORCEUNIT"
  | "TEMPERATUREGRADIENTUNIT"
  | "USERDEFINED";

export interface IfcUnitRef {
  readonly type: IfcUnitType;
  /** IfcSIUnitName plus prefix for SI units ("MILLI METRE"), the conversion-based unit name otherwise ("FOOT"). */
  readonly name: string;
}

export interface UnitDefinition {
  readonly code: UnitCode;
  readonly label: string;
  readonly dimension: Dimension;
  /** coherent SI = value × factor + offset. Offset is non-zero only for °C and °F. */
  readonly factor: number;
  readonly offset: number;
  /** As printed after a number: "ft", "MBH", "in. w.c.". */
  readonly symbol: string;
  /** Other spellings accepted when parsing ("cy" for yd3, "hr" for h). */
  readonly aliases: readonly string[];
  readonly ucum?: string;
  readonly ifc?: IfcUnitRef;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export type Precision =
  | {
      readonly kind: "decimals";
      readonly digits: number;
      /** At or above this magnitude the number prints whole (v1 part parameters: 112.46 kW prints "112 kW", 15.456 A prints "15.46 A"). Decimal format only. */
      readonly wholeFrom?: number;
    }
  | { readonly kind: "fraction"; readonly denominator: 2 | 4 | 8 | 16 | 32 | 64 };

/**
 * - `decimal`: 1,250.5 ft
 * - `feet_inches`: 10'-6 1/4" (length only; precision is a fraction of an inch or inch decimals)
 * - `inches_fraction`: 3/4", 1 1/2" (length only)
 * - `station`: 12+50.00 (length only; 100 ft or 1,000 m stations)
 */
export type NumberFormat = "decimal" | "feet_inches" | "inches_fraction" | "station";

export type LabelPlacement = "suffix" | "heading" | "none";

export interface KindDisplay {
  readonly unit: UnitCode;
  readonly precision: Precision;
  readonly format?: NumberFormat;
  readonly label?: LabelPlacement;
  /** Decimal precision is a most, not an exact count: "75", "2.5" instead of "75.00", "2.50". Absent: the profile's choice. */
  readonly trimZeros?: boolean;
}

/**
 * What a firm or person sees: one display choice per kind. Profiles are
 * library items, so firms share them; a person's override is stored by the
 * host. Kinds a profile leaves out display in their default unit.
 */
export interface DisplayProfile {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly kinds: Readonly<Partial<Record<Kind, KindDisplay>>>;
  /** Default for kinds that don't set `label`. */
  readonly label: LabelPlacement;
  /** Default for kinds that don't set `trimZeros`. Absent: false (fixed decimals). */
  readonly trimZeros?: boolean;
  /** Precision for kinds the profile leaves out. Absent: 2 decimals. */
  readonly precision?: Precision;
  readonly thousands: "," | "." | " " | "";
  readonly decimal: "." | ",";
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type UnitErrorCode = "kind_mismatch" | "unit_not_in_kind" | "dimension_mismatch" | "unknown_unit" | "unknown_kind" | "not_finite" | "parse" | "aggregation_refused";
