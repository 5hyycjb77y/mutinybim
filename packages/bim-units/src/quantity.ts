import { KIND_IDS, KIND_UNITS, UNIT_CODES } from "./codes";
import { describeDimension, sameDimension } from "./dimension";
import { UnitError } from "./errors";
import { KINDS } from "./kinds";
import type { AggregationRule, Kind, Measure, Quantity, UnitCode, UnitFor } from "./types";
import { UNITS } from "./units";

const KIND_SET: ReadonlySet<string> = new Set(KIND_IDS);
const UNIT_SET: ReadonlySet<string> = new Set(UNIT_CODES);
const UNITS_BY_KIND: ReadonlyMap<Kind, ReadonlySet<UnitCode>> = new Map(KIND_IDS.map((k) => [k, new Set<UnitCode>(KIND_UNITS[k])]));
const KINDS_BY_UNIT: ReadonlyMap<UnitCode, readonly Kind[]> = (() => {
  const out = new Map<UnitCode, Kind[]>();
  for (const k of KIND_IDS) for (const u of KIND_UNITS[k]) out.set(u, [...(out.get(u) ?? []), k]);
  return out;
})();

export const isKind = (value: string): value is Kind => KIND_SET.has(value);
export const isUnitCode = (value: string): value is UnitCode => UNIT_SET.has(value);

export function unitsFor<K extends Kind>(kind: K): readonly UnitFor<K>[] {
  return KIND_UNITS[kind];
}

export function kindsOfUnit(unit: UnitCode): readonly Kind[] {
  return KINDS_BY_UNIT.get(unit) ?? [];
}

export function unitAllowed(kind: Kind, unit: string): boolean {
  return isUnitCode(unit) && (UNITS_BY_KIND.get(kind)?.has(unit) ?? false);
}

function assertKindUnit(kind: Kind, unit: string): void {
  if (!isKind(kind)) throw new UnitError("unknown_kind", `"${kind}" is not a known kind of quantity.`);
  if (!isUnitCode(unit)) throw new UnitError("unknown_unit", `"${unit}" is not a known unit.`);
  if (!unitAllowed(kind, unit)) {
    throw new UnitError("unit_not_in_kind", `${KINDS[kind].label} can't be written in ${UNITS[unit].label.toLowerCase()}. Use ${KIND_UNITS[kind].map((u) => UNITS[u].symbol || u).join(", ")}.`);
  }
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new UnitError("not_finite", `${what} must be a finite number, got ${value}.`);
}

/** Value written in `unit` → coherent SI. */
export function toSI(value: number, unit: UnitCode): number {
  const u = UNITS[unit];
  return value * u.factor + u.offset;
}

/** Coherent SI → value written in `unit`. */
export function fromSI(si: number, unit: UnitCode): number {
  const u = UNITS[unit];
  return (si - u.offset) / u.factor;
}

/**
 * Converts between two units that can express the same kind. Same dimension
 * is not enough: WSFU and DFU, joules and newton-metres, a temperature and a
 * temperature difference all share one and are refused.
 */
export function convert(value: number, from: UnitCode, to: UnitCode): number {
  if (from === to) return value;
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a) throw new UnitError("unknown_unit", `"${from}" is not a known unit.`);
  if (!b) throw new UnitError("unknown_unit", `"${to}" is not a known unit.`);
  if (!sameDimension(a.dimension, b.dimension)) {
    throw new UnitError("dimension_mismatch", `${a.label} can't be converted to ${b.label.toLowerCase()} (${describeDimension(a.dimension)} vs ${describeDimension(b.dimension)}).`);
  }
  const shared = kindsOfUnit(from).some((k) => UNITS_BY_KIND.get(k)?.has(to));
  if (!shared) throw new UnitError("kind_mismatch", `${a.label} and ${b.label.toLowerCase()} measure different things, so one can't be converted to the other.`);
  return (value * a.factor + a.offset - b.offset) / b.factor;
}

/** `qty("flow_gas_energy", 199, "MBH")`. Refuses NaN, infinities and units the kind can't be written in. */
export function qty<K extends Kind>(kind: K, value: number, unit: UnitFor<K>): Quantity<K> {
  assertKindUnit(kind, unit);
  assertFinite(value, KINDS[kind].label);
  return toSI(value, unit) as Quantity<K>;
}

/** Wraps a value already in coherent SI (from storage or a solver). */
export function fromCanonical<K extends Kind>(kind: K, si: number): Quantity<K> {
  assertFinite(si, KINDS[kind].label);
  return si as Quantity<K>;
}

/** The quantity written in `unit`. */
export function to<K extends Kind>(quantity: Quantity<K>, unit: UnitFor<K>): number {
  return fromSI(quantity, unit);
}

/** Kinds whose values may be added. Absolute temperatures may not (add a `temperature_delta` instead). */
export type AdditiveKind = Exclude<Kind, "temperature">;

export function add<K extends AdditiveKind>(a: Quantity<K>, b: Quantity<NoInfer<K>>): Quantity<K> {
  return (a + b) as Quantity<K>;
}

export function subtract<K extends AdditiveKind>(a: Quantity<K>, b: Quantity<NoInfer<K>>): Quantity<K> {
  return (a - b) as Quantity<K>;
}

export function scale<K extends Kind>(a: Quantity<K>, factor: number): Quantity<K> {
  return (a * factor) as Quantity<K>;
}

/** a ÷ b of the same kind: a plain number (utilisation, percent of capacity). */
export function ratioOf<K extends Kind>(a: Quantity<K>, b: Quantity<NoInfer<K>>): number {
  return a / b;
}

export function compare<K extends Kind>(a: Quantity<K>, b: Quantity<NoInfer<K>>): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertRule(kind: Kind, rule: AggregationRule): void {
  if (!KINDS[kind].aggregation.allowed.includes(rule)) {
    throw new UnitError("aggregation_refused", `${KINDS[kind].label} values can't be totalled with "${rule}". Allowed: ${KINDS[kind].aggregation.allowed.join(", ")}.`);
  }
}

/**
 * Totals values of one kind by its rule (default: the kind's own). `none`
 * gives null; `max`/`min` of nothing give null; a sum of nothing is 0. A
 * rule the kind doesn't allow is refused, so absolute temperatures never sum.
 */
export function aggregate<K extends Kind>(kind: K, values: readonly Quantity<NoInfer<K>>[], rule: AggregationRule = KINDS[kind].aggregation.default): Quantity<K> | null {
  assertRule(kind, rule);
  switch (rule) {
    case "none":
      return null;
    case "sum": {
      let total = 0;
      for (const v of values) total += v;
      return total as Quantity<K>;
    }
    case "max":
    case "min": {
      if (values.length === 0) return null;
      let best: number = values[0] as number;
      for (const v of values) if (rule === "max" ? v > best : v < best) best = v;
      return best as Quantity<K>;
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime-typed measures
// ---------------------------------------------------------------------------

export function measure(kind: Kind, value: number, unit: UnitCode): Measure {
  assertKindUnit(kind, unit);
  assertFinite(value, KINDS[kind].label);
  return { kind, value: toSI(value, unit) };
}

export function measureIn(m: Measure, unit: UnitCode): number {
  assertKindUnit(m.kind, unit);
  return fromSI(m.value, unit);
}

/** Narrows a measure to a typed quantity, refusing another kind. */
export function asQuantity<K extends Kind>(m: Measure, kind: K): Quantity<K> {
  if (m.kind !== kind) throw new UnitError("kind_mismatch", `Expected ${KINDS[kind].label.toLowerCase()}, got ${KINDS[m.kind].label.toLowerCase()}.`);
  return m.value as Quantity<K>;
}

function assertSameKind(a: Measure, b: Measure, verb: string): void {
  if (a.kind !== b.kind) {
    throw new UnitError("kind_mismatch", `${KINDS[a.kind].label} can't be ${verb} ${KINDS[b.kind].label.toLowerCase()}.`);
  }
}

export function addMeasures(a: Measure, b: Measure): Measure {
  if (a.kind === "temperature" && b.kind === "temperature_delta") return { kind: "temperature", value: a.value + b.value };
  assertSameKind(a, b, "added to");
  assertRule(a.kind, "sum");
  return { kind: a.kind, value: a.value + b.value };
}

/** Two temperatures differ by a `temperature_delta`. */
export function subtractMeasures(a: Measure, b: Measure): Measure {
  if (a.kind === "temperature" && b.kind === "temperature") return { kind: "temperature_delta", value: a.value - b.value };
  if (a.kind === "temperature" && b.kind === "temperature_delta") return { kind: "temperature", value: a.value - b.value };
  assertSameKind(a, b, "subtracted from");
  assertRule(a.kind, "sum");
  return { kind: a.kind, value: a.value - b.value };
}

export function compareMeasures(a: Measure, b: Measure): -1 | 0 | 1 {
  assertSameKind(a, b, "compared with");
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

export function aggregateMeasures(kind: Kind, values: readonly Measure[], rule: AggregationRule = KINDS[kind].aggregation.default): Measure | null {
  const raw: number[] = [];
  for (const m of values) {
    if (m.kind !== kind) throw new UnitError("kind_mismatch", `A ${KINDS[kind].label.toLowerCase()} total can't include ${KINDS[m.kind].label.toLowerCase()}.`);
    raw.push(m.value);
  }
  const total = aggregate(kind, raw as Quantity<Kind>[], rule);
  return total === null ? null : { kind, value: total };
}
