/**
 * The single seam between the formula engine and `@permitzip/bim-units`.
 * Every other file in this package imports units only from here.
 */

import {
  KINDS,
  KIND_IDS,
  KIND_UNITS,
  UNITS,
  DIMENSIONLESS as ZERO_DIMENSION,
  divideDimensions,
  fromSI,
  isKind,
  isUnitCode,
  kindsOfUnit,
  multiplyDimensions,
  powDimension,
  sameDimension,
  toSI,
  unitAllowed,
  unitCandidates,
} from "@permitzip/bim-units";
import type { Dimension, Kind, Quantity, UnitCode } from "@permitzip/bim-units";

export type { Dimension, Kind, Quantity, UnitCode };
export { ZERO_DIMENSION, divideDimensions, fromSI, isKind, isUnitCode, multiplyDimensions, powDimension, sameDimension, toSI, unitAllowed };

export const NUMBER_KIND: Kind = "dimensionless";
export const COUNT_KIND: Kind = "count";
export const NUMBER_UNIT: UnitCode = "1";

/** Kinds that scale another value without changing what it measures: plain numbers, ratios, counts. */
const SCALAR_KINDS: ReadonlySet<Kind> = new Set<Kind>([NUMBER_KIND, "ratio", COUNT_KIND]);

export function isScalarKind(kind: Kind): boolean {
  return SCALAR_KINDS.has(kind);
}

/**
 * Absolute kinds and their difference kind: two temperatures subtract to a
 * temperature difference, a difference adds to a temperature, and two
 * temperatures never add (mirrors `addMeasures` / `subtractMeasures`).
 */
export const AFFINE_DELTA: ReadonlyMap<Kind, Kind> = new Map<Kind, Kind>([["temperature", "temperature_delta"]]);

export function dimensionOf(kind: Kind): Dimension {
  return KINDS[kind].dimension;
}

export function defaultUnitOf(kind: Kind): UnitCode {
  return KIND_UNITS[kind][0];
}

/** "Gas input" -> "gas input"; "K-factor" stays as written. */
export function kindLabel(kind: Kind): string {
  const label = KINDS[kind].label;
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

export function unitSymbol(unit: UnitCode): string {
  return UNITS[unit].symbol;
}

export function unitDimension(unit: UnitCode): Dimension {
  return UNITS[unit].dimension;
}

export function sumAllowed(kind: Kind): boolean {
  return KINDS[kind].aggregation.allowed.includes("sum");
}

/** Kinds sharing a dimension, in the library's declared order. */
export function kindsWithDimension(dimension: Dimension): readonly Kind[] {
  return KIND_IDS.filter((k) => sameDimension(KINDS[k].dimension, dimension));
}

/** What a unit written after a number can mean: the unit codes for that spelling and every kind they serve. */
export function readUnitSpelling(text: string): { readonly units: readonly UnitCode[]; readonly kinds: readonly Kind[] } | null {
  const units = unitCandidates(text);
  if (units.length === 0) return null;
  const kinds: Kind[] = [];
  for (const u of units) for (const k of kindsOfUnit(u)) if (!kinds.includes(k)) kinds.push(k);
  return { units, kinds };
}

/** The unit a spelling means for one kind ("°F" is degF for a temperature, delta_degF for a difference). */
export function unitForKind(text: string, kind: Kind): UnitCode | null {
  for (const u of unitCandidates(text)) if (unitAllowed(kind, u)) return u;
  return null;
}
