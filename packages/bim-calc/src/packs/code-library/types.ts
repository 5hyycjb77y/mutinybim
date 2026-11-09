/**
 * Code tables as data, whatever their origin: PermitZIP's code library (the
 * adopted Virginia text in the host's code library), a firm's
 * one-time import of its adopted tables, or a CSV / vision proposal waiting
 * for an engineer to accept it. Calcs read `CodeTable`s and never care which.
 */

/** The instrument a library section belongs to (a row of `codes.instruments`). */
export interface CodeInstrument {
  /** "va_vfgc" */
  readonly slug: string;
  /** "VFGC" */
  readonly shortName: string;
  /** "VA" */
  readonly jurisdiction: string;
  /** "2021" */
  readonly edition: string;
  /** "2021 IFGC" */
  readonly baseModelCode: string;
}

/** One table section as the library (or a firm import) holds it: citation, heading and the row text. */
export interface CodeLibrarySection {
  readonly instrument: CodeInstrument;
  /** "TABLE 402.4(28)" */
  readonly citation: string;
  readonly heading: string;
  /** Row text: one row per line, cells separated by tabs (library) or "|" (bundled snapshot). */
  readonly text: string;
  readonly source: CodeTableSourceKind;
}

export type CodeTableSourceKind = "code_library" | "firm_import" | "proposal";

/** A finding about a table's own data (a cell out of order), reported, never silently corrected. */
export interface CodeTableIssue {
  readonly row: number | null;
  readonly column: number | null;
  readonly message: string;
}

/**
 * The firm/project table record (`firm_code_table`): which code and edition,
 * which table, its two axes, and the cells. Row axis is numeric (length,
 * fixture units); columns are labelled (sizes) with an optional numeric value.
 */
export interface CodeTable {
  /** "VFGC", "IFGC", "VPC", "IPC" */
  readonly code: string;
  readonly edition: string;
  /** "Table 402.4(28)" */
  readonly tableId: string;
  readonly title: string;
  readonly source: { readonly kind: CodeTableSourceKind; readonly note: string; readonly instrument: string | null };
  readonly rows: { readonly name: string; readonly unit: string; readonly values: readonly number[] };
  readonly columns: { readonly name: string; readonly unit: string; readonly labels: readonly string[]; readonly values: readonly (number | null)[] };
  /** `cells[row][column]`; null where the table prints NA or a dash. */
  readonly cells: ReadonlyArray<ReadonlyArray<number | null>>;
  readonly cellUnit: string;
  /** Header values that qualify the table (gas, inlet pressure, drop, specific gravity). */
  readonly meta: Readonly<Record<string, string | number>>;
  readonly issues: readonly CodeTableIssue[];
}
