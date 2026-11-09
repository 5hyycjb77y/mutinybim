import type { ElementId } from "../types";
import type { DesignLimitSelector } from "../policy/design-limits";

/**
 * Live calculation sheets (contract 1.10.0). A sheet is a worked calculation
 * placed on a drawing sheet or in a report: inputs bound to the model, table
 * lookups with the cell that decided the answer marked, steps, checks against
 * the firm's design limits, citations in our own words, and a result. It
 * re-runs only when an input it read changed, and freezes with an issued set.
 *
 * Any discipline uses the same shape: a pipe sizing table, a beam check, a
 * hydraulic calculation, an owner's pro forma line.
 */

/** Where an input's value comes from. */
export type CalcInputBinding =
  /** A model field read by token path, as field blocks read them (`<subject>.<field>`). */
  | { readonly from: "field"; readonly subjectId?: ElementId; readonly path: string }
  /** A number the person typed on the sheet. */
  | { readonly from: "typed"; readonly value: number }
  /** Another sheet's result (a chain of sheets). */
  | { readonly from: "sheet"; readonly sheetId: string; readonly key: string };

export interface CalcSheetInput {
  readonly key: string;
  readonly label: string;
  /** A `bim-units` unit code ("ft", "psi"). */
  readonly unit: string;
  readonly bind: CalcInputBinding;
}

/** Which row or column of a table a value picks. `next_up`: the first heading at or above it (sizing tables read up). */
export type CalcLookupMatch = "exact" | "next_up" | "next_down" | "nearest";

export interface CalcSheetLookup {
  readonly key: string;
  readonly label: string;
  /** The table, by the slot the firm or project fills (a library table item), never table text in the add-on. */
  readonly table: { readonly slot: string };
  readonly row: { readonly input: string; readonly match: CalcLookupMatch };
  /**
   * `by` (S12, additive): `"heading"` (default) picks the column by its
   * heading; `"value"` searches the picked row's cells for the input (a
   * sizing table read across: the first capacity at or above the load), so
   * the column heading is the answer. Either way `<key>_row` and
   * `<key>_column` hold the governing headings as numbers.
   */
  readonly column: { readonly input: string; readonly match: CalcLookupMatch; readonly by?: "heading" | "value" };
  readonly unit: string;
}

export interface CalcSheetStep {
  readonly key: string;
  readonly label: string;
  /**
   * A `@permitzip/bim-formula` expression over input, lookup and earlier step
   * keys written as `{key}` ("{load} / {capacity}"). A sheet works in the
   * units each line is written in, as a hand calculation does: every value
   * enters as a number in its line's unit and the result is in the step's
   * unit. Conversion happens at the edges (a check converts to its limit's unit).
   */
  readonly formula: string;
  readonly unit: string;
}

export interface CalcSheetCheck {
  readonly key: string;
  readonly label: string;
  /** The input, lookup or step key compared. */
  readonly value: string;
  /** Which design limit applies (resolved project → firm → add-on default). */
  readonly limit: DesignLimitSelector;
}

/** A reference in our own words: a section label and an edition label, never the code book's text. */
export interface CalcSheetCitation {
  readonly section: string;
  readonly edition?: string;
  readonly note?: string;
}

export interface CalcSheetSpec {
  /** The template that built it (`CALC_SHEET_POINT` id). */
  readonly template: string;
  readonly title: string;
  readonly inputs: readonly CalcSheetInput[];
  readonly lookups: readonly CalcSheetLookup[];
  readonly steps: readonly CalcSheetStep[];
  readonly checks: readonly CalcSheetCheck[];
  readonly citations: readonly CalcSheetCitation[];
  /** Which key is the answer, and what a person calls it. */
  readonly result: { readonly key: string; readonly label: string };
}

/** A lookup table a firm or project keeps (a library table item), as the sheet reads it. */
export interface CalcTable {
  readonly id: string;
  readonly label: string;
  readonly rowHeading: { readonly label: string; readonly unit: string };
  readonly columnHeading: { readonly label: string; readonly unit: string };
  readonly rows: readonly number[];
  /** Column headings; text when a column is a named size ("1-1/4"). */
  readonly columns: readonly (number | string)[];
  /** `values[row][column]`; null where the table has no value. */
  readonly values: readonly (readonly (number | null)[])[];
  readonly citation?: CalcSheetCitation;
}

/** Where a sheet finds the tables its lookups name (the host reads library items; a test passes them in). */
export interface CalcTableSource {
  table(slot: string): CalcTable | null;
}

/** The cell that decided a lookup: marked on the sheet by label and colour. */
export interface GoverningCell {
  readonly lookup: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowLabel: string;
  readonly columnLabel: string;
  readonly value: number;
  readonly unit: string;
}

export interface CalcCheckResult {
  readonly key: string;
  /** null: the check couldn't run (no limit set, an input missing); `message` says what to add. */
  readonly pass: boolean | null;
  readonly limitId?: string;
  /** "Velocity 9.2 ft/s over the firm's 8 ft/s". */
  readonly message: string;
}

export interface CalcSheetEvaluation {
  /** Every input, lookup and step value by key; null when it couldn't be worked out. */
  readonly values: Readonly<Record<string, number | null>>;
  readonly governing: readonly GoverningCell[];
  readonly checks: readonly CalcCheckResult[];
  /** What the sheet needs before it can finish, in words ("Add a sizing table"). */
  readonly missing: readonly string[];
  /** Every element whose change re-runs the sheet. */
  readonly dependsOn: readonly ElementId[];
}
