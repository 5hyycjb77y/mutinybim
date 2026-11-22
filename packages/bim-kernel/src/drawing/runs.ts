import { add, perp, scale, sub, unit } from "../geometry";
import { partToWorld } from "../parts";
import { flexPlanLines } from "../routing/flex";
import { FaceIndex, cellFor, planProjector, projectSolid, splitHidden } from "./projection";
import { elementSolid } from "./solids";
import { fittingBody, segmentWidthAxis, straightPiece, type Ring } from "../routing/fittings/geometry";
import { drawnWidth } from "../routing/pipe/geometry";
import { sizeLabel, sizeWidth } from "../routing/rules";
import type { BimElement, ModelState, PartInstance, RunFitting, RunSegment, Vec2 } from "../types";
import type { Pen } from "./sheet";
import { drawInsulationPlan } from "./insulation";
import { styleOfSystemId, systemLineCode } from "../routing/system-graphics";
import { partClearances } from "../spatial";
import { runViewCategory } from "../categories/element";
import type { DetailLevel } from "../part-model/schema";
import { resolveTextStyle } from "../organization/model";
import {
  DEFAULT_SYMBOL_SCALE,
  arcPolyline,
  growBox,
  lineEndpoints,
  partPlanOutline,
  resolvePartPlan,
  type PartLabelBox,
  type PlanOutline,
} from "./part-outline";

export { partPlanOutline, type PartLabelBox, type PlanOutline };

/**
 * Plan linework for routed runs and placed parts. Duct draws double-line at
 * its width; pipe and conduit draw single-line, with the system's line type.
 * Vertical pieces (drops and rises) draw as their cross-section with a
 * diagonal. Fittings close the linework where pieces meet.
 */

export interface TextDrawStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontFamily?: string;
  readonly mask?: boolean;
  readonly color?: string;
}

export type LineFn = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => void;
export type TextFn = (at: Vec2, text: string, size: number, anchor?: "start" | "middle" | "end", style?: TextDrawStyle) => void;
/** Emits a rotated inline label; returns true when it fit and was placed (so the caller cuts a gap in the line only when placed). */
export type InlineTextFn = (at: Vec2, text: string, size: number, rotationDeg: number) => boolean;
export type FillFn = (points: readonly Vec2[], grey: number) => void;

/** Spatial hash index for occupied label/symbol boxes — O(1) average lookup so large plans stay linear. */
export class PartLabelIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, PartLabelBox[]>();

  constructor(viewScale = DEFAULT_SYMBOL_SCALE) {
    this.cellSize = Math.max(20 * viewScale, 500);
  }

  private range(box: PartLabelBox): readonly [number, number, number, number] {
    const cs = this.cellSize;
    return [Math.floor(box.min.x / cs), Math.floor(box.max.x / cs), Math.floor(box.min.y / cs), Math.floor(box.max.y / cs)];
  }

  add(box: PartLabelBox): void {
    const [x0, x1, y0, y1] = this.range(box);
    // Guard against huge boxes (e.g. long perimeter walls) spanning hundreds of cells: clamp cell span.
    const spanX = Math.min(x1 - x0, 64);
    const spanY = Math.min(y1 - y0, 64);
    for (let x = x0; x <= x0 + spanX; x++) {
      for (let y = y0; y <= y0 + spanY; y++) {
        const k = `${x},${y}`;
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(box);
      }
    }
  }

  overlaps(box: PartLabelBox): boolean {
    const [x0, x1, y0, y1] = this.range(box);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const list = this.cells.get(`${x},${y}`);
        if (!list) continue;
        for (const other of list) if (boxesOverlap(box, other)) return true;
      }
    }
    return false;
  }
}

export type PartLabelStore = PartLabelIndex | PartLabelBox[];

function addLabelBox(store: PartLabelStore | undefined, box: PartLabelBox): void {
  if (!store) return;
  if (store instanceof PartLabelIndex) store.add(box);
  else store.push(box);
}

function overlapsLabelStore(store: PartLabelStore, box: PartLabelBox): boolean {
  if (store instanceof PartLabelIndex) return store.overlaps(box);
  return store.some((t) => boxesOverlap(box, t));
}

export interface DrawPartSymbolOptions {
  /** View scale (model mm per paper mm). Used to size paper-space symbols and smart label offsets. Default 48. */
  readonly scale?: number;
  /** View-level multiplier for paper-space symbols and `minPaperMm` floors (0.5–3.0). Default 1. */
  readonly symbolScale?: number;
  /** Whether to draw the part's automatic mark. Set to false when a real tag is placed on the part or tags are hidden. Default true. */
  readonly showMark?: boolean;
  /** Filled polygon callback (grey 1 = opaque white mask, 0 = solid black fill). */
  readonly fill?: FillFn;
  /** True vector circle outline callback (center and radius in model mm). When omitted, circles fall back to polygon line segments. */
  readonly circle?: (center: Vec2, radius: number, pen: Pen) => void;
  /** Occupied label/symbol boxes in model mm so auto-placed marks avoid colliding with symbols and each other. */
  readonly takenBoxes?: PartLabelStore;
  /** Optional sink notified whenever an automatic part mark is placed (used for interactive mark picking/dragging). */
  readonly onMarkPlaced?: (mark: { readonly partId: string; readonly text: string; readonly at: Vec2; readonly sizeMm: number }) => void;
}

export interface RunDrawOptions {
  /** Resolved detail level for this run (category override ?? view detailLevel). */
  readonly detail?: DetailLevel;
  /** Runs narrower than this nominal width (mm) draw single-line; at or above draw double-line. */
  readonly singleLineBelowMm?: number | null;
  /** Inline repeating service code ("CW", "SAN", "G") for single-line runs; undefined suppresses. */
  readonly lineCode?: string;
  /** Rotated text callback for inline service codes; returns true when emitted. */
  readonly inlineText?: InlineTextFn;
  /** Default pen for single-line runs when the system has no weight override. */
  readonly singleLinePen?: Pen;
  /** Optional model-space crop bounds so very long runs only iterate visible inline labels. */
  readonly clipBounds?: { readonly min: Vec2; readonly max: Vec2 };
  /** Optional resolver for a connected fitting's own single-line decision (handles mismatched category overrides). */
  readonly fittingIsSingleLine?: (f: RunFitting) => boolean;
}

const plan = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: p.y });
/** Truly plumb (vertical) port direction (> ~81°); 45° slopes stay non-plumb so they project as bends. */
const isPlumb = (d: { x: number; y: number; z: number }): boolean => Math.hypot(d.x, d.y) < 0.15 && Math.abs(d.z) > 0.85;
const flatDir = (d: { x: number; y: number; z: number }): boolean => !isPlumb(d);

/** Paper-mm schematic symbol radii, scaled by `scaleMmPerPaperMm` into model mm. */
const SCHEMATIC_TICK_HALF_MM = 1.25;
const SCHEMATIC_FITTING_OFFSET_MM = 1.8;
const SCHEMATIC_NODE_RADIUS_MM = 1.5;

/**
 * Domain-neutral single-line vs double-line rule:
 * - If a category/service sets `singleLineBelowMm`, runs narrower than that
 *   threshold draw single-line and runs at or above draw double-line.
 * - Otherwise: Coarse = all single-line; Medium = air runs double-line, other
 *   runs single-line schematic; Fine = all double-line.
 */
const BEND_FITTING: RunFitting["fittingType"] = "elbow";
const BRANCH_TAP_FITTING: RunFitting["fittingType"] = "tap";
export function isSingleLineRun(domain: RunSegment["domain"], size: RunSegment["size"] | undefined, detail: DetailLevel = "medium", singleLineBelowMm: number | null = null): boolean {
  if (singleLineBelowMm !== null && singleLineBelowMm !== undefined) {
    if (singleLineBelowMm <= 0) return false;
    return size ? sizeWidth(size) < singleLineBelowMm : detail !== "fine";
  }
  if (detail === "coarse") return true;
  if (detail === "fine") return false;
  return domain !== "duct";
}

/** The system's line pattern and weight (system-graphics.ts): vent dashed, cold water dash-dot, gas long dash, or the system's own. */
export function systemLine(model: ModelState, systemId: string): { readonly dash: number[] | undefined; readonly weight: Pen | undefined; readonly lineCode: string | undefined } {
  const style = styleOfSystemId(model.elements, systemId);
  return { dash: style?.dash ? [...style.dash] : undefined, weight: style?.weight, lineCode: systemLineCode(model.elements, systemId) };
}

function circle(center: Vec2, r: number, line: LineFn, pen: Pen): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    line({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) }, { x: center.x + r * Math.cos(b), y: center.y + r * Math.sin(b) }, pen);
  }
}

function riseDot(center: Vec2, r: number, line: LineFn, pen: Pen): void {
  const dr = r * 0.34;
  circle(center, dr, line, pen);
  line({ x: center.x - dr, y: center.y }, { x: center.x + dr, y: center.y }, pen);
  line({ x: center.x, y: center.y - dr }, { x: center.x, y: center.y + dr }, pen);
}

function jointTick(origin: Vec2, dir: Vec2, offset: number, halfLen: number, line: LineFn): void {
  const c = add(origin, scale(dir, offset));
  const n = perp(dir);
  line(add(c, scale(n, halfLen)), add(c, scale(n, -halfLen)), "thin");
}

function vertical(seg: RunSegment): boolean {
  return Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y) < 0.01;
}

/** Effective schematic bend radius for a bend fitting, coordinated with connected leg lengths so short legs never bleed through the bend. */
function elbowOffsetMm(model: ModelState, f: RunFitting, scaleMmPerPaperMm: number): number {
  let maxR = SCHEMATIC_FITTING_OFFSET_MM * scaleMmPerPaperMm;
  for (const pt of f.ports) {
    const link = pt.link;
    const seg = link ? model.elements[link.elementId] : undefined;
    if (seg?.kind === "run_segment") {
      const legLen = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
      if (legLen > 1e-3) maxR = Math.min(maxR, legLen * 0.35);
    }
  }
  return maxR;
}

/** How far to trim a single-line segment's endpoint back so curved elbows and rise circles draw cleanly without lines bleeding through. */
function schematicEndTrimMm(model: ModelState, seg: RunSegment, end: "start" | "end", scaleMmPerPaperMm: number, detail: DetailLevel, singleLineBelowMm: number | null, fittingIsSingleLine?: (f: RunFitting) => boolean): number {
  const link = seg.links[end];
  if (!link) return 0;
  const f = model.elements[link.elementId];
  if (f?.kind !== "run_fitting") return 0;
  const fSingle = fittingIsSingleLine ? fittingIsSingleLine(f) : isSingleLineRun(f.domain, f.ports[0]?.size ?? seg.size, detail, singleLineBelowMm);
  if (!fSingle) return 0;
  if (f.fittingType === BEND_FITTING && f.ports.length >= 2) {
    const [pa, pb] = f.ports;
    if (!pa || !pb) return 0;
    if (flatDir(pa.direction) && flatDir(pb.direction)) {
      const da = unit(plan(pa.direction));
      const db = unit(plan(pb.direction));
      // Only curve non-collinear bends.
      if (Math.abs(da.x * db.y - da.y * db.x) > 0.05) return elbowOffsetMm(model, f, scaleMmPerPaperMm);
      return 0;
    }
    const vPort = !flatDir(pa.direction) ? pa : !flatDir(pb.direction) ? pb : null;
    // Turning UP (rise): pipe stops at the circle perimeter; turning DOWN (drop): pipe runs to center.
    if (vPort && vPort.direction.z > 0.5) return SCHEMATIC_NODE_RADIUS_MM * scaleMmPerPaperMm;
  }
  if ((f.fittingType === "tee" || f.fittingType === BRANCH_TAP_FITTING) && f.ports.some((pt) => !flatDir(pt.direction) && pt.direction.z > 0.5)) {
    return SCHEMATIC_NODE_RADIUS_MM * scaleMmPerPaperMm;
  }
  return 0;
}

/** Angle in degrees for upright text along unit vector `u` (always readable from bottom or right: (-90, 90]). */
function uprightAngleDeg(u: Vec2): number {
  let deg = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  else if (deg <= -90) deg += 180;
  return deg;
}

/** Visible [tMin, tMax] parameter interval of segment a->b against an axis-aligned crop box, or null if outside. */
function visibleParamRange(a: Vec2, b: Vec2, clip: { readonly min: Vec2; readonly max: Vec2 }): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: readonly [number, number][] = [
    [-dx, a.x - clip.min.x],
    [dx, clip.max.x - a.x],
    [-dy, a.y - clip.min.y],
    [dy, clip.max.y - a.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return null;
    }
  }
  return [t0, t1];
}

/** Draw a single-line run, breaking for repeating inline service codes ("CW", "SAN", "G") when configured and actually placed. */
function drawSingleLineWithCode(a: Vec2, b: Vec2, pen: Pen, dash: number[] | undefined, line: LineFn, scaleMmPerPaperMm: number, lineCode: string | undefined, inlineText: InlineTextFn | undefined, clipBounds?: { readonly min: Vec2; readonly max: Vec2 }): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return;
  if (!lineCode || !inlineText) {
    line(a, b, pen, dash);
    return;
  }
  const paperLen = len / scaleMmPerPaperMm;
  const textSize = 1.8;
  // Conservative glyph width (1.0 * cap height per char + generous end padding) so wide glyphs like W/M never get struck through.
  const gapPaper = lineCode.length * textSize * 1.0 + 2.8;
  if (paperLen < gapPaper + 12) {
    line(a, b, pen, dash);
    return;
  }
  const pitchPaper = Math.max(55, gapPaper + 24);
  const count = Math.max(1, Math.floor((paperLen - 12) / pitchPaper));
  const u = unit(sub(b, a));
  const angle = uprightAngleDeg(u);
  const halfGapModel = (gapPaper / 2) * scaleMmPerPaperMm;
  let iStart = 0;
  let iEnd = count - 1;
  if (clipBounds) {
    const range = visibleParamRange(a, b, clipBounds);
    if (!range) {
      line(a, b, pen, dash);
      return;
    }
    const padT = halfGapModel / len;
    iStart = Math.max(0, Math.floor((range[0] - padT) * count - 0.5));
    iEnd = Math.min(count - 1, Math.ceil((range[1] + padT) * count - 0.5));
  }
  let cursor = 0;
  for (let i = iStart; i <= iEnd; i++) {
    const centerDist = ((i + 0.5) / count) * len;
    const at = add(a, scale(u, centerDist));
    // Only cut a gap in the pipe when the label is actually accepted & emitted.
    if (!inlineText(at, lineCode, textSize, angle)) continue;
    const gapStart = Math.max(cursor, centerDist - halfGapModel);
    const gapEnd = Math.min(len, centerDist + halfGapModel);
    if (gapStart - cursor > 1e-3) line(add(a, scale(u, cursor)), add(a, scale(u, gapStart)), pen, dash);
    cursor = gapEnd;
  }
  if (len - cursor > 1e-3) line(add(a, scale(u, cursor)), b, pen, dash);
}

export function drawRunSegment(model: ModelState, seg: RunSegment, line: LineFn, label: TextFn | null, scaleMmPerPaperMm: number, opts?: RunDrawOptions): void {
  const detail = opts?.detail ?? "medium";
  const singleLineBelowMm = opts?.singleLineBelowMm ?? null;
  const singleLine = isSingleLineRun(seg.domain, seg.size, detail, singleLineBelowMm);
  const w = singleLine ? sizeWidth(seg.size) : drawnWidth(seg.size);
  const { dash, weight } = systemLine(model, seg.systemId);
  const singlePen = weight ?? opts?.singleLinePen ?? "wide";
  const a = plan(seg.start);
  const b = plan(seg.end);
  if (seg.flex) {
    if (singleLine) {
      // Single-line flex: draw its curved centreline.
      const pts = seg.flex.path;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        if (p0 && p1) line(plan(p0), plan(p1), singlePen, dash);
      }
    } else {
      // Flex: both edges along its curve with ticks across, labelled as flex.
      for (const [p, q, what] of flexPlanLines(seg)) line(p, q, what === "edge" ? "medium" : "thin");
    }
    const mid = seg.flex.path[Math.floor(seg.flex.path.length / 2)] ?? seg.start;
    if (label) label(add(plan(mid), { x: 0, y: (singleLine ? 0 : sizeWidth(seg.size) / 2) + 6 * scaleMmPerPaperMm }), `${sizeLabel(seg.size)} FLEX`, 2.5);
    return;
  }
  drawInsulationPlan(model, seg, line);
  if (vertical(seg)) {
    // A drop or rise, seen from above.
    const h = singleLine ? Math.max(w / 2, SCHEMATIC_NODE_RADIUS_MM * scaleMmPerPaperMm) : Math.max(w, 50) / 2;
    if (!singleLine && seg.domain === "duct" && seg.size.shape === "rect") {
      // Turned the way the elbows into it turn it.
      const wa = segmentWidthAxis(model.elements, seg);
      const ha = { x: -wa.y, y: wa.x };
      const hy = seg.size.height / 2;
      const at = (sw: number, sh: number) => add(a, { x: wa.x * sw * h + ha.x * sh * hy, y: wa.y * sw * h + ha.y * sh * hy });
      const corners = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
      for (let i = 0; i < 4; i++) line(corners[i] ?? a, corners[(i + 1) % 4] ?? a, "medium");
      line(corners[0] ?? a, corners[2] ?? a, "thin");
    } else if (singleLine) {
      // When a connected fitting owns the rise/drop transition symbol, don't overwrite a drop circle with a rise dot.
      const ownedByFitting = [seg.links.start, seg.links.end].some((l) => {
        const f = l ? model.elements[l.elementId] : undefined;
        return f?.kind === "run_fitting" && f.ports.some((pt) => !flatDir(pt.direction));
      });
      if (!ownedByFitting) {
        const pen = seg.domain === "duct" ? (weight ?? "medium") : singlePen;
        circle(a, h, line, pen);
        riseDot(a, h, line, "thin");
      }
    } else {
      circle(a, h, line, weight ?? "medium");
      const r = h * 0.7;
      line({ x: a.x - r, y: a.y - r }, { x: a.x + r, y: a.y + r }, "thin");
    }
    return;
  }
  // Library fittings take real length: the straight piece stops where their bodies begin.
  const fromLibrary = [seg.links.start, seg.links.end].some((l) => {
    const f = l ? model.elements[l.elementId] : undefined;
    return f?.kind === "run_fitting" && f.family !== undefined;
  });
  const piece = !singleLine && fromLibrary ? straightPiece(model.elements, seg) : null;
  const u = unit(sub(b, a));
  const n = perp(u);
  if (piece) {
    // Fittings meeting end to end leave no straight run to draw.
    if (piece.lengthMm > 0) {
      const pa = plan(piece.start);
      const pb = plan(piece.end);
      line(add(pa, scale(n, w / 2)), add(pb, scale(n, w / 2)), weight ?? "medium", dash);
      line(add(pa, scale(n, -w / 2)), add(pb, scale(n, -w / 2)), weight ?? "medium", dash);
      if (!seg.links.start) line(add(pa, scale(n, w / 2)), add(pa, scale(n, -w / 2)), "medium");
      if (!seg.links.end) line(add(pb, scale(n, w / 2)), add(pb, scale(n, -w / 2)), "medium");
    }
  } else if (!singleLine) {
    line(add(a, scale(n, w / 2)), add(b, scale(n, w / 2)), weight ?? "medium", dash);
    line(add(a, scale(n, -w / 2)), add(b, scale(n, -w / 2)), weight ?? "medium", dash);
    // An open end shows as its end line.
    if (!seg.links.start) line(add(a, scale(n, w / 2)), add(a, scale(n, -w / 2)), "medium");
    if (!seg.links.end) line(add(b, scale(n, w / 2)), add(b, scale(n, -w / 2)), "medium");
  } else {
    const runLen = Math.hypot(b.x - a.x, b.y - a.y);
    const trimA = opts ? Math.min(runLen * 0.45, schematicEndTrimMm(model, seg, "start", scaleMmPerPaperMm, detail, singleLineBelowMm, opts.fittingIsSingleLine)) : 0;
    const trimB = opts ? Math.min(runLen * 0.45, schematicEndTrimMm(model, seg, "end", scaleMmPerPaperMm, detail, singleLineBelowMm, opts.fittingIsSingleLine)) : 0;
    const pa = trimA > 0 ? add(a, scale(u, trimA)) : a;
    const pb = trimB > 0 ? add(b, scale(u, -trimB)) : b;
    drawSingleLineWithCode(pa, pb, singlePen, dash, line, scaleMmPerPaperMm, opts?.lineCode, opts?.inlineText, opts?.clipBounds);
  }
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  if (label && run / scaleMmPerPaperMm > 25) {
    const at = add(scale(add(a, b), 0.5), scale(n, (!singleLine ? w / 2 : 0) + 6 * scaleMmPerPaperMm));
    label(at, sizeLabel(seg.size), 2.5);
  }
}

/** A library fitting's outline in plan: both sides of every tube, joint lines, and (fine detail) turning vanes. */
function drawBody(model: ModelState, f: RunFitting, line: LineFn, vanes: boolean): boolean {
  const body = fittingBody(model.elements, f);
  if (body.tubes.length === 0 && body.plates.length === 0) return false;
  const side = (r: Ring, k: 1 | -1): Vec2 => {
    // The horizontal half-axis is what shows in plan.
    const h = Math.abs(r.a.z) <= Math.abs(r.b.z) ? r.a : r.b;
    return { x: r.center.x + k * h.x, y: r.center.y + k * h.y };
  };
  for (const tube of body.tubes) {
    for (let i = 0; i + 1 < tube.rings.length; i++) {
      const r0 = tube.rings[i];
      const r1 = tube.rings[i + 1];
      if (!r0 || !r1) continue;
      line(side(r0, 1), side(r1, 1), "medium");
      line(side(r0, -1), side(r1, -1), "medium");
    }
    const first = tube.rings[0];
    const last = tube.rings[tube.rings.length - 1];
    for (const r of first && last ? [first, last] : []) line(side(r, 1), side(r, -1), "thin");
  }
  for (const plate of vanes ? body.plates : []) {
    if (plate.kind !== "sheet") continue;
    for (let i = 0; i + 1 < plate.points.length; i++) {
      const q0 = plate.points[i];
      const q1 = plate.points[i + 1];
      if (q0 && q1) line(plan(q0), plan(q1), "thin");
    }
  }
  return true;
}

/**
 * Industry-standard single-line schematic fitting symbols (ASME Y32.2.3 / Revit MEP),
 * sized in paper mm so elbows, tees, wyes, reducers, caps and rise/drop transitions
 * read crisply at every drawing scale instead of bare right angles.
 */
function drawSchematicFitting(model: ModelState, f: RunFitting, line: LineFn, scaleMmPerPaperMm: number, defaultPen: Pen): void {
  const p = plan(f.position);
  const { weight } = systemLine(model, f.systemId);
  const pen = weight ?? defaultPen;
  const tickHalf = SCHEMATIC_TICK_HALF_MM * scaleMmPerPaperMm;
  const offset = SCHEMATIC_FITTING_OFFSET_MM * scaleMmPerPaperMm;
  const nodeR = SCHEMATIC_NODE_RADIUS_MM * scaleMmPerPaperMm;
  const [pa, pb] = f.ports;

  switch (f.fittingType) {
    case BEND_FITTING: {
      if (!pa || !pb) return;
      if (flatDir(pa.direction) && flatDir(pb.direction)) {
        const da = unit(plan(pa.direction));
        const db = unit(plan(pb.direction));
        const bendR = elbowOffsetMm(model, f, scaleMmPerPaperMm);
        if (Math.abs(da.x * db.y - da.y * db.x) <= 0.05) {
          jointTick(p, da, bendR, tickHalf, line);
          jointTick(p, db, bendR, tickHalf, line);
          return;
        }
        const p1 = add(p, scale(da, bendR));
        const p2 = add(p, scale(db, bendR));
        jointTick(p, da, bendR, tickHalf, line);
        jointTick(p, db, bendR, tickHalf, line);
        // Smooth quadratic bend from p1 through corner p to p2.
        const steps = 4;
        let prev = p1;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          const q: Vec2 = {
            x: mt * mt * p1.x + 2 * mt * t * p.x + t * t * p2.x,
            y: mt * mt * p1.y + 2 * mt * t * p.y + t * t * p2.y,
          };
          line(prev, q, pen);
          prev = q;
        }
        return;
      }
      // Vertical transition elbow (horizontal pipe turning UP or DOWN).
      const vPort = !flatDir(pa.direction) ? pa : !flatDir(pb.direction) ? pb : null;
      const hPort = flatDir(pa.direction) ? pa : flatDir(pb.direction) ? pb : null;
      circle(p, nodeR, line, pen);
      if (vPort && vPort.direction.z > 0.5) riseDot(p, nodeR, line, "thin");
      if (hPort) jointTick(p, unit(plan(hPort.direction)), nodeR + 0.5 * scaleMmPerPaperMm, tickHalf * 0.85, line);
      return;
    }
    case "tee":
    case BRANCH_TAP_FITTING: {
      const vPort = f.ports.find((pt) => !flatDir(pt.direction));
      const flatPorts = f.ports.filter((pt) => flatDir(pt.direction));
      if (vPort) {
        circle(p, nodeR, line, pen);
        if (vPort.direction.z > 0.5) riseDot(p, nodeR, line, "thin");
        for (const pt of flatPorts) {
          const pp = plan(pt.position);
          if (Math.hypot(pp.x - p.x, pp.y - p.y) > 1) line(p, pp, pen);
          jointTick(p, unit(plan(pt.direction)), nodeR + 0.5 * scaleMmPerPaperMm, tickHalf * 0.85, line);
        }
        return;
      }
      for (const pt of flatPorts) {
        const pp = plan(pt.position);
        // Hosted branch ports sit on the trunk's outer face; bridge back to the single-line trunk centreline.
        if (Math.hypot(pp.x - p.x, pp.y - p.y) > 1) line(p, pp, pen);
        jointTick(pp, unit(plan(pt.direction)), offset, tickHalf, line);
      }
      return;
    }
    case "wye": {
      const flatPorts = f.ports.filter((pt) => flatDir(pt.direction));
      for (const pt of flatPorts) {
        const pp = plan(pt.position);
        if (Math.hypot(pp.x - p.x, pp.y - p.y) > 1) line(p, pp, pen);
        jointTick(pp, unit(plan(pt.direction)), offset, tickHalf, line);
      }
      // Swept 45° diagonal marker on the branch port so wyes read distinctly from tees.
      if (flatPorts.length >= 3) {
        const dirs = flatPorts.map((pt) => unit(plan(pt.direction)));
        let branchIdx = 2;
        for (let i = 0; i < dirs.length; i++) {
          const di = dirs[i];
          if (!di) continue;
          const hasOpposite = dirs.some((dj, j) => j !== i && dj !== undefined && di.x * dj.x + di.y * dj.y < -0.9);
          if (!hasOpposite) {
            branchIdx = i;
            break;
          }
        }
        const bd = dirs[branchIdx];
        const md = dirs[(branchIdx + 1) % dirs.length];
        if (bd && md) {
          line(add(p, scale(bd, offset * 0.9)), add(p, scale(md, offset * 0.9)), "thin");
        }
      } else if (pa) {
        // Hosted wye on a continuous trunk: derive trunk axis from the host segment when available.
        const hostSeg = f.host ? model.elements[f.host.segmentId] : undefined;
        const bd = unit(plan(pa.direction));
        const trunkDir = hostSeg?.kind === "run_segment" && !vertical(hostSeg) ? unit(sub(plan(hostSeg.end), plan(hostSeg.start))) : perp(bd);
        const branchStart = add(p, scale(bd, offset * 0.9));
        const trunkPt = add(p, scale(trunkDir, offset * 0.9));
        line(branchStart, trunkPt, "thin");
      }
      return;
    }
    case "accessory": {
      // Inline valve / cleanout / damper bowtie symbol along host segment axis.
      const hostSeg = f.host ? model.elements[f.host.segmentId] : undefined;
      const d = hostSeg?.kind === "run_segment" && !vertical(hostSeg) ? unit(sub(plan(hostSeg.end), plan(hostSeg.start))) : { x: 1, y: 0 };
      const n = perp(d);
      const halfLen = 1.4 * scaleMmPerPaperMm;
      const halfW = 1.0 * scaleMmPerPaperMm;
      const a1 = add(add(p, scale(d, -halfLen)), scale(n, halfW));
      const a2 = add(add(p, scale(d, -halfLen)), scale(n, -halfW));
      const b1 = add(add(p, scale(d, halfLen)), scale(n, halfW));
      const b2 = add(add(p, scale(d, halfLen)), scale(n, -halfW));
      line(a1, a2, pen);
      line(b1, b2, pen);
      line(a1, b2, pen);
      line(a2, b1, pen);
      return;
    }
    case "transition": {
      if (!pa || !pb || !flatDir(pa.direction)) return;
      const d = unit(plan(pa.direction));
      const n = perp(d);
      const aLarger = sizeWidth(pa.size) >= sizeWidth(pb.size);
      const halfLen = 1.4 * scaleMmPerPaperMm;
      const wBig = 1.2 * scaleMmPerPaperMm;
      const wSmall = 0.45 * scaleMmPerPaperMm;
      const pA = add(p, scale(d, halfLen));
      const pB = add(p, scale(d, -halfLen));
      const wA = aLarger ? wBig : wSmall;
      const wB = aLarger ? wSmall : wBig;
      const a1 = add(pA, scale(n, wA));
      const a2 = add(pA, scale(n, -wA));
      const b1 = add(pB, scale(n, wB));
      const b2 = add(pB, scale(n, -wB));
      line(a1, a2, "thin");
      line(b1, b2, "thin");
      line(a1, b1, "thin");
      line(a2, b2, "thin");
      return;
    }
    case "cap": {
      if (!pa || !flatDir(pa.direction)) return;
      const d = unit(plan(pa.direction));
      const n = perp(d);
      const w = 1.2 * scaleMmPerPaperMm;
      const capOut = scale(d, -0.7 * scaleMmPerPaperMm);
      const c1 = add(p, scale(n, w));
      const c2 = add(p, scale(n, -w));
      const tip1 = add(add(p, scale(n, w * 0.7)), capOut);
      const tip2 = add(add(p, scale(n, -w * 0.7)), capOut);
      line(c1, c2, pen);
      line(c1, tip1, pen);
      line(tip1, tip2, pen);
      line(tip2, c2, pen);
      return;
    }
    case "offset": {
      if (!pa || !pb) return;
      const a = plan(pa.position);
      const b = plan(pb.position);
      line(a, b, pen);
      if (flatDir(pa.direction)) jointTick(a, unit(plan(pa.direction)), 0, tickHalf, line);
      if (flatDir(pb.direction)) jointTick(b, unit(plan(pb.direction)), 0, tickHalf, line);
      return;
    }
  }
}

/** Effective nominal size of a fitting for single-line threshold checks (falls back to host segment for portless hosted accessories). */
function fittingSize(model: ModelState, f: RunFitting): RunSegment["size"] | undefined {
  if (f.ports[0]?.size) return f.ports[0].size;
  if (f.host) {
    const host = model.elements[f.host.segmentId];
    if (host?.kind === "run_segment") return host.size;
  }
  return undefined;
}

export function drawRunFitting(model: ModelState, f: RunFitting, line: LineFn, vanes = true, scaleMmPerPaperMm = 48, opts?: Pick<RunDrawOptions, "detail" | "singleLineBelowMm" | "singleLinePen">): void {
  drawInsulationPlan(model, f, line);
  const detail = opts?.detail ?? (vanes ? "fine" : "medium");
  const threshold = opts?.singleLineBelowMm ?? null;
  // Transition straddling a singleLineBelowMm threshold: one side is double-line and the other single-line regardless of port order.
  if (opts !== undefined && f.fittingType === "transition" && f.ports.length >= 2) {
    const [pa, pb] = f.ports;
    if (pa && pb) {
      const aSingle = isSingleLineRun(f.domain, pa.size, detail, threshold);
      const bSingle = isSingleLineRun(f.domain, pb.size, detail, threshold);
      if (aSingle !== bSingle && flatDir(pa.direction)) {
        const p = plan(f.position);
        const doublePort = aSingle ? pb : pa;
        const singlePort = aSingle ? pa : pb;
        const d = unit(plan(doublePort.direction));
        const n = perp(d);
        const halfW = (f.domain === "duct" ? sizeWidth(doublePort.size) : drawnWidth(doublePort.size)) / 2;
        const halfLen = Math.max(halfW, 1.4 * scaleMmPerPaperMm);
        const pDouble = add(p, scale(d, halfLen));
        const pSingle = add(p, scale(unit(plan(singlePort.direction)), halfLen));
        const d1 = add(pDouble, scale(n, halfW));
        const d2 = add(pDouble, scale(n, -halfW));
        const pen = opts.singleLinePen ?? (f.domain === "duct" ? "wide" : "medium");
        line(d1, d2, "medium");
        line(d1, pSingle, "medium");
        line(d2, pSingle, "medium");
        line(p, pSingle, pen);
        return;
      }
    }
  }
  const singleLine = opts !== undefined ? isSingleLineRun(f.domain, fittingSize(model, f), detail, threshold) : f.domain !== "duct";
  if (singleLine && opts !== undefined) {
    drawSchematicFitting(model, f, line, scaleMmPerPaperMm, opts.singleLinePen ?? (f.domain === "duct" ? "wide" : "medium"));
    return;
  }
  if (!singleLine && f.family !== undefined && drawBody(model, f, line, vanes)) return;
  const p = plan(f.position);
  const [pa, pb] = f.ports;
  const flat = (d: { z: number }) => Math.abs(d.z) < 1e-6;
  const isDuct = f.domain === "duct";
  switch (f.fittingType) {
    case BEND_FITTING: {
      if (!pa || !pb) return;
      const w = (isDuct ? sizeWidth(pa.size) : drawnWidth(pa.size)) / 2;
      if (flat(pa.direction) && flat(pb.direction) && !singleLine) {
        const la = perp(unit(plan(pa.direction)));
        const lb = perp(unit(plan(pb.direction)));
        const inner = add(p, sub(scale(la, w), scale(lb, w)));
        const outer = add(p, sub(scale(lb, w), scale(la, w)));
        line(add(p, scale(la, w)), inner, "medium");
        line(inner, add(p, scale(lb, -w)), "medium");
        line(add(p, scale(la, -w)), outer, "medium");
        line(outer, add(p, scale(lb, w)), "medium");
      }
      return;
    }
    case "transition": {
      if (!pa || !pb || !flat(pa.direction)) return;
      const n = perp(unit(plan(pa.direction)));
      const w = Math.max(sizeWidth(pa.size), sizeWidth(pb.size)) / 2;
      line(add(p, scale(n, w)), add(p, scale(n, -w)), isDuct ? "medium" : "wide");
      return;
    }
    case "cap": {
      if (!pa || !flat(pa.direction)) return;
      const n = perp(unit(plan(pa.direction)));
      const w = isDuct ? sizeWidth(pa.size) / 2 : Math.max(sizeWidth(pa.size), 60);
      line(add(p, scale(n, w)), add(p, scale(n, -w)), "wide");
      return;
    }
    case BRANCH_TAP_FITTING:
    case "tee":
    case "wye": {
      if (!pa) return;
      const at = plan(pa.position);
      const d = unit(plan(pa.direction));
      const n = perp(d);
      const w = sizeWidth(pa.size) / 2;
      if (isDuct) {
        line(add(at, scale(n, w)), add(at, scale(n, -w)), "thin");
      } else if (f.fittingType === "wye") {
        line(at, add(at, scale(add(d, n), Math.max(w * 2, 60))), "thin");
      } else {
        circle(at, Math.max(w, 25), line, "thin");
      }
      return;
    }
    case "offset": {
      if (!pa || !pb || !flat(pa.direction)) return;
      const n = perp(unit(plan(pb.direction)));
      const w = sizeWidth(pa.size) / 2;
      line(add(plan(pa.position), scale(n, w)), add(plan(pb.position), scale(n, w)), "medium");
      line(add(plan(pa.position), scale(n, -w)), add(plan(pb.position), scale(n, -w)), "medium");
      return;
    }
  }
}

/** A modeled part seen from above: its sharp and outline edges, with the ones it hides itself left out. */
function drawPartModelPlan(model: ModelState, part: PartInstance, line: LineFn): void {
  const solid = elementSolid(model, part, 0);
  if (!solid?.mesh) return;
  const projected = projectSolid(solid, planProjector(false));
  if (projected.faces.length === 0) return;
  const xs = projected.faces.flatMap((f) => [f.minU, f.maxU]);
  const ys = projected.faces.flatMap((f) => [f.minV, f.maxV]);
  const index = new FaceIndex(cellFor(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)));
  for (const f of projected.faces) index.add(f);
  for (const e of projected.edges) {
    for (const [a, b] of splitHidden(e.a, e.b, index).visible) line({ x: a.u, y: a.v }, { x: b.u, y: b.v }, "medium");
  }
}

const MARK_SIZE_MM = 2.5;
const CLEARANCE_TEXT_MM = 1.8;

function circlePolygon(center: Vec2, r: number, steps = 20): Vec2[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  });
}

function boxesOverlap(a: PartLabelBox, b: PartLabelBox): boolean {
  return a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y;
}

function worldTextBox(at: Vec2, text: string, sizeMm: number, viewScale: number, anchor: "start" | "middle" | "end" = "middle"): PartLabelBox {
  const h = sizeMm * viewScale;
  const w = Math.max(h * 0.75, text.length * sizeMm * 0.74 * viewScale);
  const padX = 1.2 * viewScale;
  const padY = 0.55 * viewScale;
  const minX = anchor === "start" ? at.x : anchor === "end" ? at.x - w : at.x - w / 2;
  return {
    min: { x: minX - padX, y: at.y - h / 2 - padY },
    max: { x: minX + w + padX, y: at.y + h / 2 + padY },
  };
}

/** Pick a collision-free world-mm position for a part's default mark outside its symbol bounds. */
function placePartMark(
  part: PartInstance,
  mark: string,
  bounds: PartLabelBox | null,
  viewScale: number,
  taken: PartLabelStore | undefined,
  hasCenterText: boolean,
  markSizeMm = MARK_SIZE_MM,
): Vec2 {
  const textH = markSizeMm * viewScale;
  const textW = Math.max(textH * 0.75, mark.length * markSizeMm * 0.72 * viewScale);
  const gap = 1.8 * viewScale;
  const box = bounds ?? { min: { x: part.position.x - 1.5 * viewScale, y: part.position.y - 1.5 * viewScale }, max: { x: part.position.x + 1.5 * viewScale, y: part.position.y + 1.5 * viewScale } };
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const bw = box.max.x - box.min.x;
  const bh = box.max.y - box.min.y;
  // Large parts with empty interior (e.g. wide boxes) can keep their mark centered when clear.
  const canCenter = !hasCenterText && bw >= textW * 1.6 && bh >= textH * 2.2;
  const candidates: Vec2[] = [];
  if (canCenter) candidates.push({ x: cx, y: cy });
  // Prefer the room-facing side (+Y in part local coordinates) first so wall-mounted devices never stamp marks onto their host wall.
  const normal = sub(partToWorld(part, { x: 0, y: 1 }), part.position);
  const nLen = Math.hypot(normal.x, normal.y) || 1;
  const nx = normal.x / nLen;
  const ny = normal.y / nLen;
  for (const ring of [1, 2.1, 3.2]) {
    const dx = textW / 2 + gap * ring;
    const dy = textH / 2 + gap * ring;
    const roomSide: Vec2 = {
      x: cx + nx * (bw / 2 + dx) + (Math.abs(nx) < 0.2 ? 0 : 0),
      y: cy + ny * (bh / 2 + dy),
    };
    const roomDiagR: Vec2 = {
      x: roomSide.x + (Math.abs(ny) > 0.5 ? dx * 0.7 : 0),
      y: roomSide.y + (Math.abs(nx) > 0.5 ? dy * 0.8 : 0),
    };
    const roomDiagL: Vec2 = {
      x: roomSide.x - (Math.abs(ny) > 0.5 ? dx * 0.7 : 0),
      y: roomSide.y - (Math.abs(nx) > 0.5 ? dy * 0.8 : 0),
    };
    candidates.push(
      roomSide,
      roomDiagR,
      roomDiagL,
      { x: box.max.x + dx * 0.85, y: box.max.y + dy * 0.75 }, // top-right
      { x: cx, y: box.max.y + dy }, // top
      { x: box.max.x + dx, y: cy }, // right
      { x: cx, y: box.min.y - dy }, // bottom
      { x: box.min.x - dx, y: cy }, // left
      { x: box.max.x + dx * 0.85, y: box.min.y - dy * 0.75 }, // bottom-right
      { x: box.min.x - dx * 0.85, y: box.max.y + dy * 0.75 }, // top-left
      { x: box.min.x - dx * 0.85, y: box.min.y - dy * 0.75 }, // bottom-left
    );
  }
  if (!taken) return candidates[0] ?? part.position;
  for (const at of candidates) {
    const tb = worldTextBox(at, mark, markSizeMm, viewScale);
    if (!overlapsLabelStore(taken, tb)) {
      addLabelBox(taken, tb);
      return at;
    }
  }
  const fallback = candidates[0] ?? part.position;
  addLabelBox(taken, worldTextBox(fallback, mark, markSizeMm, viewScale));
  return fallback;
}

/**
 * A placed part in a plan: its plan symbol, its 3D body seen from above, or
 * both, as its type says unless the view's category says symbol or body
 * (`planSymbol`, from `categories/resolve.ts`; null keeps the type's).
 */
export function drawPartSymbol(
  model: ModelState,
  part: PartInstance,
  line: LineFn,
  text: TextFn,
  planSymbol: boolean | null = null,
  detail: DetailLevel = "medium",
  opts: DrawPartSymbolOptions = {},
): void {
  const viewScale = opts.scale ?? DEFAULT_SYMBOL_SCALE;
  const symScale = opts.symbolScale ?? 1;
  const resolved = resolvePartPlan(model, part, planSymbol, detail, viewScale, symScale);
  if (!resolved) return;
  const w = (q: Vec2) => partToWorld(part, q);
  if (resolved.planDisplay === "model" || resolved.planDisplay === "both") drawPartModelPlan(model, part, line);
  const symbols = resolved.symbols;
  const fill = opts.fill;
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let hasCenterText = false;

  // Pass 1: opaque white masks first so background linework and under-parts runs never bleed through.
  // Cache tessellated circle rings so Pass 3 reuses the exact vertices without recomputing cos/sin.
  const circleRings = new Map<number, Vec2[]>();
  const ringFor = (idx: number, c: Vec2, r: number): Vec2[] => {
    let pts = circleRings.get(idx);
    if (!pts) {
      pts = circlePolygon(c, r, r <= 2.5 * viewScale ? 24 : 32);
      circleRings.set(idx, pts);
    }
    return pts;
  };
  if (fill) {
    for (let idx = 0; idx < symbols.length; idx++) {
      const s = symbols[idx]!;
      if (s.kind === "rect" && s.fill === "mask") {
        const hx = s.size.x / 2;
        const hy = s.size.y / 2;
        const c = s.center;
        fill([w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })], 1);
      } else if (s.kind === "circle" && s.fill === "mask") {
        fill(ringFor(idx, w(s.center), s.radius), 1);
      } else if (s.kind === "polyline" && s.closed && s.fill === "mask" && s.points.length >= 3) {
        fill(s.points.map(w), 1);
      }
    }
    // Pass 2: solid black fills (half-filled indicators, shaded symbols).
    for (let idx = 0; idx < symbols.length; idx++) {
      const s = symbols[idx]!;
      if (s.kind === "rect" && s.fill === "solid") {
        const hx = s.size.x / 2;
        const hy = s.size.y / 2;
        const c = s.center;
        fill([w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })], 0);
      } else if (s.kind === "circle" && s.fill === "solid") {
        fill(ringFor(idx, w(s.center), s.radius), 0);
      } else if (s.kind === "polyline" && s.closed && s.fill === "solid" && s.points.length >= 3) {
        fill(s.points.map(w), 0);
      }
    }
  }

  // Pass 3: symbol strokes and embedded text.
  for (let idx = 0; idx < symbols.length; idx++) {
    const s = symbols[idx]!;
    switch (s.kind) {
      case "rect": {
        const hx = s.size.x / 2;
        const hy = s.size.y / 2;
        const c = s.center;
        const pen = s.pen ?? "medium";
        const corners = [w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })];
        for (let i = 0; i < 4; i++) {
          const a = corners[i] ?? c;
          const b = corners[(i + 1) % 4] ?? c;
          line(a, b, pen);
          growBox(bb, a);
        }
        break;
      }
      case "circle": {
        const c = w(s.center);
        const pen = s.pen ?? "medium";
        if (opts.circle) {
          opts.circle(c, s.radius, pen);
        } else {
          const pts = ringFor(idx, c, s.radius);
          for (let i = 0; i < pts.length; i++) line(pts[i]!, pts[(i + 1) % pts.length]!, pen);
        }
        growBox(bb, { x: c.x - s.radius, y: c.y - s.radius });
        growBox(bb, { x: c.x + s.radius, y: c.y + s.radius });
        break;
      }
      case "arc": {
        const pts = arcPolyline(s.center, s.radius, s.startDeg, s.sweepDeg).map(w);
        const pen = s.pen ?? "medium";
        for (let i = 0; i + 1 < pts.length; i++) {
          line(pts[i]!, pts[i + 1]!, pen);
          growBox(bb, pts[i]!);
          growBox(bb, pts[i + 1]!);
        }
        break;
      }
      case "line": {
        const [a, b] = lineEndpoints(s, w);
        line(a, b, s.pen ?? "thin");
        growBox(bb, a);
        growBox(bb, b);
        break;
      }
      case "polyline": {
        const pts = s.points.map(w);
        const pen = s.pen ?? "medium";
        for (let i = 0; i + 1 < pts.length; i++) {
          line(pts[i]!, pts[i + 1]!, pen);
          growBox(bb, pts[i]!);
          growBox(bb, pts[i + 1]!);
        }
        if (s.closed && pts.length > 2) line(pts[pts.length - 1]!, pts[0]!, pen);
        break;
      }
      case "text": {
        const baseAt = w(s.at);
        const uScale = s.units === "paper" ? viewScale * symScale : 1;
        let anchor = s.anchor;
        let rawAt = baseAt;
        if (s.uprightOffset) {
          let ox = s.uprightOffset[0];
          const oy = s.uprightOffset[1];
          // When a wall-mounted part faces -X (mounted on an east/right wall), a positive
          // start-anchored uprightOffset (+X) would push the label back into the host wall;
          // mirror it to the room-facing side (-X, end-anchored) so labels stay clear of walls.
          const normal = sub(w({ x: 0, y: 1 }), part.position);
          if (anchor === "start" && ox > 0 && normal.x < -0.5) {
            ox = -ox;
            anchor = "end";
          } else if (anchor === "end" && ox < 0 && normal.x > 0.5) {
            ox = -ox;
            anchor = "start";
          }
          rawAt = { x: baseAt.x + ox * uScale, y: baseAt.y + oy * uScale };
        }
        const sizeMm = s.units === "paper" ? s.heightMm * symScale : 2;
        // SVG/PDF text `y` is the baseline; shift down by 0.35em (negative world Y) so centered glyphs ("S", "J", "OS") sit dead-center.
        const at = { x: rawAt.x, y: rawAt.y - sizeMm * 0.35 * viewScale };
        text(at, s.text, sizeMm, anchor, s.mask ? { mask: true } : undefined);
        const tb = worldTextBox(rawAt, s.text, sizeMm, viewScale, anchor ?? "middle");
        growBox(bb, tb.min);
        growBox(bb, tb.max);
        addLabelBox(opts.takenBoxes, tb);
        if (Math.hypot(s.at.x, s.at.y) < 1e-3) hasCenterText = true;
        break;
      }
    }
  }
  if (!Number.isFinite(bb.minX) && resolved.bodyBounds) {
    growBox(bb, resolved.bodyBounds.min);
    growBox(bb, resolved.bodyBounds.max);
  }
  const symbolBox: PartLabelBox | null = Number.isFinite(bb.minX) ? { min: { x: bb.minX, y: bb.minY }, max: { x: bb.maxX, y: bb.maxY } } : null;
  if (symbolBox) addLabelBox(opts.takenBoxes, symbolBox);
  if (part.mark && opts.showMark !== false) {
    const markStyle = resolveTextStyle(model, "part_mark");
    const markText = markStyle?.uppercase ? part.mark.toUpperCase() : part.mark;
    const markSize = markStyle?.textSizeMm ?? MARK_SIZE_MM;
    const markAt = placePartMark(part, markText, symbolBox, viewScale, opts.takenBoxes, hasCenterText, markSize);
    // Center the mark vertically on markAt (SVG/PDF text y is baseline).
    text(
      { x: markAt.x, y: markAt.y - markSize * 0.35 * viewScale },
      markText,
      markSize,
      "middle",
      markStyle
        ? {
            mask: markStyle.mask,
            bold: markStyle.bold,
            italic: markStyle.italic,
            fontFamily: markStyle.fontFamily,
            color: markStyle.color,
          }
        : undefined,
    );
    opts.onMarkPlaced?.({ partId: part.id, text: markText, at: markAt, sizeMm: markSize });
  }
  drawPartClearances(model, part, line, text, viewScale, opts.takenBoxes);
}

/** Clearance zones draw dashed (paper mm), never as part of the part's body. */
export const CLEARANCE_DASH: readonly number[] = [3, 1.5];

/** A placed part's clearance zones in plan: a dashed outline each, named cleanly away from the part mark. */
export function drawPartClearances(model: ModelState, part: PartInstance, line: LineFn, text: TextFn, viewScale = DEFAULT_SYMBOL_SCALE, takenBoxes?: PartLabelStore): void {
  for (const z of partClearances(model, part)) {
    const c = z.corners;
    for (let i = 0; i < 4; i++) line(c[i] ?? c[0], c[(i + 1) % 4] ?? c[0], "thin", [...CLEARANCE_DASH]);
    const label = z.name.toUpperCase();
    const mid: Vec2 = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 };
    // Push the clearance label toward the outer side of the zone (away from the part origin) if the center collides.
    const outDir = sub(mid, part.position);
    const outLen = Math.hypot(outDir.x, outDir.y);
    const candidates: Vec2[] = [mid];
    if (outLen > 1) {
      const u = scale(outDir, 1 / outLen);
      candidates.push(add(mid, scale(u, outLen * 0.45)), add(mid, scale(u, outLen * 0.85)));
    }
    let at = mid;
    if (takenBoxes) {
      const clear = candidates.find((p) => !overlapsLabelStore(takenBoxes, worldTextBox(p, label, CLEARANCE_TEXT_MM, viewScale)));
      at = clear ?? candidates[candidates.length - 1] ?? mid;
      addLabelBox(takenBoxes, worldTextBox(at, label, CLEARANCE_TEXT_MM, viewScale));
    }
    text(at, label, CLEARANCE_TEXT_MM, "middle");
  }
}

/** Drawing category of a routed element (views can hide duct and pipe separately). */
export function runCategory(el: BimElement): "duct" | "duct_fitting" | "pipe" | null {
  return runViewCategory(el);
}
