import type { ModelState, Vec2 } from "../types";
import { elementsOfKind } from "../store";
import type { SheetReference } from "../drawing/sheet";
import { buildLinkedReferenceIndex, linkedElementKey, parseLinkedElementKey, type LinkedReferenceIndex, type LinkedReferenceModel, type ReferenceItem, type ReferenceLine } from "./index-geometry";
import { linkedReferenceRulesOf } from "./linked-reference-point";

/**
 * Dimensions that follow a linked model's element. A dimension point stores
 * the usual anchor reference with the linked element's key as its element id
 * (`linked:<model>:<GlobalId>`, see `linkedElementKey`) and an anchor name:
 * `edge_left` / `edge_right` its two faces, `mid` its centre line, `start` /
 * `end` its ends, `center` the middle of its outline.
 *
 * Linked geometry lives outside the model, so the host publishes what it has
 * loaded here, by linked model id (ids are unique, so one catalogue serves
 * every model in a process). A point whose linked model is not loaded keeps
 * its stored place; one whose model is loaded but no longer has the element
 * is missing, and the drawing says so instead of moving it.
 */

/** Peers that store a dimension anchored to a linked element (and do not refuse its key as a missing element). */
export const ANNOTATION_LINKED_ANCHORS_FEATURE = "annotation:linked_anchors";

const catalogue = new Map<string, LinkedReferenceIndex>();
/** Linked models a drawing being built carries itself (a printed sheet's answers from the server), checked before the catalogue. */
let scoped: ReadonlyMap<string, LinkedReferenceIndex> | null = null;

/** An index of exactly these elements (a drawing's named anchors): every element counts, whatever the rules in force. */
export function anchorIndexOf(models: readonly LinkedReferenceModel[]): LinkedReferenceIndex {
  const classes = [...new Set(models.flatMap((m) => m.elements.map((e) => e.ifcClass.toUpperCase())))];
  return buildLinkedReferenceIndex(models, linkedReferenceRulesOf([], classes));
}

/**
 * Builds `fn`'s drawing with these linked models resolving its dimensions'
 * linked anchors (the elements a print's dimensions name, from the server's
 * linked data), then puts the page's catalogue back. A model listed with no
 * elements is loaded and has none of them: those anchors are missing.
 */
export function withLinkedReferenceModels<T>(models: readonly LinkedReferenceModel[], fn: () => T): T {
  if (models.length === 0) return fn();
  const index = anchorIndexOf(models);
  const map = new Map(scoped ?? []);
  for (const s of index.sources) map.set(s.id, index);
  const previous = scoped;
  scoped = map;
  try {
    return fn();
  } finally {
    scoped = previous;
  }
}

/** The linked models a drawing's backgrounds carry for its dimensions. */
export function linkedAnchorModelsOf(backgrounds: readonly SheetReference[]): LinkedReferenceModel[] {
  return backgrounds.flatMap((b) => b.linkedAnchors ?? []);
}

/** The linked elements a view's dimensions follow, as keys (`linked:<model>:<GlobalId>`), sorted: what its print asks the server for, and nothing more. */
export function linkedAnchorKeysOfView(model: Pick<ModelState, "elements">, viewId: string): string[] {
  const out = new Set<string>();
  for (const el of elementsOfKind(model.elements, "drawing_item")) {
    if (el.deleted || el.ownerId !== viewId) continue;
    for (const r of el.dim?.refs ?? []) if (r && parseLinkedElementKey(r.elementId)) out.add(r.elementId);
  }
  return [...out].sort();
}

/** A background with no linework that carries linked anchors (their models drew nothing in this view). */
export function anchorOnlyReference(models: readonly LinkedReferenceModel[]): SheetReference {
  return {
    plan: { id: "linked-anchors", source: { file: "", sha256: "" }, level: { name: "", elevationMm: 0 }, cutHeightMm: 0, bounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, layers: [], labels: [] },
    pen: "thin",
    tone: "ink",
    linkedAnchors: models,
  };
}

/** Make an index's linked models resolvable (replaces earlier versions of the same models). */
export function publishLinkedReferenceIndex(index: LinkedReferenceIndex): void {
  for (const s of index.sources) catalogue.set(s.id, index);
}

/** Forget these linked models (unlinked, or the page closed). */
export function withdrawLinkedReferenceSources(sourceIds: readonly string[]): void {
  for (const id of sourceIds) catalogue.delete(id);
}

/** Linked models resolvable now, by id. */
export function publishedLinkedSources(): readonly string[] {
  return [...catalogue.keys()];
}

export type LinkedAnchorAt =
  | { readonly kind: "point"; readonly at: Vec2 }
  /** The linked model is loaded and no longer has the element. */
  | { readonly kind: "missing"; readonly sourceLabel: string };

function closestOnLine(l: ReferenceLine, p: Vec2): Vec2 {
  const dx = l.end.x - l.start.x;
  const dy = l.end.y - l.start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return l.start;
  const t = ((p.x - l.start.x) * dx + (p.y - l.start.y) * dy) / len2;
  return { x: l.start.x + dx * t, y: l.start.y + dy * t };
}

function centreOf(item: ReferenceItem): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of item.outline) {
    x += p.x;
    y += p.y;
  }
  return { x: x / item.outline.length, y: y / item.outline.length };
}

/** Where an anchor on a linked element is, nearest the point it was stored at (faces and centre lines are followed square to themselves). */
export function linkedAnchorPoint(item: ReferenceItem, anchor: string, stored: Vec2): Vec2 {
  const line = item.line;
  if (line) {
    switch (anchor) {
      case "edge_left":
        return closestOnLine(line.faces[0], stored);
      case "edge_right":
        return closestOnLine(line.faces[1], stored);
      case "mid":
        return closestOnLine(line.axis, stored);
      case "start":
        return line.axis.start;
      case "end":
        return line.axis.end;
      default:
        return centreOf(item);
    }
  }
  if (anchor === "center" || anchor === "insertion") return centreOf(item);
  let best = stored;
  let bestD = Infinity;
  for (let i = 0; i < item.outline.length; i++) {
    const a = item.outline[i] as Vec2;
    const b = item.outline[(i + 1) % item.outline.length] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((stored.x - a.x) * dx + (stored.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(q.x - stored.x, q.y - stored.y);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

/**
 * A stored anchor on a linked element, resolved against what is published:
 * null when the id is not a linked element's or its linked model is not loaded
 * (the caller keeps the stored point).
 */
export function resolveLinkedAnchor(ref: { readonly elementId: string; readonly anchor: string }, stored: Vec2): LinkedAnchorAt | null {
  const linked = parseLinkedElementKey(ref.elementId);
  if (!linked) return null;
  const found = linkedAnchorItem(ref.elementId);
  if (!found) return null;
  if (found.kind === "missing") return found;
  return { kind: "point", at: linkedAnchorPoint(found.item, ref.anchor, stored) };
}

/** The linked element a key names, from the drawing's own linked data first, then the page's: null when its model isn't loaded. */
export function linkedAnchorItem(key: string): { readonly kind: "item"; readonly item: ReferenceItem } | { readonly kind: "missing"; readonly sourceLabel: string } | null {
  const linked = parseLinkedElementKey(key);
  if (!linked) return null;
  const index = scoped?.get(linked.sourceId) ?? catalogue.get(linked.sourceId);
  if (!index) return null;
  const item = index.byKey.get(linkedElementKey(linked));
  if (!item) return { kind: "missing", sourceLabel: index.sources.find((s) => s.id === linked.sourceId)?.label ?? "the linked model" };
  return { kind: "item", item };
}

/**
 * Where an anchor on a linked element lands in a section, in the section's
 * frame (along the cut, height): a face or centre line where it crosses the
 * cut line, a point projected onto it; the height stays the stored one.
 */
export function linkedAnchorInSection(item: ReferenceItem, anchor: string, cut: { readonly start: Vec2; readonly end: Vec2 }, stored: Vec2): Vec2 {
  const dx = cut.end.x - cut.start.x;
  const dy = cut.end.y - cut.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const along = (p: Vec2): number => ((p.x - cut.start.x) * dx + (p.y - cut.start.y) * dy) / len;
  const line = item.line;
  const lineOf = anchor === "edge_left" ? line?.faces[0] : anchor === "edge_right" ? line?.faces[1] : anchor === "mid" ? line?.axis : undefined;
  if (lineOf) {
    const ex = lineOf.end.x - lineOf.start.x;
    const ey = lineOf.end.y - lineOf.start.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > 1e-9) {
      const t = ((lineOf.start.x - cut.start.x) * ey - (lineOf.start.y - cut.start.y) * ex) / den;
      return { x: t * len, y: stored.y };
    }
    return { x: along({ x: (lineOf.start.x + lineOf.end.x) / 2, y: (lineOf.start.y + lineOf.end.y) / 2 }), y: stored.y };
  }
  const p = linkedAnchorPoint(item, anchor, { x: cut.start.x + (dx / len) * stored.x, y: cut.start.y + (dy / len) * stored.x });
  return { x: along(p), y: stored.y };
}

/** The words a dimension shows when a linked element it follows has gone. */
export function missingLinkedAnchorWords(sourceLabel: string): string {
  return `Measured to something no longer in ${sourceLabel}: kept where it was`;
}
