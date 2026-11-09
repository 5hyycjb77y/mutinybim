import { registerRevisionCarry } from "../revision-carry";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Vec2 } from "../types";
import { ceilingCovers, ceilingForm, ceilingHeightAtPoint, ceilingRoleId, ceilingSlope, isCeiling } from "./read";
import type { Ceiling, CeilingForm, CeilingSlope } from "./types";

/**
 * Where ceilings are: per level, a plan grid of the cells each outline's box
 * covers (the few too wide to grid listed apart), and the ceilings each space
 * hosts. An ask reads one cell, never every ceiling, and never the model.
 *
 * Built once per element record from the store's kind index (the ceilings,
 * not the model), then carried to each next revision through the revision
 * carry: a revision whose changes touch no ceiling shares the index as it is;
 * one that does copies only the outer maps and the touched level's cells.
 * The index holds ids; every answer reads the record it was asked with.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Plan grid cell, mm (about a 16 ft bay, as the space index uses). */
const GRID_MM = 5000;
/** A ceiling spanning more cells than this sits in its level's wide list (a whole-floor ceiling). */
const MAX_CELLS = 256;

interface LevelCells {
  readonly cells: ReadonlyMap<number, readonly ElementId[]>;
  readonly wide: readonly ElementId[];
}

interface CeilingIndex {
  readonly levels: ReadonlyMap<string, LevelCells>;
  readonly bySpace: ReadonlyMap<string, readonly ElementId[]>;
}

function cellKey(i: number, j: number): number {
  return i * 1_000_003 + j;
}

/** The cells a ceiling's outline box covers, or null when it is too wide to grid. */
function cellsOf(c: Ceiling): number[] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of c.outline) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!Number.isFinite(x0)) return [];
  const i0 = Math.floor(x0 / GRID_MM);
  const i1 = Math.floor(x1 / GRID_MM);
  const j0 = Math.floor(y0 / GRID_MM);
  const j1 = Math.floor(y1 / GRID_MM);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) return null;
  const out: number[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(cellKey(i, j));
  return out;
}

/** Copy-on-write over one index: the revision before keeps its own maps and lists. */
class Builder {
  private readonly levels: Map<string, LevelCells>;
  private readonly bySpace: Map<string, readonly ElementId[]>;
  private readonly ownedLevels = new Map<string, { cells: Map<number, ElementId[]>; wide: ElementId[] }>();
  private readonly ownedSpaces = new Map<string, ElementId[]>();

  constructor(from: CeilingIndex | null) {
    this.levels = new Map(from?.levels ?? []);
    this.bySpace = new Map(from?.bySpace ?? []);
  }

  private level(id: string): { cells: Map<number, ElementId[]>; wide: ElementId[] } {
    let owned = this.ownedLevels.get(id);
    if (!owned) {
      const prior = this.levels.get(id);
      const cells = new Map<number, ElementId[]>();
      for (const [k, ids] of prior?.cells ?? []) cells.set(k, [...ids]);
      owned = { cells, wide: [...(prior?.wide ?? [])] };
      this.ownedLevels.set(id, owned);
      this.levels.set(id, owned);
    }
    return owned;
  }

  private space(id: string): ElementId[] {
    let owned = this.ownedSpaces.get(id);
    if (!owned) {
      owned = [...(this.bySpace.get(id) ?? [])];
      this.ownedSpaces.set(id, owned);
      this.bySpace.set(id, owned);
    }
    return owned;
  }

  add(c: Ceiling): void {
    const lvl = this.level(c.levelId);
    const cells = cellsOf(c);
    if (cells === null) lvl.wide.push(c.id);
    else
      for (const k of cells) {
        const list = lvl.cells.get(k);
        if (list) list.push(c.id);
        else lvl.cells.set(k, [c.id]);
      }
    if (c.spaceId) this.space(c.spaceId).push(c.id);
  }

  remove(c: Ceiling): void {
    const lvl = this.level(c.levelId);
    const cells = cellsOf(c);
    if (cells === null) dropId(lvl.wide, c.id);
    else
      for (const k of cells) {
        const list = lvl.cells.get(k);
        if (!list) continue;
        dropId(list, c.id);
        if (list.length === 0) lvl.cells.delete(k);
      }
    if (c.spaceId) {
      const list = this.space(c.spaceId);
      dropId(list, c.id);
      if (list.length === 0) {
        this.bySpace.delete(c.spaceId);
        this.ownedSpaces.delete(c.spaceId);
      }
    }
  }

  done(): CeilingIndex {
    return { levels: this.levels, bySpace: this.bySpace };
  }
}

function dropId(list: ElementId[], id: ElementId): void {
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
}

const cache = new WeakMap<Elements, CeilingIndex>();
let builds = 0;

function indexOf(elements: Elements): CeilingIndex {
  const hit = cache.get(elements);
  if (hit) return hit;
  builds += 1;
  const b = new Builder(null);
  for (const c of elementsOfKind(elements, "ceiling")) b.add(c);
  const built = b.done();
  cache.set(elements, built);
  return built;
}

registerRevisionCarry("ceilings.index", (from, to, changedIds) => {
  const index = cache.get(from);
  if (!index || cache.has(to)) return;
  let b: Builder | null = null;
  for (const id of changedIds) {
    const before = from[id];
    const after = to[id];
    if (before === after || (!isCeiling(before) && !isCeiling(after))) continue;
    b ??= new Builder(index);
    if (isCeiling(before)) b.remove(before);
    if (isCeiling(after)) b.add(after);
  }
  cache.set(to, b ? b.done() : index);
});

/** What is overhead at a plan point: the ceiling seen from below there, its height and its form. */
export interface CeilingHeightAt {
  /** Height above the level, mm (a sloped plane's height at the point). */
  readonly heightMm: number;
  readonly ceilingId: ElementId;
  readonly form: CeilingForm;
  /** Its surface role id (`SURFACE_ROLE_POINT`); a role this release doesn't know is kept. */
  readonly role: string;
  /** Null for a flat plane. */
  readonly slope: CeilingSlope | null;
}

/** Every ceiling on the level that covers the point, lowest first (a cloud under the room's ceiling comes first). */
export function ceilingsAt(elements: Elements, levelId: ElementId, point: Vec2): CeilingHeightAt[] {
  const lvl = indexOf(elements).levels.get(levelId);
  if (!lvl) return [];
  const out: CeilingHeightAt[] = [];
  const seen = new Set<ElementId>();
  const take = (id: ElementId) => {
    if (seen.has(id)) return;
    seen.add(id);
    const c = elements[id];
    if (!isCeiling(c) || c.levelId !== levelId || !ceilingCovers(c, point)) return;
    out.push({ heightMm: ceilingHeightAtPoint(c, point), ceilingId: c.id, form: ceilingForm(c), role: ceilingRoleId(c), slope: ceilingSlope(c) });
  };
  for (const id of lvl.cells.get(cellKey(Math.floor(point.x / GRID_MM), Math.floor(point.y / GRID_MM))) ?? []) take(id);
  for (const id of lvl.wide) take(id);
  out.sort((a, b) => a.heightMm - b.heightMm || (a.ceilingId < b.ceilingId ? -1 : a.ceilingId > b.ceilingId ? 1 : 0));
  return out;
}

/** The ceiling seen from below at a plan point on a level (the lowest that covers it), or null when none does. */
export function ceilingHeightAt(elements: Elements, levelId: ElementId, point: Vec2): CeilingHeightAt | null {
  return ceilingsAt(elements, levelId, point)[0] ?? null;
}

/** The ceilings a space hosts (those that name it), in the order they were indexed. */
export function ceilingsOfSpace(elements: Elements, spaceId: ElementId): Ceiling[] {
  const ids = indexOf(elements).bySpace.get(spaceId) ?? [];
  const out: Ceiling[] = [];
  for (const id of ids) {
    const c = elements[id];
    if (isCeiling(c)) out.push(c);
  }
  return out;
}

/** The ceilings on a level (from the index; a level's cells hold each ceiling once per cell). */
export function ceilingsOnLevel(elements: Elements, levelId: ElementId): Ceiling[] {
  const lvl = indexOf(elements).levels.get(levelId);
  if (!lvl) return [];
  const ids = new Set<ElementId>(lvl.wide);
  for (const list of lvl.cells.values()) for (const id of list) ids.add(id);
  const out: Ceiling[] = [];
  for (const id of ids) {
    const c = elements[id];
    if (isCeiling(c)) out.push(c);
  }
  return out;
}

/** Test seam: how many times an index was built from scratch (carried revisions don't count). */
export function ceilingIndexBuilds(): number {
  return builds;
}
