import { KIND_UNITS } from "./codes";
import { UnitError } from "./errors";
import { displayUnit } from "./format";
import { KINDS } from "./kinds";
import { findUnit } from "./lookup";
import { toSI } from "./quantity";
import type { DisplayProfile, Kind, Measure, Quantity, UnitCode } from "./types";
import { UNITS } from "./units";

/**
 * Reads what a person types into a cell or formula: "199 MBH", "1,250.5",
 * "10'-6 1/4\"", "6\"", "1 1/2 in", "12+50.00", "$1,200". A bare number is in
 * the profile's display unit for the kind (or the kind's default unit).
 */

const STATION = /^([+-]?)(\d+)\+(\d+(?:\.\d+)?)$/;
const FEET_INCHES = /^([+-]?)(\d+(?:\.\d+)?)\s*(?:'|ft\.?|feet|foot)\s*(?:-\s*)?(?:(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?\s*(?:"|in\.?|inch|inches)?)?$/;
const INCHES = /^([+-]?)(?:(\d+(?:\.\d+)?)\s+)?(?:(\d+(?:\.\d+)?)|(\d+)\/(\d+))\s*(?:"|in\.?|inch|inches)$/;
const NUMBER = /^([+-]?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?(?:\s+(\d+)\/(\d+)|\/(\d+))?\s*(.*)$/;

function refuse(text: string, kind: Kind, hint: string): never {
  throw new UnitError("parse", `"${text}" isn't a ${KINDS[kind].label.toLowerCase()} value. ${hint}`);
}

function fraction(num: string | undefined, den: string | undefined): number {
  if (num === undefined || den === undefined) return 0;
  const d = Number(den);
  if (d === 0) throw new UnitError("parse", "A fraction can't have 0 under the line.");
  return Number(num) / d;
}

function lengthSpecial(text: string, profile: DisplayProfile | undefined): number | null {
  const station = STATION.exec(text);
  if (station) {
    const metric = profile ? ["m", "km", "mm", "cm"].includes(displayUnit("length", profile)) : false;
    const value = Number(station[2]) * (metric ? 1000 : 100) + Number(station[3]);
    const si = toSI(value, metric ? "m" : "ft");
    return station[1] === "-" ? -si : si;
  }
  const fi = FEET_INCHES.exec(text);
  if (fi) {
    const inches = Number(fi[3] ?? 0) + fraction(fi[4], fi[5]);
    const si = toSI(Number(fi[2]), "ft") + toSI(inches, "in");
    return fi[1] === "-" ? -si : si;
  }
  const inch = INCHES.exec(text);
  if (inch) {
    const inches = Number(inch[2] ?? 0) + (inch[3] !== undefined ? Number(inch[3]) : fraction(inch[4], inch[5]));
    const si = toSI(inches, "in");
    return inch[1] === "-" ? -si : si;
  }
  return null;
}

/** Parses to coherent SI for `kind`. */
export function parseToSI(input: string, kind: Kind, profile?: DisplayProfile): number {
  let text = input.trim();
  if (text === "") refuse(input, kind, "Type a number.");
  if (profile?.decimal === ",") text = text.replace(/\./g, "").replace(/,/g, ".");
  if (kind === "length") {
    const special = lengthSpecial(text, profile);
    if (special !== null) return special;
  }
  let forcedUnit: UnitCode | null = null;
  if (kind === "money" && text.startsWith("$")) {
    text = text.slice(1).trim();
    forcedUnit = "USD";
  } else if (kind === "money" && text.startsWith("-$")) {
    text = `-${text.slice(2).trim()}`;
    forcedUnit = "USD";
  }
  const m = NUMBER.exec(text);
  if (!m) refuse(input, kind, "Start with a number, like 12.5 or 1,250.");
  let value = Number((m[2] ?? "").replace(/,/g, ""));
  if (m[3] !== undefined) value *= 10 ** Number(m[3]);
  if (m[4] !== undefined) value += fraction(m[4], m[5]);
  else if (m[6] !== undefined) value = fraction(m[2], m[6]);
  if (m[1] === "-") value = -value;
  if (!Number.isFinite(value)) refuse(input, kind, "The number is too large.");
  const unitText = (m[7] ?? "").trim();
  let unit: UnitCode;
  if (unitText === "") {
    unit = forcedUnit ?? (profile ? displayUnit(kind, profile) : KIND_UNITS[kind][0]);
  } else {
    const found = findUnit(unitText, kind);
    if (!found) {
      const elsewhere = findUnit(unitText);
      if (elsewhere) throw new UnitError("unit_not_in_kind", `${KINDS[kind].label} can't be written in ${UNITS[elsewhere].label.toLowerCase()}.`);
      throw new UnitError("unknown_unit", `"${unitText}" isn't a unit MutinyBIM knows.`);
    }
    unit = found;
  }
  return toSI(value, unit);
}

export function parseQuantity<K extends Kind>(input: string, kind: K, profile?: DisplayProfile): Quantity<K> {
  return parseToSI(input, kind, profile) as Quantity<K>;
}

export function parseMeasure(input: string, kind: Kind, profile?: DisplayProfile): Measure {
  return { kind, value: parseToSI(input, kind, profile) };
}
