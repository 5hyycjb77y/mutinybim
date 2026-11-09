import {
  add as kernelAdd,
  dot,
  headlineKindValue,
  length,
  perp,
  planWidth,
  profileLabel,
  scale as kernelScale,
  sub as kernelSub,
  unit as kernelUnit,
  type BimElement,
  type ElementId,
  type ElementKindItem,
  type KindPlanGraphicsFace,
  type PlanGraphic,
  type PlanGraphicsContext,
  type Vec2,
} from "@permitzip/bim-kernel";

// Bound once: re-exported functions can compile to getters, too slow for every duct a full plan draws.
const add = kernelAdd;
const scale = kernelScale;
const sub = kernelSub;
const unit = kernelUnit;

/**
 * What plans and the one-sheet printout draw for the Mechanical add-on's
 * kinds (`planGraphics` on its `ELEMENT_KIND_POINT` rows): a duct's two
 * edges, mitred at elbows, capped at open ends and stopped short of a
 * diffuser, with its size along it; an elbow's outer corner; a diffuser's
 * box and cross; a unit's box and mark. Exactly what round 12's kernel drew.
 */

const INCH = 25.4;
/** A diffuser's box is 24" across; a duct ending in one stops at its face. */
const TERMINAL_HALF_MM = 12 * INCH;

type Line = Extract<PlanGraphic, { readonly form: "line" }>;
const wide = (a: Vec2, b: Vec2): Line => ({ form: "line", a, b, pen: "wide" });
const wideToned = (screened: boolean) => (a: Vec2, b: Vec2): Line => (screened ? { form: "line", a, b, pen: "wide", tone: "halftone" } : wide(a, b));

/** Unit direction from the elbow into its other leg (the one that isn't `notSegment`). */
function elbowOtherDirection(ctx: PlanGraphicsContext, elbowId: ElementId, notSegment: ElementId): Vec2 | null {
  const elbow = ctx.elements[elbowId];
  if (!elbow || elbow.kind !== "elbow") return null;
  for (const end of ["in", "out"] as const) {
    const ref = ctx.connectedTo({ elementId: elbow.id, end });
    if (!ref || ref.elementId === notSegment) continue;
    const seg = ctx.elements[ref.elementId];
    if (seg && seg.kind === "duct_segment") {
      const far = ref.end === "start" ? seg.end : seg.start;
      return unit(sub(far, elbow.position));
    }
  }
  return null;
}

/** One edge's end: stopped at a diffuser's face, and the inner side trimmed back half a width at an elbow so the corner mitres. */
function trimAt(ctx: PlanGraphicsContext, segId: ElementId, end: "start" | "end", offset: Vec2, point: Vec2, axis: Vec2, half: number, inward: 1 | -1): Vec2 {
  const ref = ctx.connectedTo({ elementId: segId, end });
  if (!ref) return point;
  const other = ctx.elements[ref.elementId];
  if (!other) return point;
  if (other.kind === "terminal") return add(point, scale(axis, inward * TERMINAL_HALF_MM));
  if (other.kind !== "elbow") return point;
  const otherDir = elbowOtherDirection(ctx, other.id, segId);
  if (!otherDir) return point;
  return dot(offset, otherDir) > 0 ? add(point, scale(axis, inward * half)) : point;
}

const ductGraphics: KindPlanGraphicsFace = (el, ctx) => {
  if (el.kind !== "duct_segment") return null;
  const coarse = ctx.detail === "coarse";
  // Looking up, a duct below the ceiling prints screened.
  const edge = wideToned(ctx.lookingUp);
  const out: PlanGraphic[] = [];
  if (coarse) {
    out.push(edge(el.start, el.end));
  } else {
    const axis = unit(sub(el.end, el.start));
    const n = perp(axis);
    const half = planWidth(el.profile) / 2;
    for (const side of [1, -1] as const) {
      const offset = scale(n, half * side);
      const a = trimAt(ctx, el.id, "start", offset, add(el.start, offset), axis, half, 1);
      const b = trimAt(ctx, el.id, "end", offset, add(el.end, offset), axis, half, -1);
      out.push(edge(a, b));
    }
    for (const end of ["start", "end"] as const) {
      if (ctx.connectedTo({ elementId: el.id, end })) continue;
      const p = end === "start" ? el.start : el.end;
      out.push(edge(add(p, scale(n, half)), add(p, scale(n, -half))));
    }
  }
  if (length(sub(el.end, el.start)) / ctx.scale > 25) {
    const mid = scale(add(el.start, el.end), 0.5);
    const n = perp(unit(sub(el.end, el.start)));
    const at = add(mid, scale(n, (coarse ? 0 : planWidth(el.profile) / 2) + 6 * ctx.scale));
    out.push({ form: "tag_place", at, rotationDeg: 0, text: profileLabel(el.profile), ref: "centerline_mid", heightMm: 2.5, anchor: "middle" });
  }
  return out;
};

const elbowGraphics: KindPlanGraphicsFace = (el, ctx) => {
  if (el.kind !== "elbow") return null;
  if (ctx.detail === "coarse") return [];
  const pos = el.position;
  const dirs: Vec2[] = [];
  for (const end of ["in", "out"] as const) {
    const ref = ctx.connectedTo({ elementId: el.id, end });
    if (!ref) continue;
    const seg = ctx.elements[ref.elementId];
    if (seg && seg.kind === "duct_segment") {
      const far = ref.end === "start" ? seg.end : seg.start;
      dirs.push(unit(sub(far, pos)));
    }
  }
  const [u1, u2] = dirs;
  if (!u1 || !u2) return [];
  const half = planWidth(el.profile) / 2;
  const corner = sub(pos, scale(add(u1, u2), half));
  return [wide(sub(pos, scale(u2, half)), corner), wide(sub(pos, scale(u1, half)), corner)];
};

/** A record's headline value as printed ("350 CFM"), empty when it keeps none. */
function headlineText(el: BimElement): string {
  const h = headlineKindValue(el);
  return h ? `${Math.round(h.value)} ${h.spec.unit}` : "";
}

const terminalGraphics: KindPlanGraphicsFace = (el, ctx) => {
  if (el.kind !== "terminal") return null;
  const h = TERMINAL_HALF_MM;
  const c = el.position;
  const corners = [add(c, { x: -h, y: -h }), add(c, { x: h, y: -h }), add(c, { x: h, y: h }), add(c, { x: -h, y: h })];
  const out: PlanGraphic[] = [];
  for (let i = 0; i < 4; i++) out.push({ form: "line", a: corners[i] ?? c, b: corners[(i + 1) % 4] ?? c, pen: "medium" });
  out.push({ form: "line", a: corners[0] ?? c, b: corners[2] ?? c, pen: "thin" });
  out.push({ form: "line", a: corners[1] ?? c, b: corners[3] ?? c, pen: "thin" });
  if (ctx.drawing === "sheet") {
    out.push({ form: "tag_place", at: add(c, { x: h + 4 * ctx.scale, y: -h }), rotationDeg: 0, text: `${el.mark} / ${headlineText(el)}`, ref: "insertion", heightMm: 2.5, anchor: "start" });
  }
  return out;
};

const unitGraphics: KindPlanGraphicsFace = (el, ctx) => {
  if (el.kind !== "equipment") return null;
  const box: PlanGraphic = { form: "rect", center: el.position, size: el.size, pen: "wide" };
  if (ctx.drawing === "sheet") {
    return [
      box,
      { form: "tag_place", at: el.position, rotationDeg: 0, text: el.mark, ref: "insertion", heightMm: 3, anchor: "middle", bold: true },
      { form: "text", at: el.position, text: headlineText(el), heightMm: 2.5, rotationDeg: 0, anchor: "middle", paperOffsetMm: { x: 0, y: 4.5 } },
    ];
  }
  return [box, { form: "text", at: el.position, text: el.mark, heightMm: 3, rotationDeg: 0, anchor: "middle", bold: true }];
};

/** The `planGraphics` face of each owned kind that draws (a tap draws nothing of its own: its branch duct does). */
export const MECHANICAL_PLAN_GRAPHICS: Readonly<Record<"equipment" | "duct_segment" | "elbow" | "terminal", Pick<ElementKindItem, "planGraphics">>> = {
  equipment: { planGraphics: unitGraphics },
  duct_segment: { planGraphics: ductGraphics },
  elbow: { planGraphics: elbowGraphics },
  terminal: { planGraphics: terminalGraphics },
};
