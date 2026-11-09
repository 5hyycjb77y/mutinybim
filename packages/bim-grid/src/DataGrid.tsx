"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { CellInput, CellSelect, GridButton } from "./components/ui/cell-controls";
import { clampRef, isSingleCell, rangeBounds, type RangeBounds } from "./selection";
import { parseTsv, toTsv } from "./tsv";
import type { GridCell, GridCellEdit, GridCellRef, GridColumn, GridEditIntent, GridRange, GridRowInfo, GridRows } from "./types";
import { columnOffsets, columnWindow, rowWindow } from "./virtual";

export interface DataGridHandle {
  focus(): void;
  scrollToRow(index: number): void;
  /** Moves the active cell (and scrolls to it). */
  setActiveCell(row: number, col: number): void;
}

export interface DataGridProps {
  readonly rows: GridRows;
  readonly columns: readonly GridColumn[];
  /** Accessible name, e.g. "Water heater schedule". */
  readonly ariaLabel: string;
  readonly frozenColumns?: number;
  readonly rowHeight?: number;
  readonly headerHeight?: number;
  /** Viewport size used until (or when) the element cannot be measured. */
  readonly height?: number;
  readonly width?: number;
  readonly overscan?: number;
  readonly columnOverscan?: number;
  /** True when rows can carry child rows (renders as a tree grid). */
  readonly hierarchical?: boolean;
  readonly onEdit?: (intent: GridEditIntent) => void;
  readonly onToggleExpand?: (rowKey: string) => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  /** Fires when this person starts or stops editing a cell (drives "editing" presence). */
  readonly onEditingChange?: (cell: { rowKey: string; columnId: string } | null) => void;
  readonly onActiveCellChange?: (cell: { rowKey: string; columnId: string } | null) => void;
  readonly onColumnResize?: (columnId: string, width: number) => void;
  /** Shown instead of rows when `rows.count` is 0. */
  readonly emptyState?: ReactNode;
  readonly className?: string;
  readonly ref?: Ref<DataGridHandle>;
}

interface EditingState {
  readonly row: number;
  readonly col: number;
  readonly rowKey: string;
  readonly columnId: string;
  readonly initial: string;
  readonly text: string;
}

const MIN_COLUMN_WIDTH = 48;

function cellId(base: string, row: number, col: number): string {
  return `${base}-r${row}-c${col}`;
}

/** The cell under a pointer event, read back from the row's and cell's ARIA indexes. */
function cellAtTarget(target: EventTarget): GridCellRef | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest('[role="gridcell"]');
  const row = Number(cell?.parentElement?.getAttribute("aria-rowindex")) - 2;
  const col = Number(cell?.getAttribute("aria-colindex")) - 1;
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 ? { row, col } : null;
}

function isEditable(column: GridColumn, cell: GridCell): boolean {
  return column.editor !== "none" && cell.state !== "locked";
}

function skipReason(column: GridColumn, cell: GridCell): string {
  if (cell.lockedReason) return cell.lockedReason;
  return column.editor === "none" ? `${column.heading} can't be typed in.` : "This cell is locked.";
}

/**
 * Generic virtualized grid (ARIA grid / treegrid, focus via
 * `aria-activedescendant` so unmounted rows never strand focus).
 *
 * Keyboard: arrows move (Shift extends, Ctrl/⌘ jumps to the edge); Home/End,
 * PageUp/PageDown; Tab/Shift+Tab move across and leave the grid at the row
 * edge; Enter or F2 edits (a locked cell explains itself instead); typing
 * starts an edit; Esc cancels an edit, closes the explanation or collapses a
 * range, and otherwise bubbles to the host; Delete clears; Space toggles a
 * Yes/No cell; Ctrl+C / Ctrl+V copy and paste TSV; Ctrl+D fills down;
 * Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo and redo; Ctrl+F finds;
 * Alt+→ / Alt+← show and hide child rows; Ctrl+A selects all.
 */
export function DataGrid(props: DataGridProps) {
  const {
    rows,
    columns,
    ariaLabel,
    frozenColumns = 0,
    rowHeight = 28,
    headerHeight = 32,
    height = 480,
    width = 960,
    overscan = 6,
    columnOverscan = 1,
    hierarchical = false,
    onEdit,
    onToggleExpand,
    onUndo,
    onRedo,
    onEditingChange,
    onActiveCellChange,
    onColumnResize,
    emptyState,
    className,
    ref,
  } = props;

  const base = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState({ height, width });
  const [rawRange, setRange] = useState<GridRange>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef<EditingState | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const [find, setFind] = useState<{ open: boolean; query: string; status: string }>({ open: false, query: "", status: "" });

  const rowCount = rows.count;
  const colCount = columns.length;
  const widths = useMemo(() => columns.map((c) => c.width), [columns]);
  const offsets = useMemo(() => columnOffsets(widths), [widths]);
  const totalWidth = offsets[colCount] ?? 0;
  // Keep the selection inside the grid when rows or columns shrink.
  const range = useMemo<GridRange>(() => {
    if (rowCount === 0 || colCount === 0) return rawRange;
    const inside = (r: GridCellRef) => r.row < rowCount && r.col < colCount;
    if (inside(rawRange.focus) && inside(rawRange.anchor)) return rawRange;
    const ref = clampRef(rawRange.focus, rowCount, colCount);
    return { anchor: ref, focus: ref };
  }, [rawRange, rowCount, colCount]);
  const active = range.focus;

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // Measure the scroller when the platform can; jsdom and SSR fall back to props.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const h = el.clientHeight;
      const w = el.clientWidth;
      if (h > 0 && w > 0) setViewport((v) => (v.height === h && v.width === w ? v : { height: h, width: w }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  const bodyHeight = Math.max(0, viewport.height - headerHeight);
  const rw = rowWindow(scroll.top, bodyHeight, rowHeight, rowCount, overscan);
  const cw = columnWindow(offsets, frozenColumns, scroll.left, viewport.width, columnOverscan);

  const rowKeyAt = useCallback((row: number) => rows.rowAt(row).key, [rows]);

  const scrollIntoView = useCallback(
    (ref: GridCellRef) => {
      const el = scrollerRef.current;
      if (!el) return;
      const top = ref.row * rowHeight;
      const viewH = Math.max(rowHeight, (el.clientHeight || viewport.height) - headerHeight);
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + viewH) el.scrollTop = top + rowHeight - viewH;
      const frozenWidth = offsets[Math.min(frozenColumns, colCount)] ?? 0;
      if (ref.col >= frozenColumns) {
        const left = (offsets[ref.col] ?? 0) - frozenWidth;
        const right = (offsets[ref.col + 1] ?? 0) - frozenWidth;
        const viewW = Math.max(0, (el.clientWidth || viewport.width) - frozenWidth);
        if (left < el.scrollLeft) el.scrollLeft = left;
        else if (right > el.scrollLeft + viewW) el.scrollLeft = right - viewW;
      }
      setScroll({ top: el.scrollTop, left: el.scrollLeft });
    },
    [rowHeight, headerHeight, viewport.height, viewport.width, offsets, frozenColumns, colCount, setScroll],
  );

  const moveTo = useCallback(
    (ref: GridCellRef, extend: boolean) => {
      if (rowCount === 0 || colCount === 0) return;
      const next = clampRef(ref, rowCount, colCount);
      setRange((r) => (extend ? { anchor: r.anchor, focus: next } : { anchor: next, focus: next }));
      setExplainOpen(false);
      scrollIntoView(next);
    },
    [rowCount, colCount, scrollIntoView, setRange, setExplainOpen],
  );

  useEffect(() => {
    if (!onActiveCellChange) return;
    if (rowCount === 0 || colCount === 0 || active.row >= rowCount) {
      onActiveCellChange(null);
      return;
    }
    const column = columns[active.col];
    if (column) onActiveCellChange({ rowKey: rowKeyAt(active.row), columnId: column.id });
  }, [active.row, active.col, rowCount, colCount, columns, rowKeyAt, onActiveCellChange]);

  const focusGrid = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: focusGrid,
      scrollToRow: (index: number) => scrollIntoView({ row: index, col: range.focus.col }),
      setActiveCell: (row: number, col: number) => moveTo({ row, col }, false),
    }),
    [focusGrid, scrollIntoView, moveTo, range.focus.col],
  );

  const startEditing = useCallback(
    (ref: GridCellRef, seed?: string) => {
      const column = columns[ref.col];
      if (!column || ref.row >= rowCount) return;
      const cell = rows.cellAt(ref.row, column.id);
      if (!isEditable(column, cell)) {
        setExplainOpen(true);
        return;
      }
      const rowKey = rowKeyAt(ref.row);
      if (column.editor === "boolean") {
        const current = (cell.editText ?? cell.display).toLowerCase();
        const next = current === "true" || current === "yes" ? "false" : "true";
        onEdit?.({ source: "type", edits: [{ rowKey, columnId: column.id, text: next }], skipped: [] });
        return;
      }
      const initial = cell.editText ?? cell.display;
      const state: EditingState = { row: ref.row, col: ref.col, rowKey, columnId: column.id, initial, text: seed ?? initial };
      editingRef.current = state;
      setEditing(state);
      onEditingChange?.({ rowKey, columnId: column.id });
    },
    [columns, rows, rowCount, rowKeyAt, onEdit, onEditingChange, setExplainOpen, setEditing],
  );

  const finishEditing = useCallback(
    (commit: boolean, move: "down" | "right" | "left" | "none") => {
      const current = editingRef.current;
      if (!current) return;
      editingRef.current = null;
      setEditing(null);
      onEditingChange?.(null);
      if (commit && current.text !== current.initial) {
        onEdit?.({ source: "type", edits: [{ rowKey: current.rowKey, columnId: current.columnId, text: current.text }], skipped: [] });
      }
      const from = { row: current.row, col: current.col };
      if (move === "down") moveTo({ row: from.row + 1, col: from.col }, false);
      else if (move === "right") moveTo({ row: from.row, col: from.col + 1 }, false);
      else if (move === "left") moveTo({ row: from.row, col: from.col - 1 }, false);
      focusGrid();
    },
    [onEdit, onEditingChange, moveTo, focusGrid, setEditing],
  );

  const collectRange = useCallback(
    (b: RangeBounds, textFor: (row: number, col: number) => string | null, source: GridEditIntent["source"]): GridEditIntent => {
      const edits: GridCellEdit[] = [];
      const skipped: { rowKey: string; columnId: string; reason: string }[] = [];
      for (let r = b.top; r <= b.bottom && r < rowCount; r++) {
        const rowKey = rowKeyAt(r);
        for (let c = b.left; c <= b.right && c < colCount; c++) {
          const column = columns[c];
          if (!column) continue;
          const text = textFor(r, c);
          if (text === null) continue;
          const cell = rows.cellAt(r, column.id);
          if (!isEditable(column, cell)) skipped.push({ rowKey, columnId: column.id, reason: skipReason(column, cell) });
          else edits.push({ rowKey, columnId: column.id, text });
        }
      }
      return { source, edits, skipped };
    },
    [rowCount, colCount, columns, rows, rowKeyAt],
  );

  const emit = useCallback(
    (intent: GridEditIntent) => {
      if (intent.edits.length === 0 && intent.skipped.length === 0) return;
      onEdit?.(intent);
    },
    [onEdit],
  );

  const runFind = useCallback(
    (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) {
        setFind((f) => ({ ...f, status: "" }));
        return;
      }
      const startIndex = active.row * colCount + active.col + 1;
      const total = rowCount * colCount;
      for (let step = 0; step < total; step++) {
        const i = (startIndex + step) % total;
        const r = Math.floor(i / colCount);
        const c = i % colCount;
        const column = columns[c];
        if (!column) continue;
        if (rows.cellAt(r, column.id).display.toLowerCase().includes(q)) {
          moveTo({ row: r, col: c }, false);
          setFind((f) => ({ ...f, status: `Row ${r + 1}, ${column.heading}` }));
          return;
        }
      }
      setFind((f) => ({ ...f, status: `No cells contain “${query.trim()}”` }));
    },
    [active.row, active.col, rowCount, colCount, columns, rows, moveTo, setFind],
  );

  const pageRows = Math.max(1, Math.floor(bodyHeight / rowHeight) - 1);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== rootRef.current) return;
    if (rowCount === 0 || colCount === 0) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const b = rangeBounds(range);

    if (mod && (key === "z" || key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) onRedo?.();
      else onUndo?.();
      return;
    }
    if (mod && (key === "y" || key === "Y")) {
      e.preventDefault();
      onRedo?.();
      return;
    }
    if (mod && (key === "f" || key === "F")) {
      e.preventDefault();
      setFind((f) => ({ ...f, open: true }));
      return;
    }
    if (mod && (key === "d" || key === "D")) {
      e.preventDefault();
      if (b.bottom === b.top) return;
      const sources = new Map<number, string>();
      for (let c = b.left; c <= b.right; c++) {
        const column = columns[c];
        if (!column) continue;
        const top = rows.cellAt(b.top, column.id);
        sources.set(c, top.editText ?? top.display);
      }
      emit(collectRange({ ...b, top: b.top + 1 }, (_r, c) => sources.get(c) ?? null, "fill_down"));
      return;
    }
    if (mod && (key === "a" || key === "A")) {
      e.preventDefault();
      setRange({ anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: colCount - 1 } });
      return;
    }

    const rowInfo = rows.rowAt(active.row);
    if (e.altKey && (key === "ArrowRight" || key === "ArrowLeft")) {
      e.preventDefault();
      if (rowInfo.expandable && rowInfo.expanded === (key === "ArrowLeft")) onToggleExpand?.(rowInfo.key);
      return;
    }

    switch (key) {
      case "ArrowUp":
        e.preventDefault();
        moveTo({ row: mod ? 0 : active.row - 1, col: active.col }, e.shiftKey);
        return;
      case "ArrowDown":
        e.preventDefault();
        moveTo({ row: mod ? rowCount - 1 : active.row + 1, col: active.col }, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        moveTo({ row: active.row, col: mod ? 0 : active.col - 1 }, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        moveTo({ row: active.row, col: mod ? colCount - 1 : active.col + 1 }, e.shiftKey);
        return;
      case "PageUp":
        e.preventDefault();
        moveTo({ row: active.row - pageRows, col: active.col }, e.shiftKey);
        return;
      case "PageDown":
        e.preventDefault();
        moveTo({ row: active.row + pageRows, col: active.col }, e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        moveTo({ row: mod ? 0 : active.row, col: 0 }, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        moveTo({ row: mod ? rowCount - 1 : active.row, col: colCount - 1 }, e.shiftKey);
        return;
      case "Tab": {
        const next = active.col + (e.shiftKey ? -1 : 1);
        // At the row edge Tab leaves the grid, so keyboard users are never trapped.
        if (next < 0 || next >= colCount) return;
        e.preventDefault();
        moveTo({ row: active.row, col: next }, false);
        return;
      }
      case "Enter":
      case "F2":
        e.preventDefault();
        startEditing(active);
        return;
      case "Escape":
        if (explainOpen) {
          e.preventDefault();
          setExplainOpen(false);
          return;
        }
        if (!isSingleCell(range)) {
          e.preventDefault();
          setRange({ anchor: active, focus: active });
        }
        // Otherwise let Esc bubble so the host can close its panel.
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        emit(collectRange(b, () => "", "clear"));
        return;
      case " ": {
        const column = columns[active.col];
        if (column?.editor === "boolean") {
          e.preventDefault();
          startEditing(active);
        }
        return;
      }
      default:
        break;
    }
    if (!mod && !e.altKey && key.length === 1) {
      const column = columns[active.col];
      if (column && (column.editor === "text" || column.editor === "number")) {
        e.preventDefault();
        startEditing(active, key);
      }
    }
  };

  const onCopy = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current || e.target !== rootRef.current) return;
    const b = rangeBounds(range);
    const out: string[][] = [];
    for (let r = b.top; r <= b.bottom && r < rowCount; r++) {
      const line: string[] = [];
      for (let c = b.left; c <= b.right && c < colCount; c++) {
        const column = columns[c];
        if (!column) continue;
        const cell = rows.cellAt(r, column.id);
        line.push(cell.editText ?? cell.display);
      }
      out.push(line);
    }
    e.clipboardData.setData("text/plain", toTsv(out));
    e.preventDefault();
  };

  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current || e.target !== rootRef.current || rowCount === 0) return;
    const data = parseTsv(e.clipboardData.getData("text/plain"));
    e.preventDefault();
    if (data.length === 0) return;
    const b = rangeBounds(range);
    const single = data.length === 1 && (data[0]?.length ?? 0) === 1;
    if (single && !isSingleCell(range)) {
      const value = data[0]?.[0] ?? "";
      emit(collectRange(b, () => value, "paste"));
      return;
    }
    const height = data.length;
    const widthCells = Math.max(...data.map((r) => r.length));
    emit(
      collectRange(
        { top: b.top, left: b.left, bottom: b.top + height - 1, right: b.left + widthCells - 1 },
        (r, c) => data[r - b.top]?.[c - b.left] ?? null,
        "paste",
      ),
    );
  };

  const onCellPointerDown = useCallback(
    (row: number, col: number, shift: boolean) => {
      if (editingRef.current && (editingRef.current.row !== row || editingRef.current.col !== col)) finishEditing(true, "none");
      moveTo({ row, col }, shift);
      focusGrid();
    },
    [moveTo, focusGrid, finishEditing],
  );

  const onCellPointerEnter = useCallback((row: number, col: number) => {
    setRange((r) => (r.focus.row === row && r.focus.col === col ? r : { anchor: r.anchor, focus: { row, col } }));
  }, []);

  const onCellDoubleClick = useCallback((row: number, col: number) => startEditing({ row, col }), [startEditing]);

  const onEditingText = useCallback((text: string) => setEditing((s) => (s ? { ...s, text } : s)), []);

  // Mount the windowed rows plus the active row, so `aria-activedescendant` always resolves.
  // Window rows are keyed by slot (row index modulo the window capacity): a row
  // scrolling in reuses the DOM of the row that scrolled out, so a scroll frame
  // rewrites text and attributes instead of building and tearing down nodes.
  const slotCount = Math.ceil(bodyHeight / rowHeight) + 2 * overscan + 2;
  const mounted: { row: number; key: string }[] = [];
  for (let r = rw.start; r < rw.end; r++) mounted.push({ row: r, key: `s${r % slotCount}` });
  if (rowCount > 0 && (active.row < rw.start || active.row >= rw.end) && active.row < rowCount) mounted.push({ row: active.row, key: "active" });

  const mountedCols: number[] = [];
  for (let c = 0; c < cw.frozen; c++) mountedCols.push(c);
  for (let c = cw.start; c < cw.end; c++) mountedCols.push(c);
  if (active.col >= cw.frozen && (active.col < cw.start || active.col >= cw.end) && active.col < colCount) mountedCols.push(active.col);

  const selection = rangeBounds(range);
  const activeId = rowCount > 0 && colCount > 0 && active.row < rowCount ? cellId(base, active.row, active.col) : undefined;
  const activeColumn = columns[active.col];
  const activeCell = activeColumn && active.row < rowCount ? rows.cellAt(active.row, activeColumn.id) : null;

  return (
    <div
      ref={rootRef}
      role={hierarchical ? "treegrid" : "grid"}
      aria-label={ariaLabel}
      aria-rowcount={rowCount + 1}
      aria-colcount={colCount}
      aria-multiselectable="true"
      aria-activedescendant={editing ? undefined : activeId}
      aria-keyshortcuts="Enter F2 Escape Control+C Control+V Control+D Control+Z Control+Y Control+F Alt+ArrowRight Alt+ArrowLeft"
      tabIndex={0}
      className={["mutiny-grid", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
    >
      {find.open ? (
        <div className="mutiny-grid-find" role="search">
          <label className="mutiny-grid-sr" htmlFor={`${base}-find`}>
            Find in {ariaLabel}
          </label>
          <CellInput
            id={`${base}-find`}
            ref={findInputRef}
            autoFocus
            type="search"
            placeholder="Find…"
            value={find.query}
            onChange={(e) => setFind((f) => ({ ...f, query: e.target.value, status: "" }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(find.query);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFind({ open: false, query: find.query, status: "" });
                focusGrid();
              }
            }}
          />
          <span role="status" className="mutiny-grid-find-status">
            {find.status}
          </span>
          <GridButton
            type="button"
            className="mutiny-grid-find-close"
            aria-label="Close find"
            onClick={() => {
              setFind({ open: false, query: find.query, status: "" });
              focusGrid();
            }}
          >
            ×
          </GridButton>
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        className="mutiny-grid-scroller"
        style={{ height: viewport.height }}
        onScroll={(e) => {
          const t = e.currentTarget;
          setScroll((s) => (s.top === t.scrollTop && s.left === t.scrollLeft ? s : { top: t.scrollTop, left: t.scrollLeft }));
        }}
      >
        <HeaderRow
          columns={columns}
          mountedCols={mountedCols}
          frozen={cw.frozen}
          offsets={offsets}
          scrollLeft={cw.frozen > 0 ? scroll.left : 0}
          headerHeight={headerHeight}
          onColumnResize={onColumnResize}
        />
        {rowCount === 0 ? (
          <div className="mutiny-grid-empty">{emptyState ?? "No rows to show."}</div>
        ) : (
          <div
            role="rowgroup"
            className="mutiny-grid-body"
            style={{ height: rowCount * rowHeight, width: totalWidth }}
            // One set of pointer handlers for every cell, so a scroll frame does not build three per cell.
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest("button,input,select")) return;
              const ref = cellAtTarget(e.target);
              if (ref) onCellPointerDown(ref.row, ref.col, e.shiftKey);
            }}
            onPointerOver={(e) => {
              if (e.buttons !== 1) return;
              const ref = cellAtTarget(e.target);
              if (ref) onCellPointerEnter(ref.row, ref.col);
            }}
            onDoubleClick={(e) => {
              const ref = cellAtTarget(e.target);
              if (ref) onCellDoubleClick(ref.row, ref.col);
            }}
          >
            {mounted.map(({ row: r, key }) => {
              const inSelection = r >= selection.top && r <= selection.bottom;
              return (
                <GridRow
                  key={key}
                  base={base}
                  rows={rows}
                  info={rows.rowAt(r)}
                  index={r}
                  columns={columns}
                  mountedCols={mountedCols}
                  frozen={cw.frozen}
                  offsets={offsets}
                  scrollLeft={cw.frozen > 0 ? scroll.left : 0}
                  rowHeight={rowHeight}
                  hierarchical={hierarchical}
                  activeCol={r === active.row ? active.col : -1}
                  selLeft={inSelection ? selection.left : -1}
                  selRight={inSelection ? selection.right : -1}
                  editing={editing && editing.row === r ? editing : null}
                  onEditingText={onEditingText}
                  onFinishEditing={finishEditing}
                  onToggleExpand={onToggleExpand}
                />
              );
            })}
          </div>
        )}
      </div>
      {explainOpen && activeCell && activeColumn && !editing ? (
        <ExplainPopover
          heading={activeColumn.heading}
          cell={activeCell}
          column={activeColumn}
          onClose={() => {
            setExplainOpen(false);
            focusGrid();
          }}
        />
      ) : null}
    </div>
  );
}

function alignClass(align: GridColumn["align"]): string {
  return align === "end" ? "is-end" : align === "center" ? "is-center" : "";
}

interface HeaderRowProps {
  readonly columns: readonly GridColumn[];
  readonly mountedCols: readonly number[];
  readonly frozen: number;
  readonly offsets: Float64Array;
  readonly scrollLeft: number;
  readonly headerHeight: number;
  readonly onColumnResize?: (columnId: string, width: number) => void;
}

const HeaderRow = memo(
  function HeaderRow({ columns, mountedCols, frozen, offsets, scrollLeft, headerHeight, onColumnResize }: HeaderRowProps) {
    const totalWidth = offsets[offsets.length - 1] ?? 0;
    return (
      <div role="rowgroup" className="mutiny-grid-header" style={{ height: headerHeight, width: totalWidth }}>
        <div role="row" aria-rowindex={1} className="mutiny-grid-row" style={{ height: headerHeight, width: totalWidth }}>
          {mountedCols.map((c) => {
            const column = columns[c];
            if (!column) return null;
            const isFrozen = c < frozen;
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-colindex={c + 1}
                className={["mutiny-grid-cell", "mutiny-grid-heading", isFrozen ? "is-frozen" : "", alignClass(column.align)].join(" ")}
                title={column.description}
                style={{ left: (offsets[c] ?? 0) + (isFrozen ? scrollLeft : 0), width: column.width, height: headerHeight }}
              >
                <span className="mutiny-grid-text">
                  {column.heading}
                  {column.unitLabel ? <span className="mutiny-grid-unit"> ({column.unitLabel})</span> : null}
                </span>
                {onColumnResize ? <ResizeHandle column={column} onResize={onColumnResize} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  },
  (a, b) =>
    a.columns === b.columns &&
    sameCols(a.mountedCols, b.mountedCols) &&
    a.frozen === b.frozen &&
    a.offsets === b.offsets &&
    a.scrollLeft === b.scrollLeft &&
    a.headerHeight === b.headerHeight &&
    a.onColumnResize === b.onColumnResize,
);

function ResizeHandle({ column, onResize }: { column: GridColumn; onResize: (id: string, width: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${column.heading}`}
      aria-valuenow={column.width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      tabIndex={-1}
      className="mutiny-grid-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = column.width;
        const move = (ev: PointerEvent) => onResize(column.id, Math.max(MIN_COLUMN_WIDTH, Math.round(startW + ev.clientX - startX)));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onResize(column.id, Math.max(MIN_COLUMN_WIDTH, column.width + (e.key === "ArrowRight" ? 8 : -8)));
        }
      }}
    />
  );
}

interface GridRowProps {
  readonly base: string;
  readonly rows: GridRows;
  readonly info: GridRowInfo;
  readonly index: number;
  readonly columns: readonly GridColumn[];
  readonly mountedCols: readonly number[];
  readonly frozen: number;
  readonly offsets: Float64Array;
  readonly scrollLeft: number;
  readonly rowHeight: number;
  readonly hierarchical: boolean;
  readonly activeCol: number;
  readonly selLeft: number;
  readonly selRight: number;
  readonly editing: EditingState | null;
  readonly onEditingText: (text: string) => void;
  readonly onFinishEditing: (commit: boolean, move: "down" | "right" | "left" | "none") => void;
  readonly onToggleExpand?: (rowKey: string) => void;
}

function sameCols(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `rowAt` may build a fresh object per call; compare by value so unchanged rows skip rendering. */
function sameInfo(a: GridRowInfo, b: GridRowInfo): boolean {
  return a === b || (a.key === b.key && a.depth === b.depth && a.expandable === b.expandable && a.expanded === b.expanded && a.expandLabel === b.expandLabel);
}

function sameRowProps(a: GridRowProps, b: GridRowProps): boolean {
  return (
    a.base === b.base &&
    a.rows === b.rows &&
    sameInfo(a.info, b.info) &&
    a.index === b.index &&
    a.columns === b.columns &&
    sameCols(a.mountedCols, b.mountedCols) &&
    a.frozen === b.frozen &&
    a.offsets === b.offsets &&
    a.scrollLeft === b.scrollLeft &&
    a.rowHeight === b.rowHeight &&
    a.hierarchical === b.hierarchical &&
    a.activeCol === b.activeCol &&
    a.selLeft === b.selLeft &&
    a.selRight === b.selRight &&
    a.editing === b.editing &&
    a.onEditingText === b.onEditingText &&
    a.onFinishEditing === b.onFinishEditing &&
    a.onToggleExpand === b.onToggleExpand
  );
}

const GridRow = memo(
  function GridRow(p: GridRowProps) {
    const { base, rows, info, index, columns, mountedCols, frozen, offsets, scrollLeft, rowHeight, hierarchical, activeCol, selLeft, selRight, editing } = p;
    return (
      <div
        role="row"
        aria-rowindex={index + 2}
        aria-level={hierarchical ? info.depth + 1 : undefined}
        aria-expanded={hierarchical && info.expandable ? info.expanded : undefined}
        className={info.depth > 0 ? "mutiny-grid-row is-child" : "mutiny-grid-row"}
        style={{ top: index * rowHeight, height: rowHeight, width: offsets[offsets.length - 1] ?? 0 }}
      >
        {mountedCols.map((c) => {
          const column = columns[c];
          if (!column) return null;
          const cell = rows.cellAt(index, column.id);
          const isFrozen = c < frozen;
          return (
            renderCell({
              base,
              column,
              cell,
              row: index,
              col: c,
              left: (offsets[c] ?? 0) + (isFrozen ? scrollLeft : 0),
              height: rowHeight,
              frozen: isFrozen,
              active: c === activeCol,
              selected: c >= selLeft && c <= selRight && selLeft >= 0,
              info: c === 0 ? info : null,
              editing: editing && editing.col === c ? editing : null,
              onEditingText: p.onEditingText,
              onFinishEditing: p.onFinishEditing,
              onToggleExpand: p.onToggleExpand,
            })
          );
        })}
      </div>
    );
  },
  sameRowProps,
);

interface GridCellProps {
  readonly base: string;
  readonly column: GridColumn;
  readonly cell: GridCell;
  readonly row: number;
  readonly col: number;
  readonly left: number;
  readonly height: number;
  readonly frozen: boolean;
  readonly active: boolean;
  readonly selected: boolean;
  readonly info: GridRowInfo | null;
  readonly editing: EditingState | null;
  readonly onEditingText: (text: string) => void;
  readonly onFinishEditing: (commit: boolean, move: "down" | "right" | "left" | "none") => void;
  readonly onToggleExpand?: (rowKey: string) => void;
}

/** Ends a clause with one full stop, whether or not the caller already wrote one. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** Words a screen reader hears after the value: lock reason, save state, who else is here. */
function cellDescription(cell: GridCell, column: GridColumn): string {
  if (cell.state === "editable" && column.editor !== "none" && !cell.label && !cell.presence && !cell.highlight) return "";
  const parts: string[] = [];
  if (cell.label && cell.label !== column.heading) parts.push(`${cell.label}.`);
  if (cell.state === "locked" || column.editor === "none") {
    parts.push(`Locked: ${sentence(cell.lockedReason ?? "this value is calculated")}`);
    if (cell.sourceAction) parts.push(`Press Enter for ${cell.sourceAction.label}.`);
  }
  if (cell.state === "pending") parts.push("Saving.");
  if (cell.state === "saved") parts.push("Saved.");
  if (cell.state === "refused") parts.push(`Not saved: ${sentence(cell.refusedReason ?? "the change was refused")}`);
  if (cell.state === "held") parts.push(`Waiting: ${cell.heldBy ?? "someone"} is editing this cell.`);
  if (cell.presence && cell.state !== "held") parts.push(`${cell.presence.name} is editing this cell.`);
  if (cell.highlight) parts.push(sentence(cell.highlight.reason));
  return parts.join(" ");
}

/**
 * One cell's markup. A plain function rather than a component: a row that re-renders
 * rewrites all of its cells anyway, and a component per cell adds an element and a fiber
 * for every cell to every scroll frame.
 */
function renderCell(p: GridCellProps) {
  const { base, column, cell, row, col, left, height, frozen, active, selected, info, editing } = p;
  const description = cellDescription(cell, column);
  // Only the active cell carries an id (`aria-activedescendant` points at it); an id on every
  // cell would be rewritten on every scroll frame for nothing.
  const ownId = active || description ? cellId(base, row, col) : undefined;
  const descId = description ? `${ownId}-desc` : undefined;
  const locked = cell.state === "locked" || column.editor === "none";
  // Concatenated rather than built from an array: this runs for every cell of every row a scroll frame moves.
  let classes = "mutiny-grid-cell";
  if (column.align === "end") classes += " is-end";
  else if (column.align === "center") classes += " is-center";
  if (frozen) classes += " is-frozen";
  if (active) classes += " is-active";
  if (selected) classes += " is-selected";
  if (locked) classes += " is-locked";
  if (cell.state === "pending" || cell.state === "saved" || cell.state === "refused" || cell.state === "held") classes += ` is-${cell.state}`;
  if (cell.highlight) classes += ` is-${cell.highlight.tone}`;
  const indent = info && info.depth > 0 ? info.depth * 16 : 0;
  return (
    <div
      key={column.id}
      id={active ? ownId : undefined}
      role="gridcell"
      aria-colindex={col + 1}
      aria-selected={selected}
      aria-readonly={locked || undefined}
      aria-invalid={cell.state === "refused" || undefined}
      aria-busy={cell.state === "pending" || undefined}
      aria-describedby={descId}
      className={classes}
      title={
        cell.state === "refused"
          ? cell.refusedReason
          : cell.state === "held"
            ? `Waiting: ${cell.heldBy ?? "someone"} is editing this cell`
            : cell.presence
              ? `${cell.presence.name} is editing this cell`
              : (cell.highlight?.reason ?? (locked ? cell.lockedReason : cell.label && cell.label !== column.heading ? cell.label : undefined))
      }
      style={{
        left,
        width: column.width,
        height,
        outline: cell.presence ? `2px solid ${cell.presence.color}` : undefined,
        outlineOffset: cell.presence ? -2 : undefined,
      }}
    >
      {info && info.expandable ? (
        <GridButton
          type="button"
          tabIndex={-1}
          className="mutiny-grid-toggle"
          aria-expanded={info.expanded}
          aria-label={`${info.expanded ? "Hide" : "Show"} ${info.expandLabel ?? "child rows"}`}
          style={{ marginInlineStart: indent }}
          onClick={() => p.onToggleExpand?.(info.key)}
        >
          {info.expanded ? "▾" : "▸"}
        </GridButton>
      ) : null}
      {editing ? (
        <CellEditor column={column} editing={editing} onText={p.onEditingText} onFinish={p.onFinishEditing} />
      ) : (
        <span className="mutiny-grid-text" style={indent && !(info && info.expandable) ? { paddingInlineStart: indent } : undefined}>
          {cell.display}
        </span>
      )}
      {locked && cell.sourceAction ? (
        <GridButton
          type="button"
          tabIndex={-1}
          className="mutiny-grid-source"
          aria-label={`${cell.sourceAction.label} for ${column.heading}`}
          title={cell.sourceAction.label}
          onClick={cell.sourceAction.run}
        >
          ↗
        </GridButton>
      ) : null}
      {cell.presence || cell.state === "held" ? (
        <span className="mutiny-grid-tag" aria-hidden style={cell.presence ? { background: cell.presence.color } : undefined}>
          {cell.presence?.name ?? cell.heldBy}
        </span>
      ) : null}
      {descId ? (
        <span id={descId} className="mutiny-grid-sr">
          {description}
        </span>
      ) : null}
    </div>
  );
}

function CellEditor({
  column,
  editing,
  onText,
  onFinish,
}: {
  column: GridColumn;
  editing: EditingState;
  onText: (text: string) => void;
  onFinish: (commit: boolean, move: "down" | "right" | "left" | "none") => void;
}) {
  const label = `Edit ${column.heading}`;
  if (column.editor === "enum") {
    return (
      <CellSelect
        autoFocus
        aria-label={label}
        className="mutiny-grid-editor"
        value={editing.text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onFinish(true, "down");
          } else if (e.key === "Escape") {
            e.preventDefault();
            onFinish(false, "none");
          } else if (e.key === "Tab") {
            e.preventDefault();
            onFinish(true, e.shiftKey ? "left" : "right");
          }
        }}
        onBlur={() => onFinish(true, "none")}
      >
        {(column.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </CellSelect>
    );
  }
  return (
    <CellInput
      autoFocus
      aria-label={label}
      className="mutiny-grid-editor"
      inputMode={column.editor === "number" ? "decimal" : undefined}
      value={editing.text}
      onChange={(e) => onText(e.target.value)}
      onFocus={(e) => {
        const len = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(len, len);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onFinish(true, "down");
        } else if (e.key === "Escape") {
          e.preventDefault();
          onFinish(false, "none");
        } else if (e.key === "Tab") {
          e.preventDefault();
          onFinish(true, e.shiftKey ? "left" : "right");
        }
      }}
      onBlur={() => onFinish(true, "none")}
    />
  );
}

function ExplainPopover({ heading, cell, column, onClose }: { heading: string; cell: GridCell; column: GridColumn; onClose: () => void }) {
  const titleId = useId();
  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="mutiny-grid-explain"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div id={titleId} className="mutiny-grid-explain-title">
        {heading} is locked
      </div>
      <p>{cell.lockedReason ?? (column.editor === "none" ? `${column.heading} can't be typed in.` : "This value is calculated.")}</p>
      {cell.explain ? <p className="mutiny-grid-explain-math">{cell.explain}</p> : null}
      <div className="mutiny-grid-explain-actions">
        {cell.sourceAction ? (
          <GridButton
            type="button"
            autoFocus
            className="mutiny-grid-button is-primary"
            onClick={() => {
              cell.sourceAction?.run();
              onClose();
            }}
          >
            {cell.sourceAction.label}
          </GridButton>
        ) : null}
        <GridButton type="button" autoFocus={!cell.sourceAction} className="mutiny-grid-button" onClick={onClose}>
          Close
        </GridButton>
      </div>
    </div>
  );
}
