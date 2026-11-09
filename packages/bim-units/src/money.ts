import { UnitError } from "./errors";

/**
 * Money with a currency (ISO 4217): an amount in the currency's minor unit
 * (cents) and its three-letter code. Integer minor units, so totals never
 * drift. Amounts in different currencies never add: converting is a
 * party's own business, not this library's.
 *
 * The `money` quantity kind (`USD`) stays for typed parameter values; this is
 * the shape prices and totals take. MutinyBIM models never store it.
 */

export interface MoneyAmount {
  readonly minor: number;
  readonly currency: string;
}

const CODE = /^[A-Z]{3}$/;

/** Minor-unit digits for currencies that don't use two. Any other well-formed code uses two. */
const MINOR_DIGITS: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, ISK: 0, CLP: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export function isCurrencyCode(code: string): boolean {
  return CODE.test(code);
}

export function currencyMinorDigits(currency: string): number {
  if (!isCurrencyCode(currency)) throw new UnitError("unknown_unit", `"${currency}" isn't a currency code (three capital letters, ISO 4217, like USD).`);
  return MINOR_DIGITS[currency] ?? 2;
}

export function money(minor: number, currency: string): MoneyAmount {
  if (!Number.isSafeInteger(minor)) throw new UnitError("parse", `A money amount is a whole number of ${currency} minor units; got ${minor}.`);
  currencyMinorDigits(currency);
  return Object.freeze({ minor, currency });
}

/** From a major-unit amount (dollars), rounded half away from zero to the minor unit. */
export function moneyFromMajor(major: number, currency: string): MoneyAmount {
  if (!Number.isFinite(major)) throw new UnitError("parse", `A money amount must be a number; got ${major}.`);
  const scale = 10 ** currencyMinorDigits(currency);
  return money(Math.sign(major) * Math.round(Math.abs(major) * scale), currency);
}

export function zeroMoney(currency: string): MoneyAmount {
  return money(0, currency);
}

export function addMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  if (a.currency !== b.currency) throw new UnitError("unit_not_in_kind", `${a.currency} and ${b.currency} amounts can't be added; convert one first.`);
  return money(a.minor + b.minor, a.currency);
}

/** A rate times a quantity (a unit price × 120 ft), rounded half away from zero to the minor unit. */
export function multiplyMoney(rate: MoneyAmount, quantity: number): MoneyAmount {
  if (!Number.isFinite(quantity)) throw new UnitError("parse", `A quantity to price must be a number; got ${quantity}.`);
  const raw = rate.minor * quantity;
  return money(Math.sign(raw) * Math.round(Math.abs(raw)), rate.currency);
}

/** "$1,234.50" for USD; "1,234.50 EUR" for codes without a symbol here. */
export function formatMoney(m: MoneyAmount): string {
  const digits = currencyMinorDigits(m.currency);
  const major = Math.abs(m.minor) / 10 ** digits;
  const text = major.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = m.minor < 0 ? "-" : "";
  return m.currency === "USD" ? `${sign}$${text}` : `${sign}${text} ${m.currency}`;
}
