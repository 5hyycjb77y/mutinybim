import type { DensityRate, QuantityBag, QuantityKey, SpaceUseRef } from "@permitzip/bim-kernel";
import { QUANTITY_BINDINGS, toSI, unitAllowed, type Kind, type UnitCode, UNIT_CODES } from "@permitzip/bim-units";

/**
 * Density loads: a space use's code rates times a space's floor area or its
 * occupants, as a quantity bag (ASHRAE 62.1 Vbz = Rp·Pz + Ra·Az; NEC 220.12
 * VA/ft² × area). Each value names the clauses it rests on.
 *
 * `pinSpaceUse` turns a library row (bim-library space-uses, rates in the
 * code's own units: cfm/person, cfm/ft², VA/ft²) into the canonical rates
 * the kernel stores on a space (quantity-bag unit per m² or per occupant),
 * through bim-units; nothing here hard-codes a conversion factor.
 */

const M2_PER_1000_FT2 = toSI(1000, "ft2");

/** A library row's rate, as `@permitzip/bim-library` writes it. */
export interface CodeRate {
  readonly key: string;
  readonly value: number;
  readonly unit: string;
  readonly cite: { readonly code: string; readonly edition: string | null; readonly clause: string; readonly verified: boolean };
}

/** The parts of a space-use row this calc reads (bim-library `SpaceUseRow` fits). */
export interface SpaceUseRates {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly occupantsPer1000Ft2?: { readonly value: number };
  readonly rates: readonly CodeRate[];
}

/** Where a rate key loads: bim-library's SPACE_USE_RATE_TARGETS, restated as the calc's contract. */
export interface RateTarget {
  /** A quantity bag key (`cfm`, `va`), or a pack's parameter key (`struct.live_load`). */
  readonly quantity: QuantityKey | (string & {});
  readonly per: "area" | "occupant";
  readonly kind: Kind;
  /** The unit a parameter-keyed rate's total is in (`lbf` for a live load); bag keys take their binding's unit. */
  readonly unit?: UnitCode;
}

/** A rate onto a pack's parameter key, in canonical units: the parameter's unit per m² (area) or per occupant. */
export interface ParameterRate {
  readonly key: string;
  readonly per: "area" | "occupant";
  readonly value: number;
}

function isBagKey(key: string): key is QuantityKey {
  return Object.prototype.hasOwnProperty.call(QUANTITY_BINDINGS, key);
}

export interface PinnedUse extends SpaceUseRef {
  readonly name: string;
  readonly revision: number;
  readonly occupantsPerM2?: number;
  readonly rates: readonly DensityRate[];
  /** Rates onto pack parameter keys; present only when the row has one. */
  readonly parameterRates?: readonly ParameterRate[];
}

/** A pinned use as a space command takes it (its own copies of the rate lists). */
export function pinnedUseForCommand(pinned: PinnedUse) {
  const { rates, parameterRates, ...rest } = pinned;
  return { ...rest, rates: [...rates], ...(parameterRates ? { parameterRates: [...parameterRates] } : {}) };
}

function unitCode(unit: string): UnitCode | null {
  return (UNIT_CODES as readonly string[]).includes(unit) ? (unit as UnitCode) : null;
}

/** One code rate in canonical units: the bag key's (or the pack parameter's) own unit per m² (area) or per occupant. */
export function canonicalRate(rate: CodeRate, target: RateTarget & { readonly quantity: QuantityKey }): DensityRate | string;
export function canonicalRate(rate: CodeRate, target: RateTarget): DensityRate | ParameterRate | string;
export function canonicalRate(rate: CodeRate, target: RateTarget): DensityRate | ParameterRate | string {
  const unit = unitCode(rate.unit);
  if (!unit || !unitAllowed(target.kind, unit)) return `${rate.unit} isn't a unit for this rate (${rate.cite.code} ${rate.cite.clause})`;
  const quantity = target.quantity;
  if (isBagKey(quantity)) {
    const bagUnit = QUANTITY_BINDINGS[quantity].unit;
    // SI per m² (or per occupant) divided by one bag unit in SI.
    return { key: quantity, per: target.per, value: toSI(rate.value, unit) / toSI(1, bagUnit) };
  }
  if (!target.unit) return `the rate onto "${quantity}" names no unit for its total, so it can't be pinned (${rate.cite.code} ${rate.cite.clause})`;
  return { key: quantity, per: target.per, value: toSI(rate.value, unit) / toSI(1, target.unit) };
}

/** A library row pinned for a space: density per m², rates in canonical units. Refuses, naming the rate, when a unit doesn't fit. */
export function pinSpaceUse(libraryId: string, row: SpaceUseRates, targets: Readonly<Record<string, RateTarget>>): PinnedUse | string {
  const rates: DensityRate[] = [];
  const parameterRates: ParameterRate[] = [];
  for (const r of row.rates) {
    const target = targets[r.key];
    if (!target) return `${row.name}: no load is defined for the rate "${r.key}"`;
    const c = canonicalRate(r, target);
    if (typeof c === "string") return `${row.name}: ${c}`;
    if (isDensityRate(c)) rates.push(c);
    else parameterRates.push(c);
  }
  return {
    libraryId,
    useId: row.id,
    name: row.name,
    revision: row.revision,
    ...(row.occupantsPer1000Ft2 ? { occupantsPerM2: row.occupantsPer1000Ft2.value / M2_PER_1000_FT2 } : {}),
    rates,
    ...(parameterRates.length > 0 ? { parameterRates } : {}),
  };
}

function isDensityRate(r: DensityRate | ParameterRate): r is DensityRate {
  return isBagKey(r.key);
}

export interface DensityLine {
  readonly key: QuantityKey;
  readonly per: "area" | "occupant";
  readonly rate: number;
  readonly basis: number;
  readonly value: number;
  /** "IMC 2021 Table 403.3.1.1 (not verified)". */
  readonly source: string;
}

export interface DensityResult {
  readonly bag: QuantityBag;
  readonly lines: readonly DensityLine[];
  /** Rates that couldn't apply, in words. */
  readonly missing: readonly string[];
  /** Totals onto pack parameter keys (`struct.live_load` in its target unit); present only when a rate has one. */
  readonly parameters?: Readonly<Record<string, number>>;
}

/**
 * Rate × area or × occupants, per line and summed per quantity. Area in m²;
 * occupants as counted for design (typed, or the use's density × area, rounded up).
 */
export function densityLoads(row: SpaceUseRates, targets: Readonly<Record<string, RateTarget>>, inputs: { readonly areaM2: number | null; readonly occupants: number | null }): DensityResult {
  const lines: DensityLine[] = [];
  const missing: string[] = [];
  const bag: Partial<Record<QuantityKey, number>> = {};
  const parameters: Record<string, number> = {};
  for (const r of row.rates) {
    const target = targets[r.key];
    const c = target ? canonicalRate(r, target) : `no load is defined for "${r.key}"`;
    if (typeof c === "string" || !target) {
      missing.push(typeof c === "string" ? c : r.key);
      continue;
    }
    const basis = c.per === "area" ? inputs.areaM2 : inputs.occupants;
    if (basis === null) {
      missing.push(c.per === "area" ? `${r.key}: the space isn't drawn yet, so it has no area` : `${r.key}: the space has no occupants yet`);
      continue;
    }
    const value = c.value * basis;
    if (!isDensityRate(c)) {
      parameters[c.key] = (parameters[c.key] ?? 0) + value;
      continue;
    }
    bag[c.key] = (bag[c.key] ?? 0) + value;
    lines.push({ key: c.key, per: c.per, rate: c.value, basis, value, source: `${r.cite.code}${r.cite.edition ? ` ${r.cite.edition}` : ""} ${r.cite.clause}${r.cite.verified ? "" : " (not verified)"}` });
  }
  return { bag, lines, missing, ...(Object.keys(parameters).length > 0 ? { parameters } : {}) };
}

/** Design occupants from a row's density: people per 1,000 ft² × area, rounded up. */
export function defaultOccupants(row: SpaceUseRates, areaM2: number): number | null {
  if (!row.occupantsPer1000Ft2) return null;
  return Math.ceil((areaM2 / M2_PER_1000_FT2) * row.occupantsPer1000Ft2.value - 1e-9);
}
