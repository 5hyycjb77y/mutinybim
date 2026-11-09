import { siteOf, type SiteFrame } from "./site";
import type { Vec2, ViewElement } from "./types";

/**
 * The working angle: the direction a person draws in. A building that sits
 * skewed on our model axes gets a working angle equal to its walls' skew, and
 * then route snaps (square and 45°), the placement grid, drafting ortho and
 * polar steps, new 3D crop boxes and (when asked) plan views all work square
 * to the building instead of square to model east.
 *
 * It is a work frame, nothing more. Geometry, linked models, shared
 * coordinates and true north never change when it does (`modelToShared` does
 * not read it). The model has one default on its site element; a view may
 * carry its own (`ViewProps.workingAngleDeg`), which wins in that view.
 *
 * Degrees counter-clockwise from model +X (east) to the working X axis, kept
 * in (−45, 45]: the frame repeats every 90°, so this is the smallest turn that
 * puts the building's walls square. A turned frame's grid runs through the
 * project base point, so moving that point onto a building corner lines the
 * grid up with the building too. With no working angle the frame is the
 * model's axes through the internal origin, exactly as before.
 */

const RAD = Math.PI / 180;

/** Any angle as a working angle: in (−45, 45], rounded to a millionth of a degree. */
export function normalizeWorkingAngleDeg(deg: number): number {
  let a = ((deg % 90) + 90) % 90;
  if (a > 45) a -= 90;
  const r = Math.round(a * 1e6) / 1e6;
  return r === -45 ? 45 : r === 0 ? 0 : r;
}

/** The working angle that makes the line from `a` to `b` square to the frame (along it or across it). Null when they coincide. */
export function workingAngleFromEdge(a: Vec2, b: Vec2): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return normalizeWorkingAngleDeg(Math.atan2(dy, dx) / RAD);
}

/** The model's default working angle (0 when none was set). */
export function siteWorkingAngleDeg(site: Pick<SiteFrame, "workingAngleDeg">): number {
  return normalizeWorkingAngleDeg(site.workingAngleDeg ?? 0);
}

/** The working angle in a view: the view's own, else the model's. Without a view, the model's. */
export function workingAngleOf(model: { readonly elements: Readonly<Record<string, { readonly kind: string }>> }, view?: Pick<ViewElement, "props"> | null): number {
  const own = view?.props?.workingAngleDeg;
  return own !== undefined ? normalizeWorkingAngleDeg(own) : siteWorkingAngleDeg(siteOf(model));
}

/** Whether a view carries its own working angle instead of the model's. */
export function viewHasOwnWorkingAngle(view: Pick<ViewElement, "props"> | null | undefined): boolean {
  return view?.props?.workingAngleDeg !== undefined;
}

/** A work frame: the working angle and the point its grid runs through (plan mm). */
export interface WorkFrame {
  readonly angleDeg: number;
  readonly origin: Vec2;
}

/** Model axes through the internal origin: what every snap used before working angles. */
export const MODEL_FRAME: WorkFrame = { angleDeg: 0, origin: { x: 0, y: 0 } };

/** The frame for a model (and, optionally, the view it is drawn in). */
export function workFrameOf(model: { readonly elements: Readonly<Record<string, { readonly kind: string }>> }, view?: Pick<ViewElement, "props"> | null): WorkFrame {
  const angleDeg = workingAngleOf(model, view);
  if (angleDeg === 0) return MODEL_FRAME;
  const site = siteOf(model);
  return { angleDeg, origin: { x: site.basePoint.x, y: site.basePoint.y } };
}

export function isModelAligned(frame: WorkFrame): boolean {
  return frame.angleDeg === 0;
}

function turn(v: Vec2, deg: number): Vec2 {
  if (deg === 0) return v;
  const a = deg * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A plan point in frame coordinates (u along the working X axis, v along working Y), mm. */
export function toWorkFrame(frame: WorkFrame, p: Vec2): Vec2 {
  if (frame.angleDeg === 0 && frame.origin.x === 0 && frame.origin.y === 0) return p;
  return turn({ x: p.x - frame.origin.x, y: p.y - frame.origin.y }, -frame.angleDeg);
}

/** Frame coordinates back to a plan point, mm (rounded to the micron so snapped values stay clean). */
export function fromWorkFrame(frame: WorkFrame, q: Vec2): Vec2 {
  if (frame.angleDeg === 0 && frame.origin.x === 0 && frame.origin.y === 0) return q;
  const r = turn(q, frame.angleDeg);
  return { x: Math.round((frame.origin.x + r.x) * 1000) / 1000, y: Math.round((frame.origin.y + r.y) * 1000) / 1000 };
}

/** A direction (no origin) in frame coordinates. */
export function directionToWorkFrame(frame: WorkFrame, d: Vec2): Vec2 {
  return turn(d, -frame.angleDeg);
}

/** A frame direction back to plan. */
export function directionFromWorkFrame(frame: WorkFrame, d: Vec2): Vec2 {
  return turn(d, frame.angleDeg);
}

/** The working X and Y axes as plan unit vectors. */
export function workAxes(frame: WorkFrame): { readonly x: Vec2; readonly y: Vec2 } {
  return { x: turn({ x: 1, y: 0 }, frame.angleDeg), y: turn({ x: 0, y: 1 }, frame.angleDeg) };
}

/** A working angle in words: "Square to model axes" or "Turned 12.5° counter-clockwise". */
export function describeWorkingAngle(deg: number): string {
  const a = normalizeWorkingAngleDeg(deg);
  if (a === 0) return "Square to the model's axes";
  const shown = Math.round(Math.abs(a) * 100) / 100;
  return `Turned ${shown}° ${a > 0 ? "counter-clockwise" : "clockwise"}`;
}
