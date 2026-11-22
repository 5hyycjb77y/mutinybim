import { planGapsOf } from "../hosting/voids";
import { resolveElementMaterial } from "../materials";
import type { KindPlanGraphicsFace, PlanGraphic } from "../registry/kind-row-faces";
import type { Vec2 } from "../types";
import { lineJoinsOf, lineMeetingsOf, type LineJoins } from "./solve";

interface Span {
  readonly a: number;
  readonly b: number;
}

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

function pointOn(j: LineJoins, d: number, side: 1 | -1): Vec2 {
  const half = j.widthMm / 2;
  return { x: j.start.x + j.u.x * d + j.n.x * side * half, y: j.start.y + j.u.y * d + j.n.y * side * half };
}

function mergeSpans(spans: readonly Span[]): Span[] {
  if (spans.length <= 1) return [...spans];
  const sorted = [...spans].sort((x, y) => x.a - y.a);
  const out: Span[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.a <= prev.b + 0.5) {
      out[out.length - 1] = { a: prev.a, b: Math.max(prev.b, s.b) };
    } else {
      out.push(s);
    }
  }
  return out;
}

function greyToHex(grey: number): string {
  const v = Math.round(Math.max(0, Math.min(1, grey)) * 255);
  const h = v.toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

/**
 * Plan graphics for a line-placed host with joins (`planGraphics` face):
 * building cut poché fill (split around hosted openings), both faces as
 * cut lines trimmed or mitered at corners and broken cleanly at both hosted
 * voids and tee/cross meetings, jamb caps at openings, and end caps where free.
 */
export const lineJoinPlanGraphics: KindPlanGraphicsFace = (el, ctx) => {
  const j = lineJoinsOf(ctx.elements, el.id);
  if (!j) return null;
  const gaps = planGapsOf(ctx.elements, el.id);
  const at = (d: number, side: 1 | -1): Vec2 => pointOn(j, d, side);
  const out: PlanGraphic[] = [];

  // 1. Cut poché fill polygon(s), split cleanly around hosted door/window openings.
  const mat = resolveElementMaterial({ elements: ctx.elements }, el);
  const isCurtain = mat?.pattern === "glass" || mat?.category === "glazing";
  if (isCurtain) {
    // Storefront / glazed assembly in plan (AIA / ISO 128):
    // crisp white backing mask + thin outer frame rails + thin double glazing pane + clean hollow mullions.
    // Returns early so opaque solid-wall cut lines never draw over the glazing or create blobs at wall joins.
    const d0 = Math.max(j.faces.startLeft, j.faces.startRight);
    const d1 = Math.min(j.faces.endLeft, j.faces.endRight);
    if (d1 > d0 + 10) {
      const frameHalf = Math.min(j.widthMm * 0.42, 48);
      const glassHalf = Math.min(j.widthMm * 0.14, 14);
      const panePt = (d: number, off: number): Vec2 => ({
        x: j.start.x + j.u.x * d + j.n.x * off,
        y: j.start.y + j.u.y * d + j.n.y * off,
      });
      // White backing mask across the curtain wall footprint
      out.push({
        form: "polyline",
        points: [panePt(d0, frameHalf), panePt(d1, frameHalf), panePt(d1, -frameHalf), panePt(d0, -frameHalf)],
        closed: true,
        pen: "none",
        fill: "#ffffff",
      });
      // Thin outer aluminum frame rails & double glazing lines
      out.push({ form: "line", a: panePt(d0, frameHalf), b: panePt(d1, frameHalf), pen: "thin" });
      out.push({ form: "line", a: panePt(d0, -frameHalf), b: panePt(d1, -frameHalf), pen: "thin" });
      out.push({ form: "line", a: panePt(d0, glassHalf), b: panePt(d1, glassHalf), pen: "thin" });
      out.push({ form: "line", a: panePt(d0, -glassHalf), b: panePt(d1, -glassHalf), pen: "thin" });
      // Rhythmic 1200 mm anodized mullion boxes (crisp hollow squares with thin ink)
      const bayMm = 1200;
      const bays = Math.max(1, Math.round((d1 - d0) / bayMm));
      const mulHalf = 22;
      for (let k = 0; k <= bays; k++) {
        const s = d0 + ((d1 - d0) * k) / bays;
        const a0 = Math.max(d0, s - mulHalf);
        const a1 = Math.min(d1, s + mulHalf);
        out.push({
          form: "polyline",
          points: [panePt(a0, frameHalf), panePt(a1, frameHalf), panePt(a1, -frameHalf), panePt(a0, -frameHalf)],
          closed: true,
          pen: "thin",
          fill: "#ffffff",
        });
      }
    }
    return out;
  }
  if (mat?.planCutHatch !== "none") {
    const pocheFill =
      typeof mat?.planCutFill === "string"
        ? mat.planCutFill
        : typeof mat?.planCutFill === "number"
          ? greyToHex(mat.planCutFill)
          : j.widthMm >= 180
            ? "#b8b5ae"
            : "#d6d3cc";
    let curL = j.faces.startLeft;
    let curR = j.faces.startRight;
    for (const g of gaps) {
      if (g.b <= Math.min(curL, curR) || g.a >= Math.max(j.faces.endLeft, j.faces.endRight)) continue;
      const stopL = Math.min(g.a, j.faces.endLeft);
      const stopR = Math.min(g.a, j.faces.endRight);
      if (stopL > curL + 0.5 || stopR > curR + 0.5) {
        out.push({
          form: "polyline",
          points: [at(curL, 1), at(stopL, 1), at(stopR, -1), at(curR, -1)],
          closed: true,
          pen: "none",
          fill: pocheFill,
        });
      }
      curL = Math.max(curL, g.b);
      curR = Math.max(curR, g.b);
    }
    if (j.faces.endLeft > curL + 0.5 || j.faces.endRight > curR + 0.5) {
      out.push({
        form: "polyline",
        points: [at(curL, 1), at(j.faces.endLeft, 1), at(j.faces.endRight, -1), at(curR, -1)],
        closed: true,
        pen: "none",
        fill: pocheFill,
      });
    }
  }

  // 2. Collect face breaks from hosted voids, teeing walls (`meetings.onFace`), and perpendicular solid walls meeting at endpoints (`meetings.atEnds`).
  const isGlazedId = (otherId: string): boolean => {
    const oEl = ctx.elements[otherId];
    if (!oEl) return false;
    const oMat = resolveElementMaterial({ elements: ctx.elements }, oEl);
    return oMat?.pattern === "glass" || oMat?.category === "glazing";
  };
  const leftBreaks: Span[] = [...gaps];
  const rightBreaks: Span[] = [...gaps];
  const meetings = lineMeetingsOf(ctx.elements, el.id);
  const addBreakFrom = (otherId: string, otherEnd: "start" | "end" | null): void => {
    if (isGlazedId(otherId)) return;
    const other = lineJoinsOf(ctx.elements, otherId);
    if (!other) return;
    // Skip collinear continuations (they meet end-to-end, not on left/right faces)
    if (Math.abs(j.u.x * other.u.y - j.u.y * other.u.x) < 0.05) return;
    const away: Vec2 = otherEnd === "start" ? other.u : otherEnd === "end" ? { x: -other.u.x, y: -other.u.y } : { x: 0, y: 0 };
    if (away.x === 0 && away.y === 0) return;
    const side: 1 | -1 = dot(j.n, away) >= 0 ? 1 : -1;
    const dL = otherEnd === "start" ? other.faces.startLeft : other.faces.endLeft;
    const dR = otherEnd === "start" ? other.faces.startRight : other.faces.endRight;
    const pL = pointOn(other, dL, 1);
    const pR = pointOn(other, dR, -1);
    const t1 = dot(sub(pL, j.start), j.u);
    const t2 = dot(sub(pR, j.start), j.u);
    const span: Span = { a: Math.min(t1, t2), b: Math.max(t1, t2) };
    if (span.b - span.a > 1) {
      if (side === 1) leftBreaks.push(span);
      else rightBreaks.push(span);
    }
  };
  if (meetings) {
    for (const f of meetings.onFace) addBreakFrom(f.otherId, f.otherEnd);
    for (const e of meetings.atEnds) addBreakFrom(e.otherId, e.otherEnd);
  }

  const face = (side: 1 | -1, from: number, to: number, breaks: readonly Span[]): void => {
    const merged = mergeSpans(breaks);
    let s = from;
    for (const g of merged) {
      if (g.b <= s || g.a >= to) continue;
      if (g.a > s) out.push({ form: "line", a: at(s, side), b: at(g.a, side), pen: "cut" });
      s = Math.max(s, g.b);
    }
    if (to > s) out.push({ form: "line", a: at(s, side), b: at(to, side), pen: "cut" });
  };
  face(1, j.faces.startLeft, j.faces.endLeft, leftBreaks);
  face(-1, j.faces.startRight, j.faces.endRight, rightBreaks);

  // 3. Opening jamb cap lines.
  for (const g of gaps) {
    out.push({ form: "line", a: at(g.a, 1), b: at(g.a, -1), pen: "cut" });
    out.push({ form: "line", a: at(g.b, 1), b: at(g.b, -1), pen: "cut" });
  }

  // 4. End caps: at free ends, outer-extending butt/cross caps, or where a solid wall meets only glazed walls (so solid walls close cleanly against storefront mullions).
  const [start, end] = j.cleanups;
  const onlyGlazedAt = (c: typeof start): boolean => c.with.length > 0 && c.with.every((id) => isGlazedId(id));
  if (
    start.style === "free" ||
    onlyGlazedAt(start) ||
    ((start.style === "butt" || start.style === "cross") && j.faces.startLeft < -1 && j.faces.startRight < -1)
  ) {
    out.push({ form: "line", a: at(j.faces.startLeft, 1), b: at(j.faces.startRight, -1), pen: "cut" });
  }
  if (
    end.style === "free" ||
    onlyGlazedAt(end) ||
    ((end.style === "butt" || end.style === "cross") && j.faces.endLeft > j.length + 1 && j.faces.endRight > j.length + 1)
  ) {
    out.push({ form: "line", a: at(j.faces.endLeft, 1), b: at(j.faces.endRight, -1), pen: "cut" });
  }
  return out;
};
