import type { ViewGraphicsContext, ViewGraphicsRow } from "../layout/view-graphics-point";
import { organizationOf } from "../organization/model";
import { copyPoint } from "../organization/typicals";
import type { Primitive } from "../drawing/sheet";
import type { ElementId, ModelState, PartInstance, Vec2 } from "../types";
import { assemblyStubMarks, type AssemblyStubMark } from "../organization/assemblies";

/**
 * "Typical to" graphics (round 12 S12; the Demo 3 review, 7:20–8:28). With the view
 * switch on (View properties › Show typical copies as "typical to"), each copy
 * of a typical draws halftone inside a hatched outline labelled "TYPICAL TO
 * UNIT 001", the way the hand-drawn sets say it. The outline is the
 * original's parts' extent, carried into each copy through the copy's
 * transform (mirror, turn, offset), so a mirrored unit's outline is mirrored.
 *
 * The switch lives in the view's opaque record under `TYPICAL_TO_HINTS_KEY`
 * (`kernel.view_graphics`); a view without it draws copies as before.
 */

export const TYPICAL_TO_HINTS_KEY = "typicalTo";
/** How far the outline stands off the parts it surrounds, model mm. */
export const TYPICAL_TO_MARGIN_MM = 300;
/** Hatch spacing on paper, mm. */
export const TYPICAL_TO_HATCH_MM = 3;
/** Label cap height on paper, mm. */
export const TYPICAL_TO_TEXT_MM = 2.5;

/** Whether a view's stored record turns "typical to" on (tolerant: anything but `{ show: true }` is off). */
export function typicalToShown(hints: unknown): boolean {
  return typeof hints === "object" && hints !== null && (hints as { readonly show?: unknown }).show === true;
}

export interface TypicalCopyOutline {
  readonly groupId: string;
  /** The copy's mark ("002"). */
  readonly mark: string;
  /** The outline, model mm, corner by corner (four corners of the original's extent, carried into the copy). */
  readonly outline: readonly Vec2[];
  /** "TYPICAL TO UNIT 001". */
  readonly label: string;
  /** Where the label sits: the outline's middle, model mm. */
  readonly at: Vec2;
}

/**
 * One outline per copy of every typical with a part in `shown` (the
 * original's parts the view drew). Copies are never expanded beyond their
 * four corners: 500 copies cost 2,000 points.
 */
export function typicalCopyOutlines(model: Pick<ModelState, "elements" | "connections">, shown: Iterable<PartInstance>): TypicalCopyOutline[] {
  const extents = new Map<string, { min: Vec2; max: Vec2 }>();
  for (const p of shown) {
    if (!p.groupId) continue;
    const e = extents.get(p.groupId);
    if (!e) extents.set(p.groupId, { min: { ...p.position }, max: { ...p.position } });
    else {
      e.min = { x: Math.min(e.min.x, p.position.x), y: Math.min(e.min.y, p.position.y) };
      e.max = { x: Math.max(e.max.x, p.position.x), y: Math.max(e.max.y, p.position.y) };
    }
  }
  if (extents.size === 0) return [];
  const out: TypicalCopyOutline[] = [];
  for (const g of organizationOf(model).groups) {
    const spec = g.entry.typical;
    const e = extents.get(g.id);
    if (!spec || !e || spec.copies.length === 0) continue;
    const m = TYPICAL_TO_MARGIN_MM;
    const corners: Vec2[] = [
      { x: e.min.x - m, y: e.min.y - m },
      { x: e.max.x + m, y: e.min.y - m },
      { x: e.max.x + m, y: e.max.y + m },
      { x: e.min.x - m, y: e.max.y + m },
    ];
    const label = `TYPICAL TO ${spec.label.toUpperCase()} ${spec.mark}`;
    for (const copy of spec.copies) {
      const outline = corners.map((c) => copyPoint(spec, copy, c));
      const at = { x: outline.reduce((s, p) => s + p.x, 0) / 4, y: outline.reduce((s, p) => s + p.y, 0) / 4 };
      out.push({ groupId: g.id, mark: copy.mark, outline, label, at });
    }
  }
  return out;
}

/** The part of segment a–b inside a convex polygon (Cyrus–Beck), or null. */
function clipToConvex(a: Vec2, b: Vec2, poly: readonly Vec2[]): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const d = { x: b.x - a.x, y: b.y - a.y };
  // Orientation: positive area is counter-clockwise; inward normals follow from it.
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    area += p.x * q.y - q.x * p.y;
  }
  const sign = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Vec2;
    const q = poly[(i + 1) % poly.length] as Vec2;
    const n = { x: -(q.y - p.y) * sign, y: (q.x - p.x) * sign };
    const num = n.x * (a.x - p.x) + n.y * (a.y - p.y);
    const den = n.x * d.x + n.y * d.y;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    { x: a.x + d.x * t0, y: a.y + d.y * t0 },
    { x: a.x + d.x * t1, y: a.y + d.y * t1 },
  ];
}

/** One copy's outline on paper: a light halftone fill, a dashed edge, 45° hatch and the label. */
export function typicalToPrimitives(outline: readonly Vec2[], label: string, at: Vec2): Primitive[] {
  const prims: Primitive[] = [{ kind: "fill", points: outline, grey: 0.94, tone: "halftone" }];
  for (let i = 0; i < outline.length; i++) {
    prims.push({ kind: "line", a: outline[i] as Vec2, b: outline[(i + 1) % outline.length] as Vec2, pen: "thin", dash: [2, 1], tone: "halftone" });
  }
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = maxX - minX + (maxY - minY);
  for (let k = TYPICAL_TO_HATCH_MM; k < span; k += TYPICAL_TO_HATCH_MM) {
    const seg = clipToConvex({ x: minX + k, y: minY }, { x: minX + k - (maxY - minY), y: maxY }, outline);
    if (seg) prims.push({ kind: "line", a: seg[0], b: seg[1], pen: "thin", tone: "halftone" });
  }
  prims.push({ kind: "text", at, text: label, size: TYPICAL_TO_TEXT_MM, anchor: "middle", bold: true, tone: "halftone" });
  return prims;
}

/** Draw every copy's "typical to" outline into a view (when its switch is on). */
export function drawTypicalTo(ctx: Pick<ViewGraphicsContext, "model" | "shown" | "toPaper" | "prims">, hints: unknown): number {
  if (!typicalToShown(hints)) return 0;
  // The originals as stored (a copy drawn in place shares its original's id).
  const originals: PartInstance[] = [];
  for (const id of ctx.shown.keys()) {
    const el = ctx.model.elements[id];
    if (el?.kind === "part") originals.push(el);
  }
  const outlines = typicalCopyOutlines(ctx.model, originals);
  for (const o of outlines) ctx.prims.push(...typicalToPrimitives(o.outline.map(ctx.toPaper), o.label, ctx.toPaper(o.at)));
  return outlines.length;
}

/** The row a host registers (or a view draws directly) for "typical to" graphics. Drawn under other plan graphics. */
export const TYPICAL_TO_VIEW_GRAPHICS: ViewGraphicsRow = {
  id: "typical_to",
  label: "Typical copies as \"typical to\"",
  hintsKey: TYPICAL_TO_HINTS_KEY,
  order: -100,
  draw: (ctx, hints) => {
    drawTypicalTo(ctx, hints);
  },
};

/**
 * Assembly stubs on plan (round 13 P13): every instance of a group made into
 * an assembly (a bathroom group's cold, hot and waste stubs) draws a short
 * stub at each service it needs from outside, tagged with the service; a
 * copy's stub reads "TYP.". Copies move, turn and mirror their stubs with
 * them. On by default; a view stores `{ show: false }` under
 * `ASSEMBLY_STUBS_HINTS_KEY` to hide them.
 */
export const ASSEMBLY_STUBS_HINTS_KEY = "assemblyStubs";
/** Stub tag cap height on paper, mm. */
export const ASSEMBLY_STUB_TEXT_MM = 2;

export function assemblyStubsShown(hints: unknown): boolean {
  return !(typeof hints === "object" && hints !== null && (hints as { readonly show?: unknown }).show === false);
}

/** One stub on paper: the short stub line and its tag at the tip. */
export function assemblyStubPrimitives(mark: AssemblyStubMark, toPaper: (p: Vec2) => Vec2): Primitive[] {
  const tip = toPaper(mark.tip);
  return [
    { kind: "line", a: toPaper(mark.at), b: tip, pen: "medium" },
    { kind: "text", at: tip, text: mark.copy ? `${mark.label.toUpperCase()} TYP.` : mark.label.toUpperCase(), size: ASSEMBLY_STUB_TEXT_MM, anchor: "middle" },
  ];
}

/** Draw the stubs of every group with a part in the view; returns how many stubs were drawn. */
export function drawAssemblyStubs(ctx: Pick<ViewGraphicsContext, "model" | "shown" | "toPaper" | "prims">, hints: unknown): number {
  if (!assemblyStubsShown(hints)) return 0;
  const groups = new Set<string>();
  for (const p of ctx.shown.values()) if (p.groupId) groups.add(p.groupId);
  let n = 0;
  for (const g of groups) {
    const marks = assemblyStubMarks(ctx.model, g as ElementId);
    if ("refused" in marks) continue;
    for (const m of marks) ctx.prims.push(...assemblyStubPrimitives(m, ctx.toPaper));
    n += marks.length;
  }
  return n;
}

/** The row a host registers for assembly stubs on plan. Drawn over the "typical to" outline. */
export const ASSEMBLY_STUBS_VIEW_GRAPHICS: ViewGraphicsRow = {
  id: "assembly_stubs",
  label: "Assembly stubs",
  hintsKey: ASSEMBLY_STUBS_HINTS_KEY,
  order: -90,
  draw: (ctx, hints) => {
    drawAssemblyStubs(ctx, hints);
  },
};
