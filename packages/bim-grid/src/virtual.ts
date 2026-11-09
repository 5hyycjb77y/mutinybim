/**
 * Windowing math. Pure functions so the hot path (every scroll frame) is a
 * handful of arithmetic and one binary search, independent of row count.
 */

export interface RowWindow {
  /** First mounted row (inclusive). */
  readonly start: number;
  /** Last mounted row (exclusive). */
  readonly end: number;
}

/** Rows to mount for a scroll position. Mounted count is bounded by viewport, never by `rowCount`. */
export function rowWindow(scrollTop: number, viewportHeight: number, rowHeight: number, rowCount: number, overscan: number): RowWindow {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, Math.min(rowCount - 1, first - overscan));
  const end = Math.min(rowCount, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

/** Left edge of every column plus the total width at the end (`offsets.length === widths.length + 1`). */
export function columnOffsets(widths: readonly number[]): Float64Array {
  const out = new Float64Array(widths.length + 1);
  for (let i = 0; i < widths.length; i++) out[i + 1] = (out[i] ?? 0) + (widths[i] ?? 0);
  return out;
}

/** Index of the column containing pixel `x` (binary search over offsets). */
export function columnAt(offsets: Float64Array, x: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface ColumnWindow {
  /** Frozen columns `[0, frozen)` are always mounted. */
  readonly frozen: number;
  /** First scrolling column mounted (inclusive, ≥ frozen). */
  readonly start: number;
  /** Last scrolling column mounted (exclusive). */
  readonly end: number;
}

/**
 * Scrolling columns to mount. Frozen columns sit at the left edge and cover
 * `offsets[frozen]` pixels, so the scrolling area starts there.
 */
export function columnWindow(offsets: Float64Array, frozen: number, scrollLeft: number, viewportWidth: number, overscan: number): ColumnWindow {
  const count = offsets.length - 1;
  const f = Math.max(0, Math.min(frozen, count));
  if (f >= count) return { frozen: f, start: count, end: count };
  const frozenWidth = offsets[f] ?? 0;
  const left = frozenWidth + Math.max(0, scrollLeft);
  const right = left + Math.max(0, viewportWidth - frozenWidth);
  const first = Math.max(f, columnAt(offsets, left));
  const last = Math.max(first, columnAt(offsets, Math.max(left, right - 1)));
  return { frozen: f, start: Math.max(f, first - overscan), end: Math.min(count, last + 1 + overscan) };
}

/**
 * Flattens parents plus the children of expanded parents into a visible-row
 * index. Cost is O(parents + visible children) and runs only when the
 * expansion set or the parent list changes, not per frame.
 *
 * Each entry encodes `parent` and `child` (−1 for the parent row itself).
 */
export interface FlatIndex {
  readonly count: number;
  readonly parent: Int32Array;
  readonly child: Int32Array;
}

export function flattenTree(parentCount: number, childCount: (parent: number) => number): FlatIndex {
  let total = parentCount;
  const counts = new Int32Array(parentCount);
  for (let p = 0; p < parentCount; p++) {
    const c = Math.max(0, childCount(p));
    counts[p] = c;
    total += c;
  }
  const parent = new Int32Array(total);
  const child = new Int32Array(total);
  let i = 0;
  for (let p = 0; p < parentCount; p++) {
    parent[i] = p;
    child[i] = -1;
    i++;
    const c = counts[p] ?? 0;
    for (let k = 0; k < c; k++) {
      parent[i] = p;
      child[i] = k;
      i++;
    }
  }
  return { count: total, parent, child };
}
