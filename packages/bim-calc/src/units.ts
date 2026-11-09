/**
 * Unit-typed numbers. A `Quantity<"A">` is a plain number at runtime, but the
 * compiler refuses to pass it where a `Quantity<"V">` or a bare length is
 * expected, so amps, volts, feet and percent can't be swapped silently inside
 * a calculation. Conversions are explicit functions.
 *
 * The calc packs keep their short unit names; each is an alias of a
 * @permitzip/bim-units code (`BIM_CALC_UNIT_CODES`), so `Quantity<"mbh">`
 * here is `InUnit<"MBH">` there and crosses into schedules and formulas
 * without a cast.
 */

import type { BIM_CALC_UNIT_CODES, BimCalcUnit, InUnit } from "@permitzip/bim-units";

export type Unit = BimCalcUnit;

export type Quantity<U extends Unit> = InUnit<(typeof BIM_CALC_UNIT_CODES)[U]>;

/** Tag a finite number with its unit. Refuses NaN and infinities so a bad input fails at the boundary. */
export function q<U extends Unit>(value: number, unit: U): Quantity<U> {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite ${unit} value: ${value}`);
  return value as Quantity<U>;
}

/** Strip the tag for output. */
export const raw = <U extends Unit>(v: Quantity<U>): number => v;

export const SQRT3 = Math.sqrt(3);

const MM_PER_IN = 25.4;
const M_PER_FT = 0.3048;

export const inToMm = (v: Quantity<"in">): number => v * MM_PER_IN;
export const ftToM = (v: Quantity<"ft">): number => v * M_PER_FT;
export const fToC = (f: number): Quantity<"degC"> => q(((f - 32) * 5) / 9, "degC");

/** Current drawn by an apparent power at a voltage: VA / V single-phase, VA / (√3 V) three-phase line-to-line. */
export function ampsFromVa(va: Quantity<"VA">, volts: Quantity<"V">, phases: 1 | 3): Quantity<"A"> {
  if (volts <= 0) throw new RangeError(`Voltage must be positive, got ${volts} V`);
  return q(phases === 3 ? va / (SQRT3 * volts) : va / volts, "A");
}

/** Round for display; calculations keep full precision. */
export function round(v: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
