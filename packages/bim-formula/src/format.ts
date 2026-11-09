/**
 * Plain, locale-independent number formatting for explain text and `list()`.
 * Deterministic on every runtime (no Intl), so the browser, worker,
 * authority and agent tools print identical strings. Sheet display goes
 * through the unit library's display profiles instead.
 */

import { fromSI, isUnitCode, unitSymbol } from "./units";
import type { UnitCode } from "./units";

export const EMPTY_TEXT = "empty";

export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return EMPTY_TEXT;
  const abs = Math.abs(x);
  let decimals: number;
  if (abs === 0) decimals = 0;
  else if (abs < 1) decimals = Math.min(6, 2 - Math.floor(Math.log10(abs)));
  else decimals = Math.max(0, 4 - (Math.floor(Math.log10(abs)) + 1));
  let text = abs.toFixed(decimals);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  const [intPart = "0", frac] = text.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = frac ? `${grouped}.${frac}` : grouped;
  return x < 0 && body !== "0" ? `-${body}` : body;
}

/** A canonical-SI value printed in `unit`, e.g. 58_322 W in "Btu/h" -> "199,000 Btu/h". */
export function formatQuantity(si: number, unit: UnitCode): string {
  if (!Number.isFinite(si)) return EMPTY_TEXT;
  if (!isUnitCode(unit)) return formatNumber(si);
  const value = fromSI(si, unit);
  const symbol = unitSymbol(unit);
  if (!symbol) return formatNumber(value);
  return symbol === "%" ? `${formatNumber(value)}%` : `${formatNumber(value)} ${symbol}`;
}

export function quoteText(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
