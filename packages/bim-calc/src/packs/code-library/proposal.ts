import { checkCapacityOrder, parseGasCapacityTable, type GasCapacityTable } from "./gas-table";
import type { CodeInstrument, CodeTable, CodeTableIssue } from "./types";

/**
 * The import path for tables the code library doesn't hold (or a firm's own
 * adopted edition): a CSV pasted or read from a sheet PDF by vision becomes a
 * *proposal*. The importer UI shows it with its issues; an engineer accepts it
 * and it becomes a firm table. Nothing here writes anywhere; the caller
 * stores the accepted record.
 */

export interface CodeTableProposal {
  readonly kind: "code_table_proposal";
  /** "csv" for a paste or file, "vision" for a table read off a drawing or PDF page. */
  readonly via: "csv" | "vision";
  readonly table: CodeTable;
  /** Cells the reader was unsure of (vision), by [row, column]. */
  readonly uncertain: ReadonlyArray<readonly [number, number]>;
  readonly issues: readonly CodeTableIssue[];
  readonly needsReview: true;
}

export interface CsvTableMeta {
  readonly code: string;
  readonly edition: string;
  readonly tableId: string;
  readonly title: string;
  readonly rowName: string;
  readonly rowUnit: string;
  readonly columnName: string;
  readonly columnUnit: string;
  readonly cellUnit: string;
  readonly meta?: Readonly<Record<string, string | number>>;
  readonly note: string;
}

/**
 * A CSV whose first line is the column labels (first cell is the row axis
 * name) and whose other lines are `row value, cell, cell, …`. "NA", "—" and
 * empty cells become null.
 */
export function proposeCodeTableFromCsv(csv: string, meta: CsvTableMeta, via: "csv" | "vision" = "csv", uncertain: ReadonlyArray<readonly [number, number]> = []): CodeTableProposal | { readonly error: string } {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const [header, ...body] = lines;
  if (!header || body.length === 0) return { error: "The CSV needs a header line of column labels and at least one row." };
  const split = (l: string) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, "").trim());
  const labels = split(header).slice(1);
  const rows: number[] = [];
  const cells: (number | null)[][] = [];
  const issues: CodeTableIssue[] = [];
  body.forEach((line, i) => {
    const c = split(line);
    const rv = Number((c[0] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(rv)) {
      issues.push({ row: i, column: null, message: `Row ${i + 1} doesn't start with a number ("${c[0] ?? ""}")` });
      return;
    }
    rows.push(rv);
    const vals = c.slice(1).map((s) => {
      const t = s.replace(/,/g, "");
      if (t === "" || /^(NA|—|-)$/i.test(t)) return null;
      const v = Number(t);
      return Number.isFinite(v) ? v : null;
    });
    if (vals.length !== labels.length) issues.push({ row: i, column: null, message: `Row ${i + 1} has ${vals.length} cells; the header has ${labels.length} columns` });
    cells.push(vals);
  });
  const columnValues = labels.map((l) => {
    const v = Number(l.replace(/[^\d.]/g, ""));
    return l.trim() !== "" && Number.isFinite(v) ? v : null;
  });
  const table: CodeTable = {
    code: meta.code,
    edition: meta.edition,
    tableId: meta.tableId,
    title: meta.title,
    source: { kind: "proposal", note: meta.note, instrument: null },
    rows: { name: meta.rowName, unit: meta.rowUnit, values: rows },
    columns: { name: meta.columnName, unit: meta.columnUnit, labels, values: columnValues },
    cells,
    cellUnit: meta.cellUnit,
    meta: meta.meta ?? {},
    issues: [],
  };
  return { kind: "code_table_proposal", via, table, uncertain, issues, needsReview: true };
}

/** The engineer accepted the proposal: it becomes the firm's table (source kind firm_import), stamped with who and when. */
export function acceptCodeTableProposal(proposal: CodeTableProposal, acceptedBy: string, acceptedAt: string): CodeTable {
  return { ...proposal.table, source: { kind: "firm_import", note: `${proposal.table.source.note}; accepted by ${acceptedBy} on ${acceptedAt}`, instrument: null }, issues: proposal.issues };
}

/**
 * A gas capacity table proposal in the library's own row shape (header lines
 * then `length|cap|cap…`), the same parser the code library uses, so an
 * imported 402.4(n) is checked exactly like a library one.
 */
export function proposeGasTableFromRows(instrument: CodeInstrument, citation: string, heading: string, text: string): { ok: true; table: GasCapacityTable; issues: readonly CodeTableIssue[] } | { ok: false; reason: string } {
  const parsed = parseGasCapacityTable({ instrument, citation, heading, text, source: "proposal" });
  if (!parsed.ok) return parsed;
  return { ok: true, table: parsed.table, issues: checkCapacityOrder(parsed.table.rows.values, parsed.table.cells) };
}
