import { DEFAULT_DETAIL_SCALE, type DrawingItem } from "../documents";
import { documentIndex } from "../commands/views";
import { viewCrop } from "../crop";
import { detailItemBounds } from "../annotation/detailing";
import { boxToPaper, noteCornersInModel, noteDrawing, textBlockCorners, type TextBlock } from "../annotation/text-note";
import { dimensionPoints } from "../annotation/annotations";
import type { ModelState, Vec2, ViewElement } from "../types";
import { buildViewScene } from "./views";

/**
 * Pure drafting-view quality audit and tight content bounds.
 *
 * Checks text-vs-text overlaps, unmasked text colliding with non-leader
 * linework, items clipped outside the view crop box, and dimensions with
 * orphaned element references. Lives in `drawing/` so it can call
 * `buildViewScene` without violating the kernel's layer DAG.
 */

export interface Box2 {
  readonly min: Vec2;
  readonly max: Vec2;
}

export interface DetailTextOverlap {
  readonly aId: string;
  readonly aText: string;
  readonly bId: string;
  readonly bText: string;
  readonly overlapAreaMm2: number;
}

export interface DetailLineCrossing {
  readonly itemId: string;
  readonly text: string;
  readonly crossingCount: number;
}

export interface DetailCheckReport {
  readonly viewId: string;
  readonly scale: number;
  readonly clean: boolean;
  readonly itemCount: number;
  readonly noteCount: number;
  readonly dimensionCount: number;
  readonly textOverlaps: readonly DetailTextOverlap[];
  readonly lineCrossings: readonly DetailLineCrossing[];
  readonly clippedItems: readonly string[];
  readonly orphanedDimensions: readonly string[];
  readonly boundsMm: Box2 | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function mergeBounds(acc: Box2 | null, pts: readonly Vec2[]): Box2 | null {
  let out = acc;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (!out) {
      out = { min: { x: p.x, y: p.y }, max: { x: p.x, y: p.y } };
    } else {
      out = {
        min: { x: Math.min(out.min.x, p.x), y: Math.min(out.min.y, p.y) },
        max: { x: Math.max(out.max.x, p.x), y: Math.max(out.max.y, p.y) },
      };
    }
  }
  return out;
}

function itemModelBounds(model: ModelState, view: ViewElement, item: DrawingItem): Box2 | null {
  const scale = view.props?.scale ?? DEFAULT_DETAIL_SCALE;
  if (item.shape === "text") {
    return mergeBounds(null, noteCornersInModel(item, scale));
  }
  const detailBox = detailItemBounds(item, (p) => p);
  if (detailBox) return detailBox;
  if (item.shape === "dimension" && item.dim) {
    const resolved = dimensionPoints(model, view, item);
    const pad = (Math.abs(item.dim.offsetMm) + 6) * scale;
    const b = mergeBounds(null, resolved.points);
    return b ? { min: { x: b.min.x - pad, y: b.min.y - pad }, max: { x: b.max.x + pad, y: b.max.y + pad } } : null;
  }
  return mergeBounds(null, item.points);
}

/** Tight bounding box of every live drawing item (including rich notes and leaders) in a view, model mm. */
export function detailContentBounds(model: ModelState, viewId: string): Box2 | null {
  const view = model.elements[viewId];
  if (!view || view.kind !== "view" || view.deleted) return null;
  const items = documentIndex(model).itemsByOwner.get(view.id) ?? [];
  let acc: Box2 | null = null;
  for (const item of items) {
    if (item.deleted) continue;
    const b = itemModelBounds(model, view, item);
    if (b) acc = mergeBounds(acc, [b.min, b.max]);
  }
  return acc;
}

interface LabelBox {
  readonly id: string;
  readonly text: string;
  readonly masked: boolean;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function rotatedBox(origin: Vec2, x0: number, y0: number, x1: number, y1: number, deg: number): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!deg) return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const) {
    const dx = cx - origin.x;
    const dy = cy - origin.y;
    const rx = origin.x + dx * c - dy * s;
    const ry = origin.y + dx * s + dy * c;
    if (rx < minX) minX = rx;
    if (ry < minY) minY = ry;
    if (rx > maxX) maxX = rx;
    if (ry > maxY) maxY = ry;
  }
  return { minX, minY, maxX, maxY };
}

function blockLabelBoxes(block: TextBlock): LabelBox[] {
  const out: LabelBox[] = [];
  for (const line of block.layout.lines) {
    const text = line.pieces.map((p) => p.text).join("").trim();
    if (!text) continue;
    const corners = [
      boxToPaper(block, { x: line.left, y: line.top }),
      boxToPaper(block, { x: line.right, y: line.top }),
      boxToPaper(block, { x: line.right, y: line.top + line.height }),
      boxToPaper(block, { x: line.left, y: line.top + line.height }),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    out.push({
      id: block.itemId,
      text,
      masked: block.mask === true,
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    });
  }
  return out;
}

/** Liang-Barsky segment-vs-AABB intersection test (paper mm). */
function segmentIntersectsBox(a: Vec2, b: Vec2, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - box.minX) &&
    clip(dx, box.maxX - a.x) &&
    clip(-dy, a.y - box.minY) &&
    clip(dy, box.maxY - a.y) &&
    t0 <= t1
  );
}

/**
 * Audit a drafting/detail view for legibility and print cleanliness:
 * overlapping text, unmasked text crossed by detail linework, clipped items,
 * and orphaned dimensions.
 */
export function checkDetailView(model: ModelState, viewId: string): DetailCheckReport {
  const view = model.elements[viewId];
  if (!view || view.kind !== "view" || view.deleted) {
    return {
      viewId,
      scale: DEFAULT_DETAIL_SCALE,
      clean: false,
      itemCount: 0,
      noteCount: 0,
      dimensionCount: 0,
      textOverlaps: [],
      lineCrossings: [],
      clippedItems: [],
      orphanedDimensions: [],
      boundsMm: null,
    };
  }
  const items = (documentIndex(model).itemsByOwner.get(view.id) ?? []).filter((it) => !it.deleted);
  const { scene, frame } = buildViewScene(model, view.id);
  const crop = viewCrop(view);
  const boundsMm = detailContentBounds(model, view.id);

  // Collect leader segment endpoints so a note's own leader line starting at its box edge isn't flagged as a crossing.
  const leaderKeys = new Set<string>();
  const segKey = (a: Vec2, b: Vec2) => `${r2(a.x)},${r2(a.y)}|${r2(b.x)},${r2(b.y)}`;
  const toPaper = (pt: Vec2): Vec2 => ({
    x: frame.center.x + (pt.x - (crop.min.x + crop.max.x) / 2) / frame.scale,
    y: frame.center.y - (pt.y - (crop.min.y + crop.max.y) / 2) / frame.scale,
  });

  const clippedItems: string[] = [];
  const orphanedDimensions: string[] = [];
  let noteCount = 0;
  let dimensionCount = 0;

  for (const item of items) {
    if (item.shape === "text") {
      noteCount += 1;
      const drawn = noteDrawing(item, toPaper);
      if (drawn) {
        for (const [s, e] of drawn.leader) {
          leaderKeys.add(segKey(s, e));
          leaderKeys.add(segKey(e, s));
        }
        const lo = toPaper({ x: crop.min.x, y: crop.max.y });
        const hi = toPaper({ x: crop.max.x, y: crop.min.y });
        const corners = textBlockCorners(drawn.block);
        if (corners.some((c) => c.x < lo.x - 1 || c.x > hi.x + 1 || c.y < lo.y - 1 || c.y > hi.y + 1)) {
          clippedItems.push(item.id);
        }
      }
    } else if (item.shape === "dimension") {
      dimensionCount += 1;
      if (item.dim && dimensionPoints(model, view, item).orphaned.length > 0) {
        orphanedDimensions.push(item.id);
      }
    } else {
      const b = itemModelBounds(model, view, item);
      if (b && (b.min.x < crop.min.x - 1 || b.max.x > crop.max.x + 1 || b.min.y < crop.min.y - 1 || b.max.y > crop.max.y + 1)) {
        clippedItems.push(item.id);
      }
    }
  }

  const labelBoxes: LabelBox[] = [];
  for (const block of scene.textBlocks ?? []) {
    labelBoxes.push(...blockLabelBoxes(block));
  }
  let primIdx = 0;
  for (const p of scene.primitives) {
    if (p.kind !== "text" || !p.text.trim()) continue;
    primIdx += 1;
    const w = Math.max(p.size * 0.65, p.text.length * p.size * 0.6);
    const x0 = p.anchor === "start" ? p.at.x : p.anchor === "end" ? p.at.x - w : p.at.x - w / 2;
    const y0 = p.vAlign === "middle" ? p.at.y - p.size * 0.6 : p.at.y - p.size;
    const y1 = p.vAlign === "middle" ? p.at.y + p.size * 0.6 : p.at.y + p.size * 0.25;
    const b = rotatedBox(p.at, x0, y0, x0 + w, y1, p.rotate ?? 0);
    labelBoxes.push({ id: `text-${primIdx}`, text: p.text, masked: p.mask === true, ...b });
  }

  const textOverlaps: DetailTextOverlap[] = [];
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const a = labelBoxes[i]!;
      const b = labelBoxes[j]!;
      if (a.id === b.id) continue;
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (ox > 0.15 && oy > 0.15) {
        textOverlaps.push({ aId: a.id, aText: a.text, bId: b.id, bText: b.text, overlapAreaMm2: r2(ox * oy) });
      }
    }
  }

  const nonLeaderLines = scene.primitives.filter(
    (p): p is Extract<typeof p, { kind: "line" }> => p.kind === "line" && !leaderKeys.has(segKey(p.a, p.b)),
  );
  const crossingMap = new Map<string, { text: string; count: number }>();
  for (const lb of labelBoxes) {
    if (lb.masked) continue;
    // Shrink slightly so touching an underline or boundary edge by < 0.25 mm doesn't false-positive.
    const inner = {
      minX: lb.minX + 0.25,
      minY: lb.minY + 0.25,
      maxX: lb.maxX - 0.25,
      maxY: lb.maxY - 0.25,
    };
    if (inner.maxX <= inner.minX || inner.maxY <= inner.minY) continue;
    let count = 0;
    for (const seg of nonLeaderLines) {
      if (segmentIntersectsBox(seg.a, seg.b, inner)) count += 1;
    }
    if (count > 0) {
      const prev = crossingMap.get(lb.id);
      crossingMap.set(lb.id, { text: prev ? `${prev.text} / ${lb.text}` : lb.text, count: (prev?.count ?? 0) + count });
    }
  }
  const lineCrossings: DetailLineCrossing[] = [...crossingMap.entries()].map(([itemId, info]) => ({
    itemId,
    text: info.text,
    crossingCount: info.count,
  }));

  return {
    viewId: view.id,
    scale: frame.scale,
    clean: textOverlaps.length === 0 && lineCrossings.length === 0 && clippedItems.length === 0 && orphanedDimensions.length === 0,
    itemCount: items.length,
    noteCount,
    dimensionCount,
    textOverlaps,
    lineCrossings,
    clippedItems,
    orphanedDimensions,
    boundsMm,
  };
}
