import type { Rect } from "../crop";
import { documentIndex } from "../commands/views";
import type { Viewport } from "../documents";
import { frameForViewport, modelToPaper, paperToModel, viewCropAndWindow, type ViewFrame } from "../drawing/views";
import type { RunPoint } from "../routing/types";
import type { ModelState, Sheet, Vec2, ViewElement } from "../types";
import { viewMapping, type DepthChoice, type ViewMapping } from "./mapping";

/**
 * The chain from a pointer to the model, for a view drawn on paper by itself
 * or through a viewport on a sheet:
 *
 *   screen px ── clientToPaper ──▶ paper mm ── paperToDrawing ──▶ drawing frame ── mapping.toModel ──▶ model mm
 *
 * `ViewFrame` (`drawing/views.ts`) already carries the viewport's scale, its
 * crop window and a true-north plan's turn, so a sheet viewport and the view
 * opened on its own are the same chain with different frames. The crop window
 * bounds where model points may be taken (a crop box hides the rest, as it prints).
 */

/** Where the paper element sits on screen, client pixels. */
export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function clientToPaper(rect: ClientRect, paper: Vec2, client: Vec2): Vec2 {
  return { x: ((client.x - rect.left) / rect.width) * paper.x, y: ((client.y - rect.top) / rect.height) * paper.y };
}

export function paperToClient(rect: ClientRect, paper: Vec2, p: Vec2): Vec2 {
  return { x: rect.left + (p.x / paper.x) * rect.width, y: rect.top + (p.y / paper.y) * rect.height };
}

/** Paper millimetres per screen pixel (the pick tolerance and snap distances are set in pixels). */
export function paperMmPerPixel(rect: ClientRect, paper: Vec2): number {
  return rect.width > 0 ? paper.x / rect.width : 1;
}

/** One view placed on paper: its mapping, its frame, and its crop window in both spaces. */
export interface ViewOnPaper {
  readonly view: ViewElement;
  readonly mapping: ViewMapping;
  readonly frame: ViewFrame;
  /** The crop window in the drawing frame (u, v). */
  readonly window: Rect;
  /** The frame's bounds on paper. */
  readonly paperRect: Rect;
  /** The viewport this came through; null for a view drawn on its own. */
  readonly viewport: Viewport | null;
}

function paperBounds(frame: ViewFrame): Rect {
  return { min: { x: frame.center.x - frame.size.x / 2, y: frame.center.y - frame.size.y / 2 }, max: { x: frame.center.x + frame.size.x / 2, y: frame.center.y + frame.size.y / 2 } };
}

export function viewOnPaper(model: ModelState, view: ViewElement, frame: ViewFrame, viewport: Viewport | null = null): ViewOnPaper {
  return { view, mapping: viewMapping(model, view), frame, window: viewCropAndWindow(model, view).window, paperRect: paperBounds(frame), viewport };
}

/** A viewport's view on its sheet. */
export function viewportOnPaper(model: ModelState, viewport: Viewport, view: ViewElement): ViewOnPaper {
  return viewOnPaper(model, view, frameForViewport(model, viewport, view), viewport);
}

export function paperToDrawing(vop: ViewOnPaper, p: Vec2): Vec2 {
  return paperToModel(vop.frame, p);
}

export function drawingToPaper(vop: ViewOnPaper, d: Vec2): Vec2 {
  return modelToPaper(vop.frame, d);
}

/** Inside the view's crop window (what prints), within `slackMm` of drawing units. */
export function insideWindow(vop: ViewOnPaper, d: Vec2, slackMm = 0): boolean {
  const w = vop.window;
  return d.x >= w.min.x - slackMm && d.x <= w.max.x + slackMm && d.y >= w.min.y - slackMm && d.y <= w.max.y + slackMm;
}

/** The model point under a paper point; null outside the crop window or where the view can't say. */
export function paperToModelPoint(vop: ViewOnPaper, p: Vec2, at?: DepthChoice): RunPoint | null {
  const d = paperToDrawing(vop, p);
  if (!insideWindow(vop, d)) return null;
  return vop.mapping.toModel(d, at);
}

export function modelToPaperPoint(vop: ViewOnPaper, p: RunPoint): Vec2 {
  const d = vop.mapping.toDrawing(p);
  return drawingToPaper(vop, { x: d.u, y: d.v });
}

/** The model move for a paper move (a drag from `a` to `b`); null where the view can't say. */
export function paperDeltaToModel(vop: ViewOnPaper, a: Vec2, b: Vec2): RunPoint | null {
  const da = paperToDrawing(vop, a);
  const db = paperToDrawing(vop, b);
  return vop.mapping.deltaToModel({ x: db.x - da.x, y: db.y - da.y });
}

/** Drawing-frame millimetres per paper millimetre (the view's scale). */
export function drawingMmPerPaperMm(vop: ViewOnPaper): number {
  return vop.frame.scale;
}

/** The viewport whose frame contains a paper point (the last placed wins, as it draws on top); null on bare paper. */
export function viewportUnder(model: ModelState, sheet: Sheet, p: Vec2): ViewOnPaper | null {
  const vps = documentIndex(model).viewportsBySheet.get(sheet.id) ?? [];
  let found: ViewOnPaper | null = null;
  for (const vp of vps) {
    const view = model.elements[vp.viewId];
    if (view?.kind !== "view" || view.deleted) continue;
    const vop = viewportOnPaper(model, vp, view);
    const r = vop.paperRect;
    if (p.x >= r.min.x && p.x <= r.max.x && p.y >= r.min.y && p.y <= r.max.y) found = vop;
  }
  return found;
}
