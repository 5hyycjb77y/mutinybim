import { z } from "zod";
import { registerSchemaStep, schemaSteps, type SchemaStep } from "../schema-version/registry";
import type { DrawingItem } from "../documents";
import type { Primitive } from "../drawing/sheet";
import type { Vec2 } from "../types";

/**
 * Sheet review markups: freehand felt-tip marker and translucent highlighter
 * ink drawn directly on sheets for human-to-agent and peer backcheck review.
 *
 * Trade-neutral and non-printing by default: issued permit PDFs omit markups
 * unless a caller explicitly requests `includeMarkups: true` (check sets,
 * screen overlays, and agent sheet image renders). When drawn, markup ink
 * preserves its vivid colour even over a black-only monochrome sheet.
 */

/** Peers that store and render sheet review markups (`shape: "markup"` + `markup` spec). */
export const SHEET_MARKUPS_FEATURE = "documents:sheet_markups";

/**
 * Gated record step with no per-record upgrade (`qto/feature.ts` /
 * `view-category-overrides` precedent): registers `documents:sheet_markups`
 * in `gatedRecordFeatures()` so every peer of this release advertises it
 * without disturbing `drawing_item`'s drafting schema version chain.
 */
export const SHEET_MARKUPS_STEP: SchemaStep = {
  kind: "sheet",
  from: 1,
  to: 2,
  name: "sheet_markups",
  feature: SHEET_MARKUPS_FEATURE,
};
if (!schemaSteps("sheet").some((s) => s.name === SHEET_MARKUPS_STEP.name)) {
  registerSchemaStep(SHEET_MARKUPS_STEP);
}

export const MARKUP_TOOLS = ["marker", "highlighter"] as const;
export type MarkupTool = (typeof MARKUP_TOOLS)[number];

export const MARKUP_STATUSES = ["open", "addressed", "resolved"] as const;
export type MarkupStatus = (typeof MARKUP_STATUSES)[number];

export const MARKUP_SMART_SHAPES = ["line", "rect", "circle"] as const;
export type MarkupSmartShape = (typeof MARKUP_SMART_SHAPES)[number];

/** Classic AEC redline + marker colour palette (paper-agnostic hex inks). */
export const MARKUP_COLOR_PRESETS = [
  { id: "red", label: "Red", hex: "#dc2626" },
  { id: "purple", label: "Purple", hex: "#9333ea" },
  { id: "blue", label: "Blue", hex: "#2563eb" },
  { id: "orange", label: "Orange", hex: "#ea580c" },
  { id: "green", label: "Green", hex: "#16a34a" },
] as const;

/** Classic yellow-line highlight colour used when an agent or reviewer marks a redline addressed. */
export const DEFAULT_ADDRESSED_HIGHLIGHT_COLOR = "#facc15";

export const DEFAULT_MARKER_COLOR = "#dc2626";
export const DEFAULT_MARKER_WIDTH_MM = 2.4;
export const DEFAULT_MARKER_OPACITY = 0.92;
export const DEFAULT_HIGHLIGHTER_WIDTH_MM = 9.0;
export const DEFAULT_HIGHLIGHTER_OPACITY = 0.36;

export const MARKUP_WIDTH_PRESETS: Readonly<Record<MarkupTool, ReadonlyArray<{ readonly id: "fine" | "medium" | "bold"; readonly label: string; readonly widthMm: number }>>> = {
  marker: [
    { id: "fine", label: "Fine", widthMm: 1.4 },
    { id: "medium", label: "Medium", widthMm: 2.4 },
    { id: "bold", label: "Bold", widthMm: 4.2 },
  ],
  highlighter: [
    { id: "fine", label: "Narrow", widthMm: 6.0 },
    { id: "medium", label: "Standard", widthMm: 9.0 },
    { id: "bold", label: "Wide", widthMm: 14.0 },
  ],
};

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Ink colour must be a 6-digit hex colour such as #dc2626");

export const sheetMarkupSpecSchema = z
  .object({
    tool: z.enum(MARKUP_TOOLS).default("marker"),
    color: hexColorSchema.default(DEFAULT_MARKER_COLOR),
    /** Stroke width on paper in mm (e.g. 2.4 mm felt-tip pen, 9 mm highlighter). */
    widthMm: z.number().finite().min(0.3).max(30).default(DEFAULT_MARKER_WIDTH_MM),
    /** Ink opacity (0.1–1). Absent: 0.92 for felt-tip marker, 0.36 for highlighter. */
    opacity: z.number().finite().min(0.1).max(1).optional(),
    status: z.enum(MARKUP_STATUSES).default("open"),
    /** Optional recognized geometric shape when smart-shape cleanup snapped the stroke. */
    smartShape: z.enum(MARKUP_SMART_SHAPES).optional(),
    /** Optional short author display label (e.g. person name or "agent"). */
    author: z.string().trim().min(1).max(120).optional(),
    /** Optional ISO 8601 timestamp when the stroke was created. */
    createdAt: z.string().trim().min(1).max(64).optional(),
    /** Optional short note added when an agent or reviewer marks this redline addressed ("yellow-lined"). */
    addressedNote: z.string().trim().min(1).max(500).optional(),
    /** Optional custom highlight colour used behind an addressed stroke (default classic yellow #facc15). */
    addressedColor: hexColorSchema.optional(),
    /** Optional short caption or open metadata note for future workflows. */
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type SheetMarkupSpec = z.infer<typeof sheetMarkupSpecSchema>;

/** Resolved opacity for a sheet markup stroke. */
export function markupOpacity(spec: Pick<SheetMarkupSpec, "tool" | "opacity">): number {
  if (spec.opacity !== undefined) return Math.min(1, Math.max(0.1, spec.opacity));
  return spec.tool === "highlighter" ? DEFAULT_HIGHLIGHTER_OPACITY : DEFAULT_MARKER_OPACITY;
}

/** Paper-mm bounding box of a sheet markup item (expanded by stroke half-width). */
export function markupBounds(item: Pick<DrawingItem, "points" | "markup">): { readonly min: Vec2; readonly max: Vec2 } | null {
  if (item.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of item.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.max(1, (item.markup?.widthMm ?? DEFAULT_MARKER_WIDTH_MM) * (item.markup?.status === "addressed" ? 1.4 : 0.6));
  return {
    min: { x: minX - pad, y: minY - pad },
    max: { x: maxX + pad, y: maxY + pad },
  };
}

/**
 * Build a smooth SVG path string for a felt-tip marker or highlighter stroke
 * using quadratic midpoint curves, or null when fewer than 2 points exist.
 */
export function smoothStrokeSvgPath(points: readonly Vec2[], closed = false): string | null {
  if (points.length < 2) return null;
  const p0 = points[0];
  const p1 = points[1];
  if (!p0 || !p1) return null;
  if (points.length === 2) {
    return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)} L${p1.x.toFixed(2)} ${p1.y.toFixed(2)}${closed ? " Z" : ""}`;
  }
  const segs: string[] = [`M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i];
    const next = points[i + 1];
    if (!cur || !next) continue;
    const midX = (cur.x + next.x) / 2;
    const midY = (cur.y + next.y) / 2;
    segs.push(`Q${cur.x.toFixed(2)} ${cur.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`);
  }
  const last = points[points.length - 1];
  if (last) segs.push(`L${last.x.toFixed(2)} ${last.y.toFixed(2)}`);
  if (closed) segs.push("Z");
  return segs.join(" ");
}

/**
 * Emit `SheetScene` primitives for one sheet markup item.
 * Resolved markups are omitted unless `includeResolved` is true.
 * Addressed markups receive a classic translucent yellow-line under-glow so
 * the human can backcheck completed redlines at a glance.
 */
export function markupToPrimitives(item: DrawingItem, opts: { readonly includeResolved?: boolean } = {}): Primitive[] {
  if (item.deleted || item.shape !== "markup" || !item.markup || item.points.length === 0) return [];
  const spec = item.markup;
  if (spec.status === "resolved" && !opts.includeResolved) return [];
  const closed = spec.smartShape === "circle" || spec.smartShape === "rect";
  const sharp = spec.smartShape === "rect" || spec.smartShape === "line";
  const out: Primitive[] = [];
  if (spec.status === "addressed") {
    out.push({
      kind: "stroke",
      points: item.points,
      widthMm: Math.min(36, Math.max(spec.widthMm * 2.8, 6.5)),
      color: spec.addressedColor ?? DEFAULT_ADDRESSED_HIGHLIGHT_COLOR,
      opacity: 0.48,
      closed,
      ...(sharp ? { sharp: true } : {}),
      preserveColor: true,
      markupId: item.id,
    });
  }
  out.push({
    kind: "stroke",
    points: item.points,
    widthMm: spec.widthMm,
    color: spec.color,
    opacity: spec.status === "resolved" ? markupOpacity(spec) * 0.3 : markupOpacity(spec),
    closed,
    ...(sharp ? { sharp: true } : {}),
    preserveColor: true,
    markupId: item.id,
  });
  return out;
}

// ── Stroke simplification & optional smart-shape cleanup ─────────────────────

function pointToSegmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const ex = p.x - px;
  const ey = p.y - py;
  return ex * ex + ey * ey;
}

function rdp(points: readonly Vec2[], tolSq: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];
  let maxDistSq = -1;
  let splitIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (!p) continue;
    const dSq = pointToSegmentDistSq(p, first, last);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      splitIdx = i;
    }
  }
  if (maxDistSq > tolSq && splitIdx > 0 && splitIdx < points.length - 1) {
    const left = rdp(points.slice(0, splitIdx + 1), tolSq);
    const right = rdp(points.slice(splitIdx), tolSq);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/**
 * Compact a raw mouse/stylus stroke in paper mm using Ramer-Douglas-Peucker
 * while preserving natural handwriting fidelity and staying under `maxPoints`.
 */
export function simplifyStroke(points: readonly Vec2[], toleranceMm = 0.55, maxPoints = 450): Vec2[] {
  if (points.length <= 2) return points.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
  // Drop near-duplicate adjacent samples first.
  const deduped: Vec2[] = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= 0.25) deduped.push(p);
  }
  if (deduped.length <= 2) return deduped.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
  let tol = toleranceMm;
  let simplified = rdp(deduped, tol * tol);
  while (simplified.length > maxPoints && tol < 20) {
    tol *= 1.5;
    simplified = rdp(deduped, tol * tol);
  }
  if (simplified.length > maxPoints) {
    const step = (simplified.length - 1) / (maxPoints - 1);
    const sampled: Vec2[] = [];
    for (let i = 0; i < maxPoints; i++) {
      const q = simplified[Math.min(simplified.length - 1, Math.round(i * step))];
      if (q) sampled.push(q);
    }
    simplified = sampled;
  }
  return simplified.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
}

function strokePathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Snap an endpoint relative to `a` to horizontal, vertical, or 45° when within `snapDeg`. */
export function snapAngleEndpoint(a: Vec2, b: Vec2, snapDeg = 9): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return b;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const nearest45 = Math.round(deg / 45) * 45;
  if (Math.abs(deg - nearest45) <= snapDeg) {
    const rad = (nearest45 * Math.PI) / 180;
    return { x: Math.round((a.x + Math.cos(rad) * len) * 100) / 100, y: Math.round((a.y + Math.sin(rad) * len) * 100) / 100 };
  }
  return { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100 };
}

/**
 * Optional smart-shape recognition for hand-drawn strokes on a sheet:
 * - Near-straight strokes snap to a clean 2-point line (and 0°/45°/90° when close).
 * - Closed round loops snap to a clean circle.
 * - Closed boxy loops snap to an axis-aligned rectangle.
 * Returns `null` for handwriting, arrows, or freeform sketches so they stay untouched.
 */
export function recognizeSmartShape(points: readonly Vec2[]): { readonly shape: MarkupSmartShape; readonly points: Vec2[] } | null {
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;

  const pathLen = strokePathLength(points);
  if (pathLen < 8) return null;

  const endGap = Math.hypot(last.x - first.x, last.y - first.y);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  const diag = Math.hypot(bw, bh);
  if (diag < 6) return null;

  // 1. Straight line check (open stroke whose points stay tightly along the chord).
  if (endGap >= diag * 0.72 && pathLen <= endGap * 1.18) {
    let maxDev = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      if (!p) continue;
      const d = Math.sqrt(pointToSegmentDistSq(p, first, last));
      if (d > maxDev) maxDev = d;
    }
    const lineTol = Math.max(2.5, endGap * 0.055);
    if (maxDev <= lineTol) {
      const a = { x: Math.round(first.x * 100) / 100, y: Math.round(first.y * 100) / 100 };
      const b = snapAngleEndpoint(a, last, 9);
      return { shape: "line", points: [a, b] };
    }
  }

  // 2. Closed shape checks (circle or axis-aligned rectangle).
  if (endGap <= Math.max(12, diag * 0.32) && bw >= 6 && bh >= 6) {
    // Check rectangle first: points hug the 4 bounding-box edges cleanly.
    const rectEdges: ReadonlyArray<readonly [Vec2, Vec2]> = [
      [{ x: minX, y: minY }, { x: maxX, y: minY }],
      [{ x: maxX, y: minY }, { x: maxX, y: maxY }],
      [{ x: maxX, y: maxY }, { x: minX, y: maxY }],
      [{ x: minX, y: maxY }, { x: minX, y: minY }],
    ];
    let rectErrSum = 0;
    let rectMaxErr = 0;
    for (const p of points) {
      let best = Infinity;
      for (const [ea, eb] of rectEdges) {
        const d = Math.sqrt(pointToSegmentDistSq(p, ea, eb));
        if (d < best) best = d;
      }
      rectErrSum += best;
      if (best > rectMaxErr) rectMaxErr = best;
    }
    const rectMeanErr = rectErrSum / points.length;
    const rectPerim = 2 * (bw + bh);
    const rectTol = Math.max(2.5, Math.min(bw, bh) * 0.14);

    // Check circle: points maintain steady distance from bounding-box center with roughly circular aspect ratio.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh);
    let rSum = 0;
    const radii: number[] = [];
    for (const p of points) {
      const r = Math.hypot(p.x - cx, p.y - cy);
      radii.push(r);
      rSum += r;
    }
    const meanR = rSum / points.length;
    let varSum = 0;
    for (const r of radii) varSum += (r - meanR) * (r - meanR);
    const rStd = Math.sqrt(varSum / points.length);
    const circleCirc = 2 * Math.PI * meanR;

    const looksCircle = aspect >= 0.72 && meanR >= 3 && rStd / meanR <= 0.16 && pathLen >= circleCirc * 0.78 && pathLen <= circleCirc * 1.35;
    const looksRect = rectMeanErr <= rectTol * 0.65 && rectMaxErr <= rectTol * 1.45 && pathLen >= rectPerim * 0.78 && pathLen <= rectPerim * 1.35;

    if (looksRect && (!looksCircle || rectMeanErr / Math.min(bw, bh) < rStd / Math.max(1, meanR) * 0.85)) {
      const r = (v: number) => Math.round(v * 100) / 100;
      return {
        shape: "rect",
        points: [
          { x: r(minX), y: r(minY) },
          { x: r(maxX), y: r(minY) },
          { x: r(maxX), y: r(maxY) },
          { x: r(minX), y: r(maxY) },
        ],
      };
    }

    if (looksCircle) {
      const steps = 36;
      const circlePts: Vec2[] = [];
      for (let i = 0; i < steps; i++) {
        const theta = (i / steps) * Math.PI * 2;
        circlePts.push({
          x: Math.round((cx + Math.cos(theta) * meanR) * 100) / 100,
          y: Math.round((cy + Math.sin(theta) * meanR) * 100) / 100,
        });
      }
      return { shape: "circle", points: circlePts };
    }
  }

  return null;
}

/** Hit-test whether a paper-mm point `at` falls within `reachMm` of a markup stroke. */
export function hitTestMarkup(item: Pick<DrawingItem, "points" | "markup">, at: Vec2, extraReachMm = 2.5): boolean {
  if (item.points.length === 0) return false;
  const reach = Math.max(extraReachMm, (item.markup?.widthMm ?? DEFAULT_MARKER_WIDTH_MM) * 0.75 + extraReachMm);
  const reachSq = reach * reach;
  if (item.points.length === 1) {
    const p = item.points[0];
    return p !== undefined && (p.x - at.x) * (p.x - at.x) + (p.y - at.y) * (p.y - at.y) <= reachSq;
  }
  const closed = item.markup?.smartShape === "circle" || item.markup?.smartShape === "rect";
  const count = closed ? item.points.length : item.points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = item.points[i];
    const b = item.points[(i + 1) % item.points.length];
    if (a && b && pointToSegmentDistSq(at, a, b) <= reachSq) return true;
  }
  return false;
}
