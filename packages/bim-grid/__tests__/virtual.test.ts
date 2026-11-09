import { columnAt, columnOffsets, columnWindow, flattenTree, parseTsv, rowWindow, toTsv } from "../src";

describe("rowWindow", () => {
  it("is bounded by the viewport, not the row count", () => {
    const a = rowWindow(0, 560, 28, 10_000, 6);
    const b = rowWindow(28 * 9_990, 560, 28, 10_000, 6);
    expect(a.end - a.start).toBeLessThanOrEqual(30);
    expect(b.end).toBe(10_000);
    expect(b.end - b.start).toBeLessThanOrEqual(30);
  });
  it("is empty for no rows", () => {
    expect(rowWindow(0, 500, 28, 0, 6)).toEqual({ start: 0, end: 0 });
  });
});

describe("columns", () => {
  const offsets = columnOffsets([100, 50, 200, 100]);
  it("finds the column under a pixel", () => {
    expect(Array.from(offsets)).toEqual([0, 100, 150, 350, 450]);
    expect(columnAt(offsets, 0)).toBe(0);
    expect(columnAt(offsets, 149)).toBe(1);
    expect(columnAt(offsets, 150)).toBe(2);
    expect(columnAt(offsets, 10_000)).toBe(3);
  });
  it("keeps frozen columns out of the scrolling window", () => {
    expect(columnWindow(offsets, 1, 0, 200, 0)).toEqual({ frozen: 1, start: 1, end: 3 });
    expect(columnWindow(offsets, 1, 260, 200, 0)).toEqual({ frozen: 1, start: 3, end: 4 });
  });
});

describe("flattenTree", () => {
  it("interleaves the children of expanded parents", () => {
    const f = flattenTree(3, (p) => (p === 1 ? 2 : 0));
    expect(f.count).toBe(5);
    expect(Array.from(f.parent)).toEqual([0, 1, 1, 1, 2]);
    expect(Array.from(f.child)).toEqual([-1, -1, 0, 1, -1]);
  });
});

describe("TSV", () => {
  it("round-trips quoted cells with tabs, quotes and newlines", () => {
    const rows = [["a", 'say "hi"'], ["two\nlines", "x\ty"]];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });
  it("ignores one trailing newline and normalizes CRLF", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([["1", "2"], ["3", "4"]]);
  });
});
