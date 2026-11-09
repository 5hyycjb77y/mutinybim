import type { Viewport } from "../documents";
import { siteOf, type SiteFrame } from "../site";
import type { ViewElement, Vec2 } from "../types";
import { normalizeWorkingAngleDeg, siteWorkingAngleDeg } from "../work-frame";
import type { Primitive } from "./sheet";

/**
 * Plan orientation and the north arrow. A plan drawn "true north" is turned
 * counter-clockwise by the true north angle, so true north points up the
 * sheet; a plan drawn "plan north" keeps model +Y up. The north arrow always
 * points at true north on paper, so it reads straight up on a true-north plan
 * and at the true north angle on a plan-north one.
 */

function isPlan(view: ViewElement): boolean {
  return view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
}

/**
 * Degrees counter-clockwise the drawing turns on paper: 0 for plan north, the
 * true north angle for true north, and minus the working angle for a plan
 * turned to the working angle (so the building's walls run square to the
 * paper). Sections, details and 3D views never turn.
 */
export function viewRotationDeg(site: Pick<SiteFrame, "trueNorthDeg" | "workingAngleDeg">, view: ViewElement): number {
  if (!isPlan(view)) return 0;
  switch (view.props?.orientation) {
    case "true_north":
      return site.trueNorthDeg;
    case "working_angle": {
      const own = view.props.workingAngleDeg;
      const deg = -(own !== undefined ? normalizeWorkingAngleDeg(own) : siteWorkingAngleDeg(site));
      return deg === 0 ? 0 : deg;
    }
    default:
      return 0;
  }
}

/**
 * The working angle as it reads on paper (degrees counter-clockwise from
 * paper-right): what drafting ortho and polar tracking step from in a drawn
 * view. A plan uses its working angle turned by the plan's own turn (0 on a
 * plan turned to the working angle). A detail view uses only an angle set on
 * that view. Sections, 3D views and sheets: 0.
 */
export function paperWorkingAngleDeg(model: { readonly elements: Readonly<Record<string, { readonly kind: string }>> }, view: ViewElement | null): number {
  if (!view) return 0;
  const own = view.props?.workingAngleDeg;
  if (view.viewType === "detail") return own !== undefined ? normalizeWorkingAngleDeg(own) : 0;
  if (!isPlan(view)) return 0;
  const site = siteOf(model);
  const deg = (own !== undefined ? normalizeWorkingAngleDeg(own) : siteWorkingAngleDeg(site)) + viewRotationDeg(site, view);
  const r = Math.round(deg * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** Degrees clockwise from paper-up to where the north arrow points. */
export function northArrowDeg(site: Pick<SiteFrame, "trueNorthDeg" | "workingAngleDeg">, view: ViewElement): number {
  const deg = site.trueNorthDeg - viewRotationDeg(site, view);
  return deg === 0 ? 0 : deg;
}

/** Whether a viewport prints its north arrow: its own setting, else on for plans. */
export function showsNorthArrow(vp: Viewport, view: ViewElement): boolean {
  return vp.northArrow ?? isPlan(view);
}

/** The north arrow for a placed view, or null when it is off. */
export function viewportNorthArrow(model: { readonly elements: Readonly<Record<string, { readonly kind: string }>> }, vp: Viewport, view: ViewElement): { deg: number } | null {
  if (!showsNorthArrow(vp, view)) return null;
  return { deg: northArrowDeg(siteOf(model), view) };
}

/** Radius of the printed north arrow, paper mm. */
export const NORTH_ARROW_RADIUS_MM = 6;

/**
 * A north arrow centred at `at` (paper mm, y down), pointing `deg` clockwise
 * from up: a circle, a half-filled arrowhead drawn as outline and centre
 * line, and an upright N beyond the tip.
 */
export function drawNorthArrow(prims: Primitive[], at: Vec2, deg: number, r = NORTH_ARROW_RADIUS_MM): void {
  const a = (deg * Math.PI) / 180;
  // Paper y is down: "up" is (0, −1); clockwise by a is (sin a, −cos a).
  const dir = (k: number, side = 0): Vec2 => {
    const ux = Math.sin(a);
    const uy = -Math.cos(a);
    return { x: at.x + ux * k + -uy * side, y: at.y + uy * k + ux * side };
  };
  const segments = 32;
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * Math.PI * 2;
    const t1 = ((i + 1) / segments) * Math.PI * 2;
    prims.push({ kind: "line", a: { x: at.x + r * Math.cos(t0), y: at.y + r * Math.sin(t0) }, b: { x: at.x + r * Math.cos(t1), y: at.y + r * Math.sin(t1) }, pen: "thin" });
  }
  const tip = dir(r * 1.15);
  const tail = dir(-r * 0.75);
  const left = dir(-r * 0.45, -r * 0.42);
  const right = dir(-r * 0.45, r * 0.42);
  prims.push({ kind: "fill", points: [tip, right, tail], grey: 0 });
  prims.push({ kind: "line", a: tip, b: left, pen: "medium" });
  prims.push({ kind: "line", a: left, b: tail, pen: "medium" });
  prims.push({ kind: "line", a: tail, b: right, pen: "medium" });
  prims.push({ kind: "line", a: right, b: tip, pen: "medium" });
  const n = dir(r * 1.15 + 3.6);
  prims.push({ kind: "text", at: { x: n.x, y: n.y + 1.3 }, text: "N", size: 2.8, anchor: "middle", bold: true });
}
