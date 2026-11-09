import { hostLineOf, type BimElement, type ClassPlanGraphicsRow, type PlanGraphic, type Vec2 } from "@permitzip/bim-kernel";
import { valueOf } from "./values";

/**
 * Doors and windows in plan, by class (`kernel.class_plan_graphics`): a
 * door's leaf and swing arc (or a sliding leaf), a window's frame and glass
 * lines, both across the gap their wall leaves, and the mark. The side a
 * door opens to is the opening's `host.side` (-1: the wall's right).
 */

type Elements = Readonly<Record<string, BimElement>>;

export const DOOR_OPERATION_KEY = "architecture.door_operation";
/** The opening's side, as `create_hosted` stores it. */
const HOST_SIDE_KEY = "host.side";

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const deg = (v: Vec2): number => ((((Math.atan2(v.y, v.x) * 180) / Math.PI) % 360) + 360) % 360;

interface OpeningFrame {
  /** Jambs along the wall. */
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

function mark(f: OpeningFrame, out: PlanGraphic[]): void {
  if (f.mark.trim().length > 0) out.push({ form: "tag_place", at: add(f.centre, mul(f.n, -(f.face + 300))), rotationDeg: 0, text: f.mark, anchor: "middle" });
}

/** One swinging leaf hinged at `hinge`, closing toward `toward` (along the wall), `w` wide. */
function leaf(hinge: Vec2, toward: Vec2, f: OpeningFrame, w: number, out: PlanGraphic[]): void {
  const open = add(hinge, mul(f.n, w));
  out.push({ form: "line", a: hinge, b: open, pen: "medium" });
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
    const onFace = (p: Vec2): Vec2 => add(p, mul(f.n, f.face));
    const out: PlanGraphic[] = [];
    if (op.includes("SLIDING")) {
      out.push({ form: "line", a: add(f.a, mul(f.n, f.face / 2)), b: add(f.b, mul(f.n, f.face / 2)), pen: "medium" });
    } else if (op.startsWith("DOUBLE_DOOR") || op.startsWith("DOUBLE_SWING")) {
      leaf(onFace(f.a), f.u, f, f.width / 2, out);
      leaf(onFace(f.b), mul(f.u, -1), f, f.width / 2, out);
    } else if (op.endsWith("RIGHT")) {
      leaf(onFace(f.b), mul(f.u, -1), f, f.width, out);
    } else {
      leaf(onFace(f.a), f.u, f, f.width, out);
    }
    mark(f, out);
    return out;
  },
};

export const WINDOW_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "arch.window",
  label: "Window sash",
  planGraphics(el, ctx) {
    const f = frameOf(el, ctx.elements);
    if (!f) return null;
    const out: PlanGraphic[] = [];
    for (const k of [-0.5, 0, 0.5]) out.push({ form: "line", a: add(f.a, mul(f.n, f.face * k)), b: add(f.b, mul(f.n, f.face * k)), pen: "thin" });
    mark(f, out);
    return out;
  },
};

export const ARCHITECTURE_PLAN_GRAPHICS: readonly ClassPlanGraphicsRow[] = [DOOR_PLAN_GRAPHICS, WINDOW_PLAN_GRAPHICS];
