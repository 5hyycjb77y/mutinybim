import { convert } from "@permitzip/bim-units";
import { documentIndex, viewportFrameSize } from "../commands/views";
import { STANDARD_SCALES, PAPER_SIZES, sheetPaperSize } from "../documents";
import { titleBlockDrawingArea } from "../drawing/title-block-definition";
import type { ModelState, Sheet, Vec2, ViewElement } from "../types";
import type { BatchCommand } from "../commands/batch";
import type { ViewCommand } from "../commands/views";
import type { Rect } from "../crop";

/**
 * Deterministic sheet layout: where viewports go and at what scale, so an
 * agent (or a person's "arrange" button) gets the same answer every time for
 * the same model. No search, no randomness: shelf packing in the order given,
 * or an aligned grid, inside the sheet's drawing area (inside the border, left
 * of the title block), with room under each frame for its view title.
 */

/** Border inset, mm (the drawn border sits 1/2" in). */
const BORDER_MM = 12.7;
/** Space under a frame for "1  VIEW NAME" and "SCALE: …". */
export const VIEW_TITLE_BAND_MM = 16;
const DEFAULT_GAP_MM = 12;

export interface LayoutItem {
  readonly viewportId: string;
  readonly viewId: string;
  readonly name: string;
  readonly isSchedule: boolean;
  readonly scale: number;
  /** Frame size at `scale`, paper mm. */
  readonly size: Vec2;
}

export interface LayoutMove {
  readonly viewportId: string;
  readonly viewName: string;
  readonly center: Vec2;
  /** Present when the layout changed the viewport's scale to fit. */
  readonly scale?: number;
}

export interface SheetLayout {
  readonly area: Rect;
  readonly moves: readonly LayoutMove[];
  /** Viewports that don't fit even at the smallest allowed scale; left where they are. */
  readonly unplaced: readonly { readonly viewportId: string; readonly viewName: string; readonly reason: string }[];
}

export interface SheetLayoutOptions {
  readonly mode: "pack" | "grid";
  /** Grid only: columns (default: as many as fit the widest frame). */
  readonly columns?: number;
  readonly gapMm?: number;
  /** Change a view's scale to the largest standard one that fits the area (never larger than it is now). */
  readonly fitScales?: boolean;
  /** Smallest drawing allowed when fitting (largest scale number), e.g. 96 for 1/8" = 1'-0". */
  readonly minScale?: number;
  /** Viewport ids in the order to lay them out; absent: the sheet's view order. */
  readonly order?: readonly string[];
}

/** Where drawings may go on a sheet: inside the border, left of the title block. */
export function sheetDrawingArea(sheet: Pick<Sheet, "props">): Rect {
  const pad = 6;
  const row = sheet.props?.titleBlockRow;
  if (row) {
    const area = titleBlockDrawingArea(row.definition);
    return { min: { x: area.min.x + pad, y: area.min.y + pad }, max: { x: area.max.x - pad, y: area.max.y - pad } };
  }
  const paper = PAPER_SIZES[sheet.props?.titleBlock ?? "arch_d_mutinybim"];
  const titleBlockW = paper.x < 600 ? 70 : 100;
  return { min: { x: BORDER_MM + pad, y: BORDER_MM + pad }, max: { x: paper.x - BORDER_MM - titleBlockW - pad, y: paper.y - BORDER_MM - pad } };
}

/** A viewport whose frame runs past its sheet's drawing area, in words an agent or a person can act on. */
export interface ViewportOverhang {
  readonly viewportId: string;
  readonly viewId: string;
  readonly sheetId: string;
  readonly message: string;
}

/** Frames this close to the drawing area's edge (paper mm) still count as inside it. */
const OVERHANG_TOLERANCE_MM = 0.5;

const inches = (mm: number) => convert(mm, "mm", "in").toFixed(1);

/** The overhang of a frame (top-left `min`, paper mm) on `sheet`, or null when it sits inside the drawing area. */
export function frameOverhang(sheet: Sheet, view: Pick<ViewElement, "id" | "name" | "props">, viewportId: string, min: Vec2, size: Vec2): ViewportOverhang | null {
  const area = sheetDrawingArea(sheet);
  const t = OVERHANG_TOLERANCE_MM;
  if (min.x >= area.min.x - t && min.y >= area.min.y - t && min.x + size.x <= area.max.x + t && min.y + size.y <= area.max.y + t) return null;
  const paper = sheetPaperSize(sheet);
  const remedy = view.props?.diagram ? "Move it, change what it draws (hints: orientation, hidden, roots), or use a bigger title block." : "Move it, resize it (crop), use a smaller scale, or a bigger title block.";
  return {
    viewportId,
    viewId: view.id,
    sheetId: sheet.id,
    message: `Viewport "${view.name}" on sheet ${sheet.number} is ${inches(size.x)} x ${inches(size.y)} in and runs past the sheet's drawing area (inside the border, left of the title block: ${inches(area.max.x - area.min.x)} x ${inches(area.max.y - area.min.y)} in on a ${inches(paper.x)} x ${inches(paper.y)} in sheet), so part of it falls outside the border or under the title block. ${remedy}`,
  };
}

/** Viewports among `ids` whose stored frame (centre and size) runs past their sheet's drawing area. No model scan: what an edit just set. */
export function storedViewportOverhangs(model: Pick<ModelState, "elements">, ids: readonly string[]): ViewportOverhang[] {
  const out: ViewportOverhang[] = [];
  for (const id of ids) {
    const vp = model.elements[id];
    if (vp?.kind !== "viewport" || vp.deleted) continue;
    const sheet = model.elements[vp.sheetId];
    const view = model.elements[vp.viewId];
    if (sheet?.kind !== "sheet" || sheet.deleted || view?.kind !== "view" || view.deleted) continue;
    const found = frameOverhang(sheet, view, vp.id, { x: vp.center.x - vp.size.x / 2, y: vp.center.y - vp.size.y / 2 }, vp.size);
    if (found) out.push(found);
  }
  return out;
}

function band(item: Pick<LayoutItem, "isSchedule">): number {
  return item.isSchedule ? 0 : VIEW_TITLE_BAND_MM;
}

/** The largest standard drawing (smallest scale number, not larger than `current`) whose frame fits `room`. */
export function fitScale(model: Pick<ModelState, "elements" | "connections">, view: ViewElement, current: number, room: Vec2, minScale = 192): number | null {
  const candidates = STANDARD_SCALES.map((s) => s.scale).filter((s) => s >= current && s <= Math.max(minScale, current)).sort((a, b) => a - b);
  for (const s of candidates) {
    const size = viewportFrameSize(model, view, s);
    if (size.x <= room.x && size.y + VIEW_TITLE_BAND_MM <= room.y) return s;
  }
  return null;
}

function items(model: ModelState, sheet: Sheet, order: readonly string[] | undefined): LayoutItem[] {
  const vps = documentIndex(model).viewportsBySheet.get(sheet.id) ?? [];
  const out: LayoutItem[] = [];
  for (const vp of vps) {
    const view = model.elements[vp.viewId];
    if (view?.kind !== "view" || view.deleted) continue;
    out.push({ viewportId: vp.id, viewId: view.id, name: view.name, isSchedule: view.viewType === "schedule", scale: vp.scale, size: viewportFrameSize(model, view, vp.scale) });
  }
  const rank = (i: LayoutItem) => {
    const explicit = order?.indexOf(i.viewportId) ?? -1;
    return explicit >= 0 ? explicit : 10_000 + sheet.viewIds.findIndex((v) => v === i.viewId);
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Lay out every viewport on a sheet. Pure: returns the moves; the caller sends them as one batch. */
export function layoutSheet(model: ModelState, sheetId: string, opts: SheetLayoutOptions): SheetLayout {
  const sheet = model.elements[sheetId];
  if (sheet?.kind !== "sheet" || sheet.deleted) throw new Error(`Sheet ${sheetId} does not exist`);
  const area = sheetDrawingArea(sheet);
  const room = { x: area.max.x - area.min.x, y: area.max.y - area.min.y };
  const gap = opts.gapMm ?? DEFAULT_GAP_MM;
  const unplaced: Array<{ viewportId: string; viewName: string; reason: string }> = [];
  const placed: LayoutItem[] = [];
  const all = items(model, sheet, opts.order);
  const originalScale = new Map(all.map((i) => [i.viewportId, i.scale]));
  for (const item of all) {
    let it = item;
    const tooBig = it.size.x > room.x || it.size.y + band(it) > room.y;
    const view = model.elements[it.viewId];
    // A live diagram, like a schedule, prints at its own size: no scale to fit.
    const ownSize = it.isSchedule || (view?.kind === "view" && Boolean(view.props?.diagram));
    if (tooBig && opts.fitScales && !ownSize && view?.kind === "view") {
      const s = fitScale(model, view, it.scale, room, opts.minScale);
      if (s !== null) it = { ...it, scale: s, size: viewportFrameSize(model, view, s) };
    }
    if (it.size.x > room.x || it.size.y + band(it) > room.y) {
      const remedy = ownSize && !it.isSchedule ? "A live diagram prints at its own size: change what it draws (hints: orientation, hidden, roots), or use a bigger title block." : "Use a smaller scale, crop it tighter, or a bigger title block.";
      unplaced.push({ viewportId: it.viewportId, viewName: it.name, reason: `Its frame (${Math.round(it.size.x)} x ${Math.round(it.size.y)} mm) is bigger than the sheet's drawing area (${Math.round(room.x)} x ${Math.round(room.y)} mm). ${remedy}` });
      continue;
    }
    placed.push(it);
  }
  const centers = opts.mode === "grid" ? grid(placed, area, gap, opts.columns) : pack(placed, area, gap);
  const moves: LayoutMove[] = [];
  placed.forEach((it, i) => {
    const center = centers[i];
    if (!center) {
      unplaced.push({ viewportId: it.viewportId, viewName: it.name, reason: "There is no room left on the sheet for it. Move it to another sheet or use a smaller scale." });
      return;
    }
    moves.push({ viewportId: it.viewportId, viewName: it.name, center, ...(originalScale.get(it.viewportId) !== it.scale ? { scale: it.scale } : {}) });
  });
  return { area, moves, unplaced };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Shelves left to right, top to bottom; each shelf as tall as its tallest frame. Null where nothing fits. */
function pack(list: readonly LayoutItem[], area: Rect, gap: number): Array<Vec2 | null> {
  const only = list.length === 1 ? list[0] : undefined;
  if (only) {
    // One drawing on a sheet sits in the middle of the drawing area, its title under it.
    const h = only.size.y + band(only);
    return [{ x: round2((area.min.x + area.max.x) / 2), y: round2((area.min.y + area.max.y) / 2 - h / 2 + only.size.y / 2) }];
  }
  const out: Array<Vec2 | null> = [];
  let x = area.min.x;
  let y = area.min.y;
  let shelf = 0;
  for (const it of list) {
    const h = it.size.y + band(it);
    if (x > area.min.x && x + it.size.x > area.max.x) {
      x = area.min.x;
      y += shelf + gap;
      shelf = 0;
    }
    if (y + h > area.max.y || x + it.size.x > area.max.x) {
      out.push(null);
      continue;
    }
    out.push({ x: round2(x + it.size.x / 2), y: round2(y + it.size.y / 2) });
    x += it.size.x + gap;
    shelf = Math.max(shelf, h);
  }
  return out;
}

/** An aligned grid: equal column widths and row heights (the largest frame in each), frames centred in their cells. */
function grid(list: readonly LayoutItem[], area: Rect, gap: number, wantColumns: number | undefined): Array<Vec2 | null> {
  if (list.length === 0) return [];
  const cellW = Math.max(...list.map((i) => i.size.x));
  const cellH = Math.max(...list.map((i) => i.size.y + band(i)));
  const fitColumns = Math.max(1, Math.floor((area.max.x - area.min.x + gap) / (cellW + gap)));
  const columns = Math.max(1, Math.min(wantColumns ?? fitColumns, fitColumns, list.length));
  return list.map((it, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const top = area.min.y + row * (cellH + gap);
    if (top + cellH > area.max.y + 1e-6) return null;
    const left = area.min.x + col * (cellW + gap);
    return { x: round2(left + cellW / 2), y: round2(top + (cellH - band(it)) / 2) };
  });
}

/** Paper mm: a viewport this close to its laid-out spot is already there. */
const SAME_SPOT_MM = 0.01;

/**
 * Where every viewport on a sheet goes, as one batch of viewport moves (and
 * scale changes) for the ones not already there. Null command: nothing
 * moves. The Views & Sheets Arrange, an agent's bim_auto_layout_sheet and a
 * script's documents.packSheet send this same edit.
 */
export function sheetLayoutCommand(model: ModelState, sheetId: string, opts: Parameters<typeof layoutSheet>[2]) {
  const planned = layoutSheet(model, sheetId, opts);
  const layout = {
    ...planned,
    moves: planned.moves.filter((m) => {
      const vp = model.elements[m.viewportId];
      if (vp?.kind !== "viewport") return true;
      const moved = Math.hypot(vp.center.x - m.center.x, vp.center.y - m.center.y) > SAME_SPOT_MM;
      return moved || (m.scale !== undefined && m.scale !== vp.scale);
    }),
  };
  const steps: ViewCommand[] = [];
  for (const m of layout.moves) {
    if (m.scale !== undefined) steps.push({ type: "set_viewport_scale", viewportId: m.viewportId, scale: m.scale });
    steps.push({ type: "move_viewport", viewportId: m.viewportId, center: m.center });
  }
  const command: BatchCommand | null = steps.length > 0 ? { type: "batch_documents", label: `Lay out ${layout.moves.length} view${layout.moves.length === 1 ? "" : "s"}`, commands: steps } : null;
  return { layout, command };
}
