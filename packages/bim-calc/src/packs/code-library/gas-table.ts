import type { CodeLibrarySection, CodeTable, CodeTableIssue } from "./types";

/**
 * Reads an IFGC / VFGC Table 402.4(n) capacity table from its row text: the
 * header (gas, inlet pressure, pressure drop, specific gravity), the size
 * rows (nominal, SDR designation or CSST EHD, actual inside diameter) and the
 * capacity rows by length. Works on the code library's tab-separated text and
 * the bundled "|" snapshot alike, so a table loaded from the library at run
 * time and a bundled one are the same record.
 */

export type GasKind = "natural" | "propane";
export type GasMaterial = "sch40" | "copper" | "csst" | "pe_pipe" | "pe_tubing";

export interface Pressure {
  readonly value: number;
  readonly unit: "in_wc" | "psi";
  /** "Less than 2 psi": the table applies below this pressure. */
  readonly lessThan: boolean;
}

export interface GasTableSize {
  /** As printed: "1-1/4", "EHD 19". */
  readonly label: string;
  /** Nominal inches (1.25), or null for CSST (sized by EHD). */
  readonly nominalIn: number | null;
  readonly idIn: number | null;
  readonly sdr: number | null;
  readonly ehd: number | null;
}

export interface GasCapacityTable extends CodeTable {
  readonly gas: GasKind;
  readonly material: GasMaterial;
  readonly inlet: Pressure;
  readonly drop: Pressure;
  readonly specificGravity: number;
  readonly sizes: readonly GasTableSize[];
  /** "cfh" (natural gas tables) or "mbh" (thousands of Btu/h, propane tables). */
  readonly capacityUnit: "cfh" | "mbh";
  /** CSST tables: feet of tubing added per fitting or bend beyond those the table includes. */
  readonly extraFittingFt: number | null;
}

const IN_WC_PER_PSI = 27.7;

/** "11/4" (1-1/4), "1/2", "3", "13/8" (1-3/8) to inches. */
export function parseNominal(s: string): number | null {
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(\d+)\/(\d+)$/.exec(t);
  if (!m) return null;
  const [, numStr = "", denStr = ""] = m;
  const den = Number(denStr);
  for (let split = 0; split < numStr.length; split++) {
    const whole = split === 0 ? 0 : Number(numStr.slice(0, split));
    const num = Number(numStr.slice(split));
    if (num > 0 && num < den) return whole + num / den;
  }
  return null;
}

export function nominalLabel(inches: number): string {
  const whole = Math.floor(inches + 1e-9);
  const frac = inches - whole;
  const eighths = Math.round(frac * 8);
  if (eighths === 0) return `${whole}`;
  const names: Readonly<Record<number, string>> = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" };
  return whole === 0 ? `${names[eighths]}` : `${whole}-${names[eighths]}`;
}

export function parsePressure(s: string): Pressure | null {
  const lessThan = /less than/i.test(s);
  const m = /([\d.]+)\s*(in\.?\s*w\.?\s*c\.?|psi)/i.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  return { value, unit: /psi/i.test(m[2] ?? "") ? "psi" : "in_wc", lessThan };
}

export function pressureInWc(p: Pressure): number {
  return p.unit === "psi" ? p.value * IN_WC_PER_PSI : p.value;
}

function cellsOf(line: string): string[] {
  return line.split(/\t|\|/).map((c) => c.trim());
}

function num(s: string): number | null {
  const t = s.replace(/,/g, "").trim();
  if (t === "" || /^(NA|—|-)$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function materialOf(heading: string): GasMaterial {
  const h = heading.toUpperCase();
  if (h.includes("CSST") || h.includes("CORRUGATED")) return "csst";
  if (h.includes("POLYETHYLENE") && h.includes("TUBING")) return "pe_tubing";
  if (h.includes("POLYETHYLENE")) return "pe_pipe";
  if (h.includes("COPPER")) return "copper";
  return "sch40";
}

/** Parse a 402.4(n) section. Returns the table, or the reason it can't be read. */
export function parseGasCapacityTable(section: CodeLibrarySection): { ok: true; table: GasCapacityTable } | { ok: false; reason: string } {
  const lines = section.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let gas: GasKind | null = null;
  let inlet: Pressure | null = null;
  let drop: Pressure | null = null;
  let sg: number | null = null;
  let nominals: string[] = [];
  let ids: (number | null)[] = [];
  let sdrs: (number | null)[] = [];
  let ehds: (number | null)[] = [];
  let capacityUnit: "cfh" | "mbh" | null = null;
  let extraFittingFt: number | null = null;
  const lengths: number[] = [];
  const cells: (number | null)[][] = [];
  let inBody = false;
  let expectEhd = false;
  for (const line of lines) {
    const c = cellsOf(line);
    const head = (c[0] ?? "").toLowerCase();
    if (inBody) {
      const len = num(c[0] ?? "");
      if (len === null || c.length < 2) {
        inBody = false;
      } else {
        lengths.push(len);
        cells.push(c.slice(1).map(num));
        continue;
      }
    }
    if (expectEhd) {
      expectEhd = false;
      const vals = c.map(num);
      if (vals.every((v) => v !== null)) {
        ehds = vals;
        continue;
      }
    }
    if (head === "gas") gas = /propane/i.test(c[1] ?? "") ? "propane" : /natural/i.test(c[1] ?? "") ? "natural" : null;
    else if (head === "inlet pressure") inlet = parsePressure(c[1] ?? "");
    else if (head === "pressure drop") drop = parsePressure(c[1] ?? "");
    else if (head === "specific gravity") sg = num(c[1] ?? "");
    else if (head === "nominal" || head === "nominal od") nominals = c.slice(1);
    else if (head === "actual id") ids = c.slice(1).map(num);
    else if (head === "designation" && c.length > 1) sdrs = c.slice(1).map((s) => num(s.replace(/sdr/i, "")));
    else if (head === "designation" || head === "flow") expectEhd = head === "designation";
    else if (head === "ehd") ehds = c.slice(1).map(num);
    else if (head === "extra fitting length (ft)") extraFittingFt = num(c[1] ?? "");
    else if (head.startsWith("length")) {
      const unit = (c[1] ?? "").toLowerCase();
      capacityUnit = unit.includes("btu") ? "mbh" : "cfh";
      inBody = true;
    }
  }
  if (!gas || !inlet || !drop || sg === null || !capacityUnit) return { ok: false, reason: `${section.citation}: the header (gas, inlet pressure, pressure drop, specific gravity, capacity unit) could not be read` };
  if (cells.length === 0) return { ok: false, reason: `${section.citation}: no capacity rows` };
  const material = materialOf(section.heading);
  const columnCount = cells[0]?.length ?? 0;
  const sizes: GasTableSize[] = [];
  for (let i = 0; i < columnCount; i++) {
    const nominalIn = material === "csst" ? null : parseNominal(nominals[i] ?? "");
    const ehd = ehds[i] ?? null;
    sizes.push({ label: nominalIn !== null ? nominalLabel(nominalIn) : ehd !== null ? `EHD ${ehd}` : `column ${i + 1}`, nominalIn, idIn: ids[i] ?? null, sdr: sdrs[i] ?? null, ehd });
  }
  const issues = checkCapacityOrder(lengths, cells);
  const tableId = section.citation.replace(/^TABLE/i, "Table");
  const table: GasCapacityTable = {
    code: section.instrument.shortName,
    edition: section.instrument.edition,
    tableId,
    title: section.heading,
    source: { kind: section.source, note: `${section.instrument.shortName} ${section.instrument.edition} (${section.instrument.baseModelCode}) ${tableId}, from the PermitZIP code library`, instrument: section.instrument.slug },
    rows: { name: "length", unit: "ft", values: lengths },
    columns: { name: "size", unit: material === "csst" ? "EHD" : "in", labels: sizes.map((s) => s.label), values: sizes.map((s) => s.nominalIn ?? s.ehd) },
    cells,
    cellUnit: capacityUnit,
    meta: { gas, inlet: `${inlet.lessThan ? "< " : ""}${inlet.value} ${inlet.unit === "psi" ? "psi" : "in. w.c."}`, drop: `${drop.value} ${drop.unit === "psi" ? "psi" : "in. w.c."}`, specific_gravity: sg },
    issues,
    gas,
    material,
    inlet,
    drop,
    specificGravity: sg,
    sizes,
    capacityUnit,
    extraFittingFt,
  };
  return { ok: true, table };
}

/** Capacity falls with length and rises with size; a cell that breaks either is reported with its place. */
export function checkCapacityOrder(lengths: readonly number[], cells: ReadonlyArray<ReadonlyArray<number | null>>): CodeTableIssue[] {
  const issues: CodeTableIssue[] = [];
  const at = (r: number, k: number): number | null => cells[r]?.[k] ?? null;
  const columns = Math.max(0, ...cells.map((row) => row.length));
  for (let k = 0; k < columns; k++) {
    for (let r = 0; r + 1 < cells.length; r++) {
      const v = at(r, k);
      const next = at(r + 1, k);
      if (v === null || next === null || next <= v) continue;
      const prev = r > 0 ? at(r - 1, k) : null;
      const bad = prev !== null && prev >= next ? r : r + 1;
      issues.push({ row: bad, column: k, message: `At ${lengths[bad]} ft, column ${k + 1} reads ${at(bad, k)}, out of order with the lengths around it` });
    }
  }
  for (let r = 0; r < cells.length; r++) {
    for (let k = 1; k < columns; k++) {
      const v = at(r, k);
      const left = at(r, k - 1);
      if (v !== null && left !== null && v < left) issues.push({ row: r, column: k, message: `At ${lengths[r]} ft, column ${k + 1} reads ${v}, less than the smaller size beside it (${left})` });
    }
  }
  return issues;
}

export interface GasTableLookup {
  readonly sizeIndex: number;
  readonly size: GasTableSize;
  /** The table row used: the first length equal to or longer than the sizing length. */
  readonly rowLengthFt: number;
  readonly capacity: number;
}

/**
 * The smallest size whose capacity at the first tabulated length equal to or
 * longer than `lengthFt` carries `load` (in the table's own unit). Null when
 * the length is past the table or no size is big enough.
 */
export function lookupGasSize(table: GasCapacityTable, lengthFt: number, load: number): GasTableLookup | { readonly none: "length_beyond_table" | "load_beyond_table"; readonly rowLengthFt: number | null } {
  const r = table.rows.values.findIndex((l) => l >= lengthFt - 1e-9);
  if (r < 0) return { none: "length_beyond_table", rowLengthFt: null };
  const row = table.cells[r] ?? [];
  const rowLengthFt = table.rows.values[r] ?? lengthFt;
  for (let k = 0; k < row.length; k++) {
    const cap = row[k];
    const size = table.sizes[k];
    if (cap !== null && cap !== undefined && size && cap >= load - 1e-9) return { sizeIndex: k, size, rowLengthFt, capacity: cap };
  }
  return { none: "load_beyond_table", rowLengthFt };
}
