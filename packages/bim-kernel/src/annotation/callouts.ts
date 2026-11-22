import { categoryOverridesWritable } from "../categories/feature";
import { documentIndex, type ViewCommand } from "../commands/views";
import type { CalloutSpec, DrawingItem, ViewProps } from "../documents";
import type { Primitive } from "../drawing/sheet";
import { normalizeLevelName, viewLevelNames } from "../levels";
import type { ModelState, Vec2, ViewElement } from "../types";

/**
 * Callouts and view references (G14): a box drawn around part of a plan,
 * bound to the view that shows it enlarged. The head reads that view's
 * number on its sheet over the sheet's number ("1 / E4"), looked up at every
 * draw, so moving the view to E5 or renumbering the sheet updates every
 * callout that points at it. Nothing about the sheet is stored on the callout.
 */

export interface CalloutHead {
  /** Upper half: the label, else the view's number on its sheet, else "?". */
  readonly top: string;
  /** Lower half: the sheet number, or "—" while the view is on no sheet. */
  readonly bottom: string;
  /** The referenced view's name, upper case ("" when it no longer exists). */
  readonly viewName: string;
  readonly sheetId: string | null;
  /** False when the view was deleted or is on no sheet: the callout says so rather than printing a stale number. */
  readonly resolved: boolean;
}

/** What a callout's head reads right now. */
export function calloutHead(model: Pick<ModelState, "elements" | "connections">, spec: CalloutSpec): CalloutHead {
  const view = model.elements[spec.viewId];
  if (view?.kind !== "view" || view.deleted) return { top: spec.label ?? "?", bottom: "—", viewName: "", sheetId: null, resolved: false };
  const index = documentIndex(model);
  const vp = index.viewportByView.get(view.id);
  const sheet = vp ? model.elements[vp.sheetId] : undefined;
  if (!vp || sheet?.kind !== "sheet" || sheet.deleted) return { top: spec.label ?? "?", bottom: "—", viewName: view.name.toUpperCase(), sheetId: null, resolved: false };
  // Numbered as the sheet numbers its views (`sheetViewports`): live views, in the sheet's order.
  const placed = (index.viewportsBySheet.get(sheet.id) ?? []).flatMap((v) => {
    const pv = model.elements[v.viewId];
    return pv?.kind === "view" && !pv.deleted ? [pv.id] : [];
  });
  placed.sort((a, b) => sheet.viewIds.indexOf(a) - sheet.viewIds.indexOf(b));
  const number = placed.indexOf(view.id) + 1;
  return { top: spec.label ?? String(number), bottom: sheet.number, viewName: view.name.toUpperCase(), sheetId: sheet.id, resolved: true };
}

/** Paper mm — NCS / Revit 1/2" Ø callout & section bubble (12.7 mm), 7/16" Ø elevation bubble (11 mm). */
export const HEAD_RADIUS_MM = 6.35;
export const ELEV_RADIUS_MM = 5.5;
const HEAD_TEXT_MM = 2.1;
const NAME_TEXT_MM = 2.0;
const CALLOUT_CORNER_MM = 2.5;
const CALLOUT_DASH: readonly number[] = [4.5, 2];
const SECTION_LINE_DASH: readonly number[] = [6, 2, 1.5, 2];
const CIRCLE_SEGMENTS = 32;

function circlePoints(center: Vec2, r: number, n = CIRCLE_SEGMENTS): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

/** Fit text cleanly inside a circle of radius `r` so sheet numbers like "M-401" or "FP-101" never touch the border. */
function fitBubbleText(text: string, r: number): number {
  const maxWidth = r * 1.55;
  const estWidth = Math.max(1, text.length) * 0.62 * HEAD_TEXT_MM;
  return estWidth <= maxWidth ? HEAD_TEXT_MM : Math.max(1.35, HEAD_TEXT_MM * (maxWidth / estWidth));
}

/** Draw an opaque white-masked split circle bubble (detail# / sheet#) at `head` in paper mm. */
function drawSplitBubble(head: Vec2, r: number, live: CalloutHead, prims: Primitive[]): void {
  const ring = circlePoints(head, r);
  // White mask prevents model lines, cut lines, or filled pointer wedges from bleeding through the bubble.
  prims.push({ kind: "fill", points: ring, grey: 1 });
  for (let i = 0; i < ring.length; i++) {
    prims.push({ kind: "line", a: ring[i]!, b: ring[(i + 1) % ring.length]!, pen: "medium" });
  }
  prims.push({ kind: "line", a: { x: head.x - r, y: head.y }, b: { x: head.x + r, y: head.y }, pen: "thin" });
  const topSize = fitBubbleText(live.top, r);
  const botSize = fitBubbleText(live.bottom, r);
  // Paper y is down; text `at.y` is baseline. Center each line vertically inside its semicircle.
  prims.push({ kind: "text", at: { x: head.x, y: head.y - 1.2 }, text: live.top, size: topSize, anchor: "middle", bold: true });
  prims.push({ kind: "text", at: { x: head.x, y: head.y + 1.0 + botSize * 0.9 }, text: live.bottom, size: botSize, anchor: "middle" });
}

/**
 * Draw a solid black Revit/NCS 90° tangent pointer wedge on the `look` side of
 * a circle of radius `r` centered at `head`. Draw BEFORE `drawSplitBubble` so
 * the white-masked circle carves a razor-sharp crescent arrowhead.
 */
function drawTangentPointer(head: Vec2, r: number, look: Vec2, prims: Primitive[]): void {
  const side = { x: -look.y, y: look.x };
  const s = r * Math.SQRT1_2;
  const tip = { x: head.x + look.x * (r * Math.SQRT2), y: head.y + look.y * (r * Math.SQRT2) };
  // Extend slightly behind the tangent chord so the white circle mask clips the inner edge cleanly with zero hairline gap.
  const backA = { x: head.x + side.x * r, y: head.y + side.y * r };
  const backB = { x: head.x - side.x * r, y: head.y - side.y * r };
  const tanA = { x: head.x + look.x * s + side.x * s, y: head.y + look.y * s + side.y * s };
  const tanB = { x: head.x + look.x * s - side.x * s, y: head.y + look.y * s - side.y * s };
  prims.push({ kind: "fill", points: [backA, tanA, tip, tanB, backB], grey: 0 });
}

/** Draw a Revit/NCS rounded-corner dashed rectangle in paper mm. */
function drawRoundedRect(min: Vec2, max: Vec2, radius: number, dash: readonly number[], prims: Primitive[]): Vec2[] {
  const w = max.x - min.x;
  const h = max.y - min.y;
  const r = Math.min(radius, w / 4, h / 4);
  const arcSteps = 6;
  const corners: Array<{ cx: number; cy: number; a0: number; a1: number; anchor: Vec2 }> = [
    { cx: min.x + r, cy: min.y + r, a0: Math.PI, a1: 1.5 * Math.PI, anchor: { x: min.x + r * 0.3, y: min.y + r * 0.3 } },
    { cx: max.x - r, cy: min.y + r, a0: 1.5 * Math.PI, a1: 2 * Math.PI, anchor: { x: max.x - r * 0.3, y: min.y + r * 0.3 } },
    { cx: max.x - r, cy: max.y - r, a0: 0, a1: 0.5 * Math.PI, anchor: { x: max.x - r * 0.3, y: max.y - r * 0.3 } },
    { cx: min.x + r, cy: max.y - r, a0: 0.5 * Math.PI, a1: Math.PI, anchor: { x: min.x + r * 0.3, y: max.y - r * 0.3 } },
  ];
  // Straight sides (dashed)
  prims.push({ kind: "line", a: { x: min.x + r, y: min.y }, b: { x: max.x - r, y: min.y }, pen: "medium", dash });
  prims.push({ kind: "line", a: { x: max.x, y: min.y + r }, b: { x: max.x, y: max.y - r }, pen: "medium", dash });
  prims.push({ kind: "line", a: { x: max.x - r, y: max.y }, b: { x: min.x + r, y: max.y }, pen: "medium", dash });
  prims.push({ kind: "line", a: { x: min.x, y: max.y - r }, b: { x: min.x, y: min.y + r }, pen: "medium", dash });
  // Smooth solid corner fillets (Revit callout style)
  for (const c of corners) {
    for (let i = 0; i < arcSteps; i++) {
      const t0 = c.a0 + ((c.a1 - c.a0) * i) / arcSteps;
      const t1 = c.a0 + ((c.a1 - c.a0) * (i + 1)) / arcSteps;
      prims.push({
        kind: "line",
        a: { x: c.cx + r * Math.cos(t0), y: c.cy + r * Math.sin(t0) },
        b: { x: c.cx + r * Math.cos(t1), y: c.cy + r * Math.sin(t1) },
        pen: "medium",
      });
    }
  }
  return corners.map((c) => c.anchor);
}

/** Draw a callout: rounded dashed box, leader from nearest corner to the split head bubble, and the view name. */
export function drawCallout(model: Pick<ModelState, "elements" | "connections">, item: DrawingItem, toPaper: (p: Vec2) => Vec2, prims: Primitive[]): boolean {
  const spec = item.callout;
  const [a, b, h] = item.points;
  if (!spec || !a || !b || !h) return false;
  const p = toPaper(a);
  const q = toPaper(b);
  const head = toPaper(h);
  const min = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) };
  const max = { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) };
  const anchors = drawRoundedRect(min, max, CALLOUT_CORNER_MM, CALLOUT_DASH, prims);
  const corner = anchors.reduce((best, c) => (Math.hypot(c.x - head.x, c.y - head.y) < Math.hypot(best.x - head.x, best.y - head.y) ? c : best), anchors[0]!);
  const d = Math.hypot(corner.x - head.x, corner.y - head.y);
  if (d > HEAD_RADIUS_MM) {
    const t = HEAD_RADIUS_MM / d;
    prims.push({ kind: "line", a: corner, b: { x: head.x + (corner.x - head.x) * t, y: head.y + (corner.y - head.y) * t }, pen: "thin" });
  }
  const live = calloutHead(model, spec);
  drawSplitBubble(head, HEAD_RADIUS_MM, live, prims);
  const name = live.viewName ? (live.resolved ? live.viewName : `${live.viewName} (NOT ON A SHEET)`) : "VIEW REMOVED";
  prims.push({ kind: "text", at: { x: head.x + HEAD_RADIUS_MM + 2, y: head.y + NAME_TEXT_MM * 0.35 }, text: name, size: NAME_TEXT_MM, anchor: "start" });
  return true;
}

export interface ModelClipBounds {
  readonly min: Vec2;
  readonly max: Vec2;
}

function pointInRect(p: Vec2, r: ModelClipBounds, eps = 1e-3): boolean {
  return p.x >= r.min.x - eps && p.x <= r.max.x + eps && p.y >= r.min.y - eps && p.y <= r.max.y + eps;
}

/** Liang-Barsky clip of segment (a, b) against axis-aligned rectangle `r`. */
function clipSegmentToRect(a: Vec2, b: Vec2, r: ModelClipBounds): { a: Vec2; b: Vec2; startInside: boolean; endInside: boolean } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, a.x - r.min.x],
    [dx, r.max.x - a.x],
    [-dy, a.y - r.min.y],
    [dy, r.max.y - a.y],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return {
    a: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    b: { x: a.x + t1 * dx, y: a.y + t1 * dy },
    startInside: t0 <= 1e-6,
    endInside: t1 >= 1 - 1e-6,
  };
}

/** Effective annotative start & end points of a section mark (applying independent `headExtMm` / `tailExtMm` extensions). */
export function sectionMarkEndpoints(cut: NonNullable<ViewElement["props"]>["section"]): { readonly start: Vec2; readonly end: Vec2 } | null {
  if (!cut) return null;
  const dx = cut.end.x - cut.start.x;
  const dy = cut.end.y - cut.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return null;
  const ux = dx / len;
  const uy = dy / len;
  const headExt = cut.headExtMm ?? 0;
  const tailExt = cut.tailExtMm ?? 0;
  return {
    start: { x: cut.start.x - ux * headExt, y: cut.start.y - uy * headExt },
    end: { x: cut.end.x + ux * tailExt, y: cut.end.y + uy * tailExt },
  };
}

/**
 * Draw a live Revit/NCS section cut mark on a plan: dashed cut line (or split
 * head/tail stubs when `splitGap` is set), solid black 45° tangent pointer head
 * with white-masked split bubble reading live detail#/sheet# at start, and
 * solid black tail flag at end. When `clipBounds` is provided, clips the cut
 * line to the crop region and suppresses endpoints outside that region.
 */
export function drawSectionMark(
  model: Pick<ModelState, "elements" | "connections">,
  view: ViewElement,
  toPaper: (p: Vec2) => Vec2,
  prims: Primitive[],
  clipBounds?: ModelClipBounds,
): boolean {
  const cut = view.props?.section;
  const endpoints = sectionMarkEndpoints(cut);
  if (!cut || !endpoints) return false;
  let drawStart = endpoints.start;
  let drawEnd = endpoints.end;
  let showHead = true;
  let showTail = true;
  if (clipBounds) {
    const clipped = clipSegmentToRect(endpoints.start, endpoints.end, clipBounds);
    if (!clipped) return false;
    drawStart = clipped.a;
    drawEnd = clipped.b;
    showHead = clipped.startInside;
    showTail = clipped.endInside;
  }
  const p0 = toPaper(drawStart);
  const p1 = toPaper(drawEnd);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return false;
  const ax = { x: dx / len, y: dy / len };
  const modelDx = cut.end.x - cut.start.x;
  const modelDy = cut.end.y - cut.start.y;
  const modelLen = Math.hypot(modelDx, modelDy) || 1;
  const lookModel = { x: -(modelDy / modelLen) * cut.direction, y: (modelDx / modelLen) * cut.direction };
  const pLook = toPaper({ x: drawStart.x + lookModel.x * 1000, y: drawStart.y + lookModel.y * 1000 });
  const lx = pLook.x - p0.x;
  const ly = pLook.y - p0.y;
  const lLen = Math.hypot(lx, ly) || 1;
  const look = { x: lx / lLen, y: ly / lLen };

  // Cut line stops cleanly at the inner face of the tail so no dash pokes past or under it.
  const tailWidth = 1.1;
  const tailLen = 5.5;
  const leadIn = 2.5;
  const cutEnd = showTail && len > leadIn + tailWidth ? { x: p1.x - ax.x * leadIn, y: p1.y - ax.y * leadIn } : p1;
  if (cut.splitGap && showHead && showTail && len > 28) {
    // Revit split/broken section line: crisp head & tail stubs leaving the middle of the plan uncluttered.
    const stub = Math.min(14, len * 0.22);
    prims.push({ kind: "line", a: p0, b: { x: p0.x + ax.x * stub, y: p0.y + ax.y * stub }, pen: "medium", dash: SECTION_LINE_DASH });
    prims.push({ kind: "line", a: { x: cutEnd.x - ax.x * stub, y: cutEnd.y - ax.y * stub }, b: cutEnd, pen: "medium", dash: SECTION_LINE_DASH });
  } else {
    prims.push({ kind: "line", a: p0, b: cutEnd, pen: "medium", dash: SECTION_LINE_DASH });
  }
  if (showTail && len > leadIn + tailWidth) {
    prims.push({ kind: "line", a: cutEnd, b: p1, pen: "medium" });
  }

  // Head bubble sits tangent to p0 along -axis with solid black pointer wedge on the look side.
  if (showHead) {
    const r = HEAD_RADIUS_MM;
    const head = { x: p0.x - ax.x * r, y: p0.y - ax.y * r };
    const live = calloutHead(model, { viewId: view.id });
    drawTangentPointer(head, r, look, prims);
    drawSplitBubble(head, r, live, prims);
  }

  // Sleek modern Revit/NCS section tail: solid black vertical bar flush with the bottom of the 0.35 mm cut line.
  if (showTail) {
    const halfStroke = 0.175;
    prims.push({
      kind: "fill",
      points: [
        { x: p1.x - look.x * halfStroke, y: p1.y - look.y * halfStroke },
        { x: p1.x + ax.x * tailWidth - look.x * halfStroke, y: p1.y + ax.y * tailWidth - look.y * halfStroke },
        { x: p1.x + ax.x * tailWidth + look.x * tailLen, y: p1.y + ax.y * tailWidth + look.y * tailLen },
        { x: p1.x + look.x * tailLen, y: p1.y + look.y * tailLen },
      ],
      grey: 0,
    });
  }
  return true;
}

/** Paper-mm center of an elevation marker's split bubble (single source of truth for drawing and interactive link hitboxes). */
export function elevationMarkCenter(
  cut: NonNullable<ViewElement["props"]>["section"],
  toPaper: (p: Vec2) => Vec2,
): { readonly head: Vec2; readonly look: Vec2; readonly midModel: Vec2 } | null {
  if (!cut) return null;
  const midModel = { x: (cut.start.x + cut.end.x) / 2, y: (cut.start.y + cut.end.y) / 2 };
  const modelDx = cut.end.x - cut.start.x;
  const modelDy = cut.end.y - cut.start.y;
  const modelLen = Math.hypot(modelDx, modelDy);
  if (modelLen < 1e-3) return null;
  const lookModel = { x: -(modelDy / modelLen) * cut.direction, y: (modelDx / modelLen) * cut.direction };
  const pMid = toPaper(midModel);
  const pLook = toPaper({ x: midModel.x + lookModel.x * 1000, y: midModel.y + lookModel.y * 1000 });
  const lx = pLook.x - pMid.x;
  const ly = pLook.y - pMid.y;
  const lLen = Math.hypot(lx, ly) || 1;
  const look = { x: lx / lLen, y: ly / lLen };
  const head = { x: pMid.x - look.x * (ELEV_RADIUS_MM * Math.SQRT2), y: pMid.y - look.y * (ELEV_RADIUS_MM * Math.SQRT2) };
  return { head, look, midModel };
}

/**
 * Draw a live Revit/NCS elevation marker on a plan: solid black 90° tangent
 * pointer aimed along the look direction with a white-masked split bubble
 * reading live detail#/sheet#.
 */
export function drawElevationMark(
  model: Pick<ModelState, "elements" | "connections">,
  view: ViewElement,
  toPaper: (p: Vec2) => Vec2,
  prims: Primitive[],
  clipBounds?: ModelClipBounds,
): boolean {
  const geo = elevationMarkCenter(view.props?.section, toPaper);
  if (!geo) return false;
  if (clipBounds && !pointInRect(geo.midModel, clipBounds)) return false;
  const live = calloutHead(model, { viewId: view.id });
  drawTangentPointer(geo.head, ELEV_RADIUS_MM, geo.look, prims);
  drawSplitBubble(geo.head, ELEV_RADIUS_MM, live, prims);
  return true;
}

function sameViewFloor(model: Pick<ModelState, "elements">, planView: ViewElement, verticalView: ViewElement): boolean {
  const planLevel = planView.props?.level;
  const vertLevel = verticalView.props?.level;
  if (!planLevel || !vertLevel) return true;
  const planNames = viewLevelNames(model, planLevel, planView.props?.levelElevationMm);
  const vertNames = viewLevelNames(model, vertLevel, verticalView.props?.levelElevationMm);
  if (!planNames || !vertNames) return true;
  for (const n of planNames) {
    if (vertNames.has(n)) return true;
  }
  const planNorm = new Set([...planNames].map(normalizeLevelName));
  for (const n of vertNames) {
    if (planNorm.has(normalizeLevelName(n))) return true;
  }
  return false;
}

/**
 * Sections and elevations whose reference marks show on a plan view: live
 * vertical views matching the plan's level (or without a level filter) whose
 * cut/view plane overlaps the plan's crop region.
 */
export function planReferenceViews(model: Pick<ModelState, "elements" | "connections">, planView: ViewElement): ViewElement[] {
  if (planView.viewType !== "floor_plan" && planView.viewType !== "ceiling_plan") return [];
  const cropOn = planView.props?.cropView !== false;
  const bounds: ModelClipBounds = { min: planView.cropMin, max: planView.cropMax };
  const out: ViewElement[] = [];
  for (const v of documentIndex(model).views) {
    if (v.deleted || (v.viewType !== "section" && v.viewType !== "elevation")) continue;
    const cut = v.props?.section;
    if (!cut) continue;
    if (!sameViewFloor(model, planView, v)) continue;
    if (cropOn) {
      if (v.viewType === "elevation") {
        const mid = { x: (cut.start.x + cut.end.x) / 2, y: (cut.start.y + cut.end.y) / 2 };
        if (!pointInRect(mid, bounds)) continue;
      } else if (!clipSegmentToRect(cut.start, cut.end, bounds)) {
        continue;
      }
    }
    out.push(v);
  }
  return out;
}

export interface ReferencingSheet {
  /** Sheet number where this view is called out (e.g. "M-101"). */
  readonly sheetNumber: string;
  readonly sheetId: string;
  readonly sourceViewId: string;
}

/**
 * NCS / Revit back-reference: finds the sheet that calls out `view` — first via
 * any live `callout` item pointing at it, else (for sections and elevations)
 * via a placed plan view whose reference marks include `view`. Prefers a sheet
 * other than `view`'s own sheet when called out on multiple sheets.
 */
export function referencingSheet(model: Pick<ModelState, "elements" | "connections">, view: ViewElement): ReferencingSheet | null {
  const index = documentIndex(model);
  const ownVp = index.viewportByView.get(view.id);
  const ownSheetId = ownVp?.sheetId ?? null;

  const sheetOf = (sourceViewId: string): ReferencingSheet | null => {
    const vp = index.viewportByView.get(sourceViewId);
    const sheet = vp ? model.elements[vp.sheetId] : undefined;
    if (!vp || sheet?.kind !== "sheet" || sheet.deleted) return null;
    return { sheetNumber: sheet.number, sheetId: sheet.id, sourceViewId };
  };

  let fallback: ReferencingSheet | null = null;
  // 1. Explicit callout pointing at this view (enlarged plans, detail callouts) via indexed drawing items.
  for (const items of index.itemsByOwner.values()) {
    for (const el of items) {
      if (el.deleted || el.shape !== "callout" || el.callout?.viewId !== view.id) continue;
      const hit = sheetOf(el.ownerId);
      if (!hit) continue;
      if (hit.sheetId !== ownSheetId) return hit;
      if (!fallback) fallback = hit;
    }
  }

  // 2. Plan reference marks (sections and elevations shown on a placed plan).
  if (view.viewType === "section" || view.viewType === "elevation") {
    for (const candidate of index.views) {
      if (candidate.deleted || (candidate.viewType !== "floor_plan" && candidate.viewType !== "ceiling_plan")) continue;
      const hit = sheetOf(candidate.id);
      if (!hit) continue;
      if (planReferenceViews(model, candidate).some((v) => v.id === view.id)) {
        if (hit.sheetId !== ownSheetId) return hit;
        if (!fallback) fallback = hit;
      }
    }
  }
  return fallback;
}

/** Paper-mm layout of a sheet viewport's title block (single source of truth for rendering, moving, resizing rule, and clicking back-reference bubbles). */
export interface ViewportTitleLayout {
  readonly left: number;
  readonly titleY: number;
  readonly bubbleCenter: Vec2;
  readonly textX: number;
  readonly ruleStartX: number;
  readonly ruleEndX: number;
  readonly ruleY: number;
  readonly hitRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export function viewportTitleLayout(
  frame: { readonly center: Vec2; readonly size: Vec2 },
  viewport: { readonly titleOffsetMm?: Vec2; readonly titleRuleMm?: number },
  viewName: string,
  hasBackRef: boolean,
): ViewportTitleLayout {
  const ox = viewport.titleOffsetMm?.x ?? 0;
  const oy = viewport.titleOffsetMm?.y ?? 0;
  const left = frame.center.x - frame.size.x / 2 + ox;
  const titleY = frame.center.y + frame.size.y / 2 + 8 + oy;
  const ruleY = titleY + 1.5;
  const defaultRuleLen = Math.min(frame.size.x, 120);
  const bubbleCenter = { x: left + HEAD_RADIUS_MM, y: ruleY };
  const textX = hasBackRef ? left + HEAD_RADIUS_MM * 2 + 2.5 : left;
  const ruleStartX = hasBackRef ? left + HEAD_RADIUS_MM * 2 : left;
  const autoRuleEnd = hasBackRef ? Math.max(left + defaultRuleLen, textX + Math.max(viewName.length * 2.2, 48)) : Math.max(left + defaultRuleLen, left + Math.max((viewName.length + 3) * 2.2, 48));
  const ruleEndX = viewport.titleRuleMm !== undefined ? ruleStartX + Math.max(20, viewport.titleRuleMm) : autoRuleEnd;
  const hitTop = hasBackRef ? ruleY - HEAD_RADIUS_MM - 1 : titleY - 4.5;
  const hitBot = hasBackRef ? ruleY + HEAD_RADIUS_MM + 1 : titleY + 7.5;
  return {
    left,
    titleY,
    bubbleCenter,
    textX,
    ruleStartX,
    ruleEndX,
    ruleY,
    hitRect: { x: left - 1.5, y: hitTop, w: Math.max(24, ruleEndX - left + 3), h: hitBot - hitTop },
  };
}

/** Paper-mm center of a sheet viewport's back-referenced title bubble (single source of truth for sheet rendering and click navigation). */
export function viewTitleBubbleCenter(
  frame: { readonly center: Vec2; readonly size: Vec2 },
  titleOffsetMm?: Vec2,
): Vec2 {
  const left = frame.center.x - frame.size.x / 2 + (titleOffsetMm?.x ?? 0);
  const titleY = frame.center.y + frame.size.y / 2 + 8 + (titleOffsetMm?.y ?? 0);
  return { x: left + HEAD_RADIUS_MM, y: titleY + 1.5 };
}

/** Paper-mm geometry for a structural grid line and its Revit circular end bubbles (single source of truth for plan rendering and bubble drag grips). */
export const GRID_BUBBLE_RADIUS_MM = 4.2;

export interface GridBubbleGeometry {
  readonly pA: Vec2;
  readonly pB: Vec2;
  readonly bubbleA: Vec2;
  readonly bubbleB: Vec2;
  readonly hasBubbleB: boolean;
  readonly radius: number;
}

export function gridBubbleEndpoints(
  start: Vec2,
  end: Vec2,
  scale: number,
  boundsMin: Vec2,
  boundsMax: Vec2,
  toPaper: (p: Vec2) => Vec2,
): GridBubbleGeometry | null {
  const gdx = end.x - start.x;
  const gdy = end.y - start.y;
  const glen = Math.hypot(gdx, gdy);
  if (glen < 1) return null;
  const ux = gdx / glen;
  const uy = gdy / glen;
  const ext = 7 * scale;
  const pad = 22 * scale;
  const gA = { x: start.x - ux * ext, y: start.y - uy * ext };
  const gB = { x: end.x + ux * ext, y: end.y + uy * ext };
  const clipped = clipSegmentToRect(gA, gB, {
    min: { x: boundsMin.x - pad, y: boundsMin.y - pad },
    max: { x: boundsMax.x + pad, y: boundsMax.y + pad },
  });
  if (!clipped) return null;
  const pA = toPaper(clipped.a);
  const pB = toPaper(clipped.b);
  const pdx = pB.x - pA.x;
  const pdy = pB.y - pA.y;
  const plen = Math.hypot(pdx, pdy) || 1;
  const pax = pdx / plen;
  const pay = pdy / plen;
  const r = GRID_BUBBLE_RADIUS_MM;
  return {
    pA,
    pB,
    bubbleA: { x: pA.x - pax * r, y: pA.y - pay * r },
    bubbleB: { x: pB.x + pax * r, y: pB.y + pay * r },
    hasBubbleB: plen > 65,
    radius: r,
  };
}

/**
 * Draw an NCS / Revit back-referenced view title bubble at `center` (paper mm):
 * top half = this viewport's detail number, bottom half = referencing sheet number.
 */
export function drawViewTitleBubble(center: Vec2, detailNumber: string, refSheetNumber: string, prims: Primitive[]): number {
  drawSplitBubble(center, HEAD_RADIUS_MM, { top: detailNumber, bottom: refSheetNumber, viewName: "", sheetId: null, resolved: true }, prims);
  return HEAD_RADIUS_MM;
}

export interface EnlargedPlanCommandInput {
  readonly parentViewId: string;
  readonly viewId: string;
  readonly calloutId: string;
  readonly name: string;
  /** Callout rectangle in model mm (also becomes the enlarged plan's crop box). */
  readonly box: { readonly min: Vec2; readonly max: Vec2 };
  /** Enlarged scale ratio (e.g. 48 = 1/4"=1'-0", 24 = 1/2"=1'-0"). Defaults to 24 if parent is <= 48, else 48. */
  readonly scale?: number;
  /** Optional head label overriding the automatic detail number. */
  readonly label?: string;
  /** Optional callout head bubble position in model mm; defaults just outside the upper-left corner. */
  readonly head?: Vec2;
  /** Optional discipline override; defaults to the parent plan's discipline. */
  readonly discipline?: ViewProps["discipline"];
  /** Optional cut height override in mm; defaults to the parent plan's cut height. */
  readonly cutHeightMm?: number;
}

/**
 * Revit-style enlarged plan creation as one atomic step list: creates a
 * cropped plan view on the same level at enlarged scale (inheriting the parent
 * plan's discipline and display settings) and places a live parametric callout
 * bubble on the parent plan pointing to it.
 */
export function enlargedPlanCommands(model: Pick<ModelState, "elements">, input: EnlargedPlanCommandInput): ViewCommand[] | string {
  const parent = model.elements[input.parentViewId];
  if (!parent || parent.kind !== "view" || parent.deleted) return `Parent view ${input.parentViewId} does not exist.`;
  if (parent.viewType !== "floor_plan" && parent.viewType !== "ceiling_plan") {
    return `"${parent.name}" is a ${parent.viewType.replace("_", " ")}; enlarged plans are created from a floor plan or ceiling plan.`;
  }
  const min = { x: Math.min(input.box.min.x, input.box.max.x), y: Math.min(input.box.min.y, input.box.max.y) };
  const max = { x: Math.max(input.box.min.x, input.box.max.x), y: Math.max(input.box.min.y, input.box.max.y) };
  if (max.x - min.x < 25.4 || max.y - min.y < 25.4) return "The enlarged plan box needs a width and height of at least 1 in.";
  const parentProps = parent.props ?? {};
  const parentScale = parentProps.scale ?? 96;
  const scale = input.scale ?? (parentScale <= 48 ? 24 : 48);
  const headOffset = 8 * parentScale;
  const head = input.head ?? { x: min.x - headOffset, y: max.y + headOffset };
  type CreateViewProps = NonNullable<Extract<ViewCommand, { type: "create_view" }>["props"]>;
  const props: CreateViewProps = {
    ...(parentProps.level ? { level: parentProps.level } : {}),
    ...(parentProps.levelElevationMm !== undefined ? { levelElevationMm: parentProps.levelElevationMm } : {}),
    scale,
    ...(input.discipline !== undefined ? { discipline: input.discipline } : parentProps.discipline ? { discipline: parentProps.discipline } : {}),
    ...(input.cutHeightMm !== undefined ? { cutHeightMm: input.cutHeightMm } : parentProps.cutHeightMm !== undefined ? { cutHeightMm: parentProps.cutHeightMm } : {}),
    ...(parentProps.viewDepthMm !== undefined ? { viewDepthMm: parentProps.viewDepthMm } : {}),
    ...(parentProps.viewBottomMm !== undefined ? { viewBottomMm: parentProps.viewBottomMm } : {}),
    ...(parentProps.viewTopMm !== undefined ? { viewTopMm: parentProps.viewTopMm } : {}),
    ...(parentProps.detailLevel ? { detailLevel: parentProps.detailLevel } : {}),
    ...(parentProps.visualStyle ? { visualStyle: parentProps.visualStyle } : {}),
    ...(parentProps.showLineCodes !== undefined ? { showLineCodes: parentProps.showLineCodes } : {}),
    ...(parentProps.symbolScale !== undefined ? { symbolScale: parentProps.symbolScale } : {}),
    ...(parentProps.hiddenCategories ? { hiddenCategories: [...parentProps.hiddenCategories] } : {}),
    ...(parentProps.categoryOverrides && Object.keys(parentProps.categoryOverrides).length > 0 && categoryOverridesWritable()
      ? { categoryOverrides: { ...parentProps.categoryOverrides } as CreateViewProps["categoryOverrides"] }
      : {}),
    ...(parentProps.phaseId ? { phaseId: parentProps.phaseId } : {}),
    ...(parentProps.phaseFilterId ? { phaseFilterId: parentProps.phaseFilterId } : {}),
    ...(parentProps.groupDisplay ? { groupDisplay: { ...parentProps.groupDisplay } } : {}),
    ...(parentProps.references ? { references: { ...parentProps.references } } : {}),
    cropView: true,
  };
  return [
    {
      type: "create_view",
      viewId: input.viewId,
      name: input.name,
      viewType: parent.viewType,
      crop: { min, max },
      props,
    },
    {
      type: "add_drawing_item",
      itemId: input.calloutId,
      ownerId: parent.id,
      shape: "callout",
      points: [min, max, head],
      callout: { viewId: input.viewId, ...(input.label?.trim() ? { label: input.label.trim() } : {}) },
    },
  ];
}
