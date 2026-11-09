import type { GridCell, GridColumn, GridRowInfo, GridRows } from "../src";

export const COLUMNS: readonly GridColumn[] = [
  { id: "mark", heading: "Mark", width: 90, editor: "text" },
  { id: "type", heading: "Type", width: 120, editor: "enum", options: [{ value: "WH-1", label: "WH-1" }, { value: "WH-2", label: "WH-2" }] },
  { id: "gpm", heading: "Flow", width: 90, editor: "number", align: "end", unitLabel: "gpm" },
  { id: "btuh", heading: "Input", width: 110, editor: "none", align: "end", unitLabel: "Btu/h" },
];

export interface FixtureOptions {
  readonly count: number;
  readonly cell?: (row: number, columnId: string) => Partial<GridCell> | undefined;
  readonly info?: (row: number) => Partial<GridRowInfo> | undefined;
}

/** Synthetic rows: cells are computed, nothing per row is allocated up front. */
export function makeRows({ count, cell, info }: FixtureOptions): GridRows {
  return {
    count,
    rowAt: (i) => ({ key: `r${i}`, depth: 0, expandable: false, expanded: false, ...info?.(i) }),
    cellAt: (i, columnId) => {
      const base: GridCell =
        columnId === "btuh"
          ? { display: `${(i * 1000).toLocaleString("en-US")}`, state: "locked", lockedReason: "Calculated from Input (MBH) × 1000.", explain: `${i} MBH × 1000 = ${(i * 1000).toLocaleString("en-US")} Btu/h` }
          : { display: columnId === "mark" ? `WH-${i}` : columnId === "type" ? "WH-1" : String(i % 7), state: "editable" };
      return { ...base, ...cell?.(i, columnId) };
    },
  };
}
