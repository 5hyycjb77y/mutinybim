import { parseGasCapacityTable, pressureInWc, type GasCapacityTable, type GasKind, type GasMaterial, type Pressure } from "../code-library/gas-table";
import { VFGC_2021_GAS_TABLES } from "../code-library/vfgc-2021-snapshot";
import type { Citation, CodeEdition } from "../../types";

/**
 * The fuel gas code pack: the 402.4 sizing equations, the Table 402.4 Cr / Y
 * factors, gas properties, and the 402.4(n) capacity tables from the code
 * library's Virginia Fuel Gas Code 2021 (2021 IFGC). Tables a project needs
 * that aren't bundled come in through `extraTables` (loaded from the library
 * at run time or imported by the firm) without any change here.
 *
 * The library carries the equations' variable list (Equations 4-1 / 4-2) but
 * not the formulas themselves (they were images in the source); the formulas
 * below are the published 402.4 forms, checked against the library's tables
 * (see the tests: within 2% across the propane Schedule 40 table).
 */

export const IFGC_EDITIONS = ["2021"] as const;
export type IfgcEditionYear = (typeof IFGC_EDITIONS)[number];
export const IFGC_PACK_VERSION = "2026.10.23";

export type IfgcClause = "sizing_methods" | "longest_length" | "branch_length" | "hybrid_pressure" | "equations" | "low_pressure_eq" | "high_pressure_eq" | "cr_y" | "capacity_tables" | "fitting_lengths";

const CLAUSES: Readonly<Record<IfgcClause, string>> = {
  sizing_methods: "402.4",
  longest_length: "402.4.1",
  branch_length: "402.4.2",
  hybrid_pressure: "402.4.3",
  equations: "402.4, Equations 4-1 and 4-2",
  low_pressure_eq: "402.4, Equation 4-1 (low pressure, under 1-1/2 psi)",
  high_pressure_eq: "402.4, Equation 4-2 (high pressure, 1-1/2 psi and above)",
  cr_y: "Table 402.4",
  capacity_tables: "Tables 402.4(1) through 402.4(37)",
  fitting_lengths: "Table A102.2",
};

export interface IfgcAdoption {
  readonly code: string;
  readonly libraryText: boolean;
}

export interface IfgcEdition extends CodeEdition<IfgcClause, { readonly gasTables: readonly GasCapacityTable[] }> {
  readonly family: "ifgc";
  readonly edition: IfgcEditionYear;
  readonly adoption: IfgcAdoption;
}

/** Table 402.4: equation factors at standard conditions. */
export const CR_Y: Readonly<Record<GasKind, { readonly cr: number; readonly y: number }>> = {
  natural: { cr: 0.6094, y: 0.9992 },
  propane: { cr: 1.2462, y: 0.991 },
};

/** Gas properties the tables are drawn at; heating values are the usual design values (give the supplier's when known). */
export const GAS_PROPERTIES: Readonly<Record<GasKind, { readonly specificGravity: number; readonly heatingValueBtuPerCf: number; readonly label: string }>> = {
  natural: { specificGravity: 0.6, heatingValueBtuPerCf: 1000, label: "natural gas" },
  propane: { specificGravity: 1.5, heatingValueBtuPerCf: 2516, label: "undiluted propane" },
};

let parsedBundled: readonly GasCapacityTable[] | null = null;

/** The bundled 402.4(n) tables, parsed once. A table that fails to parse is logged and left out, never guessed. */
export function bundledGasTables(): readonly GasCapacityTable[] {
  if (parsedBundled) return parsedBundled;
  const out: GasCapacityTable[] = [];
  for (const s of VFGC_2021_GAS_TABLES) {
    const r = parseGasCapacityTable(s);
    if (r.ok) out.push(r.table);
    else console.error(`[bim-calc] bundled VFGC table could not be read: ${r.reason}`);
  }
  parsedBundled = out;
  return out;
}

export function isIfgcYear(v: string): v is IfgcEditionYear {
  return (IFGC_EDITIONS as readonly string[]).includes(v);
}

export function ifgcEdition(year: IfgcEditionYear, adoption: IfgcAdoption = { code: "VFGC", libraryText: true }): IfgcEdition {
  return { family: "ifgc", code: adoption.code, edition: year, packVersion: IFGC_PACK_VERSION, clauses: CLAUSES, tables: { gasTables: bundledGasTables() }, adoption };
}

export function isIfgcEdition(code: CodeEdition | null): code is IfgcEdition {
  return code !== null && code.family === "ifgc";
}

export function ifgcCite(ed: IfgcEdition, clause: IfgcClause, detail?: string): Citation {
  const where = ed.adoption.libraryText ? "2021 IFGC as adopted by Virginia, PermitZIP code library" : "values from the Virginia adoption of the 2021 IFGC in the PermitZIP code library; check local amendments";
  return { source: "code", code: ed.code, edition: ed.edition, clause: ed.clauses[clause], ...(detail ? { detail } : {}), text: `${ed.code} ${ed.edition} ${ed.clauses[clause]}${detail ? `, ${detail}` : ""} (${where})` };
}

/** A capacity table's own citation: "VFGC 2021 Table 402.4(28) (… code library)" or the firm import's note. */
export function gasTableCite(table: GasCapacityTable): Citation {
  return { source: "code", code: table.code, edition: table.edition, clause: table.tableId, detail: `${table.meta.gas}, ${table.title.toLowerCase()}, inlet ${table.meta.inlet}, drop ${table.meta.drop}`, text: `${table.code} ${table.edition} ${table.tableId} (${table.source.kind === "code_library" ? "PermitZIP code library" : table.source.note})` };
}

/** The table for this gas, material, inlet pressure and allowable drop, or null. Inlet "less than 2 psi" matches any inlet under 2 psi. */
export function findGasTable(tables: readonly GasCapacityTable[], gas: GasKind, material: GasMaterial, inlet: Pressure, drop: Pressure): GasCapacityTable | null {
  const inletWc = pressureInWc(inlet);
  const dropWc = pressureInWc(drop);
  return (
    tables.find((t) => {
      if (t.gas !== gas || t.material !== material) return false;
      if (Math.abs(pressureInWc(t.drop) - dropWc) > 1e-6) return false;
      const tInlet = pressureInWc(t.inlet);
      return t.inlet.lessThan ? inletWc < tInlet - 1e-9 : Math.abs(tInlet - inletWc) < 1e-6;
    }) ?? null
  );
}

const PSIA = 14.7;

/** Equation 4-1, solved for flow: cfh a pipe of inside diameter `d` (in.) carries over `lengthFt` with drop `dropInWc`. */
export function lowPressureCfh(d: number, lengthFt: number, dropInWc: number, gas: GasKind): number {
  const { cr } = CR_Y[gas];
  return (d * 19.17 * (dropInWc / (cr * lengthFt)) ** 0.206) ** (1 / 0.381);
}

/** Equation 4-2, solved for flow: P1 and P2 gauge psi. */
export function highPressureCfh(d: number, lengthFt: number, p1Psig: number, p2Psig: number, gas: GasKind): number {
  const { cr, y } = CR_Y[gas];
  const p1 = p1Psig + PSIA;
  const p2 = p2Psig + PSIA;
  return (d * 18.93 * (((p1 * p1 - p2 * p2) * y) / (cr * lengthFt)) ** 0.206) ** (1 / 0.381);
}

/** Equation 4-1: inside diameter (in.) needed for `cfh`. */
export function lowPressureDiameter(cfh: number, lengthFt: number, dropInWc: number, gas: GasKind): number {
  const { cr } = CR_Y[gas];
  return cfh ** 0.381 / (19.17 * (dropInWc / (cr * lengthFt)) ** 0.206);
}

/** Equation 4-2: inside diameter (in.) needed for `cfh`. */
export function highPressureDiameter(cfh: number, lengthFt: number, p1Psig: number, p2Psig: number, gas: GasKind): number {
  const { cr, y } = CR_Y[gas];
  const p1 = p1Psig + PSIA;
  const p2 = p2Psig + PSIA;
  return cfh ** 0.381 / (18.93 * (((p1 * p1 - p2 * p2) * y) / (cr * lengthFt)) ** 0.206);
}

/** Which equation 402.4 uses: high pressure at 1-1/2 psi and above. */
export function usesHighPressure(inlet: Pressure): boolean {
  return pressureInWc(inlet) >= 1.5 * 27.7 - 1e-9 && !inlet.lessThan;
}
