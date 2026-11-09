import { emForCapHeight, textWidth } from "../../annotation/text-layout";
import type { Primitive } from "../../drawing/sheet";
import type { ModelState, Vec2 } from "../../types";
import { evaluateFormSchedule, type EvaluatedForm, type FormAlign, type FormGrid } from "./evaluate";
import type { FormScheduleDefinition } from "./types";
import { scheduleEmptyRow } from "../schedule";

/**
 * A form schedule on paper: stacked sections the full width of the widest
 * one. Its paper size is its window at scale 1, like a list schedule, so it
 * places, follows and prints through the same viewport path (crop.ts,
 * drawing/views.ts).
 */

const DEFAULT_TEXT_MM = 2.0;
const PAD_MM = 1.2;
const MIN_COL_MM = 5;
const MAX_COL_MM = 70;
/** The note font's metrics run a few percent narrower than printed Helvetica. */
const WIDTH_SAFETY = 1.08;

function measure(text: string, size: number, bold: boolean): number {
  return textWidth(bold ? "bold" : "regular", text, emForCapHeight(size)) * WIDTH_SAFETY;
}

/** Columns are sized to exactly their longest text; the slack absorbs float rounding so that text is never clipped. */
const FIT_SLACK_MM = 0.01;

function fit(text: string, width: number, size: number, bold: boolean): string {
  const room = width - PAD_MM * 2 + FIT_SLACK_MM;
  if (measure(text, size, bold) <= room) return text;
  let out = text;
  while (out.length > 1 && measure(`${out}…`, size, bold) > room) out = out.slice(0, -1);
  return `${out}…`;
}

function widthsFor(headings: readonly string[], rows: readonly (readonly string[])[], fixed: readonly (number | undefined)[], size: number): number[] {
  return headings.map((h, i) => {
    const f = fixed[i];
    if (f !== undefined) return f;
    const seen = new Set<string>();
    let longest = measure(h, size, true);
    for (const r of rows) {
      const c = r[i] ?? "";
      if (seen.has(c)) continue;
      seen.add(c);
      longest = Math.max(longest, measure(c, size, false));
    }
    return Math.min(MAX_COL_MM, Math.max(MIN_COL_MM, longest + PAD_MM * 2));
  });
}

/** A panel's grid is reused while its circuits are unchanged (evaluate.ts), and so are its measured widths. */
const measuredGrids = new WeakMap<FormGrid, { readonly size: number; readonly widths: readonly number[] }>();

function measuredGridWidths(grid: FormGrid, size: number): readonly number[] {
  const known = measuredGrids.get(grid);
  if (known && known.size === size) return known.widths;
  const widths = widthsFor(grid.headings, grid.rows, grid.widths, size);
  measuredGrids.set(grid, { size, widths });
  return widths;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function stretch(widths: readonly number[], to: number): number[] {
  const s = sum(widths);
  return s > 0 && s < to ? widths.map((w) => (w * to) / s) : [...widths];
}

export interface FormTable {
  readonly form: EvaluatedForm;
  readonly textSize: number;
  readonly rowHeight: number;
  readonly titleHeight: number;
  readonly width: number;
  readonly gridWidths: readonly number[];
  /** The row printed under the headings of a list with no rows (null: none). */
  readonly placeholder: string | null;
  readonly summaryWidths: readonly number[];
  readonly totalsLabelWidth: number;
  /** Summary and totals side by side (else totals under the summary). */
  readonly sideBySide: boolean;
  /** Section heights, top to bottom. */
  readonly heights: { readonly title: number; readonly problem: number; readonly header: number; readonly grid: number; readonly summary: number; readonly notes: number; readonly footer: number };
  /** Paper mm. */
  readonly size: Vec2;
}

export function formTable(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): FormTable {
  const form = evaluateFormSchedule(model, def);
  const t = def.textSizeMm ?? DEFAULT_TEXT_MM;
  const rowHeight = Math.max(3.2, t * 2.2);
  const titleHeight = rowHeight * 1.5;
  const cols = Math.max(1, form.headerColumns);
  const headerCellWidths = form.header.map((f) => measure(`${f.label}:`, t, true) + measure(f.value, t, false) + PAD_MM * 3);
  const headerWidth = cols * Math.max(0, ...headerCellWidths);
  const gridNatural = measuredGridWidths(form.grid, t);
  const summaryNatural = form.summary ? widthsFor(form.summary.headings, form.summary.rows, [], t) : [];
  const totalsLabelWidth = Math.max(0, ...form.totals.map((x) => measure(x.label, t, true))) + PAD_MM * 2;
  const totalsValueWidth = Math.max(0, ...form.totals.map((x) => measure(x.value, t, false))) + PAD_MM * 2;
  const totalsWidth = form.totals.length > 0 ? totalsLabelWidth + totalsValueWidth : 0;
  const notesWidth = Math.max(0, ...form.notes.map((n) => measure(n, t, false) + PAD_MM * 2));
  const footerWidth = form.footer ? measure(form.footer, t * 0.85, false) + PAD_MM * 2 : 0;
  const problemWidth = form.problem ? measure(form.problem, t, false) + PAD_MM * 2 : 0;
  const titleWidth = measure(form.title, t * 1.4, true) + PAD_MM * 2;
  const natural = Math.max(25.4, titleWidth, headerWidth, sum(gridNatural), notesWidth, footerWidth, problemWidth);
  const sideBySide = sum(summaryNatural) + totalsWidth <= natural || sum(summaryNatural) === 0 || totalsWidth === 0;
  const width = Math.max(natural, sideBySide ? sum(summaryNatural) + totalsWidth : Math.max(sum(summaryNatural), totalsWidth));
  const gridWidths = stretch(gridNatural, width);
  const summaryWidths = sideBySide ? summaryNatural : stretch(summaryNatural, width);
  const summaryRows = form.summary ? 1 + form.summary.rows.length : 0;
  // A list with nothing to list says so; a panel's slot grid always has its slots.
  const placeholder = def.template.body.layout === "rows" && form.grid.headings.length > 0 && form.grid.rows.length === 0 && !form.problem ? scheduleEmptyRow(def.emptyText) : null;
  const totalsRows = form.totals.length;
  const heights = {
    title: titleHeight,
    problem: form.problem ? rowHeight * 1.2 : 0,
    header: form.header.length > 0 ? Math.ceil(form.header.length / cols) * rowHeight : 0,
    grid: form.grid.headings.length > 0 ? rowHeight * (1 + form.grid.rows.length + (placeholder ? 1 : 0)) : 0,
    summary: (sideBySide ? Math.max(summaryRows, totalsRows) : summaryRows + totalsRows) * rowHeight,
    notes: form.notes.length * rowHeight * 0.85,
    footer: form.footer ? rowHeight : 0,
  };
  const height = Math.max(25.4, sum(Object.values(heights)) + (heights.notes > 0 ? PAD_MM : 0));
  return {
    form,
    textSize: t,
    rowHeight,
    titleHeight,
    width,
    gridWidths,
    placeholder,
    summaryWidths,
    totalsLabelWidth,
    sideBySide,
    heights,
    size: { x: Math.round(width * 100) / 100, y: Math.round(height * 100) / 100 },
  };
}

function textAt(prims: Primitive[], text: string, x: number, w: number, y: number, size: number, align: FormAlign, bold: boolean): void {
  const shown = fit(text, w, size, bold);
  const at = align === "left" ? { x: x + PAD_MM, y } : align === "right" ? { x: x + w - PAD_MM, y } : { x: x + w / 2, y };
  prims.push({ kind: "text", at, text: shown, size, anchor: align === "left" ? "start" : align === "right" ? "end" : "middle", bold });
}

function table(prims: Primitive[], x0: number, y0: number, widths: readonly number[], headings: readonly string[], rows: readonly (readonly string[])[], aligns: readonly FormAlign[], rowH: number, t: number, splitAt: number | null): number {
  const w = sum(widths);
  const lines = [headings, ...rows];
  const bottom = y0 + rowH * lines.length;
  lines.forEach((cells, i) => {
    const y = y0 + rowH * i;
    if (i > 0) prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + w, y }, pen: i === 1 ? "medium" : "thin" });
    let x = x0;
    cells.forEach((c, j) => {
      const cw = widths[j] ?? MIN_COL_MM;
      if (c) textAt(prims, c, x, cw, y + rowH / 2 + t / 2, t, i === 0 ? "center" : (aligns[j] ?? "center"), i === 0);
      x += cw;
    });
  });
  let x = x0;
  widths.slice(0, -1).forEach((cw, j) => {
    x += cw;
    prims.push({ kind: "line", a: { x, y: y0 }, b: { x, y: bottom }, pen: splitAt !== null && j + 1 === splitAt ? "wide" : "thin" });
  });
  return bottom;
}

/** Draw the form with its top-left corner at `topLeft` (paper mm). */
export function drawFormTable(prims: Primitive[], ft: FormTable, topLeft: Vec2): void {
  const { form, textSize: t, rowHeight: rowH, width: W, heights } = ft;
  const x0 = topLeft.x;
  let y = topLeft.y;
  const top = y;
  prims.push({ kind: "text", at: { x: x0 + W / 2, y: y + heights.title * 0.68 }, text: fit(form.title, W, t * 1.4, true), size: t * 1.4, anchor: "middle", bold: true });
  y += heights.title;
  prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + W, y }, pen: "medium" });
  if (form.problem) {
    textAt(prims, form.problem, x0, W, y + heights.problem / 2 + t / 2, t, "left", false);
    y += heights.problem;
  }
  if (heights.header > 0) {
    const cols = Math.max(1, form.headerColumns);
    const cw = W / cols;
    form.header.forEach((f, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = x0 + c * cw;
      const cy = y + r * rowH + rowH / 2 + t / 2;
      const label = `${f.label}:`;
      const lw = measure(label, t, true);
      prims.push({ kind: "text", at: { x: cx + PAD_MM, y: cy }, text: label, size: t, anchor: "start", bold: true });
      if (f.value) prims.push({ kind: "text", at: { x: cx + PAD_MM * 2 + lw, y: cy }, text: fit(f.value, cw - lw - PAD_MM, t, false), size: t, anchor: "start" });
    });
    y += heights.header;
    prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + W, y }, pen: "medium" });
  }
  if (heights.grid > 0) {
    y = table(prims, x0, y, ft.gridWidths, form.grid.headings, form.grid.rows, form.grid.aligns, rowH, t, form.grid.splitAt);
    if (ft.placeholder) {
      prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + W, y }, pen: "medium" });
      textAt(prims, ft.placeholder, x0, W, y + rowH / 2 + t / 2, t, "center", false);
      y += rowH;
    }
    prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + W, y }, pen: "medium" });
  }
  if (heights.summary > 0) {
    const sy = y;
    let summaryBottom = sy;
    if (form.summary) {
      const aligns: FormAlign[] = form.summary.headings.map((_h, i) => (i === 0 ? "left" : "right"));
      summaryBottom = table(prims, x0, sy, ft.summaryWidths, form.summary.headings, form.summary.rows, aligns, rowH, t, null);
    }
    const tx = ft.sideBySide && form.summary ? x0 + sum(ft.summaryWidths) : x0;
    const ty = ft.sideBySide ? sy : summaryBottom;
    if (ft.sideBySide && form.summary && form.totals.length > 0) prims.push({ kind: "line", a: { x: tx, y: sy }, b: { x: tx, y: sy + heights.summary }, pen: "medium" });
    form.totals.forEach((r, i) => {
      const ry = ty + rowH * i + rowH / 2 + t / 2;
      prims.push({ kind: "text", at: { x: tx + PAD_MM, y: ry }, text: r.label, size: t, anchor: "start", bold: true });
      prims.push({ kind: "text", at: { x: tx + ft.totalsLabelWidth + PAD_MM, y: ry }, text: fit(r.value, W - (tx - x0) - ft.totalsLabelWidth, t, false), size: t, anchor: "start" });
    });
    y += heights.summary;
    prims.push({ kind: "line", a: { x: x0, y }, b: { x: x0 + W, y }, pen: "medium" });
  }
  if (heights.notes > 0) {
    y += PAD_MM / 2;
    form.notes.forEach((n, i) => {
      prims.push({ kind: "text", at: { x: x0 + PAD_MM, y: y + rowH * 0.85 * i + rowH * 0.6 }, text: fit(n, W, t, false), size: t, anchor: "start" });
    });
    y += heights.notes + PAD_MM / 2;
  }
  if (form.footer) {
    prims.push({ kind: "text", at: { x: x0 + PAD_MM, y: y + rowH * 0.65 }, text: fit(form.footer, W, t * 0.85, false), size: t * 0.85, anchor: "start" });
    y += heights.footer;
  }
  prims.push({ kind: "rect", at: { x: x0, y: top }, size: { x: W, y: Math.max(y - top, ft.size.y) }, pen: "wide" });
}
