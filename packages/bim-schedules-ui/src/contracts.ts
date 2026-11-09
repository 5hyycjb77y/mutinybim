/**
 * Schedule contracts the UI codes against (SCHEDULES-PLAN §5a, §5b, §6).
 *
 * Stream E owns the row engine (`RowSet`, `RowPatch`, `ScheduleDefinitionV2`)
 * and Stream G owns the wire protocol and the client connection. Until they
 * land, these are the UI's copy of the plan's shapes, served by the in-memory
 * mock in `./mock`. When E and G merge, this file becomes re-exports of their
 * types and any drift shows up as a compile error here, not in the grid.
 */

import type { Kind, Measure, Precision, UnitCode } from "@permitzip/bim-units";

export type RowKey = string;
export type ColumnId = string;
export type ElementId = string;

// ---------------------------------------------------------------- definition (E, §5a)

export type ColumnKind = "field" | "formula" | "aggregate" | "expand" | "parameter";
export type ValueType = "quantity" | "text" | "boolean" | "choice";
export type ExpandPaper = "nested" | "summary" | "hidden";
export type AggregateFn = "sum" | "count" | "min" | "max" | "avg" | "list";

interface ColumnDefBase {
  readonly id: ColumnId;
  /** Absent: the field's label. */
  readonly heading?: string;
  /** Overrides the profile for this column. */
  readonly unit?: UnitCode;
  readonly precision?: Precision;
  readonly total?: boolean;
  readonly hideWhenEmpty?: boolean;
  readonly width?: number;
}

export type ScheduleColumnDef =
  | (ColumnDefBase & { readonly kind: "field"; readonly path: string })
  | (ColumnDefBase & { readonly kind: "parameter"; readonly path: string })
  | (ColumnDefBase & { readonly kind: "formula"; readonly expression: string; readonly calculation?: string })
  | (ColumnDefBase & { readonly kind: "aggregate"; readonly fn: AggregateFn; readonly relationship: string; readonly path?: string })
  | (ColumnDefBase & { readonly kind: "expand"; readonly relationship: string; readonly columns: readonly string[]; readonly paper: ExpandPaper });

export type ScheduleSource =
  | { readonly kind: "classes"; readonly classes: readonly string[]; readonly includeSubclasses: boolean }
  | { readonly kind: "related"; readonly from: ElementId; readonly relationship: string; readonly depth?: number }
  | { readonly kind: "catalog"; readonly catalog: string };

export type FilterOp = "equals" | "not_equals" | "contains" | "greater_than" | "less_than" | "present" | "absent";

export interface ScheduleFilter {
  readonly path: string;
  readonly op: FilterOp;
  readonly value?: string;
}

export interface ScheduleSort {
  readonly path: string;
  readonly direction: "asc" | "desc";
}

export interface ScheduleGroup {
  readonly path: string;
  readonly header: boolean;
  readonly footer: boolean;
  readonly totals: boolean;
}

export interface ScheduleDefinitionV2 {
  readonly name: string;
  readonly source: ScheduleSource;
  readonly columns: readonly ScheduleColumnDef[];
  readonly filters: readonly ScheduleFilter[];
  readonly sort: readonly ScheduleSort[];
  readonly groups: readonly ScheduleGroup[];
  readonly grandTotals: boolean;
  readonly itemize: boolean;
  readonly presentation: { readonly kind: "list" } | { readonly kind: "form"; readonly template: string };
  readonly display: { readonly profile?: string; readonly textSizeMm: number; readonly emptyText: string };
}

/**
 * One column-by-column change, the kernel's `edit_schedule` step (the same
 * shape the agent's schedule tool and a script's `documents.editSchedule`
 * send). The host sends each as one undo step.
 */
export type ScheduleColumnStep =
  | { readonly op: "add_column"; readonly column: ScheduleColumnDef; readonly at?: number }
  | { readonly op: "move_column"; readonly columnId: ColumnId; readonly to: number }
  | { readonly op: "remove_column"; readonly columnId: ColumnId }
  | { readonly op: "rename_column"; readonly columnId: ColumnId; readonly heading: string | null }
  | { readonly op: "filter"; readonly filters: readonly ScheduleFilter[] }
  | { readonly op: "sort"; readonly sort: readonly ScheduleSort[] }
  | { readonly op: "group"; readonly groups: readonly ScheduleGroup[] }
  | { readonly op: "totals"; readonly columnId?: ColumnId; readonly show: boolean }
  /** A column's paper width, mm (dragged where the schedule sits on a sheet); null sizes it to its text again. */
  | { readonly op: "resize_column"; readonly columnId: ColumnId; readonly widthMm: number | null };

// ---------------------------------------------------------------- rows (E, §6)

/** How a cell's value gets back into the model (§4 `writer`). `null` on a column: locked. */
export interface ColumnWriter {
  /** `type`: one edit changes every part of that type (asks first, D2). */
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
  readonly kind: ColumnKind;
  readonly valueType: ValueType;
  readonly quantityKind?: Kind;
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
 * One column of values for every row (same layout as bim-formula's
 * `ValueColumn`, so a formula column result drops straight in).
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

export interface RowSet {
  readonly viewId: string;
  readonly revision: number;
  readonly columns: readonly RowSetColumn[];
  readonly rowCount: number;
  readonly rowKeys: readonly RowKey[];
  readonly elementIds: readonly ElementId[];
  readonly values: ReadonlyMap<ColumnId, ColumnValues>;
  /** `expand` sub-tables: column → parent row → child rows. */
  readonly children: ReadonlyMap<ColumnId, ReadonlyMap<RowKey, RowSet>>;
  readonly highlights?: ReadonlyMap<ColumnId, ReadonlyMap<RowKey, RowHighlight>>;
  readonly totals?: ReadonlyMap<ColumnId, Measure | null>;
}

/** A single cell value on the wire: SI number for quantities. */
export type CellValue = number | string | boolean | null;

export interface RowUpsert {
  readonly rowKey: RowKey;
  readonly elementId: ElementId;
  readonly values: Readonly<Record<ColumnId, CellValue>>;
  readonly children?: Readonly<Record<ColumnId, RowSet>>;
}

/** Incremental change to an open schedule. Applying it equals rebuilding (E's property test). */
export interface RowPatch {
  readonly viewId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly upserts: readonly RowUpsert[];
  readonly removes: readonly RowKey[];
  /** Present when sort or grouping moved rows: the full new order. */
  readonly order?: readonly RowKey[];
  readonly totals?: Readonly<Record<ColumnId, Measure | null>>;
}

// ---------------------------------------------------------------- protocol (G, §6)

export interface ScheduleWindow {
  readonly offset: number;
  readonly limit: number;
}

export type ScheduleTarget = { readonly viewId: string } | { readonly definition: ScheduleDefinitionV2 };

export interface ActorRef {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export type ScheduleClientMessage =
  | { readonly type: "schedule_open"; readonly subscriptionId: string; readonly target: ScheduleTarget; readonly window: ScheduleWindow }
  | { readonly type: "schedule_window"; readonly subscriptionId: string; readonly window: ScheduleWindow }
  | { readonly type: "schedule_close"; readonly subscriptionId: string }
  | { readonly type: "editing_cell"; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId; readonly ttlMs: number }
  | { readonly type: "editing_cell_release"; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId };

export type ScheduleClosedReason = "denied" | "deleted" | "closed";

export type ScheduleServerMessage =
  | { readonly type: "schedule_rows"; readonly subscriptionId: string; readonly window: ScheduleWindow; readonly total: number; readonly rows: RowSet }
  | { readonly type: "schedule_patch"; readonly subscriptionId: string; readonly patch: RowPatch }
  | { readonly type: "schedule_closed"; readonly subscriptionId: string; readonly reason: ScheduleClosedReason; readonly message: string }
  | { readonly type: "editing_cell"; readonly actor: ActorRef; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId; readonly expiresAt: number }
  | { readonly type: "editing_cell_release"; readonly actor: ActorRef; readonly viewId: string; readonly rowKey: RowKey; readonly columnId: ColumnId };

/** Cell hold TTL ceiling (§6, D7): a second person's edit waits at most this long. */
export const EDITING_CELL_MAX_TTL_MS = 8_000;

// ---------------------------------------------------------------- client connection (G's client side)

export interface CellRef {
  readonly rowKey: RowKey;
  readonly columnId: ColumnId;
  /** Set for a child row of an `expand` column. */
  readonly parent?: { readonly rowKey: RowKey; readonly columnId: ColumnId };
}

export interface CellEdit extends CellRef {
  readonly value: CellValue;
}

export interface CellEditBatch {
  readonly source: "type" | "paste" | "fill_down" | "clear";
  readonly edits: readonly CellEdit[];
}

/** What a batch would touch beyond its own rows: the type-scope blast radius (D2). */
export interface TypeScopeImpact {
  readonly typeLabel: string;
  readonly instanceCount: number;
  readonly columnHeading: string;
}

export interface EditPreview {
  readonly typeScope: readonly TypeScopeImpact[];
  readonly refusals: readonly (CellRef & { readonly reason: string })[];
}

export type EditOutcome =
  | { readonly ok: true; readonly revision: number; readonly refusals: readonly (CellRef & { readonly reason: string })[] }
  | { readonly ok: false; readonly message: string };

export interface EditingPresence extends CellRef {
  readonly actor: ActorRef;
  readonly expiresAt: number;
}

export type ScheduleEvent =
  | { readonly type: "rows"; readonly rows: RowSet }
  | { readonly type: "patch"; readonly patch: RowPatch }
  | { readonly type: "closed"; readonly reason: ScheduleClosedReason; readonly message: string }
  | { readonly type: "presence"; readonly editing: readonly EditingPresence[] }
  | { readonly type: "connection"; readonly state: "connected" | "reconnecting" };

export interface ScheduleSubscription {
  close(): void;
  requestWindow(window: ScheduleWindow): void;
  preview(batch: CellEditBatch): Promise<EditPreview>;
  edit(batch: CellEditBatch): Promise<EditOutcome>;
  /** This person started or stopped editing a cell (`editing_cell`). */
  setEditingCell(cell: CellRef | null): void;
  /** The substituted expression for a locked cell ("199 MBH × 1000 = 199,000 Btu/h"). */
  explain(cell: CellRef): Promise<string | null>;
  undo(): void;
  redo(): void;
}

export interface ScheduleConnection {
  readonly actor: ActorRef;
  open(target: ScheduleTarget, listener: (event: ScheduleEvent) => void): ScheduleSubscription;
}
