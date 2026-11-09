/**
 * @jest-environment node
 *
 * Round 9 P9: the broad-phase grid keeps boxes wider than 16 cells in a
 * coarse grid (not one list every query walks) and its cell lists in typed
 * arrays. Every query must return exactly what the previous grid returned,
 * in the same order (rules emit in query order), over random inserts,
 * moves, removals and queries of every size.
 */
import type { Aabb } from "../src/geometry/convex";
import { UniformGrid } from "../src/spatial/grid";

/** The grid as it was before round 9 (one array per cell, every wide box in one list). */
class PreviousGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly large = new Set<number>();
  private readonly boxes = new Map<number, Aabb>();
  private seen = new Map<number, number>();
  private stamp = 0;

  constructor(readonly cellMm = 609.6) {}

  private cell(v: number): number {
    return Math.floor(v / this.cellMm);
  }

  private key(cx: number, cy: number): number {
    return (cx + 2 ** 20) * 2 ** 21 + (cy + 2 ** 20);
  }

  private eachCell(box: Aabb, fn: (k: number) => void): boolean {
    const x0 = this.cell(box.min.x);
    const y0 = this.cell(box.min.y);
    const x1 = this.cell(box.max.x);
    const y1 = this.cell(box.max.y);
    if (x1 - x0 > 16 || y1 - y0 > 16) return false;
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) fn(this.key(cx, cy));
    return true;
  }

  insert(slot: number, box: Aabb): void {
    if (this.boxes.has(slot)) this.remove(slot);
    this.boxes.set(slot, box);
    const small = this.eachCell(box, (k) => {
      const list = this.cells.get(k);
      if (list) list.push(slot);
      else this.cells.set(k, [slot]);
    });
    if (!small) this.large.add(slot);
  }

  remove(slot: number): void {
    const box = this.boxes.get(slot);
    if (!box) return;
    if (!this.large.delete(slot)) {
      this.eachCell(box, (k) => {
        const list = this.cells.get(k);
        if (!list) return;
        const i = list.indexOf(slot);
        if (i >= 0) {
          list[i] = list[list.length - 1] as number;
          list.pop();
        }
        if (list.length === 0) this.cells.delete(k);
      });
    }
    this.boxes.delete(slot);
  }

  query(q: Aabb): number[] {
    const out: number[] = [];
    this.stamp += 1;
    const hit = (slot: number) => {
      if (this.seen.get(slot) === this.stamp) return;
      this.seen.set(slot, this.stamp);
      const b = this.boxes.get(slot);
      if (b && b.min.x <= q.max.x && b.max.x >= q.min.x && b.min.y <= q.max.y && b.max.y >= q.min.y && b.min.z <= q.max.z && b.max.z >= q.min.z) out.push(slot);
    };
    const x0 = this.cell(q.min.x);
    const x1 = this.cell(q.max.x);
    const y0 = this.cell(q.min.y);
    const y1 = this.cell(q.max.y);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const list of this.cells.values()) for (const s of list) hit(s);
    } else {
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const s of this.cells.get(this.key(cx, cy)) ?? []) hit(s);
    }
    for (const s of this.large) hit(s);
    return out;
  }
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FT = 304.8;

function randomBox(rnd: () => number, span: number): Aabb {
  // Mostly small parts, some rooms and long runs (wider than 16 cells), a few whole-floor slabs (wider than 256 cells).
  const roll = rnd();
  const w = roll < 0.7 ? rnd() * 6 * FT : roll < 0.9 ? (20 + rnd() * 200) * FT : (400 + rnd() * 900) * FT;
  const d = roll < 0.7 ? rnd() * 6 * FT : roll < 0.9 ? rnd() * 60 * FT : (300 + rnd() * 600) * FT;
  const x = (rnd() - 0.3) * span;
  const y = (rnd() - 0.3) * span;
  const z = Math.floor(rnd() * 6) * 14 * FT + rnd() * 10 * FT;
  return { min: { x, y, z }, max: { x: x + w, y: y + d, z: z + rnd() * 4 * FT } };
}

describe("p9-grid-equivalence: the round 9 grid answers exactly as the previous one", () => {
  for (const [seed, cellMm] of [
    [3, 609.6],
    [41, 609.6],
    [977, 3048],
  ] as const) {
    it(`seed ${seed}, ${cellMm} mm cells: 6,000 operations, every query identical and in the same order`, () => {
      const rnd = prng(seed);
      const span = 1500 * FT;
      const next = new UniformGrid(cellMm);
      const prev = new PreviousGrid(cellMm);
      const live: number[] = [];
      let queries = 0;
      let wideHits = 0;
      for (let step = 0; step < 6000; step++) {
        const roll = rnd();
        // Re-packing the cell lists (after a build) changes nothing a query returns.
        if (step % 997 === 500) next.compact();
        if (roll < 0.45 || live.length < 20) {
          const slot = live.length < 3000 && rnd() < 0.8 ? live.length + Math.floor(rnd() * 50) : Math.floor(rnd() * 3200);
          const box = randomBox(rnd, span);
          next.insert(slot, box);
          prev.insert(slot, box);
          if (!live.includes(slot)) live.push(slot);
        } else if (roll < 0.55) {
          const i = Math.floor(rnd() * live.length);
          const slot = live[i] as number;
          next.remove(slot);
          prev.remove(slot);
          live.splice(i, 1);
        } else {
          const size = rnd();
          const q = size < 0.8 ? randomBox(rnd, span) : size < 0.95 ? { min: { x: -span, y: -span, z: -1e12 }, max: { x: 2 * span, y: 2 * span, z: 1e12 } } : (() => {
            const x = (rnd() - 0.3) * span;
            const y = (rnd() - 0.3) * span;
            return { min: { x, y, z: -1e12 }, max: { x, y, z: 1e12 } };
          })();
          const a = next.query(q);
          const b = prev.query(q);
          expect(a).toEqual(b);
          queries += 1;
          if (a.length > 0) wideHits += 1;
        }
        expect(next.size).toBe(live.length);
      }
      expect(queries).toBeGreaterThan(1000);
      expect(wideHits).toBeGreaterThan(100);
    });
  }

  it("a bulk load (an index build) answers exactly as one insert at a time, with removals, re-inserts and queries mid-load", () => {
    const rnd = prng(2026);
    const span = 1200 * FT;
    const next = new UniformGrid();
    const prev = new PreviousGrid();
    const live = new Set<number>();
    for (let round = 0; round < 6; round++) {
      next.beginBulk();
      for (let step = 0; step < 1500; step++) {
        const roll = rnd();
        if (roll < 0.7) {
          const slot = Math.floor(rnd() * 2500);
          const box = randomBox(rnd, span);
          next.insert(slot, box);
          prev.insert(slot, box);
          live.add(slot);
        } else if (roll < 0.85 && live.size > 0) {
          const slot = [...live][Math.floor(rnd() * live.size)] as number;
          next.remove(slot);
          prev.remove(slot);
          live.delete(slot);
        } else if (roll < 0.9) {
          const q = randomBox(rnd, span);
          expect(next.query(q)).toEqual(prev.query(q));
        }
        expect(next.size).toBe(live.size);
      }
      next.endBulk();
      for (let i = 0; i < 300; i++) {
        const q = rnd() < 0.9 ? randomBox(rnd, span) : { min: { x: -span, y: -span, z: -1e12 }, max: { x: 2 * span, y: 2 * span, z: 1e12 } };
        expect(next.query(q)).toEqual(prev.query(q));
      }
      // One at a time again between bulk loads.
      for (let i = 0; i < 200; i++) {
        const slot = Math.floor(rnd() * 2500);
        const box = randomBox(rnd, span);
        next.insert(slot, box);
        prev.insert(slot, box);
        live.add(slot);
      }
    }
  });

  it("a query near a wide box no longer walks every wide box in the model", () => {
    const grid = new UniformGrid();
    const prev = new PreviousGrid();
    // 20,000 rooms, each 40 ft across, in a 200 x 100 plan: every one wider than 16 cells.
    for (let i = 0; i < 20_000; i++) {
      const x = (i % 200) * 40 * FT;
      const y = Math.floor(i / 200) * 40 * FT;
      const box = { min: { x, y, z: 0 }, max: { x: x + 40 * FT, y: y + 40 * FT, z: 3000 } };
      grid.insert(i, box);
      prev.insert(i, box);
    }
    const q = { min: { x: 10 * FT, y: 10 * FT, z: 0 }, max: { x: 12 * FT, y: 12 * FT, z: 3000 } };
    expect(grid.query(q)).toEqual([0]);
    expect(prev.query(q)).toEqual([0]);
    const time = (fn: () => void) => {
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) fn();
      return performance.now() - t0;
    };
    time(() => grid.query(q));
    time(() => prev.query(q));
    // The previous grid visited all 20,000 boxes on every query; a coarse cell holds a handful.
    expect(time(() => grid.query(q)) * 20).toBeLessThan(time(() => prev.query(q)));
  });
});
