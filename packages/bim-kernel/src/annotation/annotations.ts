import { elementsOfKind } from "../store";
import { z } from "zod";
import { emForCapHeight, textWidth } from "./text-layout";
import { sizeLabel } from "../routing/rules";
import { insulatedSizeLabel, insulationLabel } from "../routing/run-insulation";
import { sectionProjector } from "../drawing/projection";
import { modelToShared, siteOf, formatSharedFt } from "../site";
import type { DrawingItem } from "../documents";
import type { Primitive } from "../drawing/sheet";
import type { BimElement, ModelState, Vec2, ViewElement } from "../types";
import { organizationOf, type TagLeaderEnd, type TagStyleBox, type TagStyleCategory, type TagStyleUnits } from "../organization/model";
import { fieldPaths, fieldText, isRelationshipField } from "../fields/resolver";
import { fillTemplate, parseFieldTemplate } from "../fields/template";
import { elbowLeaderPath, elbowLeaderSegments } from "./elbow-leader";
import { kindFieldValue } from "../kinds";
import { paramNamed } from "../parts";
import { addOnMarkedPoint, addOnRun, addOnTagCategory, addOnTagText, isAddOnRecord } from "./addon-kinds";
import { tagFieldAliases } from "./tag-types";
import { outlineAreaMm2, spaceAreaM2, spaceOutlines } from "../spaces/space-geometry";
import { parseLinkedElementKey } from "../reference-geometry/index-geometry";
import { linkedAnchorInSection, linkedAnchorItem, linkedAnchorPoint, missingLinkedAnchorWords } from "../reference-geometry/linked-anchors";

/**
 * Associative annotation: dimensions, tags and leaders that live in a view (or
 * on a sheet) as drawing items and resolve their references to the model every
 * time the drawing is built. Nothing here changes the model, and nothing is
 * stored that the model can make stale: a dimension's value and a tag's words
 * are worked out at draw time. Everything that prints is in paper millimetres
 * (annotation scale), so text and symbols are the same size at any view scale.
 *
 * Placement is deterministic and greedy (internal design note):
 * a fixed list of candidate positions, first one that collides with nothing.
 */

// ── Specs (stored on drawing items) ──────────────────────────────────────────

export const ANCHORS = ["start", "end", "mid", "center", "insertion", "edge_left", "edge_right"] as const;
export type AnchorName = (typeof ANCHORS)[number];

/** A point on an element (or on another drawing item in the same view), resolved at draw time. */
export interface AnchorRef {
  readonly elementId: string;
  readonly anchor: AnchorName;
  /** Drawing items: which of its points (default 0). */
  readonly index?: number;
}

export const DIMENSION_KINDS = ["linear", "aligned", "angular", "radial", "diameter", "arc_length", "spot_elevation", "spot_coordinate"] as const;
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

export const DIMENSION_UNITS = ["ft_in", "in", "mm", "m"] as const;
export const TERMINATORS = ["tick", "arrow", "dot"] as const;

export interface DimensionStyle {
  readonly units: (typeof DIMENSION_UNITS)[number];
  /** Round to this many inches (ft_in, in) or millimetres (mm, m). */
  readonly roundTo: number;
  readonly terminator: (typeof TERMINATORS)[number];
  /** Cap height of the value, paper mm. */
  readonly textSizeMm: number;
}

export const DEFAULT_DIMENSION_STYLE: DimensionStyle = { units: "ft_in", roundTo: 0.125, terminator: "tick", textSizeMm: 2.4 };

export interface DimSpec {
  readonly kind: DimensionKind;
  /** linear only: measure along x (horizontal) or y (vertical) on paper. */
  readonly direction?: "horizontal" | "vertical";
  /** Several points: one string of dimensions end to end, or each from the first. */
  readonly chain?: "continuous" | "baseline";
  /** Per stored point, the reference it follows (null: a free point). */
  readonly refs?: readonly (AnchorRef | null)[];
  /** Paper mm from the first point to the dimension line (sign picks the side); arc radius for angular. */
  readonly offsetMm: number;
  readonly textOverride?: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly style?: Partial<DimensionStyle>;
}

export const TAG_TEMPLATES = ["auto", "duct_size", "duct_size_insulation", "pipe_size", "pipe_size_insulation", "mark", "air_terminal", "equipment", "fixture", "fields", "gas_pipe", "name_number"] as const;
export type TagTemplate = (typeof TAG_TEMPLATES)[number];


export interface TagSpec {
  readonly elementId: string;
  readonly template: TagTemplate;
  /** template "fields": parameter names, one per line. */
  readonly fields?: readonly string[];
  readonly leader: boolean;
  /** This tag draws (true) or leaves off (false) its leader whatever its style says. Absent: the style decides, else `leader`. */
  readonly leaderOverride?: boolean;
  /** An opaque (paper-white) background under the head, hiding the linework behind its words. Absent: see-through. */
  readonly mask?: boolean;
  readonly textSizeMm?: number;
  /** A named tag style: its lines, text size, leader and box replace the fields above, so editing the style changes every tag that names it. */
  readonly styleId?: string;
  /**
   * The leader's bend (U9): a point in the view frame, like the head, placed by
   * hand; or "auto" for a short level shoulder off the tag, then one bend to
   * the element. Absent: a straight leader, as tags drew before.
   */
  readonly elbow?: Vec2 | "auto";
}

export const LEADER_ARROWS = ["arrow", "dot", "tick", "none"] as const;

const vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
export const anchorRefSchema = z.object({ elementId: z.string().min(1).max(200), anchor: z.enum(ANCHORS), index: z.number().int().min(0).max(49).optional() }).strict();
export const dimensionStyleSchema = z
  .object({ units: z.enum(DIMENSION_UNITS), roundTo: z.number().positive().max(1000), terminator: z.enum(TERMINATORS), textSizeMm: z.number().min(1.5).max(10) })
  .partial()
  .strict();
export const dimSpecSchema = z
  .object({
    kind: z.enum(DIMENSION_KINDS),
    direction: z.enum(["horizontal", "vertical"]).optional(),
    chain: z.enum(["continuous", "baseline"]).optional(),
    refs: z.array(anchorRefSchema.nullable()).max(50).readonly().optional(),
    offsetMm: z.number().finite().min(-200).max(200),
    textOverride: z.string().trim().min(1).max(80).optional(),
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    style: dimensionStyleSchema.optional(),
  })
  .strict();
export const tagSpecSchema = z
  .object({
    elementId: z.string().min(1).max(200),
    template: z.enum(TAG_TEMPLATES),
    fields: z.array(z.string().min(1).max(60)).max(6).readonly().optional(),
    leader: z.boolean(),
    leaderOverride: z.boolean().optional(),
    mask: z.boolean().optional(),
    textSizeMm: z.number().min(1.5).max(10).optional(),
    styleId: z.string().min(1).max(200).optional(),
    elbow: z.union([z.literal("auto"), vec2]).optional(),
  })
  .strict();

/** Whether a tag spec uses what only `TAGS_MASK_LEADER_FEATURE` peers store. */
export function tagSpecNeedsMaskLeaderPeers(spec: TagSpec): boolean {
  return spec.mask !== undefined || spec.leaderOverride !== undefined || spec.template === "name_number";
}
export const leaderSchema = z.object({ to: vec2, elbow: vec2.optional(), arrow: z.enum(LEADER_ARROWS).optional() }).strict();

/** How many stored points each dimension kind takes: [min, max]. */
export function dimensionPointRange(spec: Pick<DimSpec, "kind" | "chain">): [number, number] {
  switch (spec.kind) {
    case "linear":
    case "aligned":
      return spec.chain ? [2, 50] : [2, 2];
    case "angular":
    case "arc_length":
      return [3, 3];
    case "radial":
    case "diameter":
      return [2, 2];
    case "spot_elevation":
    case "spot_coordinate":
      return [2, 2];
  }
}

// ── Resolving references ─────────────────────────────────────────────────────

interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Height assumed for records that carry no elevation of their own (columns, an add-on's older runs and units). */
const UNELEVATED_Z_MM = 2743.2;

function planWidthOf(el: BimElement): number {
  if (el.kind === "run_segment") {
    const s = el.size;
    if (s.shape === "rect" || s.shape === "oval") return s.width;
    if (s.shape === "round") return s.diameter;
    if (s.shape === "pipe") return s.nominalMm;
    return s.tradeSizeMm;
  }
  const run = addOnRun(el);
  if (run) return run.widthMm;
  if (el.kind === "wall") return el.thickness;
  return 0;
}

function levelZ(model: Pick<ModelState, "elements">, levelId: string): number {
  const level = model.elements[levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** An element's straight centreline (3D), when it has one. */
function lineOf(model: Pick<ModelState, "elements">, el: BimElement): [Point3, Point3] | null {
  switch (el.kind) {
    case "run_segment":
      return [el.start, el.end];
    case "wall":
    case "grid":
      return [
        { ...el.start, z: 0 },
        { ...el.end, z: 0 },
      ];
    default: {
      void model;
      const run = addOnRun(el);
      return run ? [{ ...run.start, z: UNELEVATED_Z_MM }, { ...run.end, z: UNELEVATED_Z_MM }] : null;
    }
  }
}

/** A closed outline's area centroid (its box centre when it has no area). */
export function outlineCentroid(outline: readonly Vec2[]): Vec2 | null {
  if (outline.length === 0) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  outline.forEach((p, i) => {
    const q = outline[(i + 1) % outline.length] ?? p;
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  });
  if (Math.abs(a) > 1e-6) return { x: cx / (3 * a), y: cy / (3 * a) };
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** The outline a room or space tag sits in: the room's, or a space's largest. */
function floorOutlineOf(model: Pick<ModelState, "elements">, el: BimElement): readonly Vec2[] | null {
  if (el.kind === "room") return el.outline;
  if (el.kind !== "space") return null;
  let best: readonly Vec2[] | null = null;
  let bestArea = -1;
  for (const outline of spaceOutlines(model.elements, el)) {
    const area = outlineAreaMm2(outline);
    if (area > bestArea) {
      best = outline;
      bestArea = area;
    }
  }
  return best;
}

/** An element's insertion point (3D), when it is placed at one. */
function pointOf(model: Pick<ModelState, "elements">, el: BimElement): Point3 | null {
  switch (el.kind) {
    case "part":
      return { ...el.position, z: levelZ(model, el.levelId) + el.offsetMm };
    case "column":
      return { ...el.position, z: UNELEVATED_Z_MM };
    case "run_fitting":
      return el.position;
    case "room":
    case "space": {
      const outline = floorOutlineOf(model, el);
      const at = outline ? outlineCentroid(outline) : null;
      return at ? { ...at, z: el.kind === "space" && el.levelId ? levelZ(model, el.levelId) : 0 } : null;
    }
    default: {
      const at = addOnMarkedPoint(el);
      return at ? { ...at, z: UNELEVATED_Z_MM } : null;
    }
  }
}

/** A 3D anchor on a model element, or null when the element is gone or has no such point. */
export function modelAnchor(model: Pick<ModelState, "elements">, ref: AnchorRef): Point3 | null {
  const el = model.elements[ref.elementId];
  if (!el || ("deleted" in el && el.deleted)) return null;
  const line = lineOf(model, el);
  if (line) {
    const [a, b] = line;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    switch (ref.anchor) {
      case "start":
        return a;
      case "end":
        return b;
      case "mid":
      case "center":
      case "insertion":
        return mid;
      case "edge_left":
      case "edge_right": {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const side = ref.anchor === "edge_left" ? 1 : -1;
        const half = planWidthOf(el) / 2;
        return { x: mid.x + (-(b.y - a.y) / len) * half * side, y: mid.y + ((b.x - a.x) / len) * half * side, z: mid.z };
      }
    }
  }
  return pointOf(model, el);
}

/** Where a reference sits in a view's drawing frame (plan x/y, section along-cut/elevation, detail model mm). */
export function anchorInView(model: Pick<ModelState, "elements">, view: ViewElement | null, ref: AnchorRef): Vec2 | null {
  const el = model.elements[ref.elementId];
  if (el?.kind === "drawing_item") {
    if (el.deleted) return null;
    const pts = el.points;
    // Arcs and circles store their centre first.
    if (ref.anchor === "center" && (el.shape === "arc" || el.shape === "circle")) return pts[0] ?? null;
    if (ref.anchor === "mid" || ref.anchor === "center") {
      if (pts.length === 0) return null;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
    if (ref.anchor === "end") return pts[pts.length - 1] ?? null;
    return pts[ref.index ?? 0] ?? null;
  }
  const p = modelAnchor(model, ref);
  if (!p) return null;
  const cut = view?.props?.section;
  if (view?.viewType === "section" && cut) {
    const q = sectionProjector(cut.start, cut.end, cut.direction, cut.depthMm).project(p);
    return { x: q.u, y: q.v };
  }
  return { x: p.x, y: p.y };
}

/** A dimension's points in the view frame: each reference where it resolves, else the stored point. Also which are orphaned. */
export function dimensionPoints(model: Pick<ModelState, "elements">, view: ViewElement | null, item: DrawingItem): { points: Vec2[]; orphaned: number[]; missingLinked?: { readonly index: number; readonly sourceLabel: string }[] } {
  const refs = item.dim?.refs ?? [];
  const orphaned: number[] = [];
  const missingLinked: { index: number; sourceLabel: string }[] = [];
  const points = item.points.map((stored, i) => {
    const ref = refs[i];
    if (!ref) return stored;
    // A linked model's element: followed in plans while its model is loaded; a section keeps the stored point.
    if (parseLinkedElementKey(ref.elementId)) {
      const found = linkedAnchorItem(ref.elementId);
      if (found?.kind === "missing") {
        orphaned.push(i);
        missingLinked.push({ index: i, sourceLabel: found.sourceLabel });
        return stored;
      }
      if (!found) return stored;
      const cut = view?.props?.section;
      if (view?.viewType === "section") return cut ? linkedAnchorInSection(found.item, ref.anchor, cut, stored) : stored;
      return linkedAnchorPoint(found.item, ref.anchor, stored);
    }
    const at = anchorInView(model, view, ref);
    if (!at) orphaned.push(i);
    return at ?? stored;
  });
  return missingLinked.length > 0 ? { points, orphaned, missingLinked } : { points, orphaned };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function fraction(inches: number, step: number): string {
  const whole = Math.floor(inches + 1e-9);
  const rest = inches - whole;
  if (rest < 1e-6) return String(whole);
  const den = Math.round(1 / step);
  const num = Math.round(rest * den);
  let n = num;
  let d = den;
  while (n % 2 === 0 && d % 2 === 0) {
    n /= 2;
    d /= 2;
  }
  return whole > 0 ? `${whole} ${n}/${d}` : `${n}/${d}`;
}

/** A length as a dimension prints it. */
export function formatLength(mm: number, style: DimensionStyle): string {
  const abs = Math.abs(mm);
  switch (style.units) {
    case "ft_in": {
      const step = style.roundTo;
      const inches = Math.round(abs / 25.4 / step) * step;
      const feet = Math.floor(inches / 12 + 1e-9);
      const rest = inches - feet * 12;
      return `${feet}'-${fraction(rest, step)}"`;
    }
    case "in": {
      const step = style.roundTo;
      return `${fraction(Math.round(abs / 25.4 / step) * step, step)}"`;
    }
    case "mm":
      return `${Math.round(abs / style.roundTo) * style.roundTo}`;
    case "m":
      return `${(Math.round(abs / style.roundTo) * style.roundTo / 1000).toFixed(3)}`;
  }
}

export function styleOf(spec: Pick<DimSpec, "style"> | undefined): DimensionStyle {
  return { ...DEFAULT_DIMENSION_STYLE, ...(spec?.style ?? {}) };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

/** A printed annotation's paper box, for selection, collision and reads. */
export interface AnnotationBox {
  readonly itemId: string;
  readonly min: Vec2;
  readonly max: Vec2;
}

export interface AnnotationDrawContext {
  readonly model: Pick<ModelState, "elements">;
  /** The view the item is drawn in (null: a sheet). */
  readonly view: ViewElement | null;
  /** Model (view frame) mm to paper mm. */
  readonly toPaper: (p: Vec2) => Vec2;
  /** View scale (model units per paper unit); 1 on a sheet. */
  readonly scale: number;
  readonly prims: Primitive[];
}

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Text width on paper (the PDF's Helvetica runs a little wider than the note font's metrics). */
export function paperTextWidth(text: string, capHeightMm: number, bold = false): number {
  return textWidth(bold ? "bold" : "regular", text, emForCapHeight(capHeightMm)) * 1.08;
}

function textBox(itemId: string, at: Vec2, text: string, size: number, anchor: "start" | "middle" | "end"): AnnotationBox {
  const w = paperTextWidth(text, size);
  const x0 = anchor === "middle" ? at.x - w / 2 : anchor === "end" ? at.x - w : at.x;
  return { itemId, min: { x: x0, y: at.y - size * 1.1 }, max: { x: x0 + w, y: at.y + size * 0.25 } };
}

function terminator(prims: Primitive[], at: Vec2, along: Vec2, kind: DimensionStyle["terminator"]): void {
  const u = unit(along);
  const n = { x: -u.y, y: u.x };
  if (kind === "tick") {
    const d = mul(add(u, n), 1.1);
    prims.push({ kind: "line", a: sub(at, d), b: add(at, d), pen: "medium" });
  } else if (kind === "arrow") {
    const back = sub(at, mul(u, 2.4));
    prims.push({ kind: "fill", points: [at, add(back, mul(n, 0.7)), sub(back, mul(n, 0.7))], grey: 0 });
  } else {
    const r = 0.55;
    prims.push({ kind: "fill", points: Array.from({ length: 10 }, (_, i) => add(at, { x: r * Math.cos((i * Math.PI) / 5), y: r * Math.sin((i * Math.PI) / 5) })), grey: 0 });
  }
}

function dimText(spec: DimSpec, value: string): string {
  return `${spec.prefix ?? ""}${spec.textOverride ?? value}${spec.suffix ?? ""}`;
}

/** One linear or aligned dimension line between two paper points; returns its text box. */
function linearSegment(ctx: AnnotationDrawContext, itemId: string, pa: Vec2, pb: Vec2, axis: Vec2, offset: number, base: Vec2, label: string, style: DimensionStyle): AnnotationBox {
  const n = { x: -axis.y, y: axis.x };
  // The dimension line runs along `axis` through base + n * offset.
  const lineAt = (p: Vec2) => add(base, add(mul(axis, (p.x - base.x) * axis.x + (p.y - base.y) * axis.y), mul(n, offset)));
  const a2 = lineAt(pa);
  const b2 = lineAt(pb);
  const gap = 1.5;
  const ext = 2;
  for (const [p, q] of [
    [pa, a2],
    [pb, b2],
  ] as const) {
    const d = sub(q, p);
    const l = len(d);
    if (l > gap) {
      const u = unit(d);
      ctx.prims.push({ kind: "line", a: add(p, mul(u, gap)), b: add(q, mul(u, ext)), pen: "thin" });
    }
  }
  ctx.prims.push({ kind: "line", a: a2, b: b2, pen: "thin" });
  terminator(ctx.prims, a2, sub(a2, b2), style.terminator);
  terminator(ctx.prims, b2, sub(b2, a2), style.terminator);
  const mid = mul(add(a2, b2), 0.5);
  // Unidirectional text (always horizontal): above a horizontal or sloped line, beside a vertical one.
  const vertical = Math.abs(axis.x) < 0.3;
  const side = offset >= 0 ? 1 : -1;
  const textAt = vertical ? { x: mid.x + side * 1.5, y: mid.y + style.textSizeMm / 2 } : { x: mid.x, y: mid.y - 1.2 };
  const anchor: "start" | "middle" | "end" = vertical ? (side > 0 ? "start" : "end") : "middle";
  ctx.prims.push({ kind: "text", at: textAt, text: label, size: style.textSizeMm, anchor });
  return textBox(itemId, textAt, label, style.textSizeMm, anchor);
}

function arcPoints(center: Vec2, r: number, a0: number, a1: number): Vec2[] {
  let sweep = a1 - a0;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  const steps = Math.max(6, Math.ceil((Math.abs(sweep) * r) / 1.5));
  return Array.from({ length: steps + 1 }, (_, i) => add(center, { x: r * Math.cos(a0 + (sweep * i) / steps), y: r * Math.sin(a0 + (sweep * i) / steps) }));
}

/** Measured values of a dimension, model mm (or degrees for angular), at this model state. */
export function dimensionValues(model: Pick<ModelState, "elements">, view: ViewElement | null, item: DrawingItem): number[] {
  const spec = item.dim;
  if (!spec) return [];
  const { points } = dimensionPoints(model, view, item);
  const [p0, p1, p2] = points;
  if (!p0 || !p1) return [];
  switch (spec.kind) {
    case "linear":
    case "aligned": {
      const axis = spec.kind === "aligned" ? unit(sub(p1, p0)) : spec.direction === "vertical" ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const along = (p: Vec2) => p.x * axis.x + p.y * axis.y;
      if (!spec.chain) return [Math.abs(along(p1) - along(p0))];
      const sorted = [...points].sort((a, b) => along(a) - along(b));
      return spec.chain === "continuous" ? sorted.slice(1).map((p, i) => Math.abs(along(p) - along(sorted[i] ?? p))) : sorted.slice(1).map((p) => Math.abs(along(p) - along(sorted[0] ?? p)));
    }
    case "angular": {
      if (!p2) return [];
      const a = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const b = Math.atan2(p2.y - p0.y, p2.x - p0.x);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return [(d * 180) / Math.PI];
    }
    case "radial":
      return [len(sub(p1, p0))];
    case "diameter":
      return [2 * len(sub(p1, p0))];
    case "arc_length": {
      if (!p2) return [];
      const r = len(sub(p1, p0));
      const a = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const b = Math.atan2(p2.y - p0.y, p2.x - p0.x);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return [r * d];
    }
    case "spot_elevation": {
      const ref = spec.refs?.[0];
      const z = ref ? modelAnchor(model, ref)?.z : undefined;
      if (z !== undefined) return [z];
      return view?.viewType === "section" ? [p0.y] : [];
    }
    case "spot_coordinate":
      return [p0.x, p0.y];
  }
}

/** The words a dimension prints, one per measured segment. */
export function dimensionLabels(model: Pick<ModelState, "elements">, view: ViewElement | null, item: DrawingItem): string[] {
  const spec = item.dim;
  if (!spec) return [];
  const style = styleOf(spec);
  const values = dimensionValues(model, view, item);
  switch (spec.kind) {
    case "angular":
      return values.map((v) => dimText(spec, `${Math.round(v * 10) / 10}°`));
    case "radial":
      return values.map((v) => dimText(spec, `R ${formatLength(v, style)}`));
    case "diameter":
      return values.map((v) => dimText(spec, `Ø ${formatLength(v, style)}`));
    case "spot_elevation":
      return values.length > 0 ? [dimText(spec, `EL. ${values[0] !== undefined && values[0] < 0 ? "-" : "+"}${formatLength(values[0] ?? 0, style)}`)] : [dimText(spec, "EL. ?")];
    case "spot_coordinate": {
      const [x, y] = values;
      if (x === undefined || y === undefined) return [];
      const shared = modelToShared(siteOf(model), { x, y, z: 0 });
      return [dimText(spec, `N ${formatSharedFt(shared.northSouth)}`), dimText(spec, `E ${formatSharedFt(shared.eastWest)}`)];
    }
    default:
      return values.map((v) => dimText(spec, formatLength(v, style)));
  }
}

/** Draw a dimension in paper space. Returns the boxes its text occupies. */
export function drawDimension(ctx: AnnotationDrawContext, item: DrawingItem): AnnotationBox[] {
  const spec = item.dim;
  if (!spec) return [];
  const style = styleOf(spec);
  const { points, missingLinked } = dimensionPoints(ctx.model, ctx.view, item);
  const paper = points.map(ctx.toPaper);
  const labels = dimensionLabels(ctx.model, ctx.view, item);
  const [p0, p1, p2] = paper;
  if (!p0 || !p1) return [];
  const boxes: AnnotationBox[] = [];
  const gone = missingLinked?.[0];
  if (gone) {
    // Visible, never silently moved: the linked element it measured to has left its model.
    const at = add(paper[gone.index] ?? p0, { x: 0, y: style.textSizeMm + 2 });
    const words = missingLinkedAnchorWords(gone.sourceLabel);
    ctx.prims.push({ kind: "text", at, text: words, size: style.textSizeMm * 0.8, anchor: "start", bold: true });
    boxes.push(textBox(item.id, at, words, style.textSizeMm * 0.8, "start"));
  }
  switch (spec.kind) {
    case "linear":
    case "aligned": {
      const axis = spec.kind === "aligned" ? unit(sub(p1, p0)) : spec.direction === "vertical" ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const along = (p: Vec2) => p.x * axis.x + p.y * axis.y;
      if (!spec.chain) {
        boxes.push(linearSegment(ctx, item.id, p0, p1, axis, spec.offsetMm, p0, labels[0] ?? "", style));
        break;
      }
      const sorted = [...paper].sort((a, b) => along(a) - along(b));
      const first = sorted[0];
      if (!first) break;
      sorted.slice(1).forEach((p, i) => {
        const from = spec.chain === "continuous" ? (sorted[i] ?? first) : first;
        const offset = spec.chain === "baseline" ? spec.offsetMm + Math.sign(spec.offsetMm || 1) * i * (style.textSizeMm + 4) : spec.offsetMm;
        boxes.push(linearSegment(ctx, item.id, from, p, axis, offset, p0, labels[i] ?? "", style));
      });
      break;
    }
    case "angular":
    case "arc_length": {
      if (!p2) break;
      const r = spec.kind === "angular" ? Math.max(4, Math.abs(spec.offsetMm)) : len(sub(p1, p0)) + spec.offsetMm;
      const a0 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const a1 = Math.atan2(p2.y - p0.y, p2.x - p0.x);
      const arc = arcPoints(p0, r, a0, a1);
      arc.slice(1).forEach((q, i) => ctx.prims.push({ kind: "line", a: arc[i] ?? q, b: q, pen: "thin" }));
      const s = arc[0];
      const e = arc[arc.length - 1];
      const s1 = arc[1];
      const e1 = arc[arc.length - 2];
      if (s && e && s1 && e1) {
        terminator(ctx.prims, s, sub(s, s1), style.terminator);
        terminator(ctx.prims, e, sub(e, e1), style.terminator);
      }
      const mid = arc[Math.floor(arc.length / 2)] ?? p0;
      const at = add(mid, mul(unit(sub(mid, p0)), 2 + style.textSizeMm / 2));
      const label = labels[0] ?? "";
      ctx.prims.push({ kind: "text", at, text: label, size: style.textSizeMm, anchor: "middle" });
      boxes.push(textBox(item.id, at, label, style.textSizeMm, "middle"));
      break;
    }
    case "radial":
    case "diameter": {
      const from = spec.kind === "diameter" ? sub(mul(p0, 2), p1) : p0;
      ctx.prims.push({ kind: "line", a: from, b: p1, pen: "thin" });
      terminator(ctx.prims, p1, sub(p1, p0), "arrow");
      if (spec.kind === "diameter") terminator(ctx.prims, from, sub(from, p0), "arrow");
      const label = labels[0] ?? "";
      const at = add(p1, { x: 1.5, y: -1 });
      ctx.prims.push({ kind: "text", at, text: label, size: style.textSizeMm, anchor: "start" });
      boxes.push(textBox(item.id, at, label, style.textSizeMm, "start"));
      break;
    }
    case "spot_elevation":
    case "spot_coordinate": {
      // Target symbol at the point, leader to the text at the second point.
      const s = 1.2;
      ctx.prims.push({ kind: "line", a: { x: p0.x - s, y: p0.y - s * 1.6 }, b: p0, pen: "thin" });
      ctx.prims.push({ kind: "line", a: { x: p0.x + s, y: p0.y - s * 1.6 }, b: p0, pen: "thin" });
      ctx.prims.push({ kind: "line", a: p0, b: p1, pen: "thin" });
      const right = p1.x >= p0.x;
      const width = Math.max(...labels.map((l) => paperTextWidth(l, style.textSizeMm)), 4);
      ctx.prims.push({ kind: "line", a: p1, b: { x: p1.x + (right ? width : -width), y: p1.y }, pen: "thin" });
      labels.forEach((label, i) => {
        const at = { x: p1.x, y: p1.y - 0.8 - i * (style.textSizeMm + 1.2) };
        const anchor = right ? "start" : "end";
        ctx.prims.push({ kind: "text", at, text: label, size: style.textSizeMm, anchor });
        boxes.push(textBox(item.id, at, label, style.textSizeMm, anchor));
      });
      break;
    }
  }
  return boxes;
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/** Fields every tag can read, in the order a picker lists them; parts add their own parameter names. */
export const TAG_FIELDS = [
  { name: "size", label: "Size" },
  { name: "size_with_insulation", label: "Size with insulation" },
  { name: "insulation", label: "Insulation" },
  { name: "cfm", label: "Airflow (CFM)" },
  { name: "mark", label: "Mark" },
  { name: "type", label: "Type name" },
  { name: "system", label: "System name" },
  { name: "elevation", label: "Centreline height" },
  { name: "length", label: "Length" },
  { name: "name", label: "Room or space name" },
  { name: "number", label: "Room or space number" },
  { name: "area", label: "Floor area" },
] as const;

/** A floor area as a tag prints it: square feet beside imperial lengths, else square metres. */
export function tagAreaText(m2: number, units: TagStyleUnits = "ft_in"): string {
  if (units === "mm" || units === "m") return `${Math.round(m2 * 10) / 10} m²`;
  return `${Math.round(m2 * 10.7639)} SF`;
}

/** A length or height as a tag prints it, in the tag style's units (feet and inches by default). */
export function tagLengthText(mm: number, units: TagStyleUnits = "ft_in"): string {
  const sign = mm < 0 ? "-" : "";
  const abs = Math.abs(mm);
  switch (units) {
    case "ft_in": {
      const inches = Math.round(abs / 25.4);
      return `${sign}${Math.floor(inches / 12)}'-${inches % 12}"`;
    }
    case "ft":
      return `${sign}${(abs / 304.8).toFixed(1)}'`;
    case "in":
      return `${sign}${Math.round(abs / 25.4)}"`;
    case "mm":
      return `${sign}${Math.round(abs)}`;
    case "m":
      return `${sign}${(abs / 1000).toFixed(2)}`;
  }
}

/** How a tag's fields print: lengths and heights in these units. */
export interface TagFieldOptions {
  readonly units?: TagStyleUnits;
}

/** One named field of an element as a tag prints it; "" when it has none. Part parameters are read by their own names. */
export function tagFieldValue(model: Pick<ModelState, "elements">, el: BimElement, name: string, opts: TagFieldOptions = {}): string {
  const feetInches = (mm: number) => tagLengthText(mm, opts.units);
  // Field paths shared with schedules and diagrams ("circuit", "panel.name", "pipe.size", "pipe.length_lf") read through the one resolver.
  if (isRelationshipField(name)) {
    const resolved = fieldText(model.elements, el.id, name);
    if (resolved || el.kind === "part" || el.kind === "service_link") return resolved;
  }
  const mark = "mark" in el && typeof el.mark === "string" ? el.mark : "";
  if (el.kind === "part") {
    const type = model.elements[el.typeId];
    // Instance value, else the type's, else the parameter's default: a part left at a default still tags that value.
    const own = (n: string) => el.values[n] ?? (type?.kind === "part_type" ? (type.definition.typeValues[n] ?? paramNamed(type.definition, n)?.default) : undefined);
    const v = own(name);
    if (v !== undefined) return String(v);
    // A field a pack reads from another of the part's parameters (TAG_FIELD_ALIAS_POINT).
    for (const alias of tagFieldAliases(name)) {
      const a = own(alias);
      if (a !== undefined) return String(a);
    }
    if (name === "type") return type?.kind === "part_type" ? type.definition.typeName : "";
    if (name === "mark") return mark;
    if (name === "elevation") return feetInches(levelZ(model, el.levelId) + el.offsetMm);
    return "";
  }
  if (el.kind === "room" || el.kind === "space") {
    if (name === "name") return el.name;
    if (name === "number") return el.number;
    if (name === "area") {
      const m2 = el.kind === "room" ? (Number.isFinite(el.areaSqM) && el.areaSqM > 0 ? el.areaSqM : outlineAreaMm2(el.outline) / 1_000_000) : spaceAreaM2(model.elements, el);
      return m2 === null ? "" : tagAreaText(m2, opts.units);
    }
  }
  if (name === "mark") return mark;
  if (name === "type") return "typeName" in el && typeof el.typeName === "string" ? el.typeName : "";
  // A value an add-on-owned kind keeps, by the name its tag field uses (its add-on's row).
  if (isAddOnRecord(el)) {
    const own = kindFieldValue(el, name);
    if (own !== undefined) return String(Math.round(own));
  }
  // Field paths on a run ("pipe.size", "gas.length") read through the field resolver, so a tag and a riser print the same value.
  if ((el.kind === "run_segment" || el.kind === "run_fitting") && name.includes(".")) return fieldText(model.elements, el.id, name);
  if (el.kind === "run_segment") {
    switch (name) {
      case "size":
        return sizeLabel(el.size);
      case "size_with_insulation":
        return insulatedSizeLabel(el.size, el.insulation);
      case "insulation":
        return el.insulation ? insulationLabel(el.insulation) : "";
      case "cfm":
        return el.domain === "duct" ? String(Math.round(el.flow)) : "";
      case "system": {
        const system = model.elements[el.systemId];
        return system?.kind === "mep_system" ? system.name : "";
      }
      case "elevation":
        return feetInches((el.start.z + el.end.z) / 2);
      case "length":
        return feetInches(Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z));
    }
  }
  if (el.kind === "run_fitting") {
    const port = el.ports[0];
    if (name === "size" && port) return sizeLabel(port.size);
    if (name === "size_with_insulation" && port) return insulatedSizeLabel(port.size, el.insulation);
    if (name === "insulation") return el.insulation ? insulationLabel(el.insulation) : "";
  }
  if (name === "size" || name === "size_with_insulation") {
    const own = addOnTagText(el, model.elements);
    if (own !== null) return own;
  }
  // The element's own value by its parameter key (a keynote, a firm field).
  const values = "values" in el ? (el.values as Readonly<Record<string, unknown>> | undefined) : undefined;
  const own = values?.[name];
  if (typeof own === "string" || (typeof own === "number" && Number.isFinite(own))) return String(own);
  return "";
}

/** The field names a tag style can use in this model: the common ones, then every part parameter name. */
export function tagFieldNames(model: Pick<ModelState, "elements">): string[] {
  const names = new Set<string>(TAG_FIELDS.map((f) => f.name));
  for (const f of fieldPaths()) names.add(f.path);
  for (const el of elementsOfKind(model.elements, "part_type")) {
    if ("deleted" in el && el.deleted) continue;
    for (const p of [...el.definition.typeParams, ...el.definition.instanceParams]) names.add(p.name);
  }
  return [...names];
}

/** `{field}` placeholders in one style line, in order. */
export function tagTemplateFields(line: string): string[] {
  return [...line.matchAll(/\{([^{}]{1,60})\}/g)].map((m) => (m[1] ?? "").trim());
}

/** How a style's lines print beyond the fields: units for lengths, and words before the first line and after the last. */
export interface TagRenderOptions extends TagFieldOptions {
  readonly prefix?: string;
  readonly suffix?: string;
}

/** A style's lines filled in for one element. A line whose every field is empty is left out. */
export function renderTagStyleLines(model: Pick<ModelState, "elements">, el: BimElement, lines: readonly string[], opts: TagRenderOptions = {}): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // The shared template language: {field.path} and [optional groups] that drop when a field inside is empty.
    const parsed = parseFieldTemplate(line);
    if (parsed.ok) {
      const filled = fillTemplate(parsed.parts, (path) => tagFieldValue(model, el, path, opts));
      if (filled.any && filled.text.trim()) out.push(filled.text.trim());
      continue;
    }
    const fields = tagTemplateFields(line);
    let any = fields.length === 0;
    const text = line.replace(/\{([^{}]{1,60})\}/g, (_m, raw: string) => {
      const v = tagFieldValue(model, el, raw.trim(), opts);
      if (v) any = true;
      return v;
    });
    if (any && text.trim()) out.push(text.trim());
  }
  if (out.length > 0 && opts.prefix) out[0] = `${opts.prefix}${out[0]}`;
  if (out.length > 0 && opts.suffix) out[out.length - 1] = `${out[out.length - 1]}${opts.suffix}`;
  return out;
}

/** The kind of element a tag style can be the default for. */
export function tagStyleCategoryOf(model: Pick<ModelState, "elements">, el: BimElement): TagStyleCategory | null {
  if (el.kind === "room" || el.kind === "space") return el.kind;
  if (el.kind === "run_segment" || el.kind === "run_fitting") return el.domain === "pipe" ? "pipe" : "duct";
  if (el.kind === "part") {
    const type = model.elements[el.typeId];
    const cat = type?.kind === "part_type" ? type.definition.category : "generic";
    if (cat === "air_terminal") return "air_terminal";
    if (cat === "plumbing_fixture") return "fixture";
    if (cat === "mechanical_equipment" || cat === "electrical_equipment") return "equipment";
    return "part";
  }
  return addOnTagCategory(el);
}

/** The style new tags on this element take (the default for its kind), if one is set. */
export function defaultTagStyleFor(model: Pick<ModelState, "elements" | "connections">, el: BimElement): string | null {
  const kind = tagStyleCategoryOf(model, el);
  if (!kind) return null;
  return organizationOf(model).tagStyles.find((s) => s.entry.defaultFor.includes(kind))?.id ?? null;
}

function styleOfTag(model: Pick<ModelState, "elements">, spec: TagSpec) {
  if (!spec.styleId) return null;
  return organizationOf({ elements: model.elements, connections: [] }).tagStyleById.get(spec.styleId)?.entry ?? null;
}

/** The tag's cap height on paper: its style's, else its own, else the default. */
export function tagTextSizeMm(model: Pick<ModelState, "elements">, spec: TagSpec): number {
  return styleOfTag(model, spec)?.textSizeMm ?? spec.textSizeMm ?? TAG_TEXT_MM;
}

/** Whether the tag draws a leader: its style decides when it has one. */
export function tagHasLeader(model: Pick<ModelState, "elements">, spec: TagSpec): boolean {
  if (spec.leaderOverride !== undefined) return spec.leaderOverride;
  const style = styleOfTag(model, spec);
  return style ? style.leader : spec.leader;
}

/** The style's name, when the tag names one that exists. */
export function tagStyleName(model: Pick<ModelState, "elements">, spec: TagSpec): string | null {
  return styleOfTag(model, spec)?.name ?? null;
}

/** What a tag of this template says about an element, one string per line; null when the element is gone. */
export function tagLines(model: Pick<ModelState, "elements">, spec: TagSpec): string[] | null {
  const el = model.elements[spec.elementId];
  if (!el || ("deleted" in el && el.deleted)) return null;
  const style = styleOfTag(model, spec);
  if (style) {
    const lines = renderTagStyleLines(model, el, style.lines, { units: style.units, prefix: style.prefix, suffix: style.suffix });
    return lines.length > 0 ? lines : ["?"];
  }
  const template = spec.template === "auto" ? autoTemplate(model, el) : spec.template;
  const mark = "mark" in el && typeof el.mark === "string" ? el.mark : "";
  const param = (name: string): string => tagFieldValue(model, el, name);
  const partType = el.kind === "part" ? model.elements[el.typeId] : undefined;
  const typeName = partType?.kind === "part_type" ? partType.definition.typeName : "typeName" in el && typeof el.typeName === "string" ? el.typeName : "";
  switch (template) {
    case "duct_size":
    case "pipe_size":
      if (el.kind === "run_segment") return [sizeLabel(el.size)];
      return [addOnTagText(el, model.elements) ?? (mark || "?")];
    case "gas_pipe": {
      // A gas segment tag: size and developed length of the piece (`1" 3 LF`); off gas pipe, a size tag.
      const text = el.kind === "run_segment" ? fieldText(model.elements, el.id, "gas.tag") : "";
      if (text) return [text];
      if (el.kind === "run_segment") return [sizeLabel(el.size)];
      return [mark || "?"];
    }
    case "duct_size_insulation":
    case "pipe_size_insulation":
      if (el.kind === "run_segment") return [insulatedSizeLabel(el.size, el.insulation)];
      if (el.kind === "run_fitting" && el.ports[0]) return [insulatedSizeLabel(el.ports[0].size, el.insulation)];
      return [mark || "?"];
    case "air_terminal": {
      const cfm = param("cfm") || param("airflow");
      return [mark || typeName || "?", ...(cfm ? [`${cfm} CFM`] : [])];
    }
    case "equipment":
      return [mark || typeName || "?"];
    case "fixture":
      return [mark || typeName || "?"];
    case "mark":
      return [mark || "?"];
    case "fields":
      return (spec.fields ?? ["mark"]).map((f) => param(f) || "-");
    case "name_number": {
      const lines = [param("name"), param("number")].filter((l) => l !== "");
      return lines.length > 0 ? lines : [mark || "?"];
    }
    default:
      return [mark || "?"];
  }
}

function autoTemplate(model: Pick<ModelState, "elements">, el: BimElement): TagTemplate {
  if (el.kind === "room" || el.kind === "space") return "name_number";
  if (el.kind === "run_segment") return el.domain === "pipe" ? (isGasRun(model, el) ? "gas_pipe" : "pipe_size") : "duct_size";
  if (el.kind === "part") {
    const type = model.elements[el.typeId];
    const cat = type?.kind === "part_type" ? type.definition.category : "generic";
    if (cat === "air_terminal") return "air_terminal";
    if (cat === "plumbing_fixture") return "fixture";
    if (cat === "mechanical_equipment" || cat === "electrical_equipment") return "equipment";
    return "mark";
  }
  const category = addOnTagCategory(el);
  return (category === null ? undefined : CATEGORY_TEMPLATE[category]) ?? "mark";
}

/** The template an add-on record's tag takes by default, by its tag category; any other category tags its mark. */
const CATEGORY_TEMPLATE: Readonly<Partial<Record<TagStyleCategory, TagTemplate>>> = { duct: "duct_size", pipe: "pipe_size", air_terminal: "air_terminal", equipment: "equipment" };

/** The outline round a tag: its style's; without one, a box round marks of equipment and fixtures and none round size tags. */
export function tagShape(model: Pick<ModelState, "elements">, spec: TagSpec): TagStyleBox {
  const style = styleOfTag(model, spec);
  if (style) return style.box;
  const el = model.elements[spec.elementId];
  if (!el) return "box";
  const t = spec.template === "auto" ? autoTemplate(model, el) : spec.template;
  return t !== "duct_size" && t !== "duct_size_insulation" && t !== "pipe_size" && t !== "pipe_size_insulation" && t !== "gas_pipe" && t !== "name_number" ? "box" : "none";
}

/** An angle on paper (degrees, clockwise) turned so words never read upside down or downward: within [-90, 90). */
export function readableAngleDeg(deg: number): number {
  let a = ((deg % 360) + 360) % 360;
  if (a >= 270) a -= 360;
  if (a >= 90) a -= 180;
  return Math.round(a * 100) / 100;
}

/** How far a tag's words turn on paper (degrees, clockwise): 0, or along its element's run when its style says so. */
export function tagRotationDeg(model: Pick<ModelState, "elements">, view: ViewElement | null, spec: TagSpec, toPaper: (p: Vec2) => Vec2): number {
  if (styleOfTag(model, spec)?.orientation !== "along") return 0;
  const a = anchorInView(model, view, { elementId: spec.elementId, anchor: "start" });
  const b = anchorInView(model, view, { elementId: spec.elementId, anchor: "end" });
  if (!a || !b) return 0;
  const pa = toPaper(a);
  const pb = toPaper(b);
  if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < 1e-6) return 0;
  return readableAngleDeg((Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI);
}

function leaderEndOf(model: Pick<ModelState, "elements">, spec: TagSpec): TagLeaderEnd {
  return styleOfTag(model, spec)?.leaderEnd ?? "dot";
}

/** A pipe on a gas system: its tags say size and length, as gas plans are tagged. */
export function isGasRun(model: Pick<ModelState, "elements">, el: BimElement): boolean {
  if (el.kind !== "run_segment" || el.domain !== "pipe") return false;
  const system = model.elements[el.systemId];
  return system?.kind === "mep_system" && system.systemKind === "natural_gas";
}

const TAG_TEXT_MM = 2.4;
const TAG_PAD_MM = 1;

/** The words' own width and height on paper before any turn (paper mm). */
function tagHeadSize(lines: readonly string[], textSizeMm: number): { w: number; h: number } {
  return { w: Math.max(...lines.map((l) => paperTextWidth(l, textSizeMm)), 3) + TAG_PAD_MM * 2, h: lines.length * (textSizeMm + 1.2) + TAG_PAD_MM };
}

/** A shape's outline round words of size w × h centred on the origin, unturned (paper mm). Empty for `none`. */
export function tagOutline(shape: TagStyleBox, w: number, h: number): Vec2[] {
  const hw = w / 2;
  const hh = h / 2;
  switch (shape) {
    case "none":
      return [];
    case "box":
      return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
    case "rounded": {
      const r = Math.min(hh, 1.5);
      const out: Vec2[] = [];
      const corners: Array<[number, number, number]> = [
        [hw - r, -hh + r, -90],
        [hw - r, hh - r, 0],
        [-hw + r, hh - r, 90],
        [-hw + r, -hh + r, 180],
      ];
      for (const [cx, cy, start] of corners) for (let k = 0; k <= 4; k++) {
        const a = ((start + k * 22.5) * Math.PI) / 180;
        out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      return out;
    }
    case "circle": {
      const r = Math.hypot(hw, hh);
      return Array.from({ length: 24 }, (_, k) => ({ x: r * Math.cos((k * Math.PI) / 12), y: r * Math.sin((k * Math.PI) / 12) }));
    }
    case "hexagon": {
      const tip = hh * 0.8;
      return [{ x: -hw - tip, y: 0 }, { x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw + tip, y: 0 }, { x: hw, y: hh }, { x: -hw, y: hh }];
    }
    case "diamond":
      return [{ x: 0, y: -hh * 2 }, { x: hw * 1.5, y: 0 }, { x: 0, y: hh * 2 }, { x: -hw * 1.5, y: 0 }];
  }
}

function turn(p: Vec2, deg: number): Vec2 {
  if (deg === 0) return p;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** A tag head's paper box, centred on `at`: round its outline (when it has one) and turned words, axis-aligned. */
export function tagHeadBox(itemId: string, lines: readonly string[], at: Vec2, textSizeMm: number, rotationDeg = 0, shape: TagStyleBox = "box"): AnnotationBox {
  const { w, h } = tagHeadSize(lines, textSizeMm);
  const outline = tagOutline(shape, w, h);
  const corners = [...tagOutline("box", w, h), ...outline].map((p) => turn(p, rotationDeg));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return { itemId, min: { x: at.x + Math.min(...xs), y: at.y + Math.min(...ys) }, max: { x: at.x + Math.max(...xs), y: at.y + Math.max(...ys) } };
}

/** A tag's paper box as drawn in a view: its words, style, shape and turn. Null without a head. */
export function tagItemBox(model: Pick<ModelState, "elements">, view: ViewElement | null, item: DrawingItem, toPaper: (p: Vec2) => Vec2): AnnotationBox | null {
  const spec = item.tag;
  const head = item.points[0];
  if (!spec || !head) return null;
  return tagHeadBox(item.id, tagLines(model, spec) ?? ["?"], toPaper(head), tagTextSizeMm(model, spec), tagRotationDeg(model, view, spec, toPaper), tagShape(model, spec));
}

/** The tag's element anchor in the view frame (its centreline middle, or insertion). */
export function tagTarget(model: Pick<ModelState, "elements">, view: ViewElement | null, spec: TagSpec): Vec2 | null {
  return anchorInView(model, view, { elementId: spec.elementId, anchor: "mid" });
}

export function drawTag(ctx: AnnotationDrawContext, item: DrawingItem): AnnotationBox[] {
  const spec = item.tag;
  const head = item.points[0];
  if (!spec || !head) return [];
  const size = tagTextSizeMm(ctx.model, spec);
  const leader = tagHasLeader(ctx.model, spec);
  const lines = tagLines(ctx.model, spec) ?? ["?"];
  const at = ctx.toPaper(head);
  const rotation = tagRotationDeg(ctx.model, ctx.view, spec, ctx.toPaper);
  const shape = tagShape(ctx.model, spec);
  const box = tagHeadBox(item.id, lines, at, size, rotation, shape);
  const { w, h } = tagHeadSize(lines, size);
  // The mask goes down first so the outline and words print over it and the linework drawn before it is hidden.
  if (spec.mask) {
    const under = tagOutline(shape === "none" ? "box" : shape, w, h).map((p) => add(at, turn(p, rotation)));
    ctx.prims.push({ kind: "fill", points: under, grey: 1 });
  }
  if (shape === "box" && rotation === 0) ctx.prims.push({ kind: "rect", at: { x: at.x - w / 2, y: at.y - h / 2 }, size: { x: w, y: h }, pen: "thin" });
  else {
    const outline = tagOutline(shape, w, h).map((p) => add(at, turn(p, rotation)));
    outline.forEach((p, i) => ctx.prims.push({ kind: "line", a: p, b: outline[(i + 1) % outline.length] ?? p, pen: "thin" }));
  }
  lines.forEach((line, i) => {
    const local = { x: 0, y: -h / 2 + TAG_PAD_MM / 2 + (i + 1) * (size + 1.2) - 0.6 };
    ctx.prims.push({ kind: "text", at: add(at, turn(local, rotation)), text: line, size, anchor: "middle", ...(rotation !== 0 ? { rotate: rotation } : {}) });
  });
  const arrow = tagArrowDirection(ctx.model, ctx.view, spec, ctx.toPaper);
  if (arrow) for (const [a, b] of tagArrowSegments(add(at, turn({ x: 0, y: h / 2 + TAG_ARROW_GAP_MM }, rotation)), arrow, Math.min(Math.max(w - TAG_PAD_MM * 2, 6), 12))) ctx.prims.push({ kind: "line", a, b, pen: "thin" });
  if (leader) {
    const target = tagTarget(ctx.model, ctx.view, spec);
    if (target) {
      const to = ctx.toPaper(target);
      if (spec.elbow !== undefined) {
        const path = elbowLeaderPath(box, to, spec.elbow === "auto" ? undefined : ctx.toPaper(spec.elbow));
        if (path) {
          for (const [a, b] of elbowLeaderSegments(path)) ctx.prims.push({ kind: "line", a, b, pen: "thin" });
          const last = path.points[path.points.length - 2] ?? path.points[0] ?? to;
          const tip = path.points[path.points.length - 1] ?? to;
          const end = leaderEndOf(ctx.model, spec);
          if (end !== "none") terminator(ctx.prims, tip, sub(tip, last), end);
        }
      } else {
        const from = edgePoint(box, to);
        if (len(sub(to, from)) > 1.5) {
          ctx.prims.push({ kind: "line", a: from, b: to, pen: "thin" });
          const end = leaderEndOf(ctx.model, spec);
          if (end !== "none") terminator(ctx.prims, to, sub(to, from), end);
        }
      }
    }
  }
  return [box];
}

/** Paper mm between a tag's words and its arrow below them. */
const TAG_ARROW_GAP_MM = 1.6;

/**
 * Which way (a unit vector on paper) a tag's arrow points along the run it
 * labels: towards the run's lower end for `down_slope`, its higher end for
 * `up_slope`, as the run lies on this view's paper, so a turned plan turns the
 * arrow with it. Null when the style has no arrow, the run is level (within
 * 1 mm end to end) or seen end-on, or the tag isn't on a run.
 */
export function tagArrowDirection(model: Pick<ModelState, "elements">, view: ViewElement | null, spec: TagSpec, toPaper: (p: Vec2) => Vec2): Vec2 | null {
  const kind = styleOfTag(model, spec)?.arrow;
  if (!kind) return null;
  const el = model.elements[spec.elementId];
  if (el?.kind !== "run_segment") return null;
  const dz = el.end.z - el.start.z;
  if (Math.abs(dz) < 1) return null;
  const a = anchorInView(model, view, { elementId: spec.elementId, anchor: "start" });
  const b = anchorInView(model, view, { elementId: spec.elementId, anchor: "end" });
  if (!a || !b) return null;
  const d = sub(toPaper(b), toPaper(a));
  const l = len(d);
  if (l < 1e-6) return null;
  const towardEnd = kind === "down_slope" ? dz < 0 : dz > 0;
  return mul(d, (towardEnd ? 1 : -1) / l);
}

/** An arrow `lengthMm` long centred on `at`, pointing `dir` (unit, paper): the shaft and the two strokes of its head. */
export function tagArrowSegments(at: Vec2, dir: Vec2, lengthMm: number): Array<[Vec2, Vec2]> {
  const tip = add(at, mul(dir, lengthMm / 2));
  const tail = sub(at, mul(dir, lengthMm / 2));
  const n = { x: -dir.y, y: dir.x };
  const head = Math.min(1.8, lengthMm / 3);
  const back = sub(tip, mul(dir, head));
  return [
    [tail, tip],
    [tip, add(back, mul(n, head * 0.45))],
    [tip, sub(back, mul(n, head * 0.45))],
  ];
}

/** Where a line from a box's centre to `to` leaves the box. */
function edgePoint(box: AnnotationBox, to: Vec2): Vec2 {
  const c = mul(add(box.min, box.max), 0.5);
  const d = sub(to, c);
  const hx = (box.max.x - box.min.x) / 2;
  const hy = (box.max.y - box.min.y) / 2;
  const t = Math.min(Math.abs(d.x) > 1e-9 ? hx / Math.abs(d.x) : Infinity, Math.abs(d.y) > 1e-9 ? hy / Math.abs(d.y) : Infinity, 1);
  return add(c, mul(d, t));
}

// ── Leaders on notes ─────────────────────────────────────────────────────────

/** A leader on paper: from `from` (on the note), through an optional elbow, to `to`, with its arrowhead. */
export function leaderPrims(from: Vec2, to: Vec2, elbow: Vec2 | undefined, arrow: (typeof LEADER_ARROWS)[number] | undefined): Array<[Vec2, Vec2]> {
  const pts = elbow ? [from, elbow, to] : [from, to];
  const segs: Array<[Vec2, Vec2]> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) segs.push([a, b]);
  }
  const last = pts[pts.length - 2] ?? from;
  const d = sub(to, last);
  const l = len(d);
  if (l < 1) return segs;
  const u = mul(d, 1 / l);
  const n = { x: -u.y, y: u.x };
  const head = Math.min(2.5, l / 3);
  switch (arrow ?? "arrow") {
    case "arrow":
      segs.push([to, add(sub(to, mul(u, head)), mul(n, head * 0.35))], [to, sub(sub(to, mul(u, head)), mul(n, head * 0.35))]);
      break;
    case "tick": {
      const t = mul(add(u, n), 1);
      segs.push([sub(to, t), add(to, t)]);
      break;
    }
    case "dot": {
      const r = 0.6;
      for (let i = 0; i < 8; i++) {
        const a0 = (i * Math.PI) / 4;
        const a1 = ((i + 1) * Math.PI) / 4;
        segs.push([add(to, { x: r * Math.cos(a0), y: r * Math.sin(a0) }), add(to, { x: r * Math.cos(a1), y: r * Math.sin(a1) })]);
      }
      break;
    }
    case "none":
      break;
  }
  return segs;
}
