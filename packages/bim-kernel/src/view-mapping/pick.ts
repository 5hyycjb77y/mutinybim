import type { Rect } from "../crop";
import { otherLevelElementsInRange, viewCropAndWindow } from "../drawing/views";
import { elementSolid, hull2 } from "../drawing/solids";
import { modelLevels, viewLevelNames } from "../levels";
import { displayContextOf, displayResolver } from "../organization/model";
import { sizeHeight, sizeWidth } from "../routing/rules";
import { straightPiece } from "../routing/fittings/geometry";
import type { RunPoint, RunSegment } from "../routing/types";
import { DEFAULT_PARTITION, type BimElement, type ModelState, type Vec2, type ViewElement } from "../types";
import { viewMapping, type ViewMapping } from "./mapping";
import { elementEntries } from "../store";
import { elementLook } from "../categories/element";
import { kindRowOf } from "../kinds/rows";

/**
 * What a pointer is over in a plan, section or elevation drawing, by element id.
 *
 * Each element the view draws gets a footprint in the drawing frame: the
 * convex outline of its projected solid (or, for a straight run, its
 * centreline with a half-width, which is exact enough to pick and cheap enough
 * for very large models). Footprints sit in a uniform grid, so a hover asks a
 * few cells instead of every element.
 *
 * Pickable is what draws: the view's level, its hidden categories, its phase
 * and group display, its crop window and (sections) the strip between the cut
 * line and the far clip. Tab cycling and the 3D view share the same element
 * ids, so a pre-highlight widens to the run, branch or system identically.
 */

/** Kinds a person can select in a drawing (annotations belong to the drafting tools). */
const PICKABLE = new Set<BimElement["kind"]>(["run_segment", "run_fitting", "part", "wall", "column", "opening", "room", "grid"]);
/** Drawn only in plans (a section draws their cut through solids, which these don't have). */
const PLAN_ONLY = new Set<BimElement["kind"]>(["opening", "room", "grid"]);
/** Picked only when nothing else is under the pointer (they cover whole rooms and floors). */
const BACKGROUND = new Set<BimElement["kind"]>(["room", "grid"]);
/** Changes to these never change what a drawing can pick. */
const INERT = new Set<BimElement["kind"]>(["view", "viewport", "sheet", "drawing_item", "mep_system", "tag", "dimension"]);

/**
 * True when the kind's row makes its records pickable: `pickShape` says where
 * a click picks one in plan (a point kind there and nowhere else), and a
 * `solid` body picks by its outline in plans and sections.
 */
const rowPicks = (kind: string): boolean => {
  const row = kindRowOf(kind);
  return row?.pickShape !== undefined || row?.solid !== undefined;
};

const CELL_MM = 2000;
/** Footprints spanning more cells than this are checked on every query instead of filling the grid. */
const MAX_CELLS = 256;

export interface Footprint {
  readonly id: string;
  readonly kind: BimElement["kind"];
  /** Convex outline (counter-clockwise), drawing frame. A strip's is its swept box. */
  readonly poly: readonly Vec2[];
  /** A straight run's centreline and half-width; picks by distance to the line. */
  readonly strip: { readonly a: Vec2; readonly b: Vec2; readonly half: number } | null;
  readonly min: Vec2;
  readonly max: Vec2;
  /** Nearest point to the viewer (larger is nearer). */
  readonly depth: number;
  /** Farthest point (sections keep what reaches the strip between the cut and the far clip). */
  readonly far: number;
  readonly background: boolean;
}

export interface ViewPickIndex {
  readonly viewId: string;
  /** The view record it was built for (a changed view rebuilds). */
  readonly view: ViewElement;
  readonly model: ModelState;
  readonly mapping: ViewMapping;
  readonly window: Rect;
  readonly levelZ: ReadonlyMap<string, number>;
  /** Crop view on: the window is the crop box and doesn't move with the content. */
  readonly cropOn: boolean;
  /** What the view draws (level, categories, phase and group display), as of the last full build. */
  readonly shown: (el: BimElement) => boolean;
  /** By id. Updated in place when the index is updated (see `buildViewPickIndex`). */
  readonly footprints: Map<string, Footprint>;
  /** Grid cell → ids. */
  readonly cells: Map<string, Set<string>>;
  readonly big: Set<string>;
}

export type BoxMode = "window" | "crossing";

function cellKey(i: number, j: number): string {
  return `${i},${j}`;
}

function cellRange(f: Footprint): { i0: number; i1: number; j0: number; j1: number } {
  return { i0: Math.floor(f.min.x / CELL_MM), i1: Math.floor(f.max.x / CELL_MM), j0: Math.floor(f.min.y / CELL_MM), j1: Math.floor(f.max.y / CELL_MM) };
}

function boundsOf(points: readonly Vec2[], pad = 0): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of points) {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  return { min: { x: minX - pad, y: minY - pad }, max: { x: maxX + pad, y: maxY + pad } };
}

function squareAround(c: Vec2, half: number): Vec2[] {
  return [
    { x: c.x - half, y: c.y - half },
    { x: c.x + half, y: c.y - half },
    { x: c.x + half, y: c.y + half },
    { x: c.x - half, y: c.y + half },
  ];
}

/**
 * A straight run's ends as far as its straight piece goes, pulled back a further `half` at an end that meets a
 * fitting (the strip's square cap reaches that far); never past the middle, so a piece shorter than its fittings
 * still picks at its centre.
 */
function trimmedEnds(elements: ModelState["elements"], seg: RunSegment, half: number): { start: RunPoint; end: RunPoint } {
  if (seg.flex) return { start: seg.start, end: seg.end };
  const piece = straightPiece(elements, seg);
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const dz = seg.end.z - seg.start.z;
  const total = Math.hypot(dx, dy, dz);
  if (total < 1e-6 || (piece.cutStart <= 0 && piece.cutEnd <= 0)) return { start: seg.start, end: seg.end };
  const along = (s: number): RunPoint => ({ x: seg.start.x + (dx * s) / total, y: seg.start.y + (dy * s) / total, z: seg.start.z + (dz * s) / total });
  const s0 = piece.cutStart > 0 ? Math.min(piece.cutStart + half, total / 2) : 0;
  const s1 = piece.cutEnd > 0 ? Math.min(piece.cutEnd + half, total / 2) : 0;
  return { start: along(s0), end: along(total - s1) };
}

function stripBox(a: Vec2, b: Vec2, half: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return squareAround(a, half);
  const n = { x: (-dy / len) * half, y: (dx / len) * half };
  const t = { x: (dx / len) * half, y: (dy / len) * half };
  return [
    { x: a.x - t.x + n.x, y: a.y - t.y + n.y },
    { x: a.x - t.x - n.x, y: a.y - t.y - n.y },
    { x: b.x + t.x - n.x, y: b.y + t.y - n.y },
    { x: b.x + t.x + n.x, y: b.y + t.y + n.y },
  ];
}

interface Build {
  readonly model: ModelState;
  readonly mapping: ViewMapping;
  readonly levelZ: ReadonlyMap<string, number>;
}

function footprintOf(b: Build, el: BimElement): Footprint | null {
  const { mapping } = b;
  const section = mapping.kind === "section";
  if (section && PLAN_ONLY.has(el.kind)) return null;
  const make = (poly: readonly Vec2[], depth: number, far: number, strip: Footprint["strip"] = null): Footprint => ({
    id: el.id,
    kind: el.kind,
    poly,
    strip,
    ...boundsOf(poly),
    depth,
    far,
    background: BACKGROUND.has(el.kind),
  });
  const at = (x: number, y: number, z: number) => mapping.toDrawing({ x, y, z });
  const pickShape = section ? undefined : kindRowOf(el.kind)?.pickShape;
  if (pickShape) {
    const shape = pickShape(el, b.model.elements);
    if (!shape) return null;
    const flat = (q: Vec2) => {
      const d = at(q.x, q.y, mapping.floorMm);
      return { p: { x: d.u, y: d.v }, depth: d.depth };
    };
    switch (shape.form) {
      case "segment": {
        const pa = flat(shape.a);
        const pb = flat(shape.b);
        return make(stripBox(pa.p, pb.p, shape.halfWidthMm), pa.depth, pa.depth, { a: pa.p, b: pb.p, half: shape.halfWidthMm });
      }
      case "point": {
        const c = flat(shape.at);
        return make(squareAround(c.p, shape.radiusMm), c.depth, c.depth);
      }
      case "outline": {
        if (shape.points.length < 3) return null;
        const pts = shape.points.map(flat);
        return make(hull2(pts.map((q) => q.p)), pts[0]?.depth ?? mapping.floorMm, pts[0]?.depth ?? mapping.floorMm);
      }
    }
  }
  switch (el.kind) {
    case "run_segment": {
      const z = b.levelZ.get(el.levelId) ?? 0;
      const w = sizeWidth(el.size);
      const h = sizeHeight(el.size);
      const full = { a: at(el.start.x, el.start.y, el.start.z + z), b: at(el.end.x, el.end.y, el.end.z + z) };
      // Across the drawn line a level run shows its width in plan and its height in a section;
      // a riser, or a run seen end-on (a point in the drawing), its larger side.
      const level = Math.abs(el.start.z - el.end.z) < 0.5;
      const endOn = Math.hypot(full.b.u - full.a.u, full.b.v - full.a.v) < 1;
      const half = (!level || endOn ? Math.max(w, h) : section ? h : w) / 2;
      // Only the straight piece: where an elbow, tee or transition sits on an end, the strip (and its square cap) stops at
      // that fitting's edge, so the fitting's own body picks it (before, an elbow on a printed plan was never
      // pickable, so its tee "+" never showed). A fitting's cut-back is read from its neighbours only, never a model scan.
      const ends = trimmedEnds(b.model.elements, el, half);
      const pa = at(ends.start.x, ends.start.y, ends.start.z + z);
      const pb = at(ends.end.x, ends.end.y, ends.end.z + z);
      const a = { x: pa.u, y: pa.v };
      const bb = { x: pb.u, y: pb.v };
      return make(stripBox(a, bb, half), Math.max(pa.depth, pb.depth) + half, Math.min(pa.depth, pb.depth) - half, { a, b: bb, half });
    }
    case "grid": {
      const pa = at(el.start.x, el.start.y, mapping.floorMm);
      const pb = at(el.end.x, el.end.y, mapping.floorMm);
      const a = { x: pa.u, y: pa.v };
      const bb = { x: pb.u, y: pb.v };
      return make(stripBox(a, bb, 0), pa.depth, pa.depth, { a, b: bb, half: 0 });
    }
    case "opening": {
      const half = el.width / 2;
      const pa = at(el.position.x - half, el.position.y, mapping.floorMm);
      const pb = at(el.position.x + half, el.position.y, mapping.floorMm);
      const a = { x: pa.u, y: pa.v };
      const bb = { x: pb.u, y: pb.v };
      return make(stripBox(a, bb, 100), pa.depth, pa.depth, { a, b: bb, half: 100 });
    }
    case "room": {
      if (el.outline.length < 3) return null;
      const pts = el.outline.map((q) => at(q.x, q.y, mapping.floorMm));
      return make(
        hull2(pts.map((q) => ({ x: q.u, y: q.v }))),
        mapping.floorMm,
        mapping.floorMm,
      );
    }
    default: {
      const solid = elementSolid(b.model, el, mapping.floorMm);
      if (!solid || solid.pieces.length === 0) return null;
      const pts: Vec2[] = [];
      let depth = -Infinity;
      let far = Infinity;
      for (const piece of solid.pieces) {
        for (const q of [...piece.r0, ...piece.r1]) {
          const d = mapping.toDrawing(q);
          pts.push({ x: d.u, y: d.v });
          if (d.depth > depth) depth = d.depth;
          if (d.depth < far) far = d.depth;
        }
      }
      const poly = hull2(pts);
      return poly.length > 0 ? make(poly.length < 3 ? stripBox(poly[0] as Vec2, (poly[1] ?? poly[0]) as Vec2, 25) : poly, depth, far) : null;
    }
  }
}

/** What the drawing shows of the element (the same filter `drawing/views.ts` draws by). */
function shownFilter(model: ModelState, view: ViewElement): (el: BimElement) => boolean {
  const names = viewLevelNames(model, view.props?.level, view.props?.levelElevationMm);
  const reached = names ? new Set(otherLevelElementsInRange(model, view).map((el) => el.id)) : null;
  const display = displayResolver(model, displayContextOf(view));
  return (el) => {
    if (!PICKABLE.has(el.kind) && !rowPicks(el.kind)) return false;
    if (names && !names.has((el.partition ?? DEFAULT_PARTITION).level) && !reached?.has(el.id)) return false;
    if (!elementLook(model, view, el).visible) return false;
    return display(el).visible;
  };
}

function overlaps(f: Footprint, w: Rect): boolean {
  return f.max.x >= w.min.x && f.min.x <= w.max.x && f.max.y >= w.min.y && f.min.y <= w.max.y;
}

/** Kept by the view: inside the crop window, and (sections) reaching the strip between the cut and the far clip. */
function kept(f: Footprint, mapping: ViewMapping, window: Rect): boolean {
  if (!overlaps(f, window)) return false;
  if (mapping.kind === "section" && mapping.depthRangeMm !== null) return f.depth >= -mapping.depthRangeMm && f.far <= 0;
  return true;
}

function levelElevations(model: ModelState): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of modelLevels(model)) out.set(el.id, el.elevationMm);
  return out;
}

function addTo(index: { cells: Map<string, Set<string>>; big: Set<string> }, f: Footprint): void {
  const r = cellRange(f);
  if ((r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1) > MAX_CELLS) {
    index.big.add(f.id);
    return;
  }
  for (let i = r.i0; i <= r.i1; i++) {
    for (let j = r.j0; j <= r.j1; j++) {
      const k = cellKey(i, j);
      let set = index.cells.get(k);
      if (!set) index.cells.set(k, (set = new Set()));
      set.add(f.id);
    }
  }
}

function removeFrom(index: { cells: Map<string, Set<string>>; big: Set<string> }, f: Footprint): void {
  if (index.big.delete(f.id)) return;
  const r = cellRange(f);
  for (let i = r.i0; i <= r.i1; i++) for (let j = r.j0; j <= r.j1; j++) index.cells.get(cellKey(i, j))?.delete(f.id);
}

/** Ids whose record differs between two models; null when something changed that every footprint depends on (a level, a part type, groups and phases). */
function affectsAll(el: BimElement | undefined): boolean {
  return el !== undefined && !PICKABLE.has(el.kind) && !INERT.has(el.kind) && !rowPicks(el.kind);
}

function changedIds(before: ModelState["elements"], after: ModelState["elements"]): readonly string[] | null {
  const changed: string[] = [];
  for (const id in after) {
    const el = after[id];
    if (el === before[id]) continue;
    if (affectsAll(el) || affectsAll(before[id])) return null;
    changed.push(id);
  }
  for (const id in before) {
    if (after[id] !== undefined) continue;
    if (affectsAll(before[id])) return null;
    changed.push(id);
  }
  return changed;
}

/**
 * The pick index for a view. Pass the previous index for the same view to
 * update it instead of rebuilding: when the view record is unchanged and the
 * edit touched no level, part type or group/phase record, only the changed
 * elements are re-measured, with no pass over the whole model's levels,
 * partitions or organization (one edit on a very large model touches a handful).
 * The previous index is consumed: its grid is reused in place. A caller that
 * knows which ids an edit touched (a changeset) passes them as `changedHint`
 * and skips the comparison of every record.
 */
export function buildViewPickIndex(model: ModelState, view: ViewElement, previous?: ViewPickIndex | null, changedHint?: readonly string[]): ViewPickIndex {
  if (previous && previous.viewId === view.id && previous.view === view) {
    if (previous.model.elements === model.elements) return { ...previous, model };
    const hinted = changedHint && !changedHint.some((id) => affectsAll(model.elements[id]) || affectsAll(previous.model.elements[id])) ? changedHint : null;
    const changed = previous.cropOn ? (hinted ?? changedIds(previous.model.elements, model.elements)) : null;
    if (changed) {
      // A straight run's footprint stops at the fittings on its ends: a changed fitting re-measures the runs it joins.
      const withLegs = new Set(changed);
      for (const id of changed) {
        for (const el of [model.elements[id], previous.model.elements[id]]) {
          if (el?.kind !== "run_fitting") continue;
          for (const port of el.ports) if (port.link) withLegs.add(port.link.elementId);
        }
      }
      const footprints = previous.footprints;
      const grid = { cells: previous.cells, big: previous.big };
      const build: Build = { model, mapping: previous.mapping, levelZ: previous.levelZ };
      for (const id of withLegs) {
        const old = footprints.get(id);
        if (old) {
          removeFrom(grid, old);
          footprints.delete(id);
        }
        const el = model.elements[id];
        if (!el || !previous.shown(el)) continue;
        const f = footprintOf(build, el);
        if (!f || !kept(f, previous.mapping, previous.window)) continue;
        footprints.set(id, f);
        addTo(grid, f);
      }
      return { ...previous, model, footprints, cells: grid.cells, big: grid.big };
    }
  }
  const mapping = viewMapping(model, view);
  const window = viewCropAndWindow(model, view).window;
  const levelZ = levelElevations(model);
  const cropOn = view.props?.cropView !== false;
  const empty = { viewId: view.id, view, model, mapping, window, levelZ, cropOn };
  if (mapping.kind !== "plan" && mapping.kind !== "section") return { ...empty, shown: () => false, footprints: new Map(), cells: new Map(), big: new Set() };
  const shown = shownFilter(model, view);
  const build: Build = { model, mapping, levelZ };
  const footprints = new Map<string, Footprint>();
  const grid = { cells: new Map<string, Set<string>>(), big: new Set<string>() };
  for (const [id, el] of elementEntries(model.elements)) {
    if (!shown(el)) continue;
    const f = footprintOf(build, el);
    if (!f || !kept(f, mapping, window)) continue;
    footprints.set(id, f);
    addTo(grid, f);
  }
  return { ...empty, shown, footprints, cells: grid.cells, big: grid.big };
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function insideConvex(p: Vec2, poly: readonly Vec2[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Distance from a drawing point to the footprint (0 inside). */
export function footprintDistance(f: Footprint, p: Vec2): number {
  if (f.strip) return Math.max(0, distToSegment(p, f.strip.a, f.strip.b) - f.strip.half);
  if (insideConvex(p, f.poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < f.poly.length; i++) best = Math.min(best, distToSegment(p, f.poly[i] as Vec2, f.poly[(i + 1) % f.poly.length] as Vec2));
  return best;
}

function area(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * Element ids under a drawing point, best first: in front of the background
 * (rooms, grids), then under rather than beside the pointer, then nearest the
 * viewer, then the smallest (a part on a run before the run).
 * `toleranceMm` is in drawing units (screen pixels times the view's mm per pixel).
 */
export function pickAt(index: ViewPickIndex, p: Vec2, toleranceMm: number): string[] {
  const hits: Array<{ f: Footprint; d: number }> = [];
  const seen = new Set<string>();
  const consider = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const f = index.footprints.get(id);
    if (!f) return;
    if (p.x < f.min.x - toleranceMm || p.x > f.max.x + toleranceMm || p.y < f.min.y - toleranceMm || p.y > f.max.y + toleranceMm) return;
    const d = footprintDistance(f, p);
    if (d <= toleranceMm) hits.push({ f, d });
  };
  const i0 = Math.floor((p.x - toleranceMm) / CELL_MM);
  const i1 = Math.floor((p.x + toleranceMm) / CELL_MM);
  const j0 = Math.floor((p.y - toleranceMm) / CELL_MM);
  const j1 = Math.floor((p.y + toleranceMm) / CELL_MM);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const id of index.cells.get(cellKey(i, j)) ?? []) consider(id);
  for (const id of index.big) consider(id);
  hits.sort((a, b) => Number(a.f.background) - Number(b.f.background) || Number(a.d > 0) - Number(b.d > 0) || b.f.depth - a.f.depth || area(a.f.poly) - area(b.f.poly) || a.d - b.d);
  return hits.map((h) => h.f.id);
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function touchesRect(f: Footprint, r: Rect): boolean {
  if (!(f.max.x >= r.min.x && f.min.x <= r.max.x && f.max.y >= r.min.y && f.min.y <= r.max.y)) return false;
  const inR = (q: Vec2) => q.x >= r.min.x && q.x <= r.max.x && q.y >= r.min.y && q.y <= r.max.y;
  if (f.poly.some(inR)) return true;
  const corners = [r.min, { x: r.max.x, y: r.min.y }, r.max, { x: r.min.x, y: r.max.y }];
  if (corners.some((c) => insideConvex(c, f.poly))) return true;
  for (let i = 0; i < f.poly.length; i++) {
    const a = f.poly[i] as Vec2;
    const b = f.poly[(i + 1) % f.poly.length] as Vec2;
    for (let k = 0; k < 4; k++) if (segmentsCross(a, b, corners[k] as Vec2, corners[(k + 1) % 4] as Vec2)) return true;
  }
  return false;
}

/** Window drags left to right (fully inside), crossing right to left (touching), as in the 3D view. */
export function boxModeFor(startX: number, endX: number): BoxMode {
  return endX >= startX ? "window" : "crossing";
}

/** Element ids a box selects, drawing frame. Background kinds (rooms, grids) only when fully inside. */
export function pickInBox(index: ViewPickIndex, a: Vec2, b: Vec2, mode: BoxMode): string[] {
  const r: Rect = { min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } };
  const out: string[] = [];
  for (const f of index.footprints.values()) {
    const inside = f.min.x >= r.min.x && f.max.x <= r.max.x && f.min.y >= r.min.y && f.max.y <= r.max.y;
    if (inside || (mode === "crossing" && !f.background && touchesRect(f, r))) out.push(f.id);
  }
  return out;
}
