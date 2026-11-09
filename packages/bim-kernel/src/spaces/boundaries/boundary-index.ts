import { activePackSet, withPackSet } from "../../packs/scope";
import { packSetReadsRecorded, type PackSet } from "../../packs/set";
import { ratingOf } from "../../registry/rating-kind-point";
import { registerRevisionCarry } from "../../revision-carry";
import { recordsOfKinds } from "../../store";
import type { BimElement, ElementId, Vec2 } from "../../types";
import { boxOf, type Box } from "../space-geometry";
import { BOUNDING_ELEMENT_POINT, boundingElementRow, boundsRooms, type BoundarySegment } from "./rows";

/**
 * Where bounding elements' segments are, per level: a plan grid of their
 * edge pieces, so "the walls near this click" reads a few cells, never a
 * level. Built per level on first read from the bounding kinds (an indexed
 * kind read, not a model scan), then carried revision to revision by the ids
 * each one changed: an element's segments are re-asked only when it, its
 * type or a neighbour it joins changed.
 *
 * One grid per lens: the room-bounding lens (elements that bound rooms) and
 * one rated lens per rating kind (elements rated of that kind, whether or not
 * they bound rooms, so route checks see a rated wall set not to bound rooms).
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Plan grid cell, the same bay as the space index. */
export const BOUNDARY_GRID_MM = 5000;
/** A segment spanning more cells than this sits in its level's wide list (a long diagonal). */
const MAX_CELLS = 256;

/** Which bounding elements a grid holds. */
interface Lens {
  readonly key: string;
  admits(el: BimElement, elements: Elements): boolean;
}

const BOUNDING_LENS: Lens = { key: "bounds_rooms", admits: boundsRooms };

const ratedLenses = new Map<string, Lens>();
function ratedLens(ratingKind: string): Lens {
  let lens = ratedLenses.get(ratingKind);
  if (!lens) {
    lens = { key: `rated:${ratingKind}`, admits: (el, elements) => ratingOf(elements, el, ratingKind) !== null };
    ratedLenses.set(ratingKind, lens);
  }
  return lens;
}

interface LevelBoundary {
  readonly segs: Map<ElementId, readonly BoundarySegment[]>;
  readonly cells: Map<string, Set<ElementId>>;
  readonly cellsOf: Map<ElementId, readonly string[]>;
  readonly wide: Set<ElementId>;
  /** Covers every segment ever placed here; it only grows, so it is a bound, not an exact extent. */
  extent: Box | null;
}

interface BoundaryIndexState {
  bound: Elements;
  readonly set: PackSet;
  readonly lens: Lens;
  readonly kinds: readonly string[];
  readonly levels: Map<ElementId, LevelBoundary>;
  /** A type's id → the bounding elements that take values from it, so a type's room-bounding switch or rating re-asks them. */
  readonly ofType: Map<ElementId, Set<ElementId>>;
  levelBuilds: number;
  advances: number;
}

export interface BoundaryIndexStats {
  /** Levels read from the bounding kinds (once each per index). */
  readonly levelBuilds: number;
  /** Revisions the index moved onto by changed ids. */
  readonly advances: number;
}

const bySet = new WeakMap<PackSet, Map<string, WeakMap<Elements, BoundaryIndexState>>>();
const statesOf = new WeakMap<Elements, Set<BoundaryIndexState>>();

function cellKey(ix: number, iy: number): string {
  return `${ix},${iy}`;
}

function cellsOfBox(box: Box): string[] | null {
  const x0 = Math.floor(box.minX / BOUNDARY_GRID_MM);
  const x1 = Math.floor(box.maxX / BOUNDARY_GRID_MM);
  const y0 = Math.floor(box.minY / BOUNDARY_GRID_MM);
  const y1 = Math.floor(box.maxY / BOUNDARY_GRID_MM);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(cellKey(x, y));
  return out;
}

const finite = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

function lensMap(set: PackSet, lens: Lens): WeakMap<Elements, BoundaryIndexState> {
  let byLens = bySet.get(set);
  if (!byLens) {
    byLens = new Map();
    bySet.set(set, byLens);
  }
  let map = byLens.get(lens.key);
  if (!map) {
    map = new WeakMap();
    byLens.set(lens.key, map);
  }
  return map;
}

function bind(state: BoundaryIndexState, elements: Elements): void {
  statesOf.get(state.bound)?.delete(state);
  const map = lensMap(state.set, state.lens);
  map.delete(state.bound);
  state.bound = elements;
  let held = statesOf.get(elements);
  if (!held) {
    held = new Set();
    statesOf.set(elements, held);
  }
  held.add(state);
  map.set(elements, state);
}

function indexFor(elements: Elements, lens: Lens = BOUNDING_LENS): BoundaryIndexState {
  const set = activePackSet();
  const hit = bySet.get(set)?.get(lens.key)?.get(elements);
  if (hit && hit.bound === elements) return hit;
  const kinds = [...new Set(set.items(BOUNDING_ELEMENT_POINT).map((r) => r.kind))].sort();
  const state: BoundaryIndexState = { bound: elements, set, lens, kinds, levels: new Map(), ofType: new Map(), levelBuilds: 0, advances: 0 };
  bind(state, elements);
  return state;
}

function unplace(level: LevelBoundary, id: ElementId): void {
  level.segs.delete(id);
  level.wide.delete(id);
  for (const c of level.cellsOf.get(id) ?? []) level.cells.get(c)?.delete(id);
  level.cellsOf.delete(id);
}

function noteType(state: BoundaryIndexState, el: BimElement): void {
  const typeId = "typeId" in el && typeof el.typeId === "string" ? (el.typeId as ElementId) : undefined;
  if (typeId === undefined) return;
  let set = state.ofType.get(typeId);
  if (!set) {
    set = new Set();
    state.ofType.set(typeId, set);
  }
  set.add(el.id);
}

/** An element's edge pieces on a level from its bounding row, whatever the lens (empty with no row or off the level). */
function rowSegments(el: BimElement, elements: Elements, levelId: ElementId): BoundarySegment[] {
  const row = boundingElementRow(el.kind);
  if (!row) return [];
  return row.segments(el, elements, levelId).filter((s) => finite(s.start) && finite(s.end) && (s.start.x !== s.end.x || s.start.y !== s.end.y));
}

function place(state: BoundaryIndexState, level: LevelBoundary, levelId: ElementId, elements: Elements, el: BimElement): void {
  unplace(level, el.id);
  if (!boundingElementRow(el.kind) || !state.lens.admits(el, elements)) return;
  const segs = rowSegments(el, elements, levelId);
  if (segs.length === 0) return;
  level.segs.set(el.id, segs);
  const box = boxOf(segs.flatMap((s) => [s.start, s.end]));
  level.extent = level.extent ? { minX: Math.min(level.extent.minX, box.minX), minY: Math.min(level.extent.minY, box.minY), maxX: Math.max(level.extent.maxX, box.maxX), maxY: Math.max(level.extent.maxY, box.maxY) } : box;
  const cells = cellsOfBox(box);
  if (cells === null) {
    level.wide.add(el.id);
    return;
  }
  level.cellsOf.set(el.id, cells);
  for (const c of cells) {
    let ids = level.cells.get(c);
    if (!ids) {
      ids = new Set();
      level.cells.set(c, ids);
    }
    ids.add(el.id);
  }
}

function levelFor(state: BoundaryIndexState, levelId: ElementId): LevelBoundary {
  const held = state.levels.get(levelId);
  if (held) return held;
  const level: LevelBoundary = { segs: new Map(), cells: new Map(), cellsOf: new Map(), wide: new Set(), extent: null };
  state.levels.set(levelId, level);
  state.levelBuilds += 1;
  for (const el of recordsOfKinds(state.bound, state.kinds)) {
    noteType(state, el);
    place(state, level, levelId, state.bound, el);
  }
  return level;
}

/** How far a changed element's neighbours can be and still have their faces re-trimmed by it (a joined end moves at most a wall's width). */
const NEIGHBOUR_MM = 1000;

function segsBox(segs: readonly BoundarySegment[] | undefined): Box | null {
  return segs && segs.length > 0 ? boxOf(segs.flatMap((x) => [x.start, x.end])) : null;
}

function idsNear(level: LevelBoundary, box: Box): Set<ElementId> {
  const out = new Set<ElementId>(level.wide);
  const x0 = Math.floor((box.minX - NEIGHBOUR_MM) / BOUNDARY_GRID_MM);
  const x1 = Math.floor((box.maxX + NEIGHBOUR_MM) / BOUNDARY_GRID_MM);
  const y0 = Math.floor((box.minY - NEIGHBOUR_MM) / BOUNDARY_GRID_MM);
  const y1 = Math.floor((box.maxY + NEIGHBOUR_MM) / BOUNDARY_GRID_MM);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const id of level.cells.get(cellKey(x, y)) ?? []) out.add(id);
  return out;
}

/** Where a changed element was or is on a level: its indexed pieces, else (it isn't in this lens) its row's pieces in that revision. */
function placeBox(state: BoundaryIndexState, level: LevelBoundary, levelId: ElementId, elements: Elements, id: ElementId): Box | null {
  const held = segsBox(level.segs.get(id));
  if (held) return held;
  const el = elements[id];
  return el !== undefined && state.kinds.includes(el.kind) ? segsBox(rowSegments(el, elements, levelId)) : null;
}

function advance(state: BoundaryIndexState, to: Elements, changedIds: readonly string[], counted = true): void {
  if (counted) state.advances += 1;
  const from = state.bound;
  const touched = new Set<ElementId>();
  for (const id of changedIds) {
    touched.add(id as ElementId);
    for (const inst of state.ofType.get(id as ElementId) ?? []) touched.add(inst);
  }
  for (const [levelId, level] of state.levels) {
    // A changed element's neighbours re-trim their faces where they meet it (joins): re-ask every element near its old or new place, even one this lens leaves out.
    const near = new Set<ElementId>();
    for (const id of touched) {
      const before = placeBox(state, level, levelId, from, id);
      const el = to[id];
      if (el !== undefined && state.kinds.includes(el.kind)) {
        noteType(state, el);
        place(state, level, levelId, to, el);
      } else unplace(level, id);
      for (const box of [before, placeBox(state, level, levelId, to, id)]) if (box) for (const n of idsNear(level, box)) near.add(n);
    }
    for (const id of near) {
      if (touched.has(id)) continue;
      const el = to[id];
      if (el !== undefined && state.kinds.includes(el.kind)) place(state, level, levelId, to, el);
      else unplace(level, id);
    }
  }
  bind(state, to);
}

// Each new revision moves every bound index along by the ids it changed, in the pack set it was built under.
registerRevisionCarry("spaces.boundary_index", (from, to, changedIds) => {
  for (const state of [...(statesOf.get(from) ?? [])]) {
    if (state.bound !== from) continue;
    withPackSet(state.set, () => advance(state, to, changedIds));
  }
});

/**
 * Runs `read` with the indexes moved from `previous` to `next` (an edit's
 * working copy, not committed), then moves them back. O(changed) both ways;
 * with no index bound to `previous`, `read` builds what it needs for `next`.
 */
export function withBoundaryIndexAt<T>(previous: Elements, next: Elements, changedIds: readonly string[], read: () => T): T {
  const set = activePackSet();
  const states = previous === next ? [] : [...(statesOf.get(previous) ?? [])].filter((s) => !packSetReadsRecorded() && s.set === set && s.bound === previous);
  if (states.length === 0) return read();
  for (const s of states) advance(s, next, changedIds, false);
  try {
    return read();
  } finally {
    for (const s of states) if (s.bound === next) advance(s, previous, changedIds, false);
  }
}

/** The bounding elements that take values from a type, as far as the index has read them (levels it has built). */
export function boundingInstancesOfType(elements: Elements, typeId: ElementId): readonly ElementId[] {
  return [...(indexFor(elements).ofType.get(typeId) ?? [])];
}

// ---------------------------------------------------------------- reads

function byElementId(a: BoundarySegment, b: BoundarySegment): number {
  return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
}

function segmentsNear(level: LevelBoundary, box: Box): BoundarySegment[] {
  const ids = new Set<ElementId>(level.wide);
  const x0 = Math.floor(box.minX / BOUNDARY_GRID_MM);
  const x1 = Math.floor(box.maxX / BOUNDARY_GRID_MM);
  const y0 = Math.floor(box.minY / BOUNDARY_GRID_MM);
  const y1 = Math.floor(box.maxY / BOUNDARY_GRID_MM);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const id of level.cells.get(cellKey(x, y)) ?? []) ids.add(id);
  return [...ids].flatMap((id) => level.segs.get(id) ?? []).sort(byElementId);
}

/** Every room-bounding segment on a level, by element id. */
export function boundarySegmentsOfLevel(elements: Elements, levelId: ElementId): BoundarySegment[] {
  const level = levelFor(indexFor(elements), levelId);
  return [...level.segs.values()].flat().sort(byElementId);
}

/** The room-bounding segments of every element whose cells meet `box` on a level (plus the level's wide ones). */
export function boundarySegmentsNear(elements: Elements, levelId: ElementId, box: Box): BoundarySegment[] {
  return segmentsNear(levelFor(indexFor(elements), levelId), box);
}

/** The segments of every element rated of `ratingKind` (room-bounding or not) whose cells meet `box` on a level. */
export function ratedSegmentsNearIn(elements: Elements, levelId: ElementId, box: Box, ratingKind: string): BoundarySegment[] {
  return segmentsNear(levelFor(indexFor(elements, ratedLens(ratingKind)), levelId), box);
}

/** Every segment on a level of the elements rated of `ratingKind` (room-bounding or not), by element id. */
export function ratedSegmentsOfLevel(elements: Elements, levelId: ElementId, ratingKind: string): BoundarySegment[] {
  const level = levelFor(indexFor(elements, ratedLens(ratingKind)), levelId);
  return [...level.segs.values()].flat().sort(byElementId);
}

/** A box holding every room-bounding segment on the level (a bound: it never shrinks), or null when none bounds there. */
export function boundaryExtent(elements: Elements, levelId: ElementId): Box | null {
  return levelFor(indexFor(elements), levelId).extent;
}

export function boundaryIndexStats(elements: Elements): BoundaryIndexStats {
  const s = indexFor(elements);
  return { levelBuilds: s.levelBuilds, advances: s.advances };
}

export function ratedIndexStats(elements: Elements, ratingKind: string): BoundaryIndexStats {
  const s = indexFor(elements, ratedLens(ratingKind));
  return { levelBuilds: s.levelBuilds, advances: s.advances };
}
