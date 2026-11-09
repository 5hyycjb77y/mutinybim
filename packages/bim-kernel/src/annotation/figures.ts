import { z } from "zod";
import type { Primitive } from "../drawing/sheet";
import type { ModelState, Vec2 } from "../types";

/**
 * Figures on a sheet: a live chart drawn from the model at every print, the
 * way a schedule is. The kernel knows charts only as data (axes, series,
 * marked points); what a chart shows comes from a chart kind a host
 * registers (bim-calc's Hunter curve, a fan curve, a load profile). A chart
 * prints as ordinary sheet linework and text, so it plots in the PDF exactly
 * as it shows, in black and white: series are told apart by pen and dash,
 * not colour.
 */

export const SHEET_FIGURE_KINDS = ["chart", "image"] as const;

/** Picture formats a sheet prints (embedded as they are in the PDF). */
export const SHEET_IMAGE_MIMES = ["image/png", "image/jpeg"] as const;

export const sheetFigureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chart"),
      /** A registered chart kind ("plumbing.hunter_curve"). */
      chart: z.string().trim().min(1).max(80),
      /** What the chart kind takes (which systems, which curves). */
      params: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number().finite(), z.boolean()])).optional(),
      /** Replaces the chart kind's own title. */
      title: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      image: z
        .object({
          /** Where the host keeps the picture: the host's workspace file id, a file path in standalone. */
          fileId: z.string().trim().min(1).max(400),
          /** What it is called, for the properties panel and a picture that can't be loaded. */
          name: z.string().trim().min(1).max(200),
          mime: z.enum(SHEET_IMAGE_MIMES),
        })
        .strict(),
    })
    .strict(),
]);

export type SheetFigureSpec = z.infer<typeof sheetFigureSchema>;

/** A picture placed on a sheet, in paper mm; the host supplies the bytes (screen: a URL, print: `ImageSource`). */
export interface SheetImage {
  readonly itemId: string;
  readonly fileId: string;
  readonly name: string;
  readonly mime: (typeof SHEET_IMAGE_MIMES)[number];
  readonly at: Vec2;
  readonly size: Vec2;
}

/** A figure's frame from its two points, top-left and size. */
export function figureFrame(points: readonly Vec2[]): { readonly min: Vec2; readonly max: Vec2 } | null {
  const [a, b] = points;
  if (!a || !b) return null;
  return { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } };
}

export interface ChartAxis {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Gridline spacing in axis units. */
  readonly step: number;
}

export interface ChartSeries {
  readonly id: string;
  readonly label: string;
  readonly points: readonly Vec2[];
  /** Drawn heavier (the curve the model uses). */
  readonly emphasis?: boolean;
}

export interface ChartMarker {
  readonly at: Vec2;
  readonly label: string;
}

/** A chart as data, in its own axis units. */
export interface ChartData {
  readonly title: string;
  readonly x: ChartAxis;
  readonly y: ChartAxis;
  readonly series: readonly ChartSeries[];
  readonly markers: readonly ChartMarker[];
  /** Printed small under the chart (where the curves come from). */
  readonly note?: string;
}

export interface ChartKind {
  readonly id: string;
  /** What a person picks it by ("Hunter curve (water demand)"). */
  readonly label: string;
  /** The chart for this model, or why it can't be drawn, in words. */
  readonly evaluate: (model: ModelState, params: Readonly<Record<string, string | number | boolean>>) => ChartData | { readonly reason: string };
}

const kinds = new Map<string, ChartKind>();

/** A host adds the chart kinds it offers (a host may register bim-calc's). Registering an id again replaces it. */
export function registerChartKind(kind: ChartKind): void {
  kinds.set(kind.id, kind);
}

export function chartKind(id: string): ChartKind | null {
  return kinds.get(id) ?? null;
}

export function chartKinds(): readonly ChartKind[] {
  return [...kinds.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** A figure's chart now, or why not. */
export function evaluateFigure(model: ModelState, figure: Extract<SheetFigureSpec, { kind: "chart" }>): ChartData | { readonly reason: string } {
  const kind = chartKind(figure.chart);
  if (!kind) return { reason: `This MutinyBIM has no "${figure.chart}" chart` };
  const data = kind.evaluate(model, figure.params ?? {});
  return "reason" in data || !figure.title ? data : { ...data, title: figure.title };
}

/** Paper mm. */
const TITLE_MM = 3;
const LABEL_MM = 2;
const SMALL_MM = 1.6;
const DASHES: ReadonlyArray<readonly number[] | undefined> = [undefined, [3, 1.5], [1, 1], [4, 1.5, 1, 1.5], [6, 2]];

/** Helvetica's average glyph width as a share of cap height (a fit estimate; nothing here measures fonts). */
const GLYPH_PER_CAP = 0.62;
const textWidth = (text: string, size: number) => text.length * size * GLYPH_PER_CAP;
const fitText = (text: string, size: number, width: number) => {
  const max = Math.max(1, Math.floor(width / (size * GLYPH_PER_CAP)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};

/** The part of segment a→b inside the box (Liang–Barsky), or null when none of it is. */
function clipSegment(a: Vec2, b: Vec2, x0: number, x1: number, y0: number, y1: number): [Vec2, Vec2] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : `${Math.round(v * 100) / 100}`);

/**
 * A chart drawn into a frame on paper (min top-left, max bottom-right, mm, y
 * down): title, axes with gridlines and tick values, each series clipped to
 * the axes, marked points with their labels, and a legend.
 */
export function chartPrimitives(data: ChartData, min: Vec2, max: Vec2): Primitive[] {
  const out: Primitive[] = [];
  const w = max.x - min.x;
  const h = max.y - min.y;
  out.push({ kind: "rect", at: min, size: { x: w, y: h }, pen: "thin" });
  const titleSize = Math.min(TITLE_MM, (w - 4) / Math.max(1, data.title.length * GLYPH_PER_CAP));
  out.push({ kind: "text", at: { x: min.x + w / 2, y: min.y + TITLE_MM + 2 }, text: data.title, size: titleSize, anchor: "middle", bold: true });
  const left = min.x + LABEL_MM * 5;
  const right = max.x - 3;
  const top = min.y + TITLE_MM + 6;
  const bottom = max.y - LABEL_MM * 4 - (data.note ? SMALL_MM + 2 : 0);
  if (right - left < 10 || bottom - top < 10) {
    out.push({ kind: "text", at: { x: min.x + w / 2, y: min.y + h / 2 }, text: "Make the frame larger to draw this chart", size: SMALL_MM, anchor: "middle" });
    return out;
  }
  const sx = (v: number) => left + ((v - data.x.min) / (data.x.max - data.x.min || 1)) * (right - left);
  const sy = (v: number) => bottom - ((v - data.y.min) / (data.y.max - data.y.min || 1)) * (bottom - top);
  const ticks = (axis: ChartAxis) => {
    const list: number[] = [];
    const step = axis.step > 0 ? axis.step : (axis.max - axis.min) / 5 || 1;
    for (let v = axis.min, i = 0; v <= axis.max + step * 1e-6 && i < 200; v = axis.min + ++i * step) list.push(v);
    return list;
  };
  for (const v of ticks(data.x)) {
    out.push({ kind: "line", a: { x: sx(v), y: top }, b: { x: sx(v), y: bottom }, pen: "thin", dash: [0.5, 1], tone: "halftone" });
    out.push({ kind: "text", at: { x: sx(v), y: bottom + LABEL_MM + 1 }, text: fmt(v), size: SMALL_MM, anchor: "middle" });
  }
  for (const v of ticks(data.y)) {
    out.push({ kind: "line", a: { x: left, y: sy(v) }, b: { x: right, y: sy(v) }, pen: "thin", dash: [0.5, 1], tone: "halftone" });
    out.push({ kind: "text", at: { x: left - 1, y: sy(v) + SMALL_MM / 2 }, text: fmt(v), size: SMALL_MM, anchor: "end" });
  }
  out.push({ kind: "line", a: { x: left, y: bottom }, b: { x: right, y: bottom }, pen: "medium" });
  out.push({ kind: "line", a: { x: left, y: top }, b: { x: left, y: bottom }, pen: "medium" });
  out.push({ kind: "text", at: { x: (left + right) / 2, y: bottom + LABEL_MM * 2 + 2 }, text: data.x.label, size: LABEL_MM, anchor: "middle" });
  out.push({ kind: "text", at: { x: min.x + LABEL_MM + 0.5, y: (top + bottom) / 2 }, text: data.y.label, size: LABEL_MM, anchor: "middle", rotate: -90 });
  // Series, clipped to the plot so nothing crosses the axes or the frame.
  data.series.forEach((s, i) => {
    const dash = DASHES[i % DASHES.length];
    for (let k = 1; k < s.points.length; k++) {
      const a = s.points[k - 1];
      const b = s.points[k];
      if (!a || !b) continue;
      const seg = clipSegment(a, b, data.x.min, data.x.max, data.y.min, data.y.max);
      if (!seg) continue;
      out.push({ kind: "line", a: { x: sx(seg[0].x), y: sy(seg[0].y) }, b: { x: sx(seg[1].x), y: sy(seg[1].y) }, pen: s.emphasis ? "wide" : "thin", ...(dash ? { dash } : {}) });
    }
  });
  const inside = (p: Vec2) => p.x >= data.x.min - 1e-9 && p.x <= data.x.max + 1e-9 && p.y >= data.y.min - 1e-9 && p.y <= data.y.max + 1e-9;
  for (const m of data.markers) {
    if (!inside(m.at)) continue;
    const c = { x: sx(m.at.x), y: sy(m.at.y) };
    out.push({ kind: "line", a: { x: c.x - 1, y: c.y - 1 }, b: { x: c.x + 1, y: c.y + 1 }, pen: "wide" });
    out.push({ kind: "line", a: { x: c.x - 1, y: c.y + 1 }, b: { x: c.x + 1, y: c.y - 1 }, pen: "wide" });
    // The label reads away from the nearer side so it stays inside the plot.
    const toLeft = c.x > (left + right) / 2;
    const room = toLeft ? c.x - left - 2 : right - c.x - 2;
    out.push({ kind: "text", at: { x: c.x + (toLeft ? -1.5 : 1.5), y: Math.max(top + SMALL_MM, c.y - 1.5) }, text: fitText(m.label, SMALL_MM, room), size: SMALL_MM, anchor: toLeft ? "end" : "start", bold: true });
  }
  // Legend: inside the plot's top-left corner on a white backing, each label cut to fit.
  const sample = 6;
  const legendWidth = Math.min((right - left) * 0.6, sample + 2 + Math.max(0, ...data.series.map((s) => textWidth(s.label, SMALL_MM))) + 2);
  const rowH = SMALL_MM + 1.5;
  const rows = Math.max(0, Math.min(data.series.length, Math.floor((bottom - top - 4) / rowH)));
  if (rows > 0) {
    const lx = left + 2;
    const ly = top + 2;
    const lh = rows * rowH + 1;
    out.push({ kind: "fill", points: [{ x: lx, y: ly }, { x: lx + legendWidth, y: ly }, { x: lx + legendWidth, y: ly + lh }, { x: lx, y: ly + lh }], grey: 1 });
    out.push({ kind: "rect", at: { x: lx, y: ly }, size: { x: legendWidth, y: lh }, pen: "thin" });
    data.series.slice(0, rows).forEach((s, i) => {
      const dash = DASHES[i % DASHES.length];
      const y = ly + 1 + i * rowH + SMALL_MM / 2 + 0.5;
      out.push({ kind: "line", a: { x: lx + 1, y }, b: { x: lx + 1 + sample, y }, pen: s.emphasis ? "wide" : "thin", ...(dash ? { dash } : {}) });
      out.push({ kind: "text", at: { x: lx + sample + 2, y: y + SMALL_MM / 2 }, text: fitText(s.label, SMALL_MM, legendWidth - sample - 3), size: SMALL_MM, anchor: "start" });
    });
  }
  if (data.note) out.push({ kind: "text", at: { x: min.x + 2, y: max.y - 1.5 }, text: fitText(data.note, SMALL_MM * 0.8, w - 4), size: SMALL_MM * 0.8, anchor: "start", tone: "halftone" });
  return out;
}

/** A chart figure in its frame: the chart, or a framed note saying why it can't be drawn (never a blank box). */
export function figurePrimitives(model: ModelState, figure: Extract<SheetFigureSpec, { kind: "chart" }>, min: Vec2, max: Vec2): Primitive[] {
  const data = evaluateFigure(model, figure);
  if (!("reason" in data)) return chartPrimitives(data, min, max);
  return [
    { kind: "rect", at: min, size: { x: max.x - min.x, y: max.y - min.y }, pen: "thin" },
    { kind: "text", at: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }, text: data.reason, size: LABEL_MM, anchor: "middle" },
  ];
}
