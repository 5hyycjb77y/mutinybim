import type { ElementId, Vec2 } from "../types";
import type { BoundarySegment } from "../spaces/boundaries/rows";
import { linkedReferenceRules, type LinkedReferenceRule, type LinkedReferenceRules } from "./linked-reference-point";

/**
 * Linked models as reference geometry: the straight edges (faces, centre
 * lines, outline edges) and points (ends, corners) of their elements, in
 * model millimetres, so tools can snap to them, dimensions can attach to
 * them and rooms can be found from them. Trade-agnostic: which entities
 * count, and for what, comes from `kernel.linked_reference` rows.
 *
 * Built once per loaded set of linked models (O(elements); each element's
 * plan outline has at most a dozen corners), then read by plan grid cell and
 * height: a pointer move reads the few cells round it, never the model.
 */

/** One linked element as a host sends it: its box and plan outline in host mm, and what it is. */
export interface LinkedReferenceElement {
  readonly globalId: string;
  readonly name: string;
  readonly ifcClass: string;
  /** [minX, minY, minZ, maxX, maxY, maxZ], model mm. */
  readonly box: readonly [number, number, number, number, number, number];
  /** Plan convex hull, model mm, flat [x0, y0, x1, y1, …]. Absent: the box's footprint. */
  readonly hull?: readonly number[];
}

/** One linked model as a host sends it. */
export interface LinkedReferenceModel {
  /** The linked model's id, stable across its versions (the link), so references survive an update. */
  readonly modelId: string;
  readonly label: string;
  /** Which version of it this is (changes with every update). Absent: unknown. */
  readonly version?: string;
  readonly elements: readonly LinkedReferenceElement[];
}

/** A linked element, by the linked model and its IFC GlobalId (stable across versions of the file). */
export interface LinkedElementRef {
  readonly sourceId: string;
  readonly globalId: string;
}

export interface ReferenceLine {
  readonly start: Vec2;
  readonly end: Vec2;
}

/** The axis and the two long faces of a long, thin element (a wall, a beam in plan). */
export interface LineLikeShape {
  readonly axis: ReferenceLine;
  readonly faces: readonly [ReferenceLine, ReferenceLine];
  readonly widthMm: number;
}

export interface ReferenceItem {
  readonly ref: LinkedElementRef;
  readonly sourceLabel: string;
  readonly name: string;
  readonly ifcClass: string;
  readonly rule: LinkedReferenceRule;
  readonly minZ: number;
  readonly maxZ: number;
  /** Counter-clockwise plan outline. */
  readonly outline: readonly Vec2[];
  /** Set for a long, thin element: snaps and room boundaries use its faces and centre line. */
  readonly line: LineLikeShape | null;
}

export interface LinkedReferenceIndex {
  readonly items: readonly ReferenceItem[];
  /** Per linked model: its label and how many of its elements are reference geometry. */
  readonly sources: readonly { readonly id: string; readonly label: string; readonly count: number; readonly version?: string }[];
  /** The rules it was built under. */
  readonly rulesFingerprint: string;
  readonly byKey: ReadonlyMap<string, ReferenceItem>;
  readonly cells: ReadonlyMap<string, readonly number[]>;
  readonly wide: readonly number[];
}

/** Plan grid cell, mm: the same bay as the room boundary index. */
export const REFERENCE_GRID_MM = 5000;
/** An element spanning more cells than this sits in the wide list. */
const MAX_CELLS = 256;
/** Height above a level that its plan reads linked geometry at (a plan's usual cut). */
export const REFERENCE_PLAN_HEIGHT_MM = 1200;
/** A long, thin element: length at least this many times its width, and no wider than this. */
const LINE_LIKE_RATIO = 3;
const LINE_LIKE_MAX_WIDTH_MM = 1500;
/** Hull edges within this angle of the axis are faces. */
const FACE_PARALLEL_RAD = (2 * Math.PI) / 180;

/** The key an element of a linked model goes by in maps and room boundaries. */
export function linkedElementKey(ref: LinkedElementRef): string {
  return `linked:${ref.sourceId}:${ref.globalId}`;
}

/** The linked element a key names, or null when the key is not a linked element's. */
export function parseLinkedElementKey(key: string): LinkedElementRef | null {
  if (!key.startsWith("linked:")) return null;
  const rest = key.slice("linked:".length);
  const at = rest.lastIndexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { sourceId: rest.slice(0, at), globalId: rest.slice(at + 1) };
}

const cellKey = (ix: number, iy: number): string => `${ix},${iy}`;

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Counter-clockwise convex hull (monotone chain); duplicates dropped. */
export function convexHullCcw(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Vec2, lower[lower.length - 1] as Vec2, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Vec2;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Vec2, upper[upper.length - 1] as Vec2, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function outlineOf(el: LinkedReferenceElement): Vec2[] {
  const [x0, y0, , x1, y1] = el.box;
  const pts: Vec2[] = [];
  if (el.hull && el.hull.length >= 6) for (let i = 0; i + 1 < el.hull.length; i += 2) pts.push({ x: el.hull[i] as number, y: el.hull[i + 1] as number });
  const hull = pts.length >= 3 ? convexHullCcw(pts) : [];
  return hull.length >= 3 ? hull : [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/**
 * The axis and faces of a convex outline when it is long and thin: the
 * smallest-area rectangle round it (one side lies along a hull edge), its long
 * direction the axis; each face is the longest hull edge parallel to the axis
 * on its side, else the rectangle's side. Null for a squat outline.
 */
export function lineLikeOf(outline: readonly Vec2[]): LineLikeShape | null {
  if (outline.length < 3) return null;
  let best: { area: number; ux: number; uy: number; minU: number; maxU: number; minV: number; maxV: number } | null = null;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Vec2;
    const b = outline[(i + 1) % outline.length] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of outline) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uy, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  let { ux, uy, minU, maxU, minV, maxV } = best;
  if (maxV - minV > maxU - minU) {
    // Long side across: turn the frame a quarter so u runs along it.
    [ux, uy] = [-uy, ux];
    [minU, maxU, minV, maxV] = [minV, maxV, -maxU, -minU];
  }
  const length = maxU - minU;
  const width = maxV - minV;
  if (width <= 0 || width > LINE_LIKE_MAX_WIDTH_MM || length < LINE_LIKE_RATIO * width) return null;
  const at = (u: number, v: number): Vec2 => ({ x: u * ux - v * uy, y: u * uy + v * ux });
  const midV = (minV + maxV) / 2;
  const sideFace = (side: 1 | -1): ReferenceLine => {
    let face: ReferenceLine | null = null;
    let faceLen = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i] as Vec2;
      const b = outline[(i + 1) % outline.length] as Vec2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const along = Math.abs(((b.x - a.x) * ux + (b.y - a.y) * uy) / len);
      if (along < Math.cos(FACE_PARALLEL_RAD)) continue;
      const v = (-((a.x + b.x) / 2) * uy + ((a.y + b.y) / 2) * ux) - midV;
      if (Math.sign(v) !== side) continue;
      if (len > faceLen) {
        face = { start: a, end: b };
        faceLen = len;
      }
    }
    return face ?? (side === 1 ? { start: at(minU, maxV), end: at(maxU, maxV) } : { start: at(minU, minV), end: at(maxU, minV) });
  };
  return { axis: { start: at(minU, midV), end: at(maxU, midV) }, faces: [sideFace(1), sideFace(-1)], widthMm: width };
}

function cellsOf(outline: readonly Vec2[]): string[] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outline) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const cx0 = Math.floor(x0 / REFERENCE_GRID_MM);
  const cx1 = Math.floor(x1 / REFERENCE_GRID_MM);
  const cy0 = Math.floor(y0 / REFERENCE_GRID_MM);
  const cy1 = Math.floor(y1 / REFERENCE_GRID_MM);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAX_CELLS) return null;
  const out: string[] = [];
  for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) out.push(cellKey(x, y));
  return out;
}

const finiteBox = (b: LinkedReferenceElement["box"]): boolean => b.length === 6 && b.every((n) => Number.isFinite(n));

/** How many indexes were built (perf proofs and tests read the delta). */
export const linkedReferenceStats = { builds: 0, queries: 0 };

/** The reference geometry of these linked models under the rules in force (or the ones given). */
export function buildLinkedReferenceIndex(models: readonly LinkedReferenceModel[], rules: LinkedReferenceRules = linkedReferenceRules()): LinkedReferenceIndex {
  linkedReferenceStats.builds += 1;
  const items: ReferenceItem[] = [];
  const byKey = new Map<string, ReferenceItem>();
  const cells = new Map<string, number[]>();
  const wide: number[] = [];
  const sources: { id: string; label: string; count: number; version?: string }[] = [];
  for (const model of models) {
    let count = 0;
    for (const el of model.elements) {
      const rule = rules.rules[el.ifcClass.toUpperCase()];
      if (!rule || !finiteBox(el.box)) continue;
      const outline = outlineOf(el);
      const item: ReferenceItem = {
        ref: { sourceId: model.modelId, globalId: el.globalId },
        sourceLabel: model.label,
        name: el.name,
        ifcClass: el.ifcClass.toUpperCase(),
        rule,
        minZ: el.box[2],
        maxZ: el.box[5],
        outline,
        line: lineLikeOf(outline),
      };
      const key = linkedElementKey(item.ref);
      if (byKey.has(key)) continue;
      const i = items.length;
      items.push(item);
      byKey.set(key, item);
      count += 1;
      const at = cellsOf(outline);
      if (at === null) wide.push(i);
      else
        for (const c of at) {
          const list = cells.get(c);
          if (list) list.push(i);
          else cells.set(c, [i]);
        }
    }
    sources.push({ id: model.modelId, label: model.label, count, ...(model.version ? { version: model.version } : {}) });
  }
  return { items, sources, rulesFingerprint: rules.fingerprint, byKey, cells, wide };
}

/** The element a reference names in this index, or null when the linked model no longer has it. */
export function linkedReferenceItem(index: LinkedReferenceIndex, ref: LinkedElementRef): ReferenceItem | null {
  return index.byKey.get(linkedElementKey(ref)) ?? null;
}

/** The elements whose cells meet the box and whose height range holds `zMm` (null: any height). */
export function linkedItemsNear(index: LinkedReferenceIndex, box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }, zMm: number | null): ReferenceItem[] {
  linkedReferenceStats.queries += 1;
  const seen = new Set<number>(index.wide);
  const x0 = Math.floor(box.minX / REFERENCE_GRID_MM);
  const x1 = Math.floor(box.maxX / REFERENCE_GRID_MM);
  const y0 = Math.floor(box.minY / REFERENCE_GRID_MM);
  const y1 = Math.floor(box.maxY / REFERENCE_GRID_MM);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS * 16) {
    for (let i = 0; i < index.items.length; i++) seen.add(i);
  } else {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const i of index.cells.get(cellKey(x, y)) ?? []) seen.add(i);
  }
  const out: ReferenceItem[] = [];
  for (const i of seen) {
    const item = index.items[i] as ReferenceItem;
    if (zMm !== null && (zMm < item.minZ || zMm > item.maxZ)) continue;
    out.push(item);
  }
  return out;
}

export type ReferencePointKind = "end" | "corner";
export type ReferenceLineKind = "face" | "centre" | "edge";

export interface ReferenceSnapPoint {
  readonly at: Vec2;
  readonly kind: ReferencePointKind;
  readonly ref: LinkedElementRef;
  /** What the marker says ("End of the linked wall"). */
  readonly label: string;
}

export interface ReferenceSnapLine extends ReferenceLine {
  readonly kind: ReferenceLineKind;
  readonly ref: LinkedElementRef;
  /** Which face of a long, thin element (0 or 1); absent for its centre line or an outline edge. */
  readonly face?: 0 | 1;
  readonly label: string;
}

export interface ReferenceSnapCandidates {
  readonly points: readonly ReferenceSnapPoint[];
  readonly lines: readonly ReferenceSnapLine[];
}

/** The snap points and lines of the snap-reference elements within `reachMm` of `at` at height `zMm`. */
export function linkedSnapCandidates(index: LinkedReferenceIndex, query: { readonly at: Vec2; readonly reachMm: number; readonly zMm: number | null }): ReferenceSnapCandidates {
  const { at, reachMm, zMm } = query;
  const items = linkedItemsNear(index, { minX: at.x - reachMm, minY: at.y - reachMm, maxX: at.x + reachMm, maxY: at.y + reachMm }, zMm);
  const points: ReferenceSnapPoint[] = [];
  const lines: ReferenceSnapLine[] = [];
  for (const item of items) {
    if (!item.rule.snap) continue;
    const noun = item.rule.noun;
    const ref = item.ref;
    for (const c of item.outline) points.push({ at: c, kind: "corner", ref, label: `Corner of the linked ${noun}` });
    if (item.line) {
      points.push({ at: item.line.axis.start, kind: "end", ref, label: `End of the linked ${noun}` }, { at: item.line.axis.end, kind: "end", ref, label: `End of the linked ${noun}` });
      lines.push(
        { ...item.line.faces[0], kind: "face", face: 0, ref, label: `On the linked ${noun}'s face` },
        { ...item.line.faces[1], kind: "face", face: 1, ref, label: `On the linked ${noun}'s face` },
        { ...item.line.axis, kind: "centre", ref, label: `On the linked ${noun}'s centre line` },
      );
    } else {
      for (let i = 0; i < item.outline.length; i++) lines.push({ start: item.outline[i] as Vec2, end: item.outline[(i + 1) % item.outline.length] as Vec2, kind: "edge", ref, label: `On the linked ${noun}'s edge` });
    }
  }
  return { points, lines };
}

/** The room-bounding edges of linked elements at height `zMm`: faces of long, thin ones, outline edges of the rest. */
export function linkedBoundarySegments(index: LinkedReferenceIndex, zMm: number): BoundarySegment[] {
  const out: BoundarySegment[] = [];
  for (const item of index.items) {
    if (!item.rule.boundsRooms || zMm < item.minZ || zMm > item.maxZ) continue;
    const elementId = linkedElementKey(item.ref) as ElementId;
    if (item.line) for (const f of item.line.faces) out.push({ elementId, start: f.start, end: f.end });
    else for (let i = 0; i < item.outline.length; i++) out.push({ elementId, start: item.outline[i] as Vec2, end: item.outline[(i + 1) % item.outline.length] as Vec2 });
  }
  return out;
}

/** The body outlines of room-bounding linked elements at `zMm` (between a wall's two faces is wall, not floor). */
export function linkedBoundingOutlines(index: LinkedReferenceIndex, zMm: number): readonly (readonly Vec2[])[] {
  return index.items.filter((i) => i.rule.boundsRooms && zMm >= i.minZ && zMm <= i.maxZ).map((i) => i.outline);
}
