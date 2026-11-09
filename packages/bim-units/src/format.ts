import { KIND_UNITS } from "./codes";
import { UnitError } from "./errors";
import { KINDS } from "./kinds";
import { unitAllowed } from "./quantity";
import type { DisplayProfile, Kind, KindDisplay, LabelPlacement, Measure, Quantity, UnitCode } from "./types";
import { UNITS } from "./units";

/**
 * Formatting is the hot path of a schedule grid, so a formatter is built
 * once per (profile, kind, column override) and cached: each call is then a
 * multiply-add, one rounding and a few string joins. No `toLocaleString`.
 */

/** A column's own choice, overriding the profile for one kind. */
export type DisplayOverride = Partial<KindDisplay>;

export type Formatter = (si: number) => string;

const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
const NUDGE = 1 + 1e-12;

const ATTACHED = new Set(["%", "°", "°C", "°F", "'", "\""]);

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** "000" … "999", so grouping and short fractions are lookups, not padding. */
const PAD3: readonly string[] = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, "0"));
const PAD2: readonly string[] = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0"));
const PAD1: readonly string[] = Array.from({ length: 10 }, (_, i) => String(i));

function group(int: number, sep: string): string {
  if (int < 1000 || sep === "") return String(int);
  if (int < 1e6) return Math.floor(int / 1000) + sep + PAD3[int % 1000];
  if (int < 1e9) return Math.floor(int / 1e6) + sep + PAD3[Math.floor(int / 1000) % 1000] + sep + PAD3[int % 1000];
  const s = String(int);
  let out = s.slice(0, s.length % 3 || 3);
  for (let i = out.length; i < s.length; i += 3) out += sep + s.slice(i, i + 3);
  return out;
}

function fraction(frac: number, digits: number): string {
  if (digits === 1) return PAD1[frac] as string;
  if (digits === 2) return PAD2[frac] as string;
  if (digits === 3) return PAD3[frac] as string;
  return String(frac).padStart(digits, "0");
}

/** Fixed decimals with grouping. `value` may be negative. */
function fixed(value: number, digits: number, thousands: string, decimal: string): string {
  const p = POW10[digits] ?? 10 ** digits;
  const scaled = Math.round((value < 0 ? -value : value) * p * NUDGE);
  const sign = value < 0 && scaled !== 0 ? "-" : "";
  if (digits === 0) return sign + group(scaled, thousands);
  const int = Math.floor(scaled / p);
  return sign + group(int, thousands) + decimal + fraction(scaled - int * p, digits);
}

/** `fixed` followed by a constant tail, with every fractional ending (".5 MBH") built once: one join per cell instead of three. */
function fixedTailed(digits: number, thousands: string, decimal: string, tail: string): (value: number) => string {
  if (digits > 3) return (value) => fixed(value, digits, thousands, decimal) + tail;
  const p = POW10[digits] as number;
  const endings: readonly string[] = Array.from({ length: p }, (_, f) => (digits === 0 ? tail : decimal + fraction(f, digits) + tail));
  return (value) => {
    const scaled = Math.round((value < 0 ? -value : value) * p * NUDGE);
    const int = Math.floor(scaled / p);
    const ending = endings[scaled - int * p];
    if (ending === undefined) return fixed(value, digits, thousands, decimal) + tail;
    return (value < 0 && scaled !== 0 ? "-" : "") + group(int, thousands) + ending;
  };
}

/** Drops trailing zeros after the decimal mark, and the mark itself when nothing follows ("75.00" → "75", "2.50" → "2.5"). */
function trimmed(text: string, decimal: string): string {
  if (text.indexOf(decimal) < 0) return text;
  let end = text.length;
  while (text.charCodeAt(end - 1) === 48) end--;
  if (text[end - 1] === decimal) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** Whole part and a reduced fraction of `1/denominator`: "1 1/2", "3/4", "6". */
function mixed(value: number, denominator: number, thousands: string): string {
  const units = Math.round(Math.abs(value) * denominator * NUDGE);
  const sign = value < 0 && units !== 0 ? "-" : "";
  const whole = Math.floor(units / denominator);
  const num = units - whole * denominator;
  if (num === 0) return sign + group(whole, thousands);
  const g = gcd(num, denominator);
  const frac = `${num / g}/${denominator / g}`;
  return whole === 0 ? sign + frac : `${sign}${group(whole, thousands)} ${frac}`;
}

export function resolveDisplay(kind: Kind, profile: DisplayProfile, override?: DisplayOverride): Required<KindDisplay> {
  const base = profile.kinds[kind];
  const unit = override?.unit ?? base?.unit ?? KIND_UNITS[kind][0];
  if (!unitAllowed(kind, unit)) throw new UnitError("unit_not_in_kind", `${KINDS[kind].label} can't be shown in ${UNITS[unit].label.toLowerCase()}.`);
  const format = override?.format ?? (override?.unit && override.unit !== base?.unit ? "decimal" : (base?.format ?? "decimal"));
  if (format !== "decimal" && kind !== "length") throw new UnitError("unit_not_in_kind", `Only lengths can be shown as ${format.replace("_", " ")}.`);
  return {
    unit,
    precision: override?.precision ?? base?.precision ?? profile.precision ?? { kind: "decimals", digits: 2 },
    format,
    label: override?.label ?? base?.label ?? profile.label,
    trimZeros: override?.trimZeros ?? base?.trimZeros ?? profile.trimZeros ?? false,
  };
}

/** `null` when nothing is appended, so the caller can skip a call. */
function suffixer(symbol: string, label: LabelPlacement): ((text: string) => string) | null {
  if (label !== "suffix" || symbol === "") return null;
  if (symbol === "$") return (t) => (t.charCodeAt(0) === 45 ? `-$${t.slice(1)}` : `$${t}`);
  const tail = ATTACHED.has(symbol) ? symbol : ` ${symbol}`;
  return (t) => t + tail;
}

function build(kind: Kind, profile: DisplayProfile, override?: DisplayOverride): Formatter {
  const d = resolveDisplay(kind, profile, override);
  const u = UNITS[d.unit];
  const { factor, offset } = u;
  const { thousands, decimal } = profile;
  const precision = d.precision;

  switch (d.format) {
    case "feet_inches": {
      const inch = UNITS.in.factor;
      if (precision.kind === "fraction") {
        const den = precision.denominator;
        const perFoot = 12 * den;
        const scaleUnits = (den / inch) * NUDGE;
        // Every inch-and-fraction tail ("-6 1/4\"") for one foot, built once.
        const tails: string[] = [];
        for (let rest = 0; rest < perFoot; rest++) {
          const wholeIn = Math.floor(rest / den);
          const num = rest - wholeIn * den;
          const g = num === 0 ? 1 : gcd(num, den);
          tails.push(num === 0 ? `'-${wholeIn}"` : `'-${wholeIn} ${num / g}/${den / g}"`);
        }
        return (si) => {
          const units = Math.round((si < 0 ? -si : si) * scaleUnits);
          const feet = Math.floor(units / perFoot);
          const tail = tails[units - feet * perFoot] as string;
          return (si < 0 && units !== 0 ? "-" : "") + group(feet, thousands) + tail;
        };
      }
      const digits = precision.digits;
      const p = POW10[digits] ?? 10 ** digits;
      return (si) => {
        const units = Math.round((Math.abs(si) / inch) * p * NUDGE);
        const sign = si < 0 && units !== 0 ? "-" : "";
        const feet = Math.floor(units / (12 * p));
        const rest = units - feet * 12 * p;
        return `${sign}${group(feet, thousands)}'-${fixed(rest / p, digits, "", decimal)}"`;
      };
    }
    case "inches_fraction": {
      const inch = UNITS.in.factor;
      if (precision.kind === "fraction") {
        const den = precision.denominator;
        return (si) => `${mixed(si / inch, den, thousands)}"`;
      }
      const digits = precision.digits;
      return (si) => `${fixed(si / inch, digits, thousands, decimal)}"`;
    }
    case "station": {
      const metric = d.unit === "m" || d.unit === "km" || d.unit === "mm" || d.unit === "cm";
      const stationM = metric ? 1000 : 100 * UNITS.ft.factor;
      const inStation = metric ? 1000 : 100;
      const pad = metric ? 3 : 2;
      const digits = precision.kind === "decimals" ? precision.digits : 2;
      const p = POW10[digits] ?? 10 ** digits;
      return (si) => {
        const local = Math.round(((Math.abs(si) / stationM) * inStation) * p * NUDGE);
        const sign = si < 0 && local !== 0 ? "-" : "";
        const station = Math.floor(local / (inStation * p));
        const rest = (local - station * inStation * p) / p;
        const restText = fixed(rest, digits, "", decimal);
        const intLen = digits > 0 ? restText.length - digits - 1 : restText.length;
        return `${sign}${station}+${"0".repeat(Math.max(0, pad - intLen))}${restText}`;
      };
    }
    case "decimal": {
      const finish = suffixer(u.symbol, d.label);
      if (precision.kind === "fraction") {
        const den = precision.denominator;
        return finish ? (si) => finish(mixed((si - offset) / factor, den, thousands)) : (si) => mixed((si - offset) / factor, den, thousands);
      }
      const digits = precision.digits;
      const wholeFrom = precision.wholeFrom;
      if (wholeFrom !== undefined) {
        const num = (si: number) => {
          const v = (si - offset) / factor;
          if ((v < 0 ? -v : v) >= wholeFrom) return fixed(v, 0, thousands, decimal);
          const text = fixed(v, digits, thousands, decimal);
          return d.trimZeros ? trimmed(text, decimal) : text;
        };
        return finish ? (si) => finish(num(si)) : num;
      }
      if (d.trimZeros && digits > 0) {
        const num = (si: number) => trimmed(fixed((si - offset) / factor, digits, thousands, decimal), decimal);
        return finish ? (si) => finish(num(si)) : num;
      }
      if (finish && u.symbol !== "$") {
        const tailed = fixedTailed(digits, thousands, decimal, ATTACHED.has(u.symbol) ? u.symbol : ` ${u.symbol}`);
        return (si) => tailed((si - offset) / factor);
      }
      return finish ? (si) => finish(fixed((si - offset) / factor, digits, thousands, decimal)) : (si) => fixed((si - offset) / factor, digits, thousands, decimal);
    }
  }
}

const CACHE = new WeakMap<DisplayProfile, Map<string, Formatter>>();

/** The cached formatter for a kind under a profile (and optional column override). Takes coherent SI. */
export function formatter(kind: Kind, profile: DisplayProfile, override?: DisplayOverride): Formatter {
  let byKey = CACHE.get(profile);
  if (!byKey) {
    byKey = new Map();
    CACHE.set(profile, byKey);
  }
  const key = override ? `${kind}|${override.unit ?? ""}|${override.format ?? ""}|${override.label ?? ""}|${override.trimZeros === undefined ? "" : override.trimZeros ? "t" : "f"}|${override.precision ? JSON.stringify(override.precision) : ""}` : kind;
  let f = byKey.get(key);
  if (!f) {
    f = build(kind, profile, override);
    byKey.set(key, f);
  }
  return f;
}

export function formatQuantity<K extends Kind>(quantity: Quantity<K>, kind: K, profile: DisplayProfile, override?: DisplayOverride): string {
  return formatter(kind, profile, override)(quantity);
}

export function formatMeasure(m: Measure, profile: DisplayProfile, override?: DisplayOverride): string {
  return formatter(m.kind, profile, override)(m.value);
}

/** The label for a column heading ("CFM", "MBH"), or "" when the format carries its own marks (feet-inches). */
export function unitLabel(kind: Kind, profile: DisplayProfile, override?: DisplayOverride): string {
  const d = resolveDisplay(kind, profile, override);
  return d.format === "decimal" ? UNITS[d.unit].symbol : "";
}

/** The display unit a profile picks for a kind. */
export function displayUnit(kind: Kind, profile: DisplayProfile, override?: DisplayOverride): UnitCode {
  return resolveDisplay(kind, profile, override).unit;
}
