import { hostLineOf, hostVoidRow, type BimElement, type ClassSolidPart, type ClassSolidsRow, type KindSolidContext, type Vec2 } from "@permitzip/bim-kernel";
import { DOOR_OPERATION_KEY } from "./graphics";
import { valueOf } from "./values";

/**
 * Doors and windows in 3D, by class (`kernel.class_solids`): what fills the
 * void the kernel cuts in the wall. A door is a frame (two jambs and a head)
 * and its leaf, closed, flush with the face it opens to (two leaves for a
 * double door); a window is a frame, a sill and see-through glass. Sized from
 * the void (width, sill and head, so the body sits exactly in the hole), the
 * wall's thickness and the type's frame depth. Sections and elevations cut
 * the same body.
 */

/** The type's frame depth across the wall, mm; absent: the wall's thickness. */
export const FRAME_DEPTH_KEY = "architecture.frame_depth";
/** The opening's side, as `create_hosted` stores it (-1: the wall's right). */
const HOST_SIDE_KEY = "host.side";

/** Jamb and head face width, mm. */
const FRAME_FACE_MM = 50;
/** A door leaf's thickness, mm. */
const LEAF_MM = 45;
/** The gap between two leaves of a double door, mm. */
const LEAF_GAP_MM = 3;
/** A window sill's height and how far it stands proud of each wall face, mm. */
const SILL_MM = 40;
const SILL_PROUD_MM = 25;
/** Glass thickness, mm. */
const GLASS_MM = 6;

interface Hole {
  readonly start: Vec2;
  readonly u: Vec2;
  /** The wall's left normal. */
  readonly n: Vec2;
  /** Along the wall from its start. */
  readonly a: number;
  readonly b: number;
  /** World z of the void's sill and head. */
  readonly lo: number;
  readonly hi: number;
  readonly wallMm: number;
  readonly frameMm: number;
  /** 1: opens to the wall's left; -1: its right. */
  readonly side: 1 | -1;
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function holeOf(el: BimElement, ctx: KindSolidContext): Hole | null {
  if (!("hostId" in el) || typeof el.hostId !== "string") return null;
  const host = ctx.elements[el.hostId];
  const line = host ? hostLineOf(host, ctx.elements) : null;
  const v = host && line ? hostVoidRow(el.kind)?.voidOf(el, host, ctx.elements) : null;
  if (!line || !v || v.profile.length === 0) return null;
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  let a = Infinity;
  let b = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of v.profile) {
    a = Math.min(a, p.x);
    b = Math.max(b, p.x);
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  if (b - a < 2 * FRAME_FACE_MM + 1 || hi - lo < 2 * FRAME_FACE_MM + 1) return null;
  const u = { x: dx / len, y: dy / len };
  const wallMm = line.widthMm > 0 ? line.widthMm : FRAME_FACE_MM * 2;
  const frameMm = Math.min(positive(valueOf(el, ctx.elements, FRAME_DEPTH_KEY)) ?? wallMm, wallMm + 2 * SILL_PROUD_MM);
  return { start: line.start, u, n: { x: -u.y, y: u.x }, a, b, lo: ctx.floorMm + lo, hi: ctx.floorMm + hi, wallMm, frameMm, side: valueOf(el, ctx.elements, HOST_SIDE_KEY) === -1 ? -1 : 1 };
}

/** A box in the wall: `s0..s1` along it, `d0..d1` across it from its centreline (toward its left), `z0..z1` up. */
function box(h: Hole, s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, look?: ClassSolidPart["look"]): ClassSolidPart {
  const at = (s: number, d: number): Vec2 => ({ x: h.start.x + h.u.x * s + h.n.x * d, y: h.start.y + h.u.y * s + h.n.y * d });
  const outline = [at(s0, d0), at(s1, d0), at(s1, d1), at(s0, d1)];
  return { shape: { form: "prism", outline, z0, z1, category: "doors_windows", role: "architecture" }, ...(look ? { look } : {}) };
}

/** Jambs from `bottom` to the head, and the head, the frame's full depth. */
function frame(h: Hole, bottom: number, out: ClassSolidPart[]): void {
  const d = h.frameMm / 2;
  const f = FRAME_FACE_MM;
  out.push(box(h, h.a, h.a + f, -d, d, bottom, h.hi));
  out.push(box(h, h.b - f, h.b, -d, d, bottom, h.hi));
  out.push(box(h, h.a + f, h.b - f, -d, d, h.hi - f, h.hi));
}

export const DOOR_BODY: ClassSolidsRow = {
  classId: "arch.door",
  label: "Door frame and leaf",
  solids(el, ctx) {
    const h = holeOf(el, ctx);
    if (!h) return null;
    const out: ClassSolidPart[] = [];
    frame(h, h.lo, out);
    const op = String(valueOf(el, ctx.elements, DOOR_OPERATION_KEY) ?? "SINGLE_SWING_LEFT");
    const face = (h.side * h.frameMm) / 2;
    const [d0, d1] = op.includes("SLIDING") ? [-LEAF_MM / 2, LEAF_MM / 2] : [Math.min(face, face - h.side * LEAF_MM), Math.max(face, face - h.side * LEAF_MM)];
    const s0 = h.a + FRAME_FACE_MM;
    const s1 = h.b - FRAME_FACE_MM;
    const top = h.hi - FRAME_FACE_MM;
    if (op.startsWith("DOUBLE_")) {
      const mid = (s0 + s1) / 2;
      out.push(box(h, s0, mid - LEAF_GAP_MM / 2, d0, d1, h.lo, top));
      out.push(box(h, mid + LEAF_GAP_MM / 2, s1, d0, d1, h.lo, top));
    } else {
      out.push(box(h, s0, s1, d0, d1, h.lo, top));
    }
    return out;
  },
};

export const WINDOW_BODY: ClassSolidsRow = {
  classId: "arch.window",
  label: "Window frame, sill and glass",
  solids(el, ctx) {
    const h = holeOf(el, ctx);
    if (!h) return null;
    const out: ClassSolidPart[] = [];
    const sillTop = h.lo + SILL_MM;
    const sillHalf = h.wallMm / 2 + SILL_PROUD_MM;
    out.push(box(h, h.a, h.b, -sillHalf, sillHalf, h.lo, sillTop));
    frame(h, sillTop, out);
    const d = h.frameMm / 2;
    const f = FRAME_FACE_MM;
    out.push(box(h, h.a + f, h.b - f, -d, d, sillTop, sillTop + f));
    if (h.hi - f > sillTop + f) out.push(box(h, h.a + f, h.b - f, -GLASS_MM / 2, GLASS_MM / 2, sillTop + f, h.hi - f, "glazing"));
    return out;
  },
};

export const ARCHITECTURE_BODIES: readonly ClassSolidsRow[] = [DOOR_BODY, WINDOW_BODY];
