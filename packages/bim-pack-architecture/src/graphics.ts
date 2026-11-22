import { hostLineOf, type BimElement, type ClassPlanGraphicsRow, type PlanGraphic, type Vec2 } from "@permitzip/bim-kernel";
import { valueOf } from "./values";

/**
 * Doors and windows in plan, by class (`kernel.class_plan_graphics`):
 * - Doors: opaque white wall-opening mask, 50 mm jamb frames, 45 mm thick
 *   door leaf rectangle(s), and smooth 90° swing arc(s) (or staggered
 *   sliding leaves).
 * - Windows: opaque white wall-opening mask, continuous outer/inner wall-face
 *   sill lines, 50 mm frame jamb rectangles, crisp double-line glazing, and
 *   intermediate mullions for multi-panel windows.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const DOOR_OPERATION_KEY = "architecture.door_operation";
export const WINDOW_PARTITIONING_KEY = "architecture.window_partitioning";
/** The opening's side, as `create_hosted` stores it. */
const HOST_SIDE_KEY = "host.side";

const JAMB_MM = 45;
const DOOR_LEAF_THICK_MM = 45;
const GLAZING_HALF_MM = 10;
const MULLION_HALF_MM = 22;

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const deg = (v: Vec2): number => ((((Math.atan2(v.y, v.x) * 180) / Math.PI) % 360) + 360) % 360;

interface OpeningFrame {
  /** Opening rough edges along the wall. */
  readonly a: Vec2;
  readonly b: Vec2;
  readonly centre: Vec2;
  readonly u: Vec2;
  /** Toward the side it opens to. */
  readonly n: Vec2;
  /** The wall's face on that side, from the centreline. */
  readonly face: number;
  readonly width: number;
  readonly mark: string;
}

function frameOf(el: BimElement, elements: Elements): OpeningFrame | null {
  if (el.kind !== "opening") return null;
  const host = elements[el.hostId];
  const line = host ? hostLineOf(host, elements) : null;
  if (!line) return null;
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || el.width <= 0) return null;
  const u = { x: dx / len, y: dy / len };
  const side = valueOf(el, elements, HOST_SIDE_KEY) === -1 ? -1 : 1;
  const n = { x: -u.y * side, y: u.x * side };
  const centre = el.position;
  return { a: add(centre, mul(u, -el.width / 2)), b: add(centre, mul(u, el.width / 2)), centre, u, n, face: line.widthMm / 2, width: el.width, mark: el.mark };
}

/** Build a closed rectangle in opening-local (along `u`, across `n`) coordinates relative to `origin`. */
function boxPoly(origin: Vec2, u: Vec2, n: Vec2, u0: number, u1: number, n0: number, n1: number): readonly Vec2[] {
  const pt = (du: number, dn: number): Vec2 => add(add(origin, mul(u, du)), mul(n, dn));
  return [pt(u0, n0), pt(u1, n0), pt(u1, n1), pt(u0, n1)];
}

function mark(f: OpeningFrame, _elements: Elements, _elementId: string, out: PlanGraphic[]): void {
  if (f.mark.trim().length === 0) return;
  // Horizontal mark strings are wider than tall, so give extra clearance when placed beside a vertical wall.
  // View renderers suppress tag_place per view when a live movable drawing tag exists for this opening.
  const clearance = Math.abs(f.n.x) > 0.5 ? 480 : 320;
  out.push({ form: "tag_place", at: add(f.centre, mul(f.n, -(f.face + clearance))), rotationDeg: 0, text: f.mark, anchor: "middle" });
}

/** One swinging 45 mm door leaf hinged at `hinge`, closing toward `toward` (along the wall), `w` wide. */
function leaf(hinge: Vec2, toward: Vec2, f: OpeningFrame, w: number, out: PlanGraphic[]): void {
  // Thickness extends from the hinge inward toward `toward` so the outer edge sits flush on the jamb face.
  const t = Math.min(DOOR_LEAF_THICK_MM, w * 0.25);
  const poly = boxPoly(hinge, toward, f.n, 0, t, 0, w);
  out.push({ form: "polyline", points: poly, closed: true, pen: "medium", fill: "#ffffff" });
  const start = deg(toward);
  const sweep = toward.x * f.n.y - toward.y * f.n.x > 0 ? 90 : -90;
  out.push({ form: "arc", center: hinge, radiusMm: w, startDeg: start, sweepDeg: sweep, pen: "thin" });
}

export const DOOR_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "arch.door",
  label: "Door swing",
  planGraphics(el, ctx) {
    const f = frameOf(el, ctx.elements);
    if (!f) return null;
    const op = String(valueOf(el, ctx.elements, DOOR_OPERATION_KEY) ?? "SINGLE_SWING_LEFT");
    const jamb = Math.min(JAMB_MM, f.width * 0.12);
    const clearW = Math.max(100, f.width - 2 * jamb);
    const innerA = add(f.a, mul(f.u, jamb));
    const innerB = add(f.b, mul(f.u, -jamb));
    const onFace = (p: Vec2): Vec2 => add(p, mul(f.n, f.face));
    const out: PlanGraphic[] = [];

    // White opening mask across wall thickness so wall fill never bleeds into the doorway.
    out.push({
      form: "polyline",
      points: boxPoly(f.centre, f.u, f.n, -f.width / 2, f.width / 2, -f.face, f.face),
      closed: true,
      pen: "none",
      fill: "#ffffff",
    });

    // Crisp flush door jamb rectangles nested cleanly inside wall face depth (no stair-step protrusion).
    const jambDepth = Math.max(f.face - 4, 36);
    out.push({
      form: "polyline",
      points: boxPoly(f.a, f.u, f.n, 0, jamb, -jambDepth, jambDepth),
      closed: true,
      pen: "thin",
      fill: "#ffffff",
    });
    out.push({
      form: "polyline",
      points: boxPoly(f.b, f.u, f.n, -jamb, 0, -jambDepth, jambDepth),
      closed: true,
      pen: "thin",
      fill: "#ffffff",
    });

    if (op.includes("SLIDING")) {
      const halfSpan = clearW * 0.54;
      const trackOff = Math.min(f.face * 0.32, 24);
      const leafT = Math.min(36, f.face * 0.35);
      out.push({
        form: "polyline",
        points: boxPoly(innerA, f.u, f.n, 0, halfSpan, trackOff - leafT / 2, trackOff + leafT / 2),
        closed: true,
        pen: "medium",
        fill: "#ffffff",
      });
      out.push({
        form: "polyline",
        points: boxPoly(innerB, f.u, f.n, -halfSpan, 0, -trackOff - leafT / 2, -trackOff + leafT / 2),
        closed: true,
        pen: "medium",
        fill: "#ffffff",
      });
    } else if (op.includes("FOLDING")) {
      // Bi-fold accordion door leaves (two or four folded panels)
      const pairs = op.startsWith("DOUBLE_") ? 2 : 1;
      const segW = clearW / (pairs * 2);
      const peakN = segW * 0.72;
      for (let i = 0; i < pairs; i++) {
        const startU = i * 2 * segW;
        const p0 = add(onFace(innerA), mul(f.u, startU));
        const pMid = add(add(onFace(innerA), mul(f.u, startU + segW * 0.72)), mul(f.n, peakN));
        const p1 = add(onFace(innerA), mul(f.u, startU + segW * 1.44));
        out.push({ form: "line", a: p0, b: pMid, pen: "medium" });
        out.push({ form: "line", a: pMid, b: p1, pen: "medium" });
      }
    } else if (op === "ROLLINGUP") {
      // Overhead / garage sectional door: closed leaf across threshold + overhead track guidelines inside
      const trackDepth = Math.min(clearW * 0.85, 2200);
      out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, 0, clearW, -25, 25), closed: true, pen: "medium", fill: "#ffffff" });
      out.push({ form: "line", a: onFace(innerA), b: add(onFace(innerA), mul(f.n, trackDepth)), pen: "thin" });
      out.push({ form: "line", a: onFace(innerB), b: add(onFace(innerB), mul(f.n, trackDepth)), pen: "thin" });
      out.push({ form: "line", a: add(onFace(innerA), mul(f.n, trackDepth)), b: add(onFace(innerB), mul(f.n, trackDepth)), pen: "thin" });
    } else if (op.startsWith("DOUBLE_DOOR") || op.startsWith("DOUBLE_SWING")) {
      leaf(onFace(innerA), f.u, f, clearW / 2, out);
      leaf(onFace(innerB), mul(f.u, -1), f, clearW / 2, out);
    } else if (op.endsWith("RIGHT")) {
      leaf(onFace(innerB), mul(f.u, -1), f, clearW, out);
    } else {
      leaf(onFace(innerA), f.u, f, clearW, out);
    }
    mark(f, ctx.elements, el.id, out);
    return out;
  },
};

export const WINDOW_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "arch.window",
  label: "Window sash",
  planGraphics(el, ctx) {
    const f = frameOf(el, ctx.elements);
    if (!f) return null;
    const jamb = Math.min(JAMB_MM, f.width * 0.12);
    const frameHalf = Math.min(f.face * 0.72, 48);
    const glassHalf = Math.min(GLAZING_HALF_MM, frameHalf * 0.45);
    const innerA = add(f.a, mul(f.u, jamb));
    const innerB = add(f.b, mul(f.u, -jamb));
    const out: PlanGraphic[] = [];

    // White opening mask across wall thickness.
    out.push({
      form: "polyline",
      points: boxPoly(f.centre, f.u, f.n, -f.width / 2, f.width / 2, -f.face, f.face),
      closed: true,
      pen: "none",
      fill: "#ffffff",
    });

    // Continuous outer and inner wall-face sill lines.
    out.push({ form: "line", a: add(f.a, mul(f.n, f.face)), b: add(f.b, mul(f.n, f.face)), pen: "thin" });
    out.push({ form: "line", a: add(f.a, mul(f.n, -f.face)), b: add(f.b, mul(f.n, -f.face)), pen: "thin" });

    // Frame jamb rectangles at both ends of the opening.
    out.push({
      form: "polyline",
      points: boxPoly(f.a, f.u, f.n, 0, jamb, -frameHalf, frameHalf),
      closed: true,
      pen: "medium",
      fill: "#e6e4df",
    });
    out.push({
      form: "polyline",
      points: boxPoly(f.b, f.u, f.n, -jamb, 0, -frameHalf, frameHalf),
      closed: true,
      pen: "medium",
      fill: "#e6e4df",
    });

    // Double-line glazing panes (or staggered double-hung sashes) between jambs.
    const part = String(valueOf(el, ctx.elements, WINDOW_PARTITIONING_KEY) ?? "SINGLE_PANEL");
    if (part === "DOUBLE_PANEL_HORIZONTAL") {
      // Classic double-hung window: two offset sash tracks + center glazing rail
      const trackOff = Math.min(frameHalf * 0.42, 20);
      out.push({ form: "line", a: add(innerA, mul(f.n, trackOff)), b: add(innerB, mul(f.n, trackOff)), pen: "medium" });
      out.push({ form: "line", a: innerA, b: innerB, pen: "thin" });
      out.push({ form: "line", a: add(innerA, mul(f.n, -trackOff)), b: add(innerB, mul(f.n, -trackOff)), pen: "medium" });
    } else {
      out.push({ form: "line", a: add(innerA, mul(f.n, glassHalf)), b: add(innerB, mul(f.n, glassHalf)), pen: "medium" });
      out.push({ form: "line", a: add(innerA, mul(f.n, -glassHalf)), b: add(innerB, mul(f.n, -glassHalf)), pen: "medium" });
    }

    // Optional intermediate mullions for multi-panel vertical windows.
    const panels = part === "TRIPLE_PANEL_VERTICAL" ? 3 : part === "DOUBLE_PANEL_VERTICAL" ? 2 : 1;
    if (panels > 1) {
      const clearW = f.width - 2 * jamb;
      const mh = Math.min(MULLION_HALF_MM, clearW / (panels * 6));
      for (let i = 1; i < panels; i++) {
        const at = add(innerA, mul(f.u, (clearW * i) / panels));
        out.push({
          form: "polyline",
          points: boxPoly(at, f.u, f.n, -mh, mh, -frameHalf * 0.85, frameHalf * 0.85),
          closed: true,
          pen: "medium",
          fill: "#e6e4df",
        });
      }
    }

    mark(f, ctx.elements, el.id, out);
    return out;
  },
};

export const ARCHITECTURE_PLAN_GRAPHICS: readonly ClassPlanGraphicsRow[] = [DOOR_PLAN_GRAPHICS, WINDOW_PLAN_GRAPHICS];
