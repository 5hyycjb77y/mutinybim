import { PATTERN_DASH, type LinePattern } from "../annotation/detailing";
import { kindRowOf } from "../kinds/rows";
import { activeClassRegistry, classPlanGraphicsOf } from "../registry";
import { connectionAt, otherEnd } from "../model";
import type { PlanGraphic, PlanGraphicsContext, PlanPen } from "../registry/kind-row-faces";
import type { BimElement, ConnectorRef, ModelState, Vec2 } from "../types";
import type { Pen } from "./sheet";

/**
 * The `planGraphics` reader (contract 1.11.0): plans and the one-sheet
 * printout draw a record from its kind row's face before any kind case of
 * their own. A row without the face, or a face that answers null, leaves the
 * record to the drawer's own cases.
 */

/** What `drawing` and `detail` a plan graphics face is asked for, over one model. */
export function planGraphicsContext(model: ModelState, opts: { readonly scale: number; readonly levelId: string; readonly detail: PlanGraphicsContext["detail"]; readonly drawing: PlanGraphicsContext["drawing"]; readonly lookingUp?: boolean }): PlanGraphicsContext {
  return {
    elements: model.elements,
    scale: opts.scale,
    levelId: opts.levelId,
    detail: opts.detail,
    drawing: opts.drawing,
    lookingUp: opts.lookingUp ?? false,
    connectedTo: (ref: ConnectorRef) => {
      const c = connectionAt(model, ref);
      return c ? otherEnd(c, ref) : null;
    },
  };
}

/** The record's plan graphics from its class's row (`kernel.class_plan_graphics`), else its kind row, or null when neither has any. */
export function planGraphicsOf(el: BimElement, ctx: PlanGraphicsContext): readonly PlanGraphic[] | null {
  const byClass = classPlanGraphicsOf(el, ctx, activeClassRegistry());
  if (byClass) return byClass;
  const face = kindRowOf(el.kind)?.planGraphics;
  return face ? face(el, ctx) : null;
}

/** A plan pen as a drawing pen; `cut` is the heavy cut line unless the view names one. */
export function penOf(pen: PlanPen, cut: Pen = "heavy"): Pen {
  return pen === "cut" ? cut : pen;
}

const isPattern = (name: string): name is LinePattern => Object.prototype.hasOwnProperty.call(PATTERN_DASH, name);

/** A line pattern's dash, undefined for solid (and for a pattern plans don't know). */
export function dashOf(name: string | undefined): number[] | undefined {
  if (name === undefined || !isPattern(name)) return undefined;
  const dash = PATTERN_DASH[name];
  return dash ? [...dash] : undefined;
}

const ARC_STEP_DEG = 22.5;

/** An arc as the chord points plans draw it with (one chord per 22.5°, at least one). */
export function arcPoints(g: Extract<PlanGraphic, { readonly form: "arc" }>): Vec2[] {
  const steps = Math.max(1, Math.ceil(Math.abs(g.sweepDeg) / ARC_STEP_DEG));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((g.startDeg + (g.sweepDeg * i) / steps) * Math.PI) / 180;
    out.push({ x: g.center.x + g.radiusMm * Math.cos(a), y: g.center.y + g.radiusMm * Math.sin(a) });
  }
  return out;
}

/** The corners of a `rect` graphic, counter-clockwise from its low corner. */
export function rectCorners(center: Vec2, size: Vec2): Vec2[] {
  const hx = size.x / 2;
  const hy = size.y / 2;
  return [
    { x: center.x + -hx, y: center.y + -hy },
    { x: center.x + hx, y: center.y + -hy },
    { x: center.x + hx, y: center.y + hy },
    { x: center.x + -hx, y: center.y + hy },
  ];
}

/** Each straight piece a line, polyline or arc graphic draws, in order. */
export function graphicSegments(g: PlanGraphic): Array<readonly [Vec2, Vec2]> {
  switch (g.form) {
    case "line":
      return [[g.a, g.b]];
    case "polyline": {
      const out: Array<readonly [Vec2, Vec2]> = [];
      const n = g.points.length;
      const last = g.closed && n > 2 ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = g.points[i];
        const b = g.points[(i + 1) % n];
        if (a && b) out.push([a, b]);
      }
      return out;
    }
    case "arc": {
      const pts = arcPoints(g);
      const out: Array<readonly [Vec2, Vec2]> = [];
      for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i] as Vec2, pts[i + 1] as Vec2]);
      return out;
    }
    case "rect": {
      const c = rectCorners(g.center, g.size);
      return c.map((q, i) => [q, c[(i + 1) % 4] ?? q] as const);
    }
    default:
      return [];
  }
}
