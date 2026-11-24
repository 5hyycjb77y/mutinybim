import { columnVerticalSpan, type BimElement, type ClassSolidPart, type ClassSolidsRow, type Vec2 } from "@permitzip/bim-kernel";
import { elementTypeValue } from "@permitzip/bim-pack/runtime";
import { to } from "@permitzip/bim-units";
import { STRUCT_KEYS } from "./frame";
import { sectionById } from "./sections";

/**
 * Structural 3D & section solids (`kernel.class_solids`):
 * - Steel beams (`struct.beam_steel`): 3-part AISC wide-flange I-beam (top
 *   flange, web, bottom flange) using exact section dimensions from `sections.ts`.
 * - Steel columns (`struct.column_steel`): 3-part AISC wide-flange H-column
 *   spanning exact `columnVerticalSpan` (`topLevelId`/`topOffsetMm`/`height`)
 *   and rotated by `placement.rotationDeg`.
 * - Pad footings (`struct.footing_pad`): concrete pad footing prism extending
 *   below its top-of-footing elevation by `struct.footing_thickness_mm`
 *   (default 18" = 457.2 mm).
 */

type Elements = Readonly<Record<string, BimElement>>;

const DEFAULT_FOOTING_THICKNESS_MM = 18 * 25.4;

function rotPoint(c: Vec2, dx: number, dy: number, cos: number, sin: number): Vec2 {
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

function rectPoly(c: Vec2, x0: number, x1: number, y0: number, y1: number, cos: number, sin: number): readonly Vec2[] {
  return [rotPoint(c, x0, y0, cos, sin), rotPoint(c, x1, y0, cos, sin), rotPoint(c, x1, y1, cos, sin), rotPoint(c, x0, y1, cos, sin)];
}

function sectionOf(elements: Elements, el: BimElement) {
  const v = elementTypeValue(elements, el, STRUCT_KEYS.section);
  if (typeof v === "string" && v.trim()) {
    const found = sectionById(v);
    if (found) return found;
  }
  if (el.kind === "beam" && el.sectionName.trim()) return sectionById(el.sectionName);
  return null;
}

export const STEEL_BEAM_BODY: ClassSolidsRow = {
  classId: "struct.beam_steel",
  label: "Wide-flange steel beam",
  solids(el, ctx) {
    if (el.kind !== "beam") return null;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return null;
    const sec = sectionOf(ctx.elements, el);
    const depth = sec ? to(sec.depth, "mm") : 400;
    const bf = sec ? to(sec.flangeWidth, "mm") : 150;
    const tf = sec ? Math.max(10, to(sec.flangeThickness, "mm")) : 14;
    const tw = sec ? Math.max(8, to(sec.webThickness, "mm")) : 10;
    const p = el.placement?.kind === "line" ? el.placement : null;
    const startOff = p?.startOffsetMm ?? 0;
    const endOff = p?.endOffsetMm ?? 0;
    const vAlign = p?.vertical ?? "top";
    const zShift = vAlign === "bottom" ? depth : vAlign === "center" ? depth / 2 : 0;
    const zTopStart = ctx.floorMm + startOff + zShift;
    const zBotStart = zTopStart - depth;
    const dz = endOff - startOff;
    const ux = dx / len;
    const uy = dy / len;
    const tilt = Math.abs(dz) > 1e-6 ? { at: el.start, rise: { x: (dz / len) * ux, y: (dz / len) * uy } } : undefined;
    const nx = -uy;
    const ny = ux;
    const strip = (halfW: number): readonly Vec2[] => [
      { x: el.start.x + nx * halfW, y: el.start.y + ny * halfW },
      { x: el.end.x + nx * halfW, y: el.end.y + ny * halfW },
      { x: el.end.x - nx * halfW, y: el.end.y - ny * halfW },
      { x: el.start.x - nx * halfW, y: el.start.y - ny * halfW },
    ];
    const flangeOutline = strip(bf / 2);
    const webOutline = strip(tw / 2);
    const t = tilt ? { tilt0: tilt, tilt1: tilt } : {};
    const parts: ClassSolidPart[] = [
      {
        shape: {
          form: "prisms",
          category: "structure",
          role: "architecture",
          blocks: [
            { outline: flangeOutline, z0: zTopStart - tf, z1: zTopStart, ...t },
            { outline: webOutline, z0: zBotStart + tf, z1: zTopStart - tf, ...t },
            { outline: flangeOutline, z0: zBotStart, z1: zBotStart + tf, ...t },
          ],
        },
      },
    ];
    return parts;
  },
};

export const STEEL_COLUMN_BODY: ClassSolidsRow = {
  classId: "struct.column_steel",
  label: "Wide-flange steel column",
  solids(el, ctx) {
    if (el.kind !== "column") return null;
    const span = columnVerticalSpan(ctx.elements, el, ctx.floorMm);
    if (span.heightMm <= 0) return null;
    const c = el.position;
    const rad = el.placement?.kind === "point" && el.placement.rotationDeg ? (el.placement.rotationDeg * Math.PI) / 180 : 0;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const sec = sectionOf(ctx.elements, el);
    const dMm = sec ? to(sec.depth, "mm") : el.size.y;
    const bfMm = sec ? to(sec.flangeWidth, "mm") : el.size.x;
    const tfMm = sec ? Math.max(12, to(sec.flangeThickness, "mm")) : Math.min(24, dMm * 0.15);
    const twMm = sec ? Math.max(10, to(sec.webThickness, "mm")) : Math.min(18, bfMm * 0.12);
    const hx = bfMm / 2;
    const hy = dMm / 2;
    return [
      {
        shape: {
          form: "prisms",
          category: "structure",
          role: "architecture",
          blocks: [
            { outline: rectPoly(c, -hx, hx, hy - tfMm, hy, cos, sin), z0: span.baseZMm, z1: span.topZMm },
            { outline: rectPoly(c, -twMm / 2, twMm / 2, -hy + tfMm, hy - tfMm, cos, sin), z0: span.baseZMm, z1: span.topZMm },
            { outline: rectPoly(c, -hx, hx, -hy, -hy + tfMm, cos, sin), z0: span.baseZMm, z1: span.topZMm },
          ],
        },
      },
    ];
  },
};

export const PAD_FOOTING_BODY: ClassSolidsRow = {
  classId: "struct.footing_pad",
  label: "Concrete pad footing",
  solids(el, ctx) {
    if (el.kind !== "component") return null;
    const c = el.position;
    const rad = (el.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hx = el.size.x / 2;
    const hy = el.size.y / 2;
    if (hx <= 0 || hy <= 0) return null;
    const offMm = el.placement?.kind === "point" ? el.placement.offsetMm : 0;
    const topZ = ctx.floorMm + offMm;
    const rawThick = elementTypeValue(ctx.elements, el, "struct.footing_thickness_mm");
    const thickMm = typeof rawThick === "number" && Number.isFinite(rawThick) && rawThick > 0 ? rawThick : DEFAULT_FOOTING_THICKNESS_MM;
    return [
      {
        shape: {
          form: "prism",
          category: "structure",
          role: "architecture",
          outline: rectPoly(c, -hx, hx, -hy, hy, cos, sin),
          z0: topZ - thickMm,
          z1: topZ,
        },
      },
    ];
  },
};

export const STRUCTURAL_BODIES: readonly ClassSolidsRow[] = [STEEL_BEAM_BODY, STEEL_COLUMN_BODY, PAD_FOOTING_BODY];
