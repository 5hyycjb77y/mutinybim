import { planGapsOf } from "../hosting/voids";
import type { KindPlanGraphicsFace, PlanGraphic } from "../registry/kind-row-faces";
import type { Vec2 } from "../types";
import { joinsChangeNothing, lineJoinsOf } from "./solve";

/**
 * Plan graphics for a line-placed host with joins (`planGraphics` face):
 * both faces as cut lines, trimmed or carried round the corner by its joins,
 * broken at the voids its hosted elements cut (a jamb line each side), and
 * an end line only where the end is free. Null when nothing joins it and
 * nothing cuts it, so the plan draws it as it always has.
 */
export const lineJoinPlanGraphics: KindPlanGraphicsFace = (el, ctx) => {
  const j = lineJoinsOf(ctx.elements, el.id);
  if (!j) return null;
  const gaps = planGapsOf(ctx.elements, el.id);
  if (gaps.length === 0 && joinsChangeNothing(j)) return null;
  const half = j.widthMm / 2;
  const at = (d: number, side: 1 | -1): Vec2 => ({ x: j.start.x + j.u.x * d + j.n.x * side * half, y: j.start.y + j.u.y * d + j.n.y * side * half });
  const out: PlanGraphic[] = [];
  const face = (side: 1 | -1, from: number, to: number): void => {
    let s = from;
    for (const g of gaps) {
      if (g.b <= s || g.a >= to) continue;
      if (g.a > s) out.push({ form: "line", a: at(s, side), b: at(g.a, side), pen: "cut" });
      s = Math.max(s, g.b);
    }
    if (to > s) out.push({ form: "line", a: at(s, side), b: at(to, side), pen: "cut" });
  };
  face(1, j.faces.startLeft, j.faces.endLeft);
  face(-1, j.faces.startRight, j.faces.endRight);
  for (const g of gaps) {
    out.push({ form: "line", a: at(g.a, 1), b: at(g.a, -1), pen: "cut" });
    out.push({ form: "line", a: at(g.b, 1), b: at(g.b, -1), pen: "cut" });
  }
  const [start, end] = j.cleanups;
  if (start.style === "free") out.push({ form: "line", a: at(j.faces.startLeft, 1), b: at(j.faces.startRight, -1), pen: "cut" });
  if (end.style === "free") out.push({ form: "line", a: at(j.faces.endLeft, 1), b: at(j.faces.endRight, -1), pen: "cut" });
  return out;
};
