import { necCite, type NecEdition, CONDUCTOR_SIZES, sizeIndex, sizeLabel, type ConductorMaterial, type ConductorSize, type ConduitSize, type ConduitType, type InsulationType, type Table9Raceway, type TempColumns, type Citation, SQRT3, q, type Quantity } from "@permitzip/bim-calc";

/**
 * NEC building blocks, each returning its number with the clause it came
 * from. Pure functions over the edition's tables: no model, no I/O.
 */

export type TempRating = 60 | 75 | 90;

const column = (t: TempRating): 0 | 1 | 2 => (t === 60 ? 0 : t === 75 ? 1 : 2);
const pick = (cols: TempColumns, t: TempRating): number | null => cols[column(t)];

// ------------------------------------------------------------------ ampacity

export interface AmpacityInput {
  readonly size: ConductorSize;
  readonly material: ConductorMaterial;
  readonly insulationTempC: TempRating;
  readonly terminalTempC: TempRating;
  readonly ambientC: number;
  readonly currentCarrying: number;
}

export interface AmpacityResult {
  readonly size: ConductorSize;
  /** Table 310.16 at the insulation's temperature column: where corrections start. */
  readonly base: number | null;
  readonly ambientFactor: number | null;
  readonly adjustmentFactor: number;
  /** base x ambient x adjustment. */
  readonly corrected: number | null;
  /** The column the terminations allow (110.14(C)), never above the insulation's own. */
  readonly terminalColumnTempC: TempRating;
  readonly terminalLimit: number | null;
  /** min(corrected, terminal limit): what the conductor may carry here. Null where the table has no value. */
  readonly allowable: number | null;
  readonly limitedBy: "terminal" | "conditions" | null;
  readonly cite: readonly Citation[];
}

export function ambientFactor(nec: NecEdition, ambientC: number, insulation: TempRating): number | null {
  const row = nec.tables.AMBIENT_CORRECTION_30C.find((r) => ambientC <= r.maxC);
  return row ? pick(row.factors, insulation) : null;
}

export function adjustmentFactor(nec: NecEdition, currentCarrying: number): number {
  const row = nec.tables.CCC_ADJUSTMENT.find((r) => currentCarrying <= r.maxConductors);
  return (row?.pct ?? 35) / 100;
}

export function conductorAmpacity(nec: NecEdition, input: AmpacityInput): AmpacityResult {
  const row = nec.tables.AMPACITY_310_16[input.size];
  const cols = input.material === "copper" ? row.copper : row.aluminum;
  const base = pick(cols, input.insulationTempC);
  const fa = ambientFactor(nec, input.ambientC, input.insulationTempC);
  const fc = adjustmentFactor(nec, input.currentCarrying);
  const terminalTemp: TempRating = input.terminalTempC < input.insulationTempC ? input.terminalTempC : input.insulationTempC;
  const terminalLimit = pick(cols, terminalTemp);
  const corrected = base === null || fa === null ? null : base * fa * fc;
  const allowable = corrected === null || terminalLimit === null ? null : Math.min(corrected, terminalLimit);
  const cite: Citation[] = [necCite(nec, "ampacity_table", `${input.material} ${input.insulationTempC}°C column`)];
  if (fa !== null && fa !== 1) cite.push(necCite(nec, "ambient_correction", `${input.ambientC}°C ambient, ${input.insulationTempC}°C insulation: ${fa}`));
  if (fc !== 1) cite.push(necCite(nec, "ccc_adjustment", `${input.currentCarrying} current-carrying conductors: ${Math.round(fc * 100)}%`));
  if (terminalTemp !== input.insulationTempC) cite.push(necCite(nec, "terminal_rating", `limited to the ${terminalTemp}°C column`));
  return {
    size: input.size,
    base,
    ambientFactor: fa,
    adjustmentFactor: fc,
    corrected,
    terminalColumnTempC: terminalTemp,
    terminalLimit,
    allowable,
    limitedBy: allowable === null ? null : corrected !== null && terminalLimit !== null && terminalLimit < corrected ? "terminal" : "conditions",
    cite,
  };
}

/** The termination temperature 110.14(C)(1) assumes when the equipment's own rating isn't given: 60°C at 100 A or less, 75°C above. */
export function defaultTerminalTemp(nec: NecEdition, circuitRatingA: number): { tempC: TempRating; cite: Citation } {
  return circuitRatingA <= 100
    ? { tempC: 60, cite: necCite(nec, "terminal_le_100", "circuit rated 100 A or less: 60°C unless the equipment is listed and marked for 75°C") }
    : { tempC: 75, cite: necCite(nec, "terminal_gt_100", "circuit rated over 100 A: 75°C") };
}

// ------------------------------------------------------------------ overcurrent protection

/** The smallest 240.6(A) standard rating at or above `amps`, or null above 6000 A. */
export function nextStandardRating(nec: NecEdition, amps: number): number | null {
  return nec.tables.STANDARD_OCPD_RATINGS.find((r) => r >= amps - 1e-9) ?? null;
}

export function isStandardRating(nec: NecEdition, amps: number): boolean {
  return nec.tables.STANDARD_OCPD_RATINGS.includes(amps);
}

export interface Protection {
  readonly ok: boolean;
  readonly reason: string;
  readonly cite: readonly Citation[];
}

/**
 * Is a conductor of `allowable` amps protected by an `ocpd` amp device?
 * 240.4(D) caps the small conductors; otherwise the device must not exceed the
 * ampacity, except that 240.4(B) allows the next standard rating up to 800 A
 * when the circuit doesn't supply receptacles for cord-and-plug loads.
 */
export function protection(nec: NecEdition, size: ConductorSize, material: ConductorMaterial, allowable: number, ocpdA: number, suppliesReceptacles: boolean): Protection {
  const cap = nec.tables.SMALL_CONDUCTOR_MAX_OCPD[material][size];
  if (cap !== undefined && ocpdA > cap) {
    return { ok: false, reason: `${sizeLabel(size)} ${material} may be protected at no more than ${cap} A`, cite: [necCite(nec, "small_conductor", `${sizeLabel(size)} ${material}: ${cap} A maximum`)] };
  }
  if (allowable >= ocpdA - 1e-9) return { ok: true, reason: `${round1(allowable)} A ≥ ${ocpdA} A device`, cite: cap !== undefined ? [necCite(nec, "small_conductor", `${sizeLabel(size)} ${material}: ${cap} A maximum`)] : [] };
  const next = nextStandardRating(nec, allowable);
  if (!suppliesReceptacles && ocpdA <= nec.tables.NEXT_SIZE_UP_MAX_A && next !== null && ocpdA <= next) {
    return { ok: true, reason: `${ocpdA} A is the next standard rating above ${round1(allowable)} A`, cite: [necCite(nec, "next_size_up", "next higher standard rating, 800 A or less")] };
  }
  return { ok: false, reason: `${round1(allowable)} A is below the ${ocpdA} A device`, cite: [necCite(nec, "next_size_up")] };
}

// ------------------------------------------------------------------ equipment grounding conductor

export function egcFromTable(nec: NecEdition, ocpdA: number, material: ConductorMaterial): { size: ConductorSize; rowA: number; cite: Citation } | null {
  const row = nec.tables.EGC_250_122.find((r) => ocpdA <= r.ocpdMaxA);
  if (!row) return null;
  const size = material === "copper" ? row.copper : row.aluminum;
  return { size, rowA: row.ocpdMaxA, cite: necCite(nec, "egc_table", `${ocpdA} A device (row ${row.ocpdMaxA} A): ${sizeLabel(size)} ${material}`) };
}

/** Smallest size whose Chapter 9 Table 8 area is at least `cmil`. */
export function sizeForCircularMils(nec: NecEdition, cmil: number): ConductorSize | null {
  return CONDUCTOR_SIZES.find((s) => nec.tables.CIRCULAR_MILS[s] >= cmil - 1e-6) ?? null;
}

export interface EgcResult {
  readonly tableSize: ConductorSize;
  readonly size: ConductorSize;
  readonly ratio: number;
  readonly upsized: boolean;
  readonly cite: readonly Citation[];
}

/**
 * The EGC: Table 250.122 for the device; where the phase conductors are
 * larger than the minimum that had the ampacity (for voltage drop), the EGC
 * grows by the same ratio of circular-mil area (250.122(B)); never larger than
 * the phase conductors (250.122(A)).
 */
export function equipmentGround(nec: NecEdition, ocpdA: number, egcMaterial: ConductorMaterial, minPhase: ConductorSize, phase: ConductorSize): EgcResult | null {
  const table = egcFromTable(nec, ocpdA, egcMaterial);
  if (!table) return null;
  const cmil = nec.tables.CIRCULAR_MILS;
  const ratio = cmil[phase] / cmil[minPhase];
  const cite: Citation[] = [table.cite];
  let size = table.size;
  if (sizeIndex(phase) > sizeIndex(minPhase)) {
    const want = cmil[table.size] * ratio;
    size = sizeForCircularMils(nec, want) ?? "2000";
    cite.push(necCite(nec, "egc_upsize", `phase conductors ${sizeLabel(minPhase)} → ${sizeLabel(phase)} (x${ratio.toFixed(3)} circular mils): ${Math.round(want)} cmil needs ${sizeLabel(size)}`));
    cite.push(necCite(nec, "circular_mils"));
  }
  if (sizeIndex(size) > sizeIndex(phase)) {
    size = phase;
    cite.push(necCite(nec, "egc_not_larger", "not larger than the circuit conductors"));
  }
  return { tableSize: table.size, size, ratio, upsized: size !== table.size, cite };
}

// ------------------------------------------------------------------ voltage drop

export interface Impedance {
  readonly r: Quantity<"ohm_per_kft">;
  readonly xl: Quantity<"ohm_per_kft">;
  readonly ze: Quantity<"ohm_per_kft">;
}

const RACEWAY_COLUMN: Readonly<Record<Table9Raceway, 0 | 1 | 2>> = { pvc: 0, aluminum: 1, steel: 2 };

/** Table 9 Note 2: Ze = R x PF + XL x sin(arccos PF). Null for sizes the table doesn't list. */
export function effectiveImpedance(nec: NecEdition, size: ConductorSize, material: ConductorMaterial, raceway: Table9Raceway, powerFactor: number): Impedance | null {
  const row = nec.tables.TABLE_9[size];
  if (!row) return null;
  const rs = material === "copper" ? row.rCopper : row.rAluminum;
  if (!rs) return null;
  const r = rs[RACEWAY_COLUMN[raceway]];
  const xl = raceway === "steel" ? row.xl[1] : row.xl[0];
  const sin = Math.sqrt(Math.max(0, 1 - powerFactor * powerFactor));
  return { r: q(r, "ohm_per_kft"), xl: q(xl, "ohm_per_kft"), ze: q(r * powerFactor + xl * sin, "ohm_per_kft") };
}

/**
 * Voltage drop over a one-way length: single-phase (two-wire, or line to line)
 * Vd = 2 I Ze L; three-phase line to line Vd = √3 I Ze L. Percent of the
 * nominal voltage the caller gives (line to neutral for a 277 V circuit, line
 * to line for 208 V or 480 V).
 */
export function voltageDrop(ze: Quantity<"ohm_per_kft">, amps: Quantity<"A">, lengthFt: Quantity<"ft">, volts: Quantity<"V">, phases: 1 | 3, sets = 1): { volts: Quantity<"V">; pct: Quantity<"pct"> } {
  const k = phases === 3 ? SQRT3 : 2;
  const vd = (k * amps * ze * lengthFt) / 1000 / sets;
  return { volts: q(vd, "V"), pct: q((vd / volts) * 100, "pct") };
}

// ------------------------------------------------------------------ conduit fill

export interface FillConductor {
  readonly size: ConductorSize;
  readonly insulation: InsulationType;
  readonly count: number;
  readonly role: string;
}

export interface FillResult {
  readonly conductors: number;
  readonly areaIn2: number;
  readonly fillPercent: number;
  readonly conduit: ConduitSize | null;
  readonly usedPct: number | null;
  readonly missing: readonly string[];
  readonly cite: readonly Citation[];
}

export function conduitFill(nec: NecEdition, type: ConduitType, conductors: readonly FillConductor[]): FillResult {
  const t = nec.tables;
  const missing: string[] = [];
  let area = 0;
  let n = 0;
  for (const c of conductors) {
    const a = t.CONDUCTOR_AREAS[c.insulation][c.size];
    if (a === undefined) missing.push(`${sizeLabel(c.size)} ${c.insulation}`);
    else area += a * c.count;
    n += c.count;
  }
  const pct = n === 1 ? t.FILL_PERCENT.one : n === 2 ? t.FILL_PERCENT.two : t.FILL_PERCENT.overTwo;
  const usable = (s: ConduitSize) => (n > 2 ? s.fill40In2 : (s.totalIn2 * pct) / 100);
  const conduit = missing.length > 0 ? null : (t.CONDUIT_AREAS[type].find((s) => usable(s) >= area - 1e-9) ?? null);
  return {
    conductors: n,
    areaIn2: area,
    fillPercent: pct,
    conduit,
    usedPct: conduit ? (area / conduit.totalIn2) * 100 : null,
    missing,
    cite: [necCite(nec, "conductor_areas"), necCite(nec, "fill_percent", `${pct}% for ${n === 1 ? "one conductor" : n === 2 ? "two conductors" : "over two conductors"}`), necCite(nec, "conduit_areas", conduitLabel(type))],
  };
}

export function conduitLabel(type: ConduitType): string {
  return type === "emt" ? "EMT" : type === "pvc40" ? "PVC Schedule 40" : "PVC Schedule 80";
}

const round1 = (v: number) => Math.round(v * 10) / 10;
