import type { GridCellRef, GridRange } from "./types";

export interface RangeBounds {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export function rangeBounds(range: GridRange): RangeBounds {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    bottom: Math.max(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.col, range.focus.col),
    right: Math.max(range.anchor.col, range.focus.col),
  };
}

export function clampRef(ref: GridCellRef, rowCount: number, colCount: number): GridCellRef {
  return {
    row: Math.max(0, Math.min(rowCount - 1, ref.row)),
    col: Math.max(0, Math.min(colCount - 1, ref.col)),
  };
}

export function isSingleCell(range: GridRange): boolean {
  return range.anchor.row === range.focus.row && range.anchor.col === range.focus.col;
}
