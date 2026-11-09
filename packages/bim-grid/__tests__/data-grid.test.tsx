/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useMemo, useState } from "react";
import { DataGrid, type GridEditIntent, type GridRows } from "../src";
import { COLUMNS, makeRows } from "./fixtures";

function grid(): HTMLElement {
  return screen.getByRole("grid");
}

function scroller(): HTMLElement {
  const el = grid().querySelector(".mutiny-grid-scroller");
  if (!(el instanceof HTMLElement)) throw new Error("scroller not rendered");
  return el;
}

function bodyRows(): HTMLElement[] {
  return Array.from(grid().querySelectorAll<HTMLElement>(".mutiny-grid-body > [role='row']"));
}

function activeCell(): HTMLElement {
  const id = grid().getAttribute("aria-activedescendant");
  const el = id ? document.getElementById(id) : null;
  if (!el) throw new Error("no active cell");
  return el;
}

describe("DataGrid virtualization", () => {
  it("mounts at most 60 row nodes for 10,000 rows, at the top and after scrolling", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10_000 })} columns={COLUMNS} height={600} />);
    expect(grid()).toHaveAttribute("aria-rowcount", "10001");
    expect(bodyRows().length).toBeGreaterThan(10);
    expect(bodyRows().length).toBeLessThanOrEqual(60);

    act(() => {
      scroller().scrollTop = 28 * 5_000;
      fireEvent.scroll(scroller());
    });
    const rows = bodyRows();
    expect(rows.length).toBeLessThanOrEqual(60);
    expect(rows.some((r) => r.getAttribute("aria-rowindex") === "5002")).toBe(true);
    expect(within(grid()).getByText("WH-5000")).toBeInTheDocument();
  });

  it("windows columns too: far-right columns are not mounted until scrolled to", () => {
    const wide = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, heading: `Column ${i}`, width: 100, editor: "text" as const }));
    const rows: GridRows = { count: 50, rowAt: (i) => ({ key: `r${i}`, depth: 0, expandable: false, expanded: false }), cellAt: (i, c) => ({ display: `${c}:${i}`, state: "editable" }) };
    render(<DataGrid ariaLabel="Wide" rows={rows} columns={wide} width={800} height={300} frozenColumns={1} />);
    expect(screen.queryByText("c150:0")).toBeNull();
    const headers = grid().querySelectorAll("[role='columnheader']");
    expect(headers.length).toBeLessThan(20);
    act(() => {
      scroller().scrollLeft = 100 * 145;
      fireEvent.scroll(scroller());
    });
    expect(screen.getByText("c150:0")).toBeInTheDocument();
    // The frozen first column stays mounted.
    expect(screen.getByText("c0:0")).toBeInTheDocument();
  });
});

describe("DataGrid editing", () => {
  it("Enter opens the editor, Esc cancels without an edit and returns focus to the grid", () => {
    const onEdit = jest.fn();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 100 })} columns={COLUMNS} onEdit={onEdit} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "Enter" });
    const input = screen.getByRole("textbox", { name: "Edit Mark" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("WH-0");
    fireEvent.change(input, { target: { value: "WH-99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Edit Mark" })).toBeNull();
    expect(grid()).toHaveFocus();
    expect(onEdit).not.toHaveBeenCalled();
    expect(activeCell()).toHaveTextContent("WH-0");
  });

  it("Enter in the editor commits one typed edit and moves down", () => {
    const onEdit = jest.fn();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 100 })} columns={COLUMNS} onEdit={onEdit} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "Enter" });
    const input = screen.getByRole("textbox", { name: "Edit Mark" });
    fireEvent.change(input, { target: { value: "WH-99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith({ source: "type", edits: [{ rowKey: "r0", columnId: "mark", text: "WH-99" }], skipped: [] });
    expect(grid()).toHaveFocus();
    expect(activeCell()).toHaveTextContent("WH-1");
  });

  it("typing a character starts editing with that character", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10 })} columns={COLUMNS} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "7" });
    expect(screen.getByRole("textbox", { name: "Edit Mark" })).toHaveValue("7");
  });

  it("Ctrl+V of a 3×20 TSV block emits exactly one batch edit intent", () => {
    const onEdit = jest.fn<void, [GridEditIntent]>();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 100 })} columns={COLUMNS} onEdit={onEdit} />);
    grid().focus();
    const tsv = Array.from({ length: 20 }, (_, r) => [`P-${r}`, "WH-2", String(r)].join("\t")).join("\n") + "\n";
    fireEvent.paste(grid(), { clipboardData: { getData: () => tsv } });
    expect(onEdit).toHaveBeenCalledTimes(1);
    const intent = onEdit.mock.calls[0]?.[0];
    expect(intent?.source).toBe("paste");
    expect(intent?.edits).toHaveLength(60);
    expect(intent?.edits[0]).toEqual({ rowKey: "r0", columnId: "mark", text: "P-0" });
    expect(intent?.edits[59]).toEqual({ rowKey: "r19", columnId: "gpm", text: "19" });
    expect(intent?.skipped).toEqual([]);
  });

  it("pasting over a locked column reports those cells as skipped with the reason, still in one intent", () => {
    const onEdit = jest.fn<void, [GridEditIntent]>();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10 })} columns={COLUMNS} onEdit={onEdit} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.keyDown(grid(), { key: "ArrowRight" });
    fireEvent.paste(grid(), { clipboardData: { getData: () => "1\t2\n3\t4" } });
    expect(onEdit).toHaveBeenCalledTimes(1);
    const intent = onEdit.mock.calls[0]?.[0];
    expect(intent?.edits.map((e) => e.columnId)).toEqual(["gpm", "gpm"]);
    expect(intent?.skipped).toEqual([
      { rowKey: "r0", columnId: "btuh", reason: "Calculated from Input (MBH) × 1000." },
      { rowKey: "r1", columnId: "btuh", reason: "Calculated from Input (MBH) × 1000." },
    ]);
  });

  it("Ctrl+C copies the selected range as TSV", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10 })} columns={COLUMNS} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid(), { key: "ArrowRight", shiftKey: true });
    const setData = jest.fn();
    fireEvent.copy(grid(), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "WH-0\tWH-1\nWH-1\tWH-1");
  });

  it("Ctrl+D fills the top cell down the selection as one intent", () => {
    const onEdit = jest.fn<void, [GridEditIntent]>();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10 })} columns={COLUMNS} onEdit={onEdit} />);
    grid().focus();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(grid(), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid(), { key: "d", ctrlKey: true });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toEqual({
      source: "fill_down",
      edits: [1, 2, 3].map((r) => ({ rowKey: `r${r}`, columnId: "mark", text: "WH-0" })),
      skipped: [],
    });
  });

  it("Ctrl+Z and Ctrl+Y call undo and redo; Tab at the last column leaves the grid", () => {
    const onUndo = jest.fn();
    const onRedo = jest.fn();
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 10 })} columns={COLUMNS} onUndo={onUndo} onRedo={onRedo} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "z", ctrlKey: true });
    fireEvent.keyDown(grid(), { key: "y", ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(grid(), { key: "End" });
    const tab = fireEvent.keyDown(grid(), { key: "Tab" });
    // Not prevented: the browser moves focus out, so nobody is trapped.
    expect(tab).toBe(true);
  });

  it("Ctrl+F finds a cell and Esc closes the find bar back to the grid", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 500 })} columns={COLUMNS} height={300} />);
    grid().focus();
    fireEvent.keyDown(grid(), { key: "f", ctrlKey: true });
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "WH-321" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("status")).toHaveTextContent("Row 322, Mark");
    expect(activeCell()).toHaveTextContent("WH-321");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(grid()).toHaveFocus();
  });
});

describe("DataGrid cell states", () => {
  it("a locked cell exposes its reason to screen readers and a Go to source action", () => {
    const goToSource = jest.fn();
    const rows = makeRows({ count: 5, cell: (_i, c) => (c === "btuh" ? { sourceAction: { label: "Go to source", run: goToSource } } : undefined) });
    render(<DataGrid ariaLabel="Water heaters" rows={rows} columns={COLUMNS} />);
    const cell = screen.getAllByRole("gridcell").find((c) => c.getAttribute("aria-colindex") === "4");
    if (!cell) throw new Error("locked cell missing");
    expect(cell).toHaveAttribute("aria-readonly", "true");
    expect(cell).toHaveAccessibleDescription(/Locked: Calculated from Input \(MBH\) × 1000\./);
    expect(cell).toHaveAccessibleDescription(/Press Enter for Go to source/);
    const button = within(cell).getByRole("button", { name: "Go to source for Input" });
    fireEvent.click(button);
    expect(goToSource).toHaveBeenCalledTimes(1);

    // Keyboard path: Enter on the locked cell explains it and offers the same action.
    grid().focus();
    fireEvent.keyDown(grid(), { key: "End" });
    fireEvent.keyDown(grid(), { key: "Enter" });
    const dialog = screen.getByRole("dialog", { name: "Input is locked" });
    expect(dialog).toHaveTextContent("0 MBH × 1000 = 0 Btu/h");
    const action = within(dialog).getByRole("button", { name: "Go to source" });
    expect(action).toHaveFocus();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(grid()).toHaveFocus();
  });

  it("a held cell shows the other person's name, in words", () => {
    const rows = makeRows({ count: 5, cell: (i, c) => (i === 2 && c === "gpm" ? { state: "held", heldBy: "Avery", presence: { name: "Avery", color: "#7c3aed" } } : undefined) });
    render(<DataGrid ariaLabel="Water heaters" rows={rows} columns={COLUMNS} />);
    const cell = screen.getAllByRole("gridcell").find((c) => c.getAttribute("aria-colindex") === "3" && c.closest("[role='row']")?.getAttribute("aria-rowindex") === "4");
    if (!cell) throw new Error("held cell missing");
    expect(within(cell).getByText("Avery")).toBeInTheDocument();
    expect(cell).toHaveAttribute("title", "Waiting: Avery is editing this cell");
    expect(cell).toHaveAccessibleDescription("Waiting: Avery is editing this cell.");
  });

  it("presence, pending, saved and refused are announced, not colour-only", () => {
    const rows = makeRows({
      count: 4,
      cell: (i, c) => {
        if (c !== "gpm") return undefined;
        if (i === 0) return { presence: { name: "Casey", color: "#0ea5e9" } };
        if (i === 1) return { state: "pending" };
        if (i === 2) return { state: "saved" };
        return { state: "refused", refusedReason: "Flow must be a number, like 4.5" };
      },
    });
    render(<DataGrid ariaLabel="Water heaters" rows={rows} columns={COLUMNS} />);
    const gpmCells = screen.getAllByRole("gridcell").filter((c) => c.getAttribute("aria-colindex") === "3");
    expect(gpmCells[0]).toHaveAccessibleDescription("Casey is editing this cell.");
    expect(gpmCells[1]).toHaveAttribute("aria-busy", "true");
    expect(gpmCells[1]).toHaveAccessibleDescription("Saving.");
    expect(gpmCells[2]).toHaveAccessibleDescription("Saved.");
    expect(gpmCells[3]).toHaveAttribute("aria-invalid", "true");
    expect(gpmCells[3]).toHaveAccessibleDescription("Not saved: Flow must be a number, like 4.5.");
  });
});

describe("DataGrid expandable rows", () => {
  function Tree() {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const rows = useMemo<GridRows>(() => {
      const keys: { key: string; depth: number; parent: number }[] = [];
      for (let p = 0; p < 3; p++) {
        keys.push({ key: `wh${p}`, depth: 0, parent: p });
        if (expanded.has(`wh${p}`)) for (let c = 0; c < 2; c++) keys.push({ key: `wh${p}/f${c}`, depth: 1, parent: p });
      }
      return {
        count: keys.length,
        rowAt: (i) => {
          const k = keys[i];
          if (!k) throw new Error("row out of range");
          return { key: k.key, depth: k.depth, expandable: k.depth === 0, expanded: expanded.has(k.key), expandLabel: "Serves (2)" };
        },
        cellAt: (i, c) => ({ display: c === "mark" ? (keys[i]?.depth ? `P-${keys[i]?.key.slice(-1)}` : `WH-${keys[i]?.parent}`) : "", state: "editable" }),
      };
    }, [expanded]);
    return (
      <DataGrid
        ariaLabel="Water heaters"
        hierarchical
        rows={rows}
        columns={COLUMNS}
        onToggleExpand={(key) =>
          setExpanded((s) => {
            const n = new Set(s);
            if (n.has(key)) n.delete(key);
            else n.add(key);
            return n;
          })
        }
      />
    );
  }

  it("Serves ▸ shows the child rows; keyboard Alt+← hides them", () => {
    render(<Tree />);
    const tree = screen.getByRole("treegrid");
    expect(tree.querySelectorAll(".mutiny-grid-body > [role='row']")).toHaveLength(3);
    const toggle = screen.getAllByRole("button", { name: "Show Serves (2)" })[0];
    if (!toggle) throw new Error("toggle missing");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const rows = tree.querySelectorAll(".mutiny-grid-body > [role='row']");
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveAttribute("aria-level", "2");
    expect(screen.getByText("P-0")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Hide Serves (2)" })).toHaveLength(1);

    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowLeft", altKey: true });
    expect(tree.querySelectorAll(".mutiny-grid-body > [role='row']")).toHaveLength(3);
  });
});

describe("DataGrid pointer", () => {
  // jsdom has no PointerEvent, so fireEvent would drop `button`, `buttons` and `shiftKey`.
  const hadPointerEvent = "PointerEvent" in window;
  beforeAll(() => {
    if (!hadPointerEvent) Object.defineProperty(window, "PointerEvent", { value: class PointerEvent extends MouseEvent {}, configurable: true });
  });
  afterAll(() => {
    if (!hadPointerEvent) Reflect.deleteProperty(window, "PointerEvent");
  });

  function cellText(text: string): HTMLElement {
    return within(grid()).getByText(text);
  }

  /** The text inside the cell at a zero-based row and column. */
  function textAt(row: number, col: number): HTMLElement {
    const el = grid().querySelector(`[aria-rowindex='${row + 2}'] [aria-colindex='${col + 1}'] .mutiny-grid-text`);
    if (!(el instanceof HTMLElement)) throw new Error(`cell ${row},${col} not mounted`);
    return el;
  }

  function selectedCount(): number {
    return grid().querySelectorAll("[role='gridcell'][aria-selected='true']").length;
  }

  it("click picks the cell, Shift+click and drag extend the range, and only the active cell carries an id", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 20 })} columns={COLUMNS} />);
    fireEvent.pointerDown(textAt(3, 0), { button: 0 });
    expect(activeCell()).toHaveTextContent("WH-3");
    expect(grid().querySelectorAll("[role='gridcell'][id]")).toHaveLength(1);

    fireEvent.pointerDown(textAt(5, 2), { button: 0, shiftKey: true });
    expect(selectedCount()).toBe(9);

    fireEvent.pointerDown(textAt(1, 0), { button: 0 });
    fireEvent.pointerOver(textAt(2, 1), { buttons: 0 });
    expect(selectedCount()).toBe(1);
    fireEvent.pointerOver(textAt(2, 1), { buttons: 1 });
    expect(selectedCount()).toBe(4);
    expect(activeCell().closest("[role='row']")).toHaveAttribute("aria-rowindex", "4");
  });

  it("a press on a button inside a cell leaves the active cell where it was", () => {
    const rows = makeRows({ count: 5, cell: (_i, c) => (c === "btuh" ? { sourceAction: { label: "Go to source", run: jest.fn() } } : undefined) });
    render(<DataGrid ariaLabel="Water heaters" rows={rows} columns={COLUMNS} />);
    fireEvent.pointerDown(cellText("WH-2"), { button: 0 });
    const source = screen.getAllByRole("button", { name: "Go to source for Input" })[3];
    if (!source) throw new Error("source button missing");
    fireEvent.pointerDown(source, { button: 0 });
    expect(activeCell()).toHaveTextContent("WH-2");
  });

  it("double-click edits an editable cell and explains a locked one", () => {
    render(<DataGrid ariaLabel="Water heaters" rows={makeRows({ count: 20 })} columns={COLUMNS} onEdit={jest.fn()} />);
    fireEvent.doubleClick(cellText("WH-2"));
    expect(screen.getByRole("textbox", { name: "Edit Mark" })).toHaveValue("WH-2");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit Mark" }), { key: "Escape" });

    fireEvent.pointerDown(cellText("4,000"), { button: 0 });
    fireEvent.doubleClick(cellText("4,000"));
    expect(screen.getByRole("dialog", { name: "Input is locked" })).toBeInTheDocument();
  });
});
