/**
 * Public contract of the grid. The grid is generic: it draws cells it is
 * handed and reports what the person asked for. It never decides whether an
 * edit is allowed to land; the owner of the data does.
 */

/** How a cell is edited. `none` cells are never editable regardless of state. */
export type GridEditorKind = "text" | "number" | "enum" | "boolean" | "none";

export interface GridEnumOption {
  readonly value: string;
  readonly label: string;
}

export interface GridColumn {
  readonly id: string;
  readonly heading: string;
  /** Pixel width. */
  readonly width: number;
  readonly editor: GridEditorKind;
  readonly options?: readonly GridEnumOption[];
  readonly align?: "start" | "end" | "center";
  /** Shown after the heading, e.g. "MBH", when the profile puts units in headings. */
  readonly unitLabel?: string;
  /** One-line help shown as the heading's description. */
  readonly description?: string;
}

/**
 * Where a cell stands. `editable` and `locked` are steady states; `pending`,
 * `saved` and `refused` follow an edit; `held` means the person's own edit is
 * waiting because someone else is in the cell.
 */
export type GridCellState = "editable" | "locked" | "pending" | "saved" | "refused" | "held";

export interface GridCellAction {
  /** Plain words, e.g. "Go to source". */
  readonly label: string;
  readonly run: () => void;
}

export interface GridPresence {
  /** Display name of the other person, e.g. "Avery". */
  readonly name: string;
  /** Outline colour (any CSS colour). */
  readonly color: string;
}

export interface GridCell {
  /** What the cell shows. */
  readonly display: string;
  /** What the editor starts with. Defaults to `display`. */
  readonly editText?: string;
  readonly state: GridCellState;
  /** Why a locked cell cannot be typed in, in plain words. Required when `state` is `locked`. */
  readonly lockedReason?: string;
  /** How the value was reached, e.g. "199 MBH × 1000 = 199,000 Btu/h". */
  readonly explain?: string;
  /** The way out of a locked cell: jump to the formula, the source element, the type. */
  readonly sourceAction?: GridCellAction;
  /** Why the last edit was refused. Required when `state` is `refused`. */
  readonly refusedReason?: string;
  /** Someone else is editing this cell. */
  readonly presence?: GridPresence;
  /** Name of the person whose edit is holding this person's edit. Required when `state` is `held`. */
  readonly heldBy?: string;
  /** The cell's own heading when it differs from the column's (sub-list rows), e.g. "Length from source". */
  readonly label?: string;
  /** Conditional highlight, with the reason as words (never colour alone). */
  readonly highlight?: { readonly tone: "warning" | "danger"; readonly reason: string };
}

/** One visible row. Child rows of an expanded parent have `depth` 1. */
export interface GridRowInfo {
  readonly key: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** Accessible label for the expand toggle, e.g. "Serves (12)". */
  readonly expandLabel?: string;
}

/** Row source. `rowAt` and `cellAt` are called only for mounted rows. */
export interface GridRows {
  readonly count: number;
  rowAt(index: number): GridRowInfo;
  cellAt(index: number, columnId: string): GridCell;
}

export interface GridCellEdit {
  readonly rowKey: string;
  readonly columnId: string;
  readonly text: string;
}

/**
 * One undoable act. Paste and fill-down arrive as a single intent so the owner
 * can commit them as one batch (one undo step).
 */
export interface GridEditIntent {
  readonly source: "type" | "paste" | "fill_down" | "clear";
  readonly edits: readonly GridCellEdit[];
  /** Cells in the target range that were not editable, so the owner can say so. */
  readonly skipped: readonly { readonly rowKey: string; readonly columnId: string; readonly reason: string }[];
}

export interface GridCellRef {
  readonly row: number;
  readonly col: number;
}

export interface GridRange {
  readonly anchor: GridCellRef;
  readonly focus: GridCellRef;
}
