import { convert, qty, to, UNIT_CODES, type Quantity, type UnitCode } from "@permitzip/bim-units";
import type { SpaceStandardVentilation, VentilationCite, VentilationInput, VentilationStandardId } from "./kernel-seam";
import { ventilationCite, DEFAULT_EZ, EZ_RANGE, standardCite, VENTILATION_STANDARDS, type VentilationStandard } from "./standards";

/**
 * One space under one standard, with no model: Vbz = Rp·Pz + Ra·Az, Voz =
 * Vbz / Ez, exhaust = exhaust rate × Az. Every missing input is a reason in
 * words; nothing defaults to zero. The model engine (engine.ts) reads area,
 * occupants and the use row and calls this.
 */

/** A library citation, as `@permitzip/bim-library` space-uses writes it. */
export interface UseRowCite {
  readonly code: string;
  readonly edition: string | null;
  readonly clause: string;
  readonly verified: boolean;
}

export interface UseRowRate {
  readonly key: string;
  readonly value: number;
  readonly unit: string;
  readonly cite: UseRowCite;
  readonly alsoCites?: readonly UseRowCite[];
}

/** The parts of a space-use row this pack reads (bim-library `SpaceUseRow` fits). */
export interface VentilationUseRow {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly occupantsPer1000Ft2?: { readonly value: number; readonly cite: UseRowCite };
  readonly rates: readonly UseRowRate[];
  readonly note?: string;
}

/** A space-use library (bim-library `SpaceUseCatalog` fits). */
export interface VentilationUseSource {
  readonly libraryId: string;
  get(id: string): VentilationUseRow | undefined;
}

/** A typed override: the value and why. Refused without a reason. */
export interface VentilationOverride {
  readonly value: number;
  readonly reason: string;
}

export interface SpaceVentilationOverrides {
  /** Zone air distribution effectiveness (0.5–1.2, the tables' range). */
  readonly ez?: VentilationOverride;
}

export interface SpaceCalcInputs {
  readonly useName: string;
  /** Floor area; null when the space isn't drawn yet. */
  readonly areaM2: number | null;
  /** Design occupants; null when neither typed nor from a default density. */
  readonly occupants: number | null;
  readonly row: VentilationUseRow;
  readonly overrides?: SpaceVentilationOverrides;
}

export const OA_PEOPLE = "outdoor_air_people";
export const OA_AREA = "outdoor_air_area";
export const EXHAUST_AREA = "exhaust_area";

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
// One formatter per precision: building an Intl formatter per number dominated a 2,000-space table.
const FORMATS = [0, 1, 2].map((d) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d }));
const fmt = (v: number, digits: 0 | 1 | 2 = 2): string => (FORMATS[digits] as Intl.NumberFormat).format(v);

function unitCode(unit: string): UnitCode | null {
  return (UNIT_CODES as readonly string[]).includes(unit) ? (unit as UnitCode) : null;
}

/** The row's rate for `key` that this standard prints (its own citation or an also-cite). */
export function rateFor(row: VentilationUseRow, key: string, s: VentilationStandard): { readonly rate: UseRowRate; readonly cite: UseRowCite } | null {
  for (const r of row.rates) {
    if (r.key !== key) continue;
    if (r.cite.code === s.code) return { rate: r, cite: r.cite };
    const also = r.alsoCites?.find((c) => c.code === s.code);
    if (also) return { rate: r, cite: also };
  }
  return null;
}

const toCite = (c: UseRowCite): VentilationCite => ventilationCite(c.code, c.edition, c.clause, c.verified);

/** A rate in the unit the arithmetic prints in, or the reason its unit can't be read. */
function rateIn(rate: UseRowRate, target: "cfm/occ" | "cfm/ft2"): number | string {
  const unit = unitCode(rate.unit);
  if (!unit) return `${rate.unit} isn't a unit this pack reads`;
  try {
    return convert(rate.value, unit, target);
  } catch (err) {
    console.error("[ventilation] a rate's unit didn't convert", { key: rate.key, unit: rate.unit, target, err });
    return `${rate.unit} can't be read as ${target === "cfm/occ" ? "air per person" : "air per area"}`;
  }
}

function ezInput(s: VentilationStandard, override: VentilationOverride | undefined, reasons: string[]): VentilationInput<"ratio"> {
  if (override) {
    if (override.reason.trim() === "") reasons.push("The Ez override has no reason. Say why it differs from the table.");
    else if (!(override.value >= EZ_RANGE.min && override.value <= EZ_RANGE.max)) reasons.push(`Ez ${override.value} is outside the table's ${EZ_RANGE.min}–${EZ_RANGE.max}.`);
    else return { value: qty("ratio", override.value, "1"), from: "override", reason: override.reason.trim(), cite: standardCite(s, "ez", "engineer's override") };
  }
  return { value: qty("ratio", DEFAULT_EZ, "1"), from: "default", cite: standardCite(s, "ez", "ceiling supply of cool air") };
}

/** One standard's result for one space. */
export function ventilateUnderStandard(standard: VentilationStandardId, inputs: SpaceCalcInputs): SpaceStandardVentilation {
  const s = VENTILATION_STANDARDS[standard];
  const { row, areaM2, occupants, useName } = inputs;
  const reasons: string[] = [];
  const cites: VentilationCite[] = [];
  const ez = ezInput(s, inputs.overrides?.ez, reasons);
  const areaFt2 = areaM2 === null ? null : convert(areaM2, "m2", "ft2");

  const people = rateFor(row, OA_PEOPLE, s);
  const area = rateFor(row, OA_AREA, s);
  let rp: VentilationInput<"airflow_per_person"> | null = null;
  let ra: VentilationInput<"airflow_per_area"> | null = null;
  if (people) {
    const v = rateIn(people.rate, "cfm/occ");
    if (typeof v === "string") reasons.push(`Rp: ${v}.`);
    else rp = { value: qty("airflow_per_person", v, "cfm/occ"), from: "library", cite: toCite(people.cite) };
  }
  if (area) {
    const v = rateIn(area.rate, "cfm/ft2");
    if (typeof v === "string") reasons.push(`Ra: ${v}.`);
    else ra = { value: qty("airflow_per_area", v, "cfm/ft2"), from: "library", cite: toCite(area.cite) };
  }
  if (rp) cites.push(rp.cite);
  if (ra) cites.push(ra.cite);

  const exhaustRate = rateFor(row, EXHAUST_AREA, s);
  let exhaust: Quantity<"flow_air"> | null = null;
  let exhaustReason: string | null = null;
  if (!exhaustRate) exhaustReason = `${s.label} gives no area exhaust rate for ${useName}${row.note ? ` (${row.note})` : ""}`;
  else {
    const v = rateIn(exhaustRate.rate, "cfm/ft2");
    if (typeof v === "string") exhaustReason = `Exhaust: ${v}`;
    else if (areaFt2 === null) exhaustReason = "The space isn't drawn yet, so it has no area.";
    else {
      exhaust = qty("flow_air", round6(v * areaFt2), "cfm");
      cites.push(toCite(exhaustRate.cite), standardCite(s, "exhaust"));
    }
  }

  if (!people && !area) {
    const why = `${s.label} gives no outdoor air rate for ${useName}${row.note ? `: ${row.note}` : ""}`;
    return { standard, label: s.label, status: reasons.length > 0 ? "missing" : "not_required", reasons: [why, ...reasons], rp, ra, ez, vbz: reasons.length > 0 ? null : qty("flow_air", 0, "cfm"), voz: reasons.length > 0 ? null : qty("flow_air", 0, "cfm"), exhaust, exhaustReason, arithmetic: null, cites };
  }
  if (people && occupants === null) reasons.push("It has no occupants: type the number of people, or pick a use with a default density.");
  if (area && areaFt2 === null) reasons.push("It isn't drawn yet, so it has no area.");
  if (reasons.length > 0 || (people && !rp) || (area && !ra)) {
    return { standard, label: s.label, status: "missing", reasons, rp, ra, ez, vbz: null, voz: null, exhaust, exhaustReason, arithmetic: null, cites };
  }

  const rpCfm = rp ? to(rp.value, "cfm/occ") : 0;
  const raCfm = ra ? to(ra.value, "cfm/ft2") : 0;
  const pz = occupants ?? 0;
  const az = areaFt2 ?? 0;
  const vbzCfm = round6(rpCfm * pz + raCfm * az);
  const ezValue = to(ez.value, "1");
  const vozCfm = round6(vbzCfm / ezValue);
  const terms = [rp ? `${fmt(rpCfm)} cfm/person × ${fmt(pz, 0)} people` : null, ra ? `${fmt(raCfm)} cfm/ft² × ${fmt(az, 0)} ft²` : null].filter((t): t is string => t !== null);
  cites.push(standardCite(s, "vbz"), ez.cite, standardCite(s, "voz"));
  return {
    standard,
    label: s.label,
    status: "ok",
    reasons: [],
    rp,
    ra,
    ez,
    vbz: qty("flow_air", vbzCfm, "cfm"),
    voz: qty("flow_air", vozCfm, "cfm"),
    exhaust,
    exhaustReason,
    arithmetic: `Vbz = ${terms.join(" + ")} = ${fmt(vbzCfm, 0)} cfm`,
    cites,
  };
}
