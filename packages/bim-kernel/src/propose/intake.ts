import { defineExtensionPoint } from "../packs/contract";
import type { PackRefusal } from "../packs/points";
import { activePackSet } from "../packs/scope";

/**
 * Picture and cut-sheet intake (contract 1.10.0). A host reads a picture or
 * a document page into table cells (`TableReader`: in a host app, for example an AI model
 * through the gateway; standalone, any reader). The kernel maps cells to
 * planned rows deterministically through registered columns
 * (`INTAKE_COLUMN_POINT`: each add-on's fields, by the headings a schedule
 * prints them under), keeps columns it doesn't know as text, never guesses,
 * and leaves unsure cells unticked. Accepting is one ordinary edit through
 * the proposer path.
 */

/** Where a cell sits on its page, as fractions of the page (0..1 from the top left). */
export interface CellBox {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TableReadCell {
  readonly row: number;
  readonly column: number;
  readonly text: string;
  /** How sure the reader is, 0..1. */
  readonly confidence: number;
  readonly box?: CellBox;
}

export interface TableReadPage {
  readonly index: number;
  /** What the page is called on the document ("Sheet K-1"), when the reader saw it. */
  readonly label?: string;
}

export interface TableReadResult {
  readonly source: { readonly name: string; readonly kind: "image" | "document" };
  readonly pages: readonly TableReadPage[];
  readonly cells: readonly TableReadCell[];
  /** The row the reader takes for the headings, or null when it found none. */
  readonly headerRow: number | null;
  /** What the reader wants a person to know ("Page 3 is too blurry to read"). */
  readonly notes: readonly string[];
}

export interface TableReadInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name: string;
  /** What the person said it is ("kitchen equipment schedule"). */
  readonly hint?: string;
}

/** The host's reader. Progress is reported per page ("Reading page 2 of 4"). */
export interface TableReader {
  read(input: TableReadInput, progress?: (at: { readonly page: number; readonly pages: number }) => void): Promise<TableReadResult | PackRefusal>;
}

/** One column an add-on reads into a field, by the headings schedules print it under. */
export interface IntakeColumnRow {
  /** `<pack>.<name>`. */
  readonly id: string;
  /** What a person calls it ("Rated input"). */
  readonly label: string;
  /** Headings that mean this column, compared case- and space-insensitively ("VOLTS", "V"). */
  readonly headings: readonly string[];
  /** The field it fills on a planned row (a parameter or facet key). */
  readonly field: string;
  /** The unit its values are written in on the row (a `bim-units` code); absent: text. */
  readonly unit?: string;
  /** Read one cell; null when the text isn't a value of this column (the cell is then unsure). Absent: numbers as numbers, else text. */
  parse?(text: string): number | string | null;
}

export const INTAKE_COLUMN_POINT = defineExtensionPoint<IntakeColumnRow>({
  id: "kernel.intake_column",
  version: 1,
  label: "Picture intake columns",
  idOf: (row) => row.id,
});

/** Problems with intake column rows (pack conformance), in words. */
export function intakeColumnRowProblems(rows: readonly IntakeColumnRow[]): string[] {
  const out: string[] = [];
  const headings = new Map<string, string>();
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`intake column ${row.id} has no label`);
    if (row.headings.length === 0) out.push(`intake column ${row.id} lists no heading`);
    if (row.field.trim().length === 0) out.push(`intake column ${row.id}: say which field it fills`);
    if (row.parse !== undefined && typeof row.parse !== "function") out.push(`intake column ${row.id}: parse must be a function`);
    for (const h of row.headings) {
      const key = intakeHeadingKey(h);
      const other = headings.get(key);
      if (other !== undefined && other !== row.id) out.push(`intake column ${row.id}: heading "${h}" is already ${other}'s`);
      headings.set(key, row.id);
    }
  }
  return out;
}

/** How headings compare: letters and digits only, upper case ("Rated  Input (kW)" → "RATEDINPUTKW"). */
export function intakeHeadingKey(heading: string): string {
  return heading.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

export function intakeColumns(): readonly IntakeColumnRow[] {
  return activePackSet().items(INTAKE_COLUMN_POINT);
}

export interface IntakeRowCell {
  readonly column: number;
  readonly heading: string;
  /** The field it fills, or null for a column no add-on reads (kept as text). */
  readonly field: string | null;
  readonly text: string;
  readonly value: number | string | null;
  readonly confidence: number;
  /** False: shown unticked with "check this". */
  readonly sure: boolean;
  readonly box?: CellBox;
}

export interface IntakePlannedRow {
  /** Stable within one proposal (`p<page>r<row>`). */
  readonly key: string;
  readonly page: number;
  readonly cells: readonly IntakeRowCell[];
  /** Field → value, from the sure cells only. */
  readonly values: Readonly<Record<string, number | string>>;
  /** Every cell is sure: ticked by default. */
  readonly sure: boolean;
}

export interface IntakeProposal {
  readonly source: TableReadResult["source"];
  readonly columns: readonly { readonly index: number; readonly heading: string; readonly field: string | null }[];
  readonly rows: readonly IntakePlannedRow[];
  /** Cells below this confidence are unsure. */
  readonly threshold: number;
  readonly notes: readonly string[];
}

export interface IntakeMappingOptions {
  /** Default 0.8. */
  readonly threshold?: number;
}

export const DEFAULT_INTAKE_THRESHOLD = 0.8;

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/** A cell's text as a number when it is one ("1,200", "4.5"), else null. Units and words are never stripped: "4.5 kW" is not a number here (a column's own `parse` may read it). */
export function intakeNumber(text: string): number | null {
  const t = text.trim();
  if (!NUMBER.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function readCell(row: IntakeColumnRow | null, text: string): number | string | null {
  if (text.trim() === "") return null;
  if (!row) return text.trim();
  if (row.parse) {
    try {
      return row.parse(text);
    } catch (err) {
      console.error("[bim-kernel/intake] a column's parse threw; the cell reads as unsure", { column: row.id, err });
      return null;
    }
  }
  const n = intakeNumber(text);
  if (row.unit !== undefined) return n;
  return n ?? text.trim();
}

/**
 * Map read cells to planned rows, deterministically: the same cells give the
 * same proposal. A heading matches a registered column only when its letters
 * and digits equal one of that column's headings (never a near match); a
 * column no add-on reads is kept as text with no field. A cell is unsure
 * (unticked, "check this") when the reader was below the threshold or the
 * text isn't a value of its column; a row is ticked only when every cell is
 * sure. A page that repeats the heading row doesn't make a row of it.
 */
export function proposeIntakeRows(read: TableReadResult, options: IntakeMappingOptions = {}): IntakeProposal | PackRefusal {
  const threshold = options.threshold ?? DEFAULT_INTAKE_THRESHOLD;
  if (read.cells.length === 0) return { refused: read.notes[0] ?? "No table was found in this picture. Try a picture that shows the whole schedule." };
  if (read.headerRow === null) return { refused: "No heading row was found, so the columns can't be matched. Try a picture that shows the schedule's headings." };
  const byKey = new Map<string, IntakeColumnRow>();
  for (const row of intakeColumns()) for (const h of row.headings) if (!byKey.has(intakeHeadingKey(h))) byKey.set(intakeHeadingKey(h), row);

  const headings = new Map<number, string>();
  for (const c of read.cells) if (c.row === read.headerRow) headings.set(c.column, c.text.trim());
  const usedFields = new Set<string>();
  const notes = [...read.notes];
  const columns: { index: number; heading: string; field: string | null; row: IntakeColumnRow | null }[] = [];
  for (const index of [...headings.keys()].sort((a, b) => a - b)) {
    const heading = headings.get(index) ?? "";
    let row = byKey.get(intakeHeadingKey(heading)) ?? null;
    if (row && usedFields.has(row.field)) {
      notes.push(`Two columns read as ${row.label}; "${heading}" is kept as text.`);
      row = null;
    }
    if (row) usedFields.add(row.field);
    columns.push({ index, heading, field: row?.field ?? null, row });
  }
  const headerKeys = columns.map((c) => intakeHeadingKey(c.heading));

  const rowsByIndex = new Map<number, TableReadCell[]>();
  for (const c of read.cells) {
    if (c.row === read.headerRow) continue;
    let list = rowsByIndex.get(c.row);
    if (!list) rowsByIndex.set(c.row, (list = []));
    list.push(c);
  }
  const firstPage = read.pages[0]?.index ?? 0;
  const rows: IntakePlannedRow[] = [];
  for (const r of [...rowsByIndex.keys()].sort((a, b) => a - b)) {
    const cells = (rowsByIndex.get(r) ?? []).slice().sort((a, b) => a.column - b.column);
    if (cells.every((c) => c.text.trim() === "")) continue;
    const repeatsHeading = cells.length > 0 && cells.every((c) => headerKeys[columns.findIndex((col) => col.index === c.column)] === intakeHeadingKey(c.text));
    if (repeatsHeading) continue;
    const page = cells.find((c) => c.box)?.box?.page ?? firstPage;
    const out: IntakeRowCell[] = [];
    const values: Record<string, number | string> = {};
    for (const col of columns) {
      const cell = cells.find((c) => c.column === col.index);
      const text = cell?.text ?? "";
      if (text.trim() === "") continue;
      const value = readCell(col.row, text);
      const confidence = cell?.confidence ?? 0;
      const sure = confidence >= threshold && value !== null;
      out.push({ column: col.index, heading: col.heading, field: col.field, text, value, confidence, sure, ...(cell?.box ? { box: cell.box } : {}) });
      if (sure && col.field !== null && value !== null) values[col.field] = value;
    }
    for (const cell of cells) {
      if (headings.has(cell.column) || cell.text.trim() === "") continue;
      out.push({ column: cell.column, heading: "", field: null, text: cell.text, value: cell.text.trim(), confidence: cell.confidence, sure: cell.confidence >= threshold, ...(cell.box ? { box: cell.box } : {}) });
    }
    out.sort((a, b) => a.column - b.column);
    rows.push({ key: `p${page}r${r}`, page, cells: out, values, sure: out.every((c) => c.sure) });
  }
  return { source: read.source, columns: columns.map(({ index, heading, field }) => ({ index, heading, field })), rows, threshold, notes };
}

export interface IntakePlanOptions {
  /** The part type the person picked for the rows (rows are planned, not drawn). */
  readonly typeId: string;
  /** Which field is the mark ("K-1"); default `mark`. */
  readonly markField?: string;
  /** A stable part id per row key, so a retried accept plans the same parts. */
  partIdFor(rowKey: string): string;
}

/** One planned row as the `plan_part` command takes it (the host sends them as one edit, one undo step). */
export interface IntakePlanCommand {
  readonly type: "plan_part";
  readonly partId: string;
  readonly typeId: string;
  readonly mark?: string;
  readonly values?: Readonly<Record<string, number | string>>;
  readonly note: string;
}

/** The `plan_part` commands for the ticked rows, in row order. A row's unsure cells never reach the model. */
export function intakePlanCommands(proposal: IntakeProposal, ticked: ReadonlySet<string>, options: IntakePlanOptions): IntakePlanCommand[] {
  const markField = options.markField ?? "mark";
  const out: IntakePlanCommand[] = [];
  for (const row of proposal.rows) {
    if (!ticked.has(row.key)) continue;
    const { [markField]: mark, ...rest } = row.values;
    const page = proposal.source.kind === "document" ? `, page ${row.page + 1}` : "";
    out.push({
      type: "plan_part",
      partId: options.partIdFor(row.key),
      typeId: options.typeId,
      ...(mark !== undefined ? { mark: String(mark).slice(0, 40) } : {}),
      ...(Object.keys(rest).length > 0 ? { values: rest } : {}),
      note: `Read from ${proposal.source.name}${page}`.slice(0, 200),
    });
  }
  return out;
}
