import type { Kind, Measure, Precision, UnitCode } from "@permitzip/bim-units";
import type { ModelState } from "../../types";
import type { ScheduleColumnKind } from "../definition";

/**
 * The row engine's public contract (SCHEDULES-PLAN §6, milestone M1).
 *
 * A `RowSet` is columnar: one typed array per column (quantities in canonical
 * SI, the same layout as `@permitzip/bim-formula`'s `ValueColumn`, so a
 * formula result drops straight in), with stable row keys and the element
 * behind each row. A `RowPatch` is what one model change does to an open
 * schedule: applying it to the previous `RowSet` (`applyRowPatch`) equals
 * building the schedule again on the new model.
 *
 * The grid (`@permitzip/bim-schedules-ui`), the sync protocol
 * (`@permitzip/bim-sync`) and the authority bind to these types.
 */

export type RowKey = string;
export type ColumnId = string;

export type ValueType = "quantity" | "text" | "boolean" | "choice";

/** How a cell's value gets back into the model (§4 `writer`). `null` on a column: locked. */
export interface ColumnWriter {
  /** `type`: one edit changes every part of that type (the grid asks first, D2). */
  readonly scope: "instance" | "type";
}

/** Where a locked value comes from, for "Go to source" (D3). */
export interface ColumnSourceRef {
  readonly kind: "formula" | "calculation" | "relationship" | "field";
  /** As a person reads it: "PZ.GasDemandBtuh", "Serves", "Panel". */
  readonly label: string;
  /** Formula text, library key, relationship id or field path. */
  readonly target: string;
}

export interface RowSetColumn {
  readonly id: ColumnId;
  readonly heading: string;
  readonly kind: ScheduleColumnKind;
  readonly valueType: ValueType;
  readonly quantityKind?: Kind;
  /** Display unit (values stay SI). */
  readonly unit?: UnitCode;
  readonly precision?: Precision;
  readonly choices?: readonly string[];
  readonly writer: ColumnWriter | null;
  /** Plain reason a locked column can't be typed in. */
  readonly lockedReason?: string;
  readonly source?: ColumnSourceRef;
  readonly width?: number;
  /** For a sub-table column: the parent column its values sit under. Absent: the next free column. */
  readonly under?: ColumnId;
  /** For `expand` columns: the sub-table's own columns. */
  readonly childColumns?: readonly RowSetColumn[];
  /** For `expand` columns: the sub-list label, e.g. "Serves". */
  readonly expandLabel?: string;
}

/**
 * One column of values for every row.
 * quantity: canonical SI, NaN empty. boolean: 1, 0, −1 empty. text/choice: null empty.
 */
export type ColumnValues =
  | { readonly type: "quantity"; readonly kind: Kind; readonly values: Float64Array }
  | { readonly type: "boolean"; readonly values: Int8Array }
  | { readonly type: "text"; readonly values: readonly (string | null)[] };

export interface RowHighlight {
  readonly tone: "warning" | "danger";
  readonly reason: string;
}

/** A run of consecutive rows sharing the values of the definition's `groups` paths. */
export interface RowGroup {
  /** Stable across revisions while the grouping values hold. */
  readonly key: string;
  /** Nesting depth, 0 for the first group path. */
  readonly depth: number;
  /** The group's value as it prints, e.g. "LEVEL 2". */
  readonly label: string;
  /** First row index and row count. */
  readonly start: number;
  readonly count: number;
  /** Footer totals for columns with `total`, when the group asks for totals. */
  readonly totals?: Readonly<Record<ColumnId, Measure | null>>;
}

export interface RowSet {
  readonly viewId: string;
  readonly revision: number;
  readonly columns: readonly RowSetColumn[];
  readonly rowCount: number;
  readonly rowKeys: readonly RowKey[];
  /** The element behind each row (the first one, for a combined row; see `rowElementIds`). */
  readonly elementIds: readonly string[];
  readonly values: ReadonlyMap<ColumnId, ColumnValues>;
  /** `expand` sub-tables: column → parent row → child rows. */
  readonly children: ReadonlyMap<ColumnId, ReadonlyMap<RowKey, RowSet>>;
  readonly highlights?: ReadonlyMap<ColumnId, ReadonlyMap<RowKey, RowHighlight>>;
  /** Grand totals for columns with `total`, when the definition asks for them. */
  readonly totals?: ReadonlyMap<ColumnId, Measure | null>;
  /** Group headers and footers, in row order. Absent: the definition has no groups. */
  readonly groups?: readonly RowGroup[];
  /** Combined rows (itemize off): every element behind each row. Absent: one element per row. */
  readonly rowElementIds?: readonly (readonly string[])[];
  /** Present on a window (`ScheduleSession.window`): where these rows start and how many the schedule has. Group starts stay schedule-wide. */
  readonly window?: { readonly offset: number; readonly totalRows: number };
}

/** A single cell value on the wire: SI number for quantities. */
export type CellValue = number | string | boolean | null;

export interface RowUpsert {
  readonly rowKey: RowKey;
  readonly elementId: string;
  readonly values: Readonly<Record<ColumnId, CellValue>>;
  readonly children?: Readonly<Record<ColumnId, RowSet>>;
  readonly highlights?: Readonly<Record<ColumnId, RowHighlight | null>>;
  readonly elementIds?: readonly string[];
}

/** Incremental change to an open schedule. Applying it equals rebuilding (the engine's property test). */
export interface RowPatch {
  readonly viewId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly upserts: readonly RowUpsert[];
  readonly removes: readonly RowKey[];
  /** Present when rows were added, removed or moved: the full new order. */
  readonly order?: readonly RowKey[];
  readonly totals?: Readonly<Record<ColumnId, Measure | null>>;
  /** Present when any group changed: the full new list. */
  readonly groups?: readonly RowGroup[];
}

/**
 * What one model change touched, as the engine needs it. Build it from a
 * committed changeset with `scheduleChangeFromChangeset`.
 */
export interface ScheduleChange {
  /** The model after the change. */
  readonly model: Pick<ModelState, "elements" | "connections">;
  readonly revision: number;
  /** Elements created or modified. */
  readonly changedIds: readonly string[];
  readonly removedIds?: readonly string[];
  /** Elements at either end of a connection the change made or cut. */
  readonly connectionEndpoints?: readonly string[];
}

/** Plain-words problems with a definition; building refuses the whole definition when there are any. */
export type ScheduleProblemCode =
  | "unknown_class"
  | "unknown_field"
  | "unknown_relationship"
  | "formula"
  | "total_refused"
  | "duplicate_column"
  | "unsupported_source"
  /** A library calculation the schedule uses isn't pinned in the model, or its pinned copy can't be read. */
  | "pin"
  /** A column's display unit doesn't measure what the column holds. */
  | "unit";

export interface ScheduleProblem {
  readonly code: ScheduleProblemCode;
  readonly message: string;
  readonly columnId?: ColumnId;
}
