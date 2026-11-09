import { noteCornersInModel } from "./annotation/text-note";
import { DEFAULT_DETAIL_SCALE, type DrawingItem, type ViewProps } from "./documents";
import { boxOverRect, cameraWindow } from "./view3d";
import { distance, round, roundVec } from "./geometry";
import { levelContentExtent, type Rect } from "./view-extents";
import { scheduleViewSize } from "./schedules/view";
import type { ModelState, Vec2, ViewElement } from "./types";

/**
 * Crop boxes. Every view has one, in its own drawing frame: plans and 3D views
 * crop a plan rectangle (model mm), sections crop along-cut distance by
 * elevation, detail views crop their drawn content. With "crop view" off a
 * view shows all of its content, so its effective crop is the content's
 * extent. A viewport's frame on a sheet is the view's window at the
 * viewport's scale, so the crop and the frame are one thing.
 */

export { levelContentExtent, type Rect } from "./view-extents";

const FT = 304.8;
/** Height the 3D isometric window allows above the level for walls, ductwork and equipment. */
export const ISO_WINDOW_HEIGHT_MM = 12 * FT;
/** Printed width of one character as a fraction of the text height (the SVG and PDF writers' sans face). */
export const TEXT_WIDTH_PER_CHAR = 0.62;
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

export function isoProject(q: Vec2, z: number): Vec2 {
  return { x: (q.x - q.y) * COS30, y: (q.x + q.y) * SIN30 + z };
}

/** Plan offset that moves the isometric drawing by `d` (at z = 0). */
function isoUnproject(d: Vec2): Vec2 {
  const u = d.x / COS30;
  return { x: (u + 2 * d.y) / 2, y: (2 * d.y - u) / 2 };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: (r.min.x + r.max.x) / 2, y: (r.min.y + r.max.y) / 2 };
}

export function rectSize(r: Rect): Vec2 {
  return { x: r.max.x - r.min.x, y: r.max.y - r.min.y };
}

export function viewCrop(view: ViewElement): Rect {
  return { min: view.cropMin, max: view.cropMax };
}

export function cropIsOn(view: ViewElement): boolean {
  // A schedule is always as big as its rows; a live diagram as big as what it draws (a stored crop never clips it).
  return view.viewType !== "schedule" && !view.props?.diagram && view.props?.cropView !== false;
}

/** Extent of a detail view's drawn lines, notes and dimensions, with a margin; null when nothing is drawn. */
export function drawnContentExtent(items: readonly DrawingItem[], scale: number, marginMm = 1 * FT): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    for (const p of item.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    // A note's printed box (and leader) at the view's scale.
    for (const c of noteCornersInModel(item, scale)) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { min: roundVec({ x: minX - marginMm, y: minY - marginMm }), max: roundVec({ x: maxX + marginMm, y: maxY + marginMm }) };
}

export const DEFAULT_DETAIL_CROP: Rect = { min: { x: 0, y: 0 }, max: { x: 10 * FT, y: 8 * FT } };
export const DEFAULT_PLAN_CROP: Rect = { min: { x: 0, y: 0 }, max: { x: 60 * FT, y: 60 * FT } };

/** A section's crop in its own frame: the whole cut length, from just below the level to 30 ft above it. */
export function sectionDefaultCrop(view: Pick<ViewElement, "props">): Rect {
  const cut = view.props?.section;
  const len = cut ? distance(cut.start, cut.end) : 0;
  const floor = view.props?.levelElevationMm ?? 0;
  return { min: { x: 0, y: round(floor - 0.5 * FT) }, max: { x: round(len), y: round(floor + 30 * FT) } };
}

/** The crop that fits the view's content: what "Fit crop to content" sets and what a view with crop off shows. */
export function fitCrop(model: Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>, view: Pick<ViewElement, "viewType" | "props">, items: readonly DrawingItem[]): Rect {
  switch (view.viewType) {
    case "section":
      return sectionDefaultCrop(view);
    case "detail":
      // A live diagram is drawn at its own size: a paper margin, not a foot of model.
      if (view.props?.diagram) return drawnContentExtent(items, 1, 8) ?? DEFAULT_DETAIL_CROP;
      return drawnContentExtent(items, view.props?.scale ?? DEFAULT_DETAIL_SCALE) ?? DEFAULT_DETAIL_CROP;
    case "schedule": {
      // The table's paper size at scale 1, top-left at the origin (y up, like every drawing frame).
      const size = scheduleViewSize(model, view.props) ?? { x: 25.4, y: 25.4 };
      return { min: { x: 0, y: -size.y }, max: { x: size.x, y: 0 } };
    }
    default:
      return levelContentExtent(model, view.props?.level, 10 * FT, view.props?.levelElevationMm) ?? DEFAULT_PLAN_CROP;
  }
}

/** What the view actually shows: its crop box, or its whole content with crop off. */
export function effectiveCrop(model: Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>, view: ViewElement, items: readonly DrawingItem[]): Rect {
  return cropIsOn(view) ? viewCrop(view) : fitCrop(model, view, items);
}

/**
 * The crop as a window in the view's drawing frame. A 3D view with a camera:
 * its 3D crop box seen from the camera (with crop off, the content's plan
 * extent at the box's heights). An older 3D view: the isometric box over the
 * plan crop.
 */
export function viewWindow(view: Pick<ViewElement, "viewType"> & { readonly props?: ViewProps }, crop: Rect): Rect {
  if (view.viewType !== "three_d") return crop;
  const camera = view.props?.camera3d;
  const box = view.props?.cropBox3d;
  if (camera) return cameraWindow(camera, box && view.props?.cropView !== false ? box : boxOverRect(crop, box ?? null));
  const corners = [crop.min, { x: crop.max.x, y: crop.min.y }, crop.max, { x: crop.min.x, y: crop.max.y }];
  const pts = corners.flatMap((c) => [isoProject(c, 0), isoProject(c, ISO_WINDOW_HEIGHT_MM)]);
  return {
    min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) },
    max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) },
  };
}

/**
 * The crop that gives `window` in the drawing frame. Plans, sections and
 * details are the window itself. A 3D view moves its plan crop with the
 * window's centre and scales it evenly (an isometric box can't be cropped
 * per axis).
 */
export function cropForWindow(view: Pick<ViewElement, "viewType">, oldCrop: Rect, window: Rect): Rect {
  if (view.viewType !== "three_d") return { min: roundVec(window.min), max: roundVec(window.max) };
  const before = viewWindow(view, oldCrop);
  const b = rectSize(before);
  const a = rectSize(window);
  const factor = Math.sqrt(Math.max(1e-6, (a.x / (b.x || 1)) * (a.y / (b.y || 1))));
  const wc = rectCenter(window);
  const bc = rectCenter(before);
  const shift = isoUnproject({ x: wc.x - bc.x, y: wc.y - bc.y });
  const c = rectCenter(oldCrop);
  const half = { x: (rectSize(oldCrop).x * factor) / 2, y: (rectSize(oldCrop).y * factor) / 2 };
  const center = { x: c.x + shift.x, y: c.y + shift.y };
  return { min: roundVec({ x: center.x - half.x, y: center.y - half.y }), max: roundVec({ x: center.x + half.x, y: center.y + half.y }) };
}

/** Paper size of a window at a scale. */
export function windowPaperSize(window: Rect, scale: number): Vec2 {
  const s = rectSize(window);
  return roundVec({ x: s.x / scale, y: s.y / scale });
}
