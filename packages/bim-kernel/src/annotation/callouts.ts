import { documentIndex } from "../commands/views";
import type { CalloutSpec, DrawingItem } from "../documents";
import type { Primitive } from "../drawing/sheet";
import type { ModelState, Vec2 } from "../types";

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

/** Paper mm. */
const HEAD_RADIUS_MM = 5;
const HEAD_TEXT_MM = 2.4;
const NAME_TEXT_MM = 2;
const CALLOUT_DASH: readonly number[] = [3, 1, 0.6, 1];

/** Draw a callout: its box, a leader from the nearest box corner to the head, the split head bubble and the view name. */
export function drawCallout(model: Pick<ModelState, "elements" | "connections">, item: DrawingItem, toPaper: (p: Vec2) => Vec2, prims: Primitive[]): boolean {
  const spec = item.callout;
  const [a, b, h] = item.points;
  if (!spec || !a || !b || !h) return false;
  const p = toPaper(a);
  const q = toPaper(b);
  const head = toPaper(h);
  const min = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) };
  const max = { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) };
  const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
  corners.forEach((c, i) => prims.push({ kind: "line", a: c, b: corners[(i + 1) % 4]!, pen: "medium", dash: CALLOUT_DASH }));
  const corner = corners.reduce((best, c) => (Math.hypot(c.x - head.x, c.y - head.y) < Math.hypot(best.x - head.x, best.y - head.y) ? c : best), corners[0]!);
  const d = Math.hypot(corner.x - head.x, corner.y - head.y);
  if (d > HEAD_RADIUS_MM) {
    const t = HEAD_RADIUS_MM / d;
    prims.push({ kind: "line", a: corner, b: { x: head.x + (corner.x - head.x) * t, y: head.y + (corner.y - head.y) * t }, pen: "thin" });
  }
  const r = HEAD_RADIUS_MM;
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI;
    const a1 = ((i + 1) / n) * 2 * Math.PI;
    prims.push({ kind: "line", a: { x: head.x + r * Math.cos(a0), y: head.y + r * Math.sin(a0) }, b: { x: head.x + r * Math.cos(a1), y: head.y + r * Math.sin(a1) }, pen: "medium" });
  }
  prims.push({ kind: "line", a: { x: head.x - r, y: head.y }, b: { x: head.x + r, y: head.y }, pen: "thin" });
  const live = calloutHead(model, spec);
  prims.push({ kind: "text", at: { x: head.x, y: head.y - 1 }, text: live.top, size: HEAD_TEXT_MM, anchor: "middle", bold: true });
  prims.push({ kind: "text", at: { x: head.x, y: head.y + 1 + HEAD_TEXT_MM }, text: live.bottom, size: HEAD_TEXT_MM, anchor: "middle" });
  const name = live.viewName ? (live.resolved ? live.viewName : `${live.viewName} (NOT ON A SHEET)`) : "VIEW REMOVED";
  prims.push({ kind: "text", at: { x: head.x + r + 1.5, y: head.y + NAME_TEXT_MM / 2 }, text: name, size: NAME_TEXT_MM, anchor: "start" });
  return true;
}
