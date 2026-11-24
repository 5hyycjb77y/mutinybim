import type { BimElement, ClassPlanGraphicsRow, PlanGraphic, Vec2 } from "@permitzip/bim-kernel";
import { elementTypeValue } from "@permitzip/bim-pack/runtime";
import { to } from "@permitzip/bim-units";
import { STRUCT_KEYS } from "./frame";
import { liveLoadRate } from "./live-loads";
import { sectionById } from "./sections";

/**
 * Structural framing, column, footing, and one-way deck plan graphics
 * (`kernel.class_plan_graphics`):
 * - Steel columns (`struct.column_steel`): crisp AISC wide-flange I-section
 *   filled solid in plan, rotated to `placement.rotationDeg`, with a mark tag.
 * - Steel beams (`struct.beam_steel`): NCS framing-plan heavy centerline with
 *   short end setbacks at columns, optional fine-detail flange lines, and an
 *   upright centered mark/section callout (with camber when set).
 * - Pad footings (`struct.footing_pad`): NCS dashed footing outline below
 *   grade, inner baseplate outline, and a footing mark + dimension callout.
 * - One-way floor & roof decks (`struct.floor_deck`, `struct.roof_deck`):
 *   slab perimeter + holes with an NCS double-headed span-direction arrow and
 *   live-load designation at the deck centroid.
 */

type Elements = Readonly<Record<string, BimElement>>;

const FT = 304.8;
const IN = 25.4;

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });

function rotPoint(c: Vec2, dx: number, dy: number, cos: number, sin: number): Vec2 {
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function rectPoly(c: Vec2, x0: number, x1: number, y0: number, y1: number, cos: number, sin: number): readonly Vec2[] {
  return [rotPoint(c, x0, y0, cos, sin), rotPoint(c, x1, y0, cos, sin), rotPoint(c, x1, y1, cos, sin), rotPoint(c, x0, y1, cos, sin)];
}

function textVal(el: BimElement, key: string): string | null {
  if (el.kind === "load_point") return null;
  const vals = "values" in el ? el.values : undefined;
  const v = vals?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function sectionTextOf(elements: Elements, el: BimElement): string | null {
  const v = elementTypeValue(elements, el, STRUCT_KEYS.section);
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  if (el.kind === "beam" && el.sectionName.trim().length > 0) return el.sectionName.trim();
  return null;
}

function feetInchesCompact(mm: number): string {
  const totalIn = Math.round(mm / IN);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${ft}'-${inch}"`;
}

function uprightDeg(rad: number): number {
  let deg = (rad * 180) / Math.PI;
  while (deg > 90) deg -= 180;
  while (deg <= -90) deg += 180;
  return deg;
}

function centroid(outline: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const q of outline) {
    x += q.x;
    y += q.y;
  }
  return outline.length > 0 ? { x: x / outline.length, y: y / outline.length } : { x: 0, y: 0 };
}

export const STEEL_COLUMN_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "struct.column_steel",
  label: "Steel column section",
  planGraphics(el, ctx) {
    if (el.kind !== "column") return null;
    const c = el.position;
    const rad = el.placement?.kind === "point" && el.placement.rotationDeg ? (el.placement.rotationDeg * Math.PI) / 180 : 0;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const secName = sectionTextOf(ctx.elements, el);
    const sec = secName ? sectionById(secName) : null;
    const dMm = sec ? to(sec.depth, "mm") : el.size.y;
    const bfMm = sec ? to(sec.flangeWidth, "mm") : el.size.x;
    // Keep thin flanges legible at 1/8" and 3/16" framing scales while staying inside the column footprint.
    const tfMm = Math.min(dMm * 0.24, Math.max(sec ? to(sec.flangeThickness, "mm") : 18, 22));
    const twMm = Math.min(bfMm * 0.22, Math.max(sec ? to(sec.webThickness, "mm") : 14, 18));
    const hx = bfMm / 2;
    const hy = dMm / 2;
    const out: PlanGraphic[] = [
      // White background mask under the column section so grid lines break cleanly behind the steel profile.
      { form: "polyline", points: rectPoly(c, -hx - 12, hx + 12, -hy - 12, hy + 12, cos, sin), closed: true, pen: "none", fill: "#ffffff" },
      // Wide-flange I-section: top flange, web, bottom flange filled solid dark steel.
      { form: "polyline", points: rectPoly(c, -hx, hx, hy - tfMm, hy, cos, sin), closed: true, pen: "cut", fill: "#222222" },
      { form: "polyline", points: rectPoly(c, -twMm / 2, twMm / 2, -hy + tfMm, hy - tfMm, cos, sin), closed: true, pen: "cut", fill: "#222222" },
      { form: "polyline", points: rectPoly(c, -hx, hx, -hy, -hy + tfMm, cos, sin), closed: true, pen: "cut", fill: "#222222" },
    ];
    const mark = textVal(el, "mark");
    if (mark && ctx.discipline === "structure") {
      const off = Math.max(hx, hy) + Math.max(180, 2.2 * ctx.scale);
      out.push({ form: "tag_place", at: { x: c.x + off, y: c.y + off * 0.65 }, rotationDeg: 0, text: mark, heightMm: 2.0, anchor: "start", bold: true });
    }
    return out;
  },
};

export const STEEL_BEAM_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "struct.beam_steel",
  label: "Steel beam framing",
  planGraphics(el, ctx) {
    if (el.kind !== "beam") return null;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 10) return null;
    const u = { x: dx / len, y: dy / len };
    const n = { x: -u.y, y: u.x };
    // Standard structural framing stick setback (~7" from column center) when span is long enough.
    const setback = len > 1200 ? Math.min(200, len * 0.08) : 0;
    const a = add(el.start, mul(u, setback));
    const b = add(el.end, mul(u, -setback));
    const secName = sectionTextOf(ctx.elements, el);
    const sec = secName ? sectionById(secName) : null;
    const out: PlanGraphic[] = [{ form: "line", a, b, pen: "wide" }];
    if (ctx.detail === "fine") {
      const halfBf = (sec ? to(sec.flangeWidth, "mm") : 150) / 2;
      out.push(
        { form: "line", a: add(a, mul(n, halfBf)), b: add(b, mul(n, halfBf)), pen: "thin", dash: "dashed" },
        { form: "line", a: add(a, mul(n, -halfBf)), b: add(b, mul(n, -halfBf)), pen: "thin", dash: "dashed" },
      );
    }
    const labelParts: string[] = [];
    const secDisplay = sec?.label ?? secName ?? el.sectionName;
    if (secDisplay) labelParts.push(secDisplay);
    const rawCamber = elementTypeValue(ctx.elements, el, "struct.camber");
    if (typeof rawCamber === "number" && rawCamber > 0) {
      const camberIn = Math.round((rawCamber / IN) * 16) / 16;
      labelParts.push(`[C=${camberIn}"]`);
    }
    if (labelParts.length > 0 && len > 1000) {
      const mid = { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 };
      const deg = uprightDeg(Math.atan2(dy, dx));
      const upNormal = n.y < -0.01 || (Math.abs(n.y) <= 0.01 && n.x < 0) ? mul(n, -1) : n;
      const offsetMm = Math.max(160, 2.2 * ctx.scale);
      out.push({
        form: "tag_place",
        at: add(mid, mul(upNormal, offsetMm)),
        rotationDeg: deg,
        ref: "centerline_mid",
        text: labelParts.join(" "),
        heightMm: 2.0,
        anchor: "middle",
        bold: true,
      });
    }
    return out;
  },
};

export const PAD_FOOTING_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "struct.footing_pad",
  label: "Pad footing",
  planGraphics(el, ctx) {
    if (el.kind !== "component") return null;
    const c = el.position;
    const rad = (el.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hx = el.size.x / 2;
    const hy = el.size.y / 2;
    const out: PlanGraphic[] = [
      // Below-grade spread footing perimeter in dashed medium linework.
      { form: "polyline", points: rectPoly(c, -hx, hx, -hy, hy, cos, sin), closed: true, pen: "medium", dash: "hidden" },
    ];
    const mark = textVal(el, "mark");
    const sizeText = `${feetInchesCompact(el.size.x)}×${feetInchesCompact(el.size.y)}`;
    const text = mark ? `${mark} (${sizeText})` : sizeText;
    const labelOffY = -(hy + Math.max(180, 2.4 * ctx.scale));
    out.push({
      form: "tag_place",
      at: { x: c.x, y: c.y + labelOffY },
      rotationDeg: 0,
      text,
      heightMm: 1.9,
      anchor: "middle",
    });
    return out;
  },
};

function deckPlanGraphics(el: BimElement, ctx: { readonly discipline?: string }, kindLabel: string): PlanGraphic[] | null {
  if (el.kind !== "slab" || el.outline.length < 3 || ctx.discipline !== "structure") return null;
  const out: PlanGraphic[] = [{ form: "polyline", points: el.outline, closed: true, pen: "thin" }];
  if (el.placement?.kind === "area" && el.placement.holes) {
    for (const hole of el.placement.holes) {
      if (hole.length >= 3) out.push({ form: "polyline", points: hole, closed: true, pen: "thin" });
    }
  }
  const spanDeg = el.placement?.kind === "area" ? el.placement.spanDirectionDeg : undefined;
  if (spanDeg !== undefined) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const q of el.outline) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    // Place the span symbol in the open lower-left quadrant (28% × 25%) so it stays clear of mid-bay girders and gridlines.
    const c: Vec2 =
      Number.isFinite(minX) && maxX - minX > 4 * FT && maxY - minY > 4 * FT
        ? { x: minX + (maxX - minX) * 0.28, y: minY + (maxY - minY) * 0.25 }
        : centroid(el.outline);
    const rad = (spanDeg * Math.PI) / 180;
    const u = { x: Math.cos(rad), y: Math.sin(rad) };
    const n = { x: -u.y, y: u.x };
    const halfSpanArrow = 2.6 * FT;
    const headLen = 0.65 * FT;
    const headHalf = 0.32 * FT;
    const pA = add(c, mul(u, -halfSpanArrow));
    const pB = add(c, mul(u, halfSpanArrow));
    out.push(
      // NCS one-way deck span symbol: double-headed shaft with arrowheads at both ends.
      { form: "line", a: pA, b: pB, pen: "medium" },
      { form: "line", a: pA, b: add(add(pA, mul(u, headLen)), mul(n, headHalf)), pen: "medium" },
      { form: "line", a: pA, b: add(add(pA, mul(u, headLen)), mul(n, -headHalf)), pen: "medium" },
      { form: "line", a: pB, b: add(add(pB, mul(u, -headLen)), mul(n, headHalf)), pen: "medium" },
      { form: "line", a: pB, b: add(add(pB, mul(u, -headLen)), mul(n, -headHalf)), pen: "medium" },
    );
    const useId = textVal(el, STRUCT_KEYS.occupancy);
    const rate = useId ? liveLoadRate(useId) : null;
    const psfText = rate ? ` (${Math.round(to(rate.value, "psf"))} PSF LL)` : "";
    const deg = uprightDeg(rad);
    const upN = n.y < -0.01 || (Math.abs(n.y) <= 0.01 && n.x < 0) ? mul(n, -1) : n;
    out.push({
      form: "text",
      at: add(c, mul(upN, 1.0 * FT)),
      text: `${kindLabel}${psfText}`,
      heightMm: 1.9,
      rotationDeg: deg,
      anchor: "middle",
      bold: true,
    });
  }
  return out;
}

export const FLOOR_DECK_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "struct.floor_deck",
  label: "Structural floor deck",
  planGraphics(el, ctx) {
    return deckPlanGraphics(el, ctx, "FLOOR DECK");
  },
};

export const ROOF_DECK_PLAN_GRAPHICS: ClassPlanGraphicsRow = {
  classId: "struct.roof_deck",
  label: "Structural roof deck",
  planGraphics(el, ctx) {
    return deckPlanGraphics(el, ctx, "ROOF DECK");
  },
};

export const STRUCTURAL_PLAN_GRAPHICS: readonly ClassPlanGraphicsRow[] = [
  STEEL_COLUMN_PLAN_GRAPHICS,
  STEEL_BEAM_PLAN_GRAPHICS,
  PAD_FOOTING_PLAN_GRAPHICS,
  FLOOR_DECK_PLAN_GRAPHICS,
  ROOF_DECK_PLAN_GRAPHICS,
];
