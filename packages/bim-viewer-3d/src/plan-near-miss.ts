import type { Solid } from "./native-geometry";

/**
 * Plan only, after every pick ray missed: the element whose footprint lies
 * within the tolerance of the pointer. The rays are a few pixels apart, so a
 * receptacle or panel that draws under a pixel at a far zoom fell between them
 * and could not be hovered, selected or given its "+" grip (electrical-ws-c,
 * Nov 2026). The nearest footprint wins; on a tie, the smaller one (a device on
 * a wall before the wall).
 *
 * Hover is a hot path, so footprints live in a plan grid: `sync` files each
 * element's solids by the cells their footprint covers when the viewer draws
 * a model revision (only what changed moves), and `nearMiss` reads only the
 * cells within reach of the pointer. Boxes and cylinders only: mesh bodies
 * (walls, doors, fittings) are wider than the ray spacing.
 */

/** Cell size, scene metres: a few receptacles across, a long duct a handful of cells. */
const CELL_M = 2;
/** A footprint covering more cells than this (a slab, a site boundary) is listed apart and always checked. */
const MAX_CELLS = 1024;

interface Entry {
  readonly solid: Solid;
  readonly hx: number;
  readonly hz: number;
  readonly cells: readonly number[] | null;
}

export interface NearMissAnswer {
  readonly hit: Solid | null;
  /** Footprints scored for this answer (tests and the perf script read it). */
  readonly examined: number;
}

export class PlanFootprintGrid {
  private readonly cells = new Map<number, Set<Entry>>();
  private readonly wide = new Set<Entry>();
  private byId = new Map<string, readonly Entry[]>();
  private solidsOf = new Map<string, readonly Solid[]>();

  /** Bring the grid to the viewer's solids for this revision: an element whose solids are unchanged is not touched. */
  sync(solidsById: ReadonlyMap<string, readonly Solid[]>): void {
    const knownBefore = this.solidsOf.size;
    let stillThere = 0;
    for (const [id, solids] of solidsById) {
      const before = this.solidsOf.get(id);
      if (before) stillThere++;
      if (before && sameSolids(before, solids)) continue;
      for (const e of this.byId.get(id) ?? []) this.remove(e);
      const entries: Entry[] = [];
      for (const s of solids) {
        const e = this.entryOf(s);
        if (e) entries.push(e);
      }
      if (entries.length > 0) this.byId.set(id, entries);
      else this.byId.delete(id);
      this.solidsOf.set(id, solids);
    }
    // Something drawn before is gone only when fewer known elements came back; usually nothing was deleted and this is skipped.
    if (stillThere === knownBefore) return;
    for (const id of [...this.solidsOf.keys()]) {
      if (solidsById.has(id)) continue;
      for (const e of this.byId.get(id) ?? []) this.remove(e);
      this.byId.delete(id);
      this.solidsOf.delete(id);
    }
  }

  /** The nearest footprint within `toleranceM` of `at` that `keep` accepts, scoring only the cells within reach. */
  nearMiss(at: { readonly x: number; readonly z: number }, toleranceM: number, keep: (s: Solid) => boolean): NearMissAnswer {
    const best: { entry: Entry | null; distance: number; area: number } = { entry: null, distance: Infinity, area: Infinity };
    let examined = 0;
    const seen = new Set<Entry>();
    const score = (e: Entry) => {
      if (seen.has(e)) return;
      seen.add(e);
      examined++;
      const d = distanceTo(e, at);
      if (d > toleranceM) return;
      const area = e.hx * e.hz;
      if (d > best.distance || (d === best.distance && area >= best.area)) return;
      if (!keep(e.solid)) return;
      best.entry = e;
      best.distance = d;
      best.area = area;
    };
    const i0 = Math.floor((at.x - toleranceM) / CELL_M);
    const i1 = Math.floor((at.x + toleranceM) / CELL_M);
    const j0 = Math.floor((at.z - toleranceM) / CELL_M);
    const j1 = Math.floor((at.z + toleranceM) / CELL_M);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = this.cells.get(cellKey(i, j));
        if (cell) for (const e of cell) score(e);
      }
    }
    for (const e of this.wide) score(e);
    return { hit: best.entry ? best.entry.solid : null, examined };
  }

  private entryOf(s: Solid): Entry | null {
    if (s.shape === "mesh") return null;
    const [hx, hz] = halfFootprint(s);
    // The footprint's box in scene x / z, turned by yaw.
    const c = Math.abs(Math.cos(s.yaw));
    const n = Math.abs(Math.sin(s.yaw));
    const ex = c * hx + n * hz;
    const ez = n * hx + c * hz;
    const i0 = Math.floor((s.center[0] - ex) / CELL_M);
    const i1 = Math.floor((s.center[0] + ex) / CELL_M);
    const j0 = Math.floor((s.center[2] - ez) / CELL_M);
    const j1 = Math.floor((s.center[2] + ez) / CELL_M);
    if (![i0, i1, j0, j1].every(Number.isFinite)) return null;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) {
      const e: Entry = { solid: s, hx, hz, cells: null };
      this.wide.add(e);
      return e;
    }
    const keys: number[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) keys.push(cellKey(i, j));
    const e: Entry = { solid: s, hx, hz, cells: keys };
    for (const k of keys) {
      const cell = this.cells.get(k);
      if (cell) cell.add(e);
      else this.cells.set(k, new Set([e]));
    }
    return e;
  }

  private remove(e: Entry): void {
    if (e.cells === null) {
      this.wide.delete(e);
      return;
    }
    for (const k of e.cells) {
      const cell = this.cells.get(k);
      if (!cell) continue;
      cell.delete(e);
      if (cell.size === 0) this.cells.delete(k);
    }
  }
}

/** Distance from `at` to the footprint, measured along the solid's own axes (the inverse of the yaw box-select uses). */
function distanceTo(e: Entry, at: { readonly x: number; readonly z: number }): number {
  const s = e.solid;
  const dx = at.x - s.center[0];
  const dz = at.z - s.center[2];
  const c = Math.cos(s.yaw);
  const n = Math.sin(s.yaw);
  const lx = dx * c - dz * n;
  const lz = dx * n + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - e.hx, 0), Math.max(Math.abs(lz) - e.hz, 0));
}

/** Half length along local X and half depth along local Z, as seen from above. */
function halfFootprint(s: Solid): [number, number] {
  if (s.shape === "box") return [s.size[0] / 2, s.size[2] / 2];
  // Cylinders: standing ones show their diameter both ways; lying ones their length by their diameter.
  return s.vertical ? [s.size[1] / 2, s.size[1] / 2] : [s.size[0] / 2, s.size[1] / 2];
}

function sameSolids(a: readonly Solid[], b: readonly Solid[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (!x || !y) return false;
    if (x.version !== y.version || x.shape !== y.shape || x.group !== y.group || x.yaw !== y.yaw || x.vertical !== y.vertical) return false;
    if (x.center[0] !== y.center[0] || x.center[1] !== y.center[1] || x.center[2] !== y.center[2]) return false;
    if (x.size[0] !== y.size[0] || x.size[1] !== y.size[1] || x.size[2] !== y.size[2]) return false;
  }
  return true;
}

function cellKey(i: number, j: number): number {
  return i * 1_000_003 + j;
}
