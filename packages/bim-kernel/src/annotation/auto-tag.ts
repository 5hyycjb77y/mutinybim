import { documentIndex } from "../commands/views";
import { effectiveCrop } from "../crop";
import { viewLevelElements } from "../drawing/views";
import { elementSolid } from "../drawing/solids";
import { addOnRun, addOnTagCategory } from "./addon-kinds";
import type { DrawingItem } from "../documents";
import type { BimElement, ModelState, Vec2, ViewElement } from "../types";
import { anchorInView, defaultTagStyleFor, dimensionLabels, dimensionPoints, isGasRun, paperTextWidth, tagHeadBox, tagItemBox, tagLines, tagRotationDeg, tagShape, tagTextSizeMm, type AnnotationBox, type TagSpec, type TagTemplate } from "./annotations";

/**
 * Tag everything of some categories in a view, deterministically: elements in
 * a fixed order (top to bottom, left to right on paper), each tried at a fixed
 * list of candidate positions around it, the first that overlaps no linework
 * and no annotation (existing or just placed) wins. Existing tags never move.
 * No randomness, no global optimisation (internal design note).
 */

export const AUTO_TAG_CATEGORIES = ["duct", "pipe", "air_terminal", "equipment", "fixture", "part"] as const;
export type AutoTagCategory = (typeof AUTO_TAG_CATEGORIES)[number];

export interface AutoTagOptions {
  readonly categories: readonly AutoTagCategory[];
  /** Leave elements that already carry a tag in this view alone (default true). */
  readonly skipTagged?: boolean;
  /** Leaders: always, never, or only when the tag sits away from its element (default). */
  readonly leader?: "always" | "never" | "when_away";
  /** Skip run pieces shorter than this on paper (default 12 mm): too short to label. */
  readonly minRunPaperMm?: number;
  readonly textSizeMm?: number;
  /** Prefix for new item ids (stable per call so a retry makes the same ids). */
  readonly idPrefix: string;
  readonly limit?: number;
  /** Duct size tags say the insulation too: 24"x12" (1" liner). */
  readonly ductInsulationInTags?: boolean;
  /** Insulated pipe size tags say the insulation too: 2" (1" ins.). Bare pipe keeps the plain size tag. */
  readonly pipeInsulationInTags?: boolean;
  /** Every new tag uses this tag style. Absent: each takes the default style for its kind, if one is set. */
  readonly styleId?: string;
  /** Only these elements get a tag (the rest of the view still counts as obstacles). */
  readonly onlyElementIds?: ReadonlySet<string>;
  /** Annotations that are not obstacles: the tag being moved itself. */
  readonly ignoreItemIds?: ReadonlySet<string>;
  /** Use this tag spec (an existing tag's) instead of building one from the category. */
  readonly specFor?: (elementId: string) => TagSpec | null;
}

const isSizeTemplate = (t: TagTemplate) => t === "duct_size" || t === "duct_size_insulation" || t === "pipe_size" || t === "pipe_size_insulation";

export interface AutoTagPlan {
  readonly items: ReadonlyArray<{ readonly itemId: string; readonly elementId: string; readonly text: string; readonly at: Vec2; readonly tag: TagSpec }>;
  readonly skipped: ReadonlyArray<{ readonly elementId: string; readonly reason: string }>;
  readonly alreadyTagged: number;
}

function categoryOf(model: Pick<ModelState, "elements">, el: BimElement): AutoTagCategory | null {
  switch (el.kind) {
    case "run_segment":
      return el.domain === "pipe" ? "pipe" : el.domain === "duct" ? "duct" : null;
    case "part": {
      const type = model.elements[el.typeId];
      const cat = type?.kind === "part_type" ? type.definition.category : "generic";
      if (cat === "air_terminal") return "air_terminal";
      if (cat === "plumbing_fixture") return "fixture";
      if (cat === "mechanical_equipment" || cat === "electrical_equipment") return "equipment";
      return "part";
    }
    default: {
      // Tag all labels runs and parts; a room or space is tagged one at a time.
      const c = addOnTagCategory(el);
      return c === "room" || c === "space" ? null : c;
    }
  }
}

const TEMPLATE_FOR: Record<AutoTagCategory, TagTemplate> = { duct: "duct_size", pipe: "pipe_size", air_terminal: "air_terminal", equipment: "equipment", fixture: "fixture", part: "mark" };

/** Paper boxes and segments a candidate must stay clear of. Bucketed on a grid so each check reads a few cells. */
class Obstacles {
  private readonly cells = new Map<string, Array<AnnotationBox | { a: Vec2; b: Vec2; half: number }>>();
  constructor(private readonly cell = 10) {}
  private keys(min: Vec2, max: Vec2): string[] {
    const out: string[] = [];
    for (let x = Math.floor(min.x / this.cell); x <= Math.floor(max.x / this.cell); x++)
      for (let y = Math.floor(min.y / this.cell); y <= Math.floor(max.y / this.cell); y++) out.push(`${x},${y}`);
    return out;
  }
  private put(min: Vec2, max: Vec2, o: AnnotationBox | { a: Vec2; b: Vec2; half: number }): void {
    for (const k of this.keys(min, max)) {
      const list = this.cells.get(k);
      if (list) list.push(o);
      else this.cells.set(k, [o]);
    }
  }
  addBox(box: AnnotationBox): void {
    this.put(box.min, box.max, box);
  }
  addSegment(a: Vec2, b: Vec2, half: number): void {
    // Long runs would touch many cells; split them so each piece stays local.
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (this.cell * 4)));
    for (let i = 0; i < steps; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      const q = { x: a.x + ((b.x - a.x) * (i + 1)) / steps, y: a.y + ((b.y - a.y) * (i + 1)) / steps };
      this.put({ x: Math.min(p.x, q.x) - half, y: Math.min(p.y, q.y) - half }, { x: Math.max(p.x, q.x) + half, y: Math.max(p.y, q.y) + half }, { a: p, b: q, half });
    }
  }
  hits(box: AnnotationBox, ignore?: { a: Vec2; b: Vec2 }): boolean {
    for (const k of this.keys(box.min, box.max)) {
      for (const o of this.cells.get(k) ?? []) {
        if ("itemId" in o) {
          if (o.min.x < box.max.x && o.max.x > box.min.x && o.min.y < box.max.y && o.max.y > box.min.y) return true;
        } else {
          if (ignore && sameSeg(o, ignore)) continue;
          if (segmentHitsBox(o.a, o.b, { min: { x: box.min.x - o.half, y: box.min.y - o.half }, max: { x: box.max.x + o.half, y: box.max.y + o.half } })) return true;
        }
      }
    }
    return false;
  }
}

function sameSeg(a: { a: Vec2; b: Vec2 }, b: { a: Vec2; b: Vec2 }): boolean {
  // A piece of the element's own centreline: lies on the same line within a hair.
  const cross = (p: Vec2) => (b.b.x - b.a.x) * (p.y - b.a.y) - (b.b.y - b.a.y) * (p.x - b.a.x);
  const l = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) || 1;
  return Math.abs(cross(a.a)) / l < 0.01 && Math.abs(cross(a.b)) / l < 0.01;
}

/** Two paper segments on one line (within half a millimetre) that touch or overlap end to end. */
function collinearTouching(p: { a: Vec2; b: Vec2 }, q: { a: Vec2; b: Vec2 }): boolean {
  const l = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
  if (l < 1e-6) return false;
  const u = { x: (p.b.x - p.a.x) / l, y: (p.b.y - p.a.y) / l };
  const off = (r: Vec2) => Math.abs((r.x - p.a.x) * u.y - (r.y - p.a.y) * u.x);
  if (off(q.a) > 0.5 || off(q.b) > 0.5) return false;
  const t = (r: Vec2) => (r.x - p.a.x) * u.x + (r.y - p.a.y) * u.y;
  const lo = Math.min(t(q.a), t(q.b));
  const hi = Math.max(t(q.a), t(q.b));
  return hi >= -0.5 && lo <= l + 0.5;
}

/** Liang–Barsky: does the segment cross the rectangle? */
function segmentHitsBox(a: Vec2, b: Vec2, r: { min: Vec2; max: Vec2 }): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - r.min.x],
    [dx, r.max.x - a.x],
    [-dy, a.y - r.min.y],
    [dy, r.max.y - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Candidate centres around a point (fixed order: right, above, left, below, then the diagonals, nearer first). */
function pointCandidates(at: Vec2, w: number, h: number): Vec2[] {
  const out: Vec2[] = [];
  for (const r of [3, 6, 10]) {
    const dx = w / 2 + r;
    const dy = h / 2 + r;
    out.push({ x: at.x + dx, y: at.y }, { x: at.x, y: at.y - dy }, { x: at.x - dx, y: at.y }, { x: at.x, y: at.y + dy }, { x: at.x + dx, y: at.y - dy }, { x: at.x - dx, y: at.y - dy }, { x: at.x - dx, y: at.y + dy }, { x: at.x + dx, y: at.y + dy });
  }
  return out;
}

/** Candidate centres around a footprint: outside each side (right, above, left, below), then the corners, nearer first. */
function footprintCandidates(box: AnnotationBox, w: number, h: number): Vec2[] {
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const out: Vec2[] = [];
  for (const r of [1.5, 4, 8]) {
    const right = box.max.x + r + w / 2;
    const left = box.min.x - r - w / 2;
    const above = box.min.y - r - h / 2;
    const below = box.max.y + r + h / 2;
    out.push({ x: right, y: cy }, { x: cx, y: above }, { x: left, y: cy }, { x: cx, y: below }, { x: right, y: above }, { x: left, y: above }, { x: left, y: below }, { x: right, y: below });
  }
  return out;
}

/** Candidate centres beside a run: on its centreline first (a size tag sits in the duct when it fits), then either side, then along it. */
function runCandidates(a: Vec2, b: Vec2, halfWidth: number, w: number, h: number): Vec2[] {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  const n = { x: -u.y, y: u.x };
  const out: Vec2[] = [];
  const reach = Math.abs(n.x) * (w / 2) + Math.abs(n.y) * (h / 2);
  for (const along of [0, -0.25, 0.25]) {
    const base = { x: mid.x + u.x * l * along, y: mid.y + u.y * l * along };
    for (const d of [halfWidth + reach + 1.5, -(halfWidth + reach + 1.5), halfWidth + reach + 6, -(halfWidth + reach + 6)]) out.push({ x: base.x + n.x * d, y: base.y + n.y * d });
  }
  return out;
}

/** View frame (model mm) to the view's own paper mm (y down), and back. */
export function paperMapping(view: ViewElement) {
  const s = view.props?.scale ?? 48;
  return { toPaper: (p: Vec2): Vec2 => ({ x: p.x / s, y: -p.y / s }), toModel: (p: Vec2): Vec2 => ({ x: p.x * s, y: -p.y * s }), scale: s };
}

/** Every annotation's paper box in a view: tags, dimensions and notes, as collision obstacles and for reads. */
export function annotationBoxes(model: ModelState, view: ViewElement, items: readonly DrawingItem[], toPaper: (p: Vec2) => Vec2): AnnotationBox[] {
  const out: AnnotationBox[] = [];
  for (const item of items) {
    if (item.deleted) continue;
    if (item.tag && item.points[0]) {
      const box = tagItemBox(model, view, item, toPaper);
      if (box) out.push(box);
    } else if (item.dim) {
      const { points } = dimensionPoints(model, view, item);
      const pp = points.map(toPaper);
      const labels = dimensionLabels(model, view, item);
      const xs = pp.map((p) => p.x);
      const ys = pp.map((p) => p.y);
      const pad = Math.abs(item.dim.offsetMm) + 4 + (labels.length > 0 ? 3 : 0);
      out.push({ itemId: item.id, min: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad }, max: { x: Math.max(...xs) + pad, y: Math.max(...ys) + pad } });
    } else if (item.shape === "text" && item.points[0]) {
      const at = toPaper(item.points[0]);
      const w = item.note ? item.note.box.width : paperTextWidth(item.text ?? "", item.textSize ?? 2.4);
      out.push({ itemId: item.id, min: at, max: { x: at.x + w, y: at.y + 10 } });
    }
  }
  return out;
}

/** Plan where the tags go. Pure: the caller sends the result as one batch. */
export function planAutoTags(model: ModelState, viewId: string, opts: AutoTagOptions): AutoTagPlan {
  const view = model.elements[viewId];
  if (view?.kind !== "view" || view.deleted) throw new Error(`View ${viewId} does not exist`);
  if (view.viewType !== "floor_plan" && view.viewType !== "ceiling_plan" && view.viewType !== "section") throw new Error("Tags go in plans and sections, which show the model.");
  const { toPaper, toModel } = paperMapping(view);
  const items = documentIndex(model).itemsByOwner.get(view.id) ?? [];
  const tagged = new Set(items.flatMap((i) => (i.tag ? [i.tag.elementId] : [])));
  const crop = effectiveCrop(model, view, items);
  const wanted = new Set(opts.categories);
  const obstacles = new Obstacles();
  for (const box of annotationBoxes(model, view, items, toPaper)) if (!opts.ignoreItemIds?.has(box.itemId)) obstacles.addBox(box);

  type Candidate = { el: BimElement; category: AutoTagCategory; anchor: Vec2; seg: { a: Vec2; b: Vec2; half: number } | null };
  const footprints = new Map<string, AnnotationBox>();
  const candidates: Candidate[] = [];
  const inCrop = (p: Vec2) => p.x >= crop.min.x && p.x <= crop.max.x && p.y >= crop.min.y && p.y <= crop.max.y;
  // Obstacles matter only near the crop: elements well outside it can't collide with a tag inside.
  const reach = 30 * paperMapping(view).scale;
  const nearCrop = (p: Vec2) => p.x >= crop.min.x - reach && p.x <= crop.max.x + reach && p.y >= crop.min.y - reach && p.y <= crop.max.y + reach;
  for (const el of viewLevelElements(model, view)) {
    if ("deleted" in el && el.deleted) continue;
    const category = categoryOf(model, el);
    // Linework of everything that draws is an obstacle, tagged or not.
    const mid = anchorInView(model, view, { elementId: el.id, anchor: "mid" });
    if (!mid) continue;
    const addOn = addOnRun(el);
    const straight = el.kind === "run_segment" || el.kind === "wall" || addOn !== null;
    if (!nearCrop(mid) && !straight) continue;
    let seg: Candidate["seg"] = null;
    if (straight) {
      const a = anchorInView(model, view, { elementId: el.id, anchor: "start" });
      const b = anchorInView(model, view, { elementId: el.id, anchor: "end" });
      if (a && b) {
        const width = el.kind === "wall" ? el.thickness : el.kind === "run_segment" ? ("width" in el.size ? el.size.width : "diameter" in el.size ? el.size.diameter : 0) : (addOn?.widthMm ?? 0);
        seg = { a: toPaper(a), b: toPaper(b), half: Math.max(0.3, width / 2 / paperMapping(view).scale) };
        obstacles.addSegment(seg.a, seg.b, seg.half);
      }
    } else {
      // A part or unit blocks its whole footprint on a plan; elsewhere, a small box at its point.
      const solid = view.viewType === "section" ? null : elementSolid(model, el, 0);
      const outline = solid ? solid.pieces.flatMap((piece) => [...piece.r0, ...piece.r1]).map((q) => toPaper({ x: q.x, y: q.y })) : [];
      const p = toPaper(mid);
      const xs = outline.length > 0 ? outline.map((q) => q.x) : [p.x - 1.5, p.x + 1.5];
      const ys = outline.length > 0 ? outline.map((q) => q.y) : [p.y - 1.5, p.y + 1.5];
      const box = { itemId: el.id, min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
      obstacles.addBox(box);
      if (outline.length > 0) footprints.set(el.id, box);
    }
    if (!category || !wanted.has(category) || !inCrop(mid)) continue;
    if (opts.onlyElementIds && !opts.onlyElementIds.has(el.id)) continue;
    candidates.push({ el, category, anchor: toPaper(mid), seg });
  }
  // Top to bottom, then left to right, on paper; ids break ties.
  candidates.sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x || (a.el.id < b.el.id ? -1 : a.el.id > b.el.id ? 1 : 0));

  const placed: Array<AutoTagPlan["items"][number]> = [];
  const skipped: Array<AutoTagPlan["skipped"][number]> = [];
  let alreadyTagged = 0;
  const sizeTagged: Array<{ label: string; seg: { a: Vec2; b: Vec2 } }> = [];
  // Existing size tags count too: a run tagged by hand isn't tagged again on its next piece.
  for (const item of items) {
    if (!item.tag || item.deleted || opts.ignoreItemIds?.has(item.id) || (!isSizeTemplate(item.tag.template) && item.tag.template !== "auto")) continue;
    const a = anchorInView(model, view, { elementId: item.tag.elementId, anchor: "start" });
    const b = anchorInView(model, view, { elementId: item.tag.elementId, anchor: "end" });
    if (a && b) sizeTagged.push({ label: (tagLines(model, item.tag) ?? []).join(" "), seg: { a: toPaper(a), b: toPaper(b) } });
  }
  const size = opts.textSizeMm ?? 2.4;
  const minRun = opts.minRunPaperMm ?? 12;
  for (const c of candidates) {
    if (opts.limit !== undefined && placed.length >= opts.limit) break;
    if ((opts.skipTagged ?? true) && tagged.has(c.el.id)) {
      alreadyTagged += 1;
      continue;
    }
    if (c.seg && Math.hypot(c.seg.b.x - c.seg.a.x, c.seg.b.y - c.seg.a.y) < minRun) {
      skipped.push({ elementId: c.el.id, reason: "too short on paper to label at this scale" });
      continue;
    }
    // Gas pipe: every piece gets its size and length (the fuel gas tables size by length), so none is skipped as "same as beside it".
    const insulatedPipe = c.category === "pipe" && opts.pipeInsulationInTags && (c.el.kind === "run_segment" || c.el.kind === "run_fitting") && c.el.insulation !== undefined;
    const template = c.category === "duct" && opts.ductInsulationInTags ? "duct_size_insulation" : c.category === "pipe" && isGasRun(model, c.el) ? "gas_pipe" : insulatedPipe ? "pipe_size_insulation" : TEMPLATE_FOR[c.category];
    const given = opts.specFor?.(c.el.id) ?? null;
    const styleId = given ? given.styleId : (opts.styleId ?? defaultTagStyleFor(model, c.el));
    const spec: TagSpec = given ?? { elementId: c.el.id, template, leader: false, ...(opts.textSizeMm ? { textSizeMm: opts.textSizeMm } : {}), ...(styleId ? { styleId } : {}) };
    const lines = tagLines(model, spec) ?? ["?"];
    // A style can turn the words along the run and draw an outline: candidates are checked with the box it really prints.
    const rotation = tagRotationDeg(model, view, spec, toPaper);
    const shape = tagShape(model, spec);
    const probe = tagHeadBox("probe", lines, { x: 0, y: 0 }, styleId ? tagTextSizeMm(model, spec) : size, rotation, shape);
    const w = probe.max.x - probe.min.x;
    const h = probe.max.y - probe.min.y;
    // One size tag per straight stretch of one size: a collinear piece of the same size already tagged covers this one.
    if (c.seg && isSizeTemplate(spec.template) && !given) {
      const label = lines.join(" ");
      const seg = c.seg;
      const covered = sizeTagged.find((t) => t.label === label && collinearTouching(t.seg, seg));
      if (covered) {
        skipped.push({ elementId: c.el.id, reason: `same size as the run beside it, already tagged (${label})` });
        continue;
      }
    }
    const foot = footprints.get(c.el.id);
    const spots = c.seg ? runCandidates(c.seg.a, c.seg.b, c.seg.half, w, h) : foot ? footprintCandidates(foot, w, h) : pointCandidates(c.anchor, w, h);
    const itemId = `${opts.idPrefix}-${c.el.id}`.slice(0, 200);
    let chosen: { at: Vec2; index: number } | null = null;
    for (const [index, at] of spots.entries()) {
      const box = tagHeadBox(itemId, lines, at, size, rotation, shape);
      if (!obstacles.hits(box, c.seg ?? undefined)) {
        chosen = { at, index };
        break;
      }
    }
    if (!chosen) {
      skipped.push({ elementId: c.el.id, reason: "no clear spot nearby; tag it by hand or crop the view less tightly" });
      continue;
    }
    obstacles.addBox(tagHeadBox(itemId, lines, chosen.at, size, rotation, shape));
    if (c.seg && isSizeTemplate(spec.template)) sizeTagged.push({ label: lines.join(" "), seg: c.seg });
    const away = c.seg ? chosen.index >= 2 : chosen.index >= 8;
    const leader = opts.leader === "always" || (opts.leader !== "never" && away);
    placed.push({ itemId, elementId: c.el.id, text: lines.join(" "), at: toModel(chosen.at), tag: given ?? { ...spec, leader, ...(leader ? { elbow: "auto" as const } : {}) } });
  }
  return { items: placed, skipped, alreadyTagged };
}

/**
 * Where an existing tag should go to sit clear of everything else in its view:
 * the same fixed candidates Tag all tries, with every other annotation and the
 * linework as obstacles and the tag itself ignored. Null when the view can't
 * hold tags or no candidate is clear (the caller says so and leaves it).
 */
export function clearSpotForTag(model: ModelState, viewId: string, itemId: string): { at: Vec2; text: string } | null {
  const item = model.elements[itemId];
  if (item?.kind !== "drawing_item" || item.deleted || !item.tag) return null;
  const view = model.elements[viewId];
  if (view?.kind !== "view" || (view.viewType !== "floor_plan" && view.viewType !== "ceiling_plan" && view.viewType !== "section")) return null;
  const tag = item.tag;
  const el = model.elements[tag.elementId];
  const category = el ? categoryOf(model, el) : null;
  if (!category) return null;
  const plan = planAutoTags(model, viewId, {
    categories: [category],
    idPrefix: "clear",
    skipTagged: false,
    minRunPaperMm: 0,
    onlyElementIds: new Set([tag.elementId]),
    ignoreItemIds: new Set([itemId]),
    specFor: (id) => (id === tag.elementId ? tag : null),
  });
  const placed = plan.items[0];
  return placed ? { at: placed.at, text: placed.text } : null;
}

/** What a tag looks like where it sits: what it prints, its paper box, and what it collides with or crowds. */
export interface TagSituation {
  readonly itemId: string;
  readonly prints: readonly string[];
  /** Paper mm, y down, in the view's own paper frame. */
  readonly box: { readonly min: Vec2; readonly max: Vec2 };
  readonly rotationDeg: number;
  /** Other annotations its box overlaps. */
  readonly overlaps: ReadonlyArray<{ readonly itemId: string; readonly what: "tag" | "dimension" | "note"; readonly prints?: string }>;
  /** Model lines (runs, walls, grids) other than its own element that cross its box. */
  readonly crossesLines: number;
  /** Other tags within 10 paper mm, nearest first (at most five). */
  readonly nearbyTags: ReadonlyArray<{ readonly itemId: string; readonly prints: string; readonly gapMm: number }>;
  /** Paper mm from the head to its element (a long way off reads as orphaned). Null when the element isn't in the view. */
  readonly distanceToElementMm: number | null;
  readonly clear: boolean;
}

const NEARBY_MM = 10;

function boxGap(a: AnnotationBox, b: { min: Vec2; max: Vec2 }): number {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  return Math.hypot(dx, dy);
}

/**
 * A tag's situation in its view, for an agent placing or moving it: pass the
 * item as it would be after the edit (it need not be in the model yet).
 * Deterministic and local: only annotations and lines near the box are read.
 */
export function tagSituation(model: ModelState, viewId: string, item: DrawingItem): TagSituation | null {
  const view = model.elements[viewId];
  if (view?.kind !== "view" || view.deleted || !item.tag || !item.points[0]) return null;
  const { toPaper, scale } = paperMapping(view);
  const box = tagItemBox(model, view, item, toPaper);
  if (!box) return null;
  const prints = tagLines(model, item.tag) ?? ["?"];
  const others = (documentIndex(model).itemsByOwner.get(view.id) ?? []).filter((i) => i.id !== item.id && !i.deleted);
  const overlaps: Array<TagSituation["overlaps"][number]> = [];
  const nearby: Array<TagSituation["nearbyTags"][number]> = [];
  const byId = new Map<string, DrawingItem>(others.map((o) => [o.id, o]));
  for (const b of annotationBoxes(model, view, others, toPaper)) {
    const other = byId.get(b.itemId);
    if (!other) continue;
    const gap = boxGap(box, b);
    const what = other.tag ? "tag" : other.dim ? "dimension" : "note";
    const otherPrints = other.tag ? (tagLines(model, other.tag) ?? []).join(" / ") : undefined;
    if (b.min.x < box.max.x && b.max.x > box.min.x && b.min.y < box.max.y && b.max.y > box.min.y) overlaps.push({ itemId: b.itemId, what, ...(otherPrints !== undefined ? { prints: otherPrints } : {}) });
    else if (other.tag && gap <= NEARBY_MM) nearby.push({ itemId: b.itemId, prints: otherPrints ?? "", gapMm: Math.round(gap * 10) / 10 });
  }
  nearby.sort((a, b) => a.gapMm - b.gapMm || (a.itemId < b.itemId ? -1 : 1));
  let crossesLines = 0;
  const reach = (NEARBY_MM + 30) * scale;
  const centre = toModelPoint(view, { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 });
  for (const el of viewLevelElements(model, view)) {
    if (("deleted" in el && el.deleted) || el.id === item.tag.elementId) continue;
    if (el.kind !== "run_segment" && el.kind !== "wall" && el.kind !== "grid" && addOnRun(el) === null) continue;
    const a = anchorInView(model, view, { elementId: el.id, anchor: "start" });
    const b = anchorInView(model, view, { elementId: el.id, anchor: "end" });
    if (!a || !b) continue;
    if (Math.min(a.x, b.x) > centre.x + reach || Math.max(a.x, b.x) < centre.x - reach || Math.min(a.y, b.y) > centre.y + reach || Math.max(a.y, b.y) < centre.y - reach) continue;
    if (segmentHitsBox(toPaper(a), toPaper(b), box)) crossesLines += 1;
  }
  const target = anchorInView(model, view, { elementId: item.tag.elementId, anchor: "mid" });
  const head = toPaper(item.points[0]);
  const distanceToElementMm = target ? Math.round(Math.hypot(toPaper(target).x - head.x, toPaper(target).y - head.y) * 10) / 10 : null;
  const r = (p: Vec2) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
  return {
    itemId: item.id,
    prints,
    box: { min: r(box.min), max: r(box.max) },
    rotationDeg: tagRotationDeg(model, view, item.tag, toPaper),
    overlaps,
    crossesLines,
    nearbyTags: nearby.slice(0, 5),
    distanceToElementMm,
    clear: overlaps.length === 0 && crossesLines === 0,
  };
}

function toModelPoint(view: ViewElement, p: Vec2): Vec2 {
  return paperMapping(view).toModel(p);
}
