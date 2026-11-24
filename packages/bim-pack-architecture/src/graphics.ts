import { hostLineOf, type BimElement, type ClassPlanGraphicsRow, type PlanGraphic, type Vec2 } from "@permitzip/bim-kernel";
import { DOOR_HANDING_KEY, DOOR_OPERATION_KEY, DOOR_SWING_KEY, WINDOW_PARTITIONING_KEY } from "./parameters";
import { valueOf } from "./values";

/**
 * Doors and windows in plan, by class (`kernel.class_plan_graphics`):
 * - Doors: opaque white wall-opening mask, 45 mm jamb frames, and standard
 *   architectural graphics for every IFC4 `OperationType` (single/double swing,
 *   double-acting swing both ways, swing + fixed sidelite, sliding with
 *   direction arrow, bi-fold accordion, overhead rolling with dashed tracks,
 *   and 4-wing revolving drum).
 * - Windows: opaque white wall-opening mask, continuous outer/inner wall-face
 *   sill lines, frame jamb rectangles, crisp double-line glazing (or staggered
 *   double-hung sashes), and intermediate mullions for multi-panel windows.
 */

type Elements = Readonly<Record<string, BimElement>>;

export { DOOR_HANDING_KEY, DOOR_OPERATION_KEY, DOOR_SWING_KEY, WINDOW_PARTITIONING_KEY };
/** The opening's side, as `create_hosted` stores it. */
const HOST_SIDE_KEY = "host.side";

/** Canonical IFC4 door operation resolved from `architecture.door_operation`, else `architecture.door_handing`, else `SINGLE_SWING_LEFT`. */
export function resolveDoorOperation(el: BimElement, elements: Elements): string {
  const rawOp = valueOf(el, elements, DOOR_OPERATION_KEY);
  if (typeof rawOp === "string" && rawOp.trim() !== "") return rawOp.trim().toUpperCase();
  const rawHanding = valueOf(el, elements, DOOR_HANDING_KEY);
  if (typeof rawHanding === "string") {
    const h = rawHanding.trim().toUpperCase();
    if (h === "RH" || h === "RHR") return "SINGLE_SWING_RIGHT";
  }
  return "SINGLE_SWING_LEFT";
}

/**
 * Which face of the host wall a door opens toward (`1` = wall left normal,
 * `-1` = wall right normal). Explicit `host.side` wins; otherwise
 * `architecture.door_swing` (`INWARD` → `1`, `OUTWARD` → `-1`) or reverse-bevel
 * handing (`LHR` / `RHR` → `-1`) decides.
 */
export function resolveDoorSide(el: BimElement, elements: Elements): 1 | -1 {
  const rawSide = valueOf(el, elements, HOST_SIDE_KEY);
  if (rawSide === -1) return -1;
  if (rawSide === 1) return 1;
  const rawSwing = valueOf(el, elements, DOOR_SWING_KEY);
  if (typeof rawSwing === "string") {
    const s = rawSwing.trim().toUpperCase();
    if (s === "OUTWARD") return -1;
    if (s === "INWARD") return 1;
  }
  const rawHanding = valueOf(el, elements, DOOR_HANDING_KEY);
  if (typeof rawHanding === "string") {
    const h = rawHanding.trim().toUpperCase();
    if (h === "LHR" || h === "RHR") return -1;
    if (h === "LH" || h === "RH") return 1;
  }
  return 1;
}

/** Standard US door handing (`LH`, `RH`, `LHR`, `RHR`), from explicit `architecture.door_handing` or derived from operation + swing side. */
export function resolveDoorHanding(el: BimElement, elements: Elements): string | null {
  const explicit = valueOf(el, elements, DOOR_HANDING_KEY);
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim().toUpperCase();
  const op = resolveDoorOperation(el, elements);
  const side = resolveDoorSide(el, elements);
  if (op === "SINGLE_SWING_LEFT" || op === "SWING_FIXED_LEFT" || op === "DOUBLE_SWING_LEFT") return side === -1 ? "LHR" : "LH";
  if (op === "SINGLE_SWING_RIGHT" || op === "SWING_FIXED_RIGHT" || op === "DOUBLE_SWING_RIGHT") return side === -1 ? "RHR" : "RH";
  return null;
}

const HANDED_FLIP: Readonly<Record<string, string>> = {
  SINGLE_SWING_LEFT: "SINGLE_SWING_RIGHT",
  SINGLE_SWING_RIGHT: "SINGLE_SWING_LEFT",
  DOUBLE_SWING_LEFT: "DOUBLE_SWING_RIGHT",
  DOUBLE_SWING_RIGHT: "DOUBLE_SWING_LEFT",
  SWING_FIXED_LEFT: "SWING_FIXED_RIGHT",
  SWING_FIXED_RIGHT: "SWING_FIXED_LEFT",
  SLIDING_TO_LEFT: "SLIDING_TO_RIGHT",
  SLIDING_TO_RIGHT: "SLIDING_TO_LEFT",
  FOLDING_TO_LEFT: "FOLDING_TO_RIGHT",
  FOLDING_TO_RIGHT: "FOLDING_TO_LEFT",
};

/** Opposite handed operation (left ↔ right), or null for symmetric / non-handed operations. */
export function flipDoorOperation(op: string): string | null {
  return HANDED_FLIP[op.trim().toUpperCase()] ?? null;
}

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
  const side = resolveDoorSide(el, elements);
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

/** One swinging 45 mm door leaf hinged at `hinge`, closing toward `toward` (along the wall), swinging into `normal`, `w` wide. */
function leafIn(hinge: Vec2, toward: Vec2, normal: Vec2, w: number, out: PlanGraphic[], dash?: string): void {
  // Thickness extends from the hinge inward toward `toward` so the outer edge sits flush on the jamb face.
  const t = Math.min(DOOR_LEAF_THICK_MM, w * 0.25);
  const poly = boxPoly(hinge, toward, normal, 0, t, 0, w);
  out.push({ form: "polyline", points: poly, closed: true, pen: "medium", fill: "#ffffff", ...(dash ? { dash } : {}) });
  const start = deg(toward);
  const sweep = toward.x * normal.y - toward.y * normal.x > 0 ? 90 : -90;
  out.push({ form: "arc", center: hinge, radiusMm: w, startDeg: start, sweepDeg: sweep, pen: "thin", ...(dash ? { dash } : {}) });
}

function leaf(hinge: Vec2, toward: Vec2, f: OpeningFrame, w: number, out: PlanGraphic[]): void {
  leafIn(hinge, toward, f.n, w, out);
}

/** A crisp sliding-direction arrow along `dir` centered at `mid`, `len` long. */
function slideArrow(mid: Vec2, dir: Vec2, n: Vec2, len: number, out: PlanGraphic[]): void {
  const half = len / 2;
  const head = Math.min(85, len * 0.32);
  const wing = head * 0.55;
  const tail = add(mid, mul(dir, -half));
  const tip = add(mid, mul(dir, half));
  out.push({ form: "line", a: tail, b: tip, pen: "thin" });
  out.push({ form: "line", a: tip, b: add(add(tip, mul(dir, -head)), mul(n, wing)), pen: "thin" });
  out.push({ form: "line", a: tip, b: add(add(tip, mul(dir, -head)), mul(n, -wing)), pen: "thin" });
}

/** One bi-fold accordion pair anchored at `anchor` extending along `dir` (total span `spanW`), folding into `f.n`. */
function bifoldPair(anchor: Vec2, dir: Vec2, f: OpeningFrame, spanW: number, out: PlanGraphic[]): void {
  const segW = spanW / 2;
  const peakN = segW * 0.65;
  const foldSpan = spanW * 0.78;
  const p0 = anchor;
  const pMid = add(add(anchor, mul(dir, foldSpan * 0.5)), mul(f.n, peakN));
  const p1 = add(anchor, mul(dir, foldSpan));
  out.push({ form: "line", a: p0, b: pMid, pen: "medium" });
  out.push({ form: "line", a: pMid, b: p1, pen: "medium" });
  // Dashed track line across the remaining closed span
  out.push({ form: "line", a: p1, b: add(anchor, mul(dir, spanW)), pen: "thin", dash: "dashed" });
}

export const DOOR_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "arch.door",
  label: "Door swing",
  planGraphics(el, ctx) {
    const f = frameOf(el, ctx.elements);
    if (!f) return null;
    const op = resolveDoorOperation(el, ctx.elements);
    const jamb = Math.min(JAMB_MM, f.width * 0.12);
    const clearW = Math.max(100, f.width - 2 * jamb);
    const innerA = add(f.a, mul(f.u, jamb));
    const innerB = add(f.b, mul(f.u, -jamb));
    const onFace = (p: Vec2): Vec2 => add(p, mul(f.n, f.face));
    const onBack = (p: Vec2): Vec2 => add(p, mul(f.n, -f.face));
    const negU = mul(f.u, -1);
    const negN = mul(f.n, -1);
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

    if (op === "DOUBLE_DOOR_SLIDING") {
      // Bi-parting sliding door: two active center leaves sliding outward + staggered outer fixed leaves
      const panelW = clearW * 0.27;
      const trackOff = Math.min(f.face * 0.32, 24);
      const leafT = Math.min(36, f.face * 0.35);
      // Outer fixed panels on back track
      out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, 0, panelW, -trackOff - leafT / 2, -trackOff + leafT / 2), closed: true, pen: "medium", fill: "#ffffff" });
      out.push({ form: "polyline", points: boxPoly(innerB, f.u, f.n, -panelW, 0, -trackOff - leafT / 2, -trackOff + leafT / 2), closed: true, pen: "medium", fill: "#ffffff" });
      // Center bi-parting active panels on front track
      const midU = clearW / 2;
      out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, midU - panelW, midU, trackOff - leafT / 2, trackOff + leafT / 2), closed: true, pen: "medium", fill: "#ffffff" });
      out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, midU, midU + panelW, trackOff - leafT / 2, trackOff + leafT / 2), closed: true, pen: "medium", fill: "#ffffff" });
      const arrowLen = Math.min(260, panelW * 0.6);
      slideArrow(add(add(innerA, mul(f.u, midU - panelW * 0.5)), mul(f.n, f.face + 120)), negU, f.n, arrowLen, out);
      slideArrow(add(add(innerA, mul(f.u, midU + panelW * 0.5)), mul(f.n, f.face + 120)), f.u, f.n, arrowLen, out);
    } else if (op.includes("SLIDING")) {
      const toRight = op === "SLIDING_TO_RIGHT";
      const halfSpan = clearW * 0.54;
      const trackOff = Math.min(f.face * 0.32, 24);
      const leafT = Math.min(36, f.face * 0.35);
      // Active panel sits on the front (+trackOff) track; fixed panel on back (-trackOff) track
      const leftTrack = toRight ? trackOff : -trackOff;
      const rightTrack = toRight ? -trackOff : trackOff;
      out.push({
        form: "polyline",
        points: boxPoly(innerA, f.u, f.n, 0, halfSpan, leftTrack - leafT / 2, leftTrack + leafT / 2),
        closed: true,
        pen: "medium",
        fill: "#ffffff",
      });
      out.push({
        form: "polyline",
        points: boxPoly(innerB, f.u, f.n, -halfSpan, 0, rightTrack - leafT / 2, rightTrack + leafT / 2),
        closed: true,
        pen: "medium",
        fill: "#ffffff",
      });
      const arrowLen = Math.min(300, clearW * 0.25);
      const arrowOrigin = toRight ? add(innerA, mul(f.u, halfSpan * 0.5)) : add(innerB, mul(f.u, -halfSpan * 0.5));
      slideArrow(add(arrowOrigin, mul(f.n, f.face + 120)), toRight ? f.u : negU, f.n, arrowLen, out);
    } else if (op === "DOUBLE_DOOR_FOLDING") {
      bifoldPair(onFace(innerA), f.u, f, clearW / 2, out);
      bifoldPair(onFace(innerB), negU, f, clearW / 2, out);
    } else if (op === "FOLDING_TO_RIGHT") {
      bifoldPair(onFace(innerB), negU, f, clearW, out);
    } else if (op.includes("FOLDING")) {
      bifoldPair(onFace(innerA), f.u, f, clearW, out);
    } else if (op === "ROLLINGUP") {
      // Overhead / garage sectional door: closed leaf across threshold + dashed overhead track guidelines inside
      const trackDepth = Math.min(clearW * 0.85, 2200);
      out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, 0, clearW, -25, 25), closed: true, pen: "medium", fill: "#ffffff" });
      out.push({ form: "line", a: onFace(innerA), b: add(onFace(innerA), mul(f.n, trackDepth)), pen: "thin", dash: "dashed" });
      out.push({ form: "line", a: onFace(innerB), b: add(onFace(innerB), mul(f.n, trackDepth)), pen: "thin", dash: "dashed" });
      out.push({ form: "line", a: add(onFace(innerA), mul(f.n, trackDepth)), b: add(onFace(innerB), mul(f.n, trackDepth)), pen: "thin", dash: "dashed" });
    } else if (op === "REVOLVING") {
      // Revolving door: circular vestibule enclosure + 4-wing cross blades
      const r = clearW / 2;
      out.push({ form: "arc", center: f.centre, radiusMm: r, startDeg: 0, sweepDeg: 180, pen: "thin" });
      out.push({ form: "arc", center: f.centre, radiusMm: r, startDeg: 180, sweepDeg: 180, pen: "thin" });
      const d = r * Math.SQRT1_2;
      const diag1 = add(mul(f.u, d), mul(f.n, d));
      const diag2 = add(mul(f.u, d), mul(f.n, -d));
      out.push({ form: "line", a: add(f.centre, mul(diag1, -1)), b: add(f.centre, diag1), pen: "medium" });
      out.push({ form: "line", a: add(f.centre, mul(diag2, -1)), b: add(f.centre, diag2), pen: "medium" });
    } else if (op === "DOUBLE_DOOR_DOUBLE_SWING") {
      // Double-leaf double-acting door: both leaves swing 90° to both sides (+n and -n)
      leafIn(onFace(innerA), f.u, f.n, clearW / 2, out);
      leafIn(onFace(innerB), negU, f.n, clearW / 2, out);
      leafIn(onBack(innerA), f.u, negN, clearW / 2, out);
      leafIn(onBack(innerB), negU, negN, clearW / 2, out);
    } else if (op === "DOUBLE_SWING_LEFT") {
      // Single-leaf double-acting door hinged on left jamb, swinging 90° both ways
      leafIn(onFace(innerA), f.u, f.n, clearW, out);
      leafIn(onBack(innerA), f.u, negN, clearW, out);
    } else if (op === "DOUBLE_SWING_RIGHT") {
      // Single-leaf double-acting door hinged on right jamb, swinging 90° both ways
      leafIn(onFace(innerB), negU, f.n, clearW, out);
      leafIn(onBack(innerB), negU, negN, clearW, out);
    } else if (op === "SWING_FIXED_LEFT" || op === "SWING_FIXED_RIGHT") {
      // Active swinging leaf (60%) + mullion + fixed closed sidelite/panel (40%)
      const activeW = clearW * 0.6;
      const fixedW = clearW - activeW;
      const panelT = Math.min(DOOR_LEAF_THICK_MM, 36);
      if (op === "SWING_FIXED_LEFT") {
        leaf(onFace(innerA), f.u, f, activeW, out);
        out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, activeW, clearW, -panelT / 2, panelT / 2), closed: true, pen: "medium", fill: "#e6e4df" });
      } else {
        leaf(onFace(innerB), negU, f, activeW, out);
        out.push({ form: "polyline", points: boxPoly(innerA, f.u, f.n, 0, fixedW, -panelT / 2, panelT / 2), closed: true, pen: "medium", fill: "#e6e4df" });
      }
    } else if (op.startsWith("DOUBLE_DOOR")) {
      leaf(onFace(innerA), f.u, f, clearW / 2, out);
      leaf(onFace(innerB), negU, f, clearW / 2, out);
    } else if (op.endsWith("RIGHT")) {
      leaf(onFace(innerB), negU, f, clearW, out);
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
