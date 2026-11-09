import type { Aabb } from "../geometry/convex";

/**
 * Broad phase: a uniform plan grid (2 ft cells by default) over axis-aligned
 * boxes. A box spanning more than 16 cells either way goes in a second grid
 * of 16-times-coarser cells, and only a box wider than that in one plain
 * list. A query returns every item whose box meets the query box. Items are
 * small integers (slots) the caller maps to its own records.
 *
 * Boxes live in one Float64Array (six numbers a slot) and a slot's cells are
 * recomputed from its box on removal. Each grid's cell lists share one
 * Int32Array, so a 1M-item index holds a few small maps on the heap rather
 * than an array per cell.
 *
 * Height is not hashed: buildings are wide and short, so a plan cell rarely
 * holds more than a few dozen boxes, and the z test is one comparison.
 *
 * A query lists the fine grid's items in cell order, then every larger item
 * in the order it was inserted.
 */

const OFFSET = 2 ** 20;
const SPAN = 2 ** 21;
/** Boxes spanning more than this many cells either way go to the next, coarser level. */
const LARGE_CELLS = 16;

function cellKey(cx: number, cy: number): number {
  return (cx + OFFSET) * SPAN + (cy + OFFSET);
}

/**
 * Cell key → list of slots, every list a block of one shared Int32Array.
 * A full block moves to a larger one and the old one goes on a free list by
 * size (kept inside the freed blocks themselves); `compact` re-packs every
 * list with a little room to grow. Order within a cell is the order slots
 * were added, except that a removal moves the cell's last slot into the gap.
 */
class CellLists {
  /** Cell key → cell number, in the order cells were first filled. */
  private readonly cellOf = new Map<number, number>();
  private start = new Int32Array(256);
  private length = new Int32Array(256);
  private capacity = new Int32Array(256);
  private freeCells = new Int32Array(256);
  private freeCellCount = 0;
  private nextCell = 0;
  private arena = new Int32Array(1 << 14);
  private top = 0;
  /** Slots listed, over every cell. */
  private entries = 0;
  /** Head of each size class's free list (-1: none): class k holds blocks of at least 2^k entries; a free block's first entry is the next one. */
  private readonly freeHead = new Int32Array(32).fill(-1);

  get size(): number {
    return this.cellOf.size;
  }

  private newCell(): number {
    if (this.freeCellCount > 0) {
      this.freeCellCount -= 1;
      return this.freeCells[this.freeCellCount] as number;
    }
    const c = this.nextCell++;
    if (c >= this.start.length) {
      const n = this.start.length * 2;
      const grow32 = (a: Int32Array) => {
        const b = new Int32Array(n);
        b.set(a);
        return b;
      };
      this.start = grow32(this.start);
      this.length = grow32(this.length);
      this.capacity = grow32(this.capacity);
      this.freeCells = grow32(this.freeCells);
    }
    return c;
  }

  /** A block of 2^log entries (from the free list, else the top of the arena). */
  private allocBlock(log: number): number {
    const head = this.freeHead[log] as number;
    if (head >= 0) {
      this.freeHead[log] = this.arena[head] as number;
      return head;
    }
    const size = 1 << log;
    if (this.top + size > this.arena.length) {
      if (this.top > 2 * this.entries + (1 << 20)) {
        // Mostly freed blocks: re-pack instead of growing.
        this.compact();
        return this.allocBlock(log);
      }
      let n = Math.ceil(this.arena.length * 1.5);
      while (this.top + size > n) n = Math.ceil(n * 1.5);
      const a = new Int32Array(n);
      a.set(this.arena.subarray(0, this.top));
      this.arena = a;
    }
    const at = this.top;
    this.top += size;
    return at;
  }

  private freeBlock(at: number, capacity: number): void {
    if (capacity < 1) return;
    const log = 31 - Math.clz32(capacity);
    this.arena[at] = this.freeHead[log] as number;
    this.freeHead[log] = at;
  }

  add(key: number, slot: number): void {
    let c = this.cellOf.get(key);
    if (c === undefined) {
      c = this.newCell();
      this.cellOf.set(key, c);
      this.start[c] = this.allocBlock(1);
      this.capacity[c] = 2;
      this.length[c] = 0;
    }
    const n = this.length[c] as number;
    if (n === this.capacity[c]) {
      const log = 32 - Math.clz32(n);
      const at = this.allocBlock(log);
      const from = this.start[c] as number;
      this.arena.copyWithin(at, from, from + n);
      this.freeBlock(from, n);
      this.start[c] = at;
      this.capacity[c] = 1 << log;
    }
    this.arena[(this.start[c] as number) + n] = slot;
    this.length[c] = n + 1;
    this.entries += 1;
  }

  remove(key: number, slot: number): void {
    const c = this.cellOf.get(key);
    if (c === undefined) return;
    const at = this.start[c] as number;
    const n = this.length[c] as number;
    for (let i = 0; i < n; i++) {
      if (this.arena[at + i] !== slot) continue;
      this.arena[at + i] = this.arena[at + n - 1] as number;
      this.length[c] = n - 1;
      this.entries -= 1;
      break;
    }
    if ((this.length[c] as number) > 0) return;
    this.freeBlock(at, this.capacity[c] as number);
    this.cellOf.delete(key);
    this.freeCells[this.freeCellCount++] = c;
  }

  /** Room a laid-out list gets to grow into: a quarter of its length, and one. */
  private static room(n: number): number {
    return n + (n >> 2) + 1;
  }

  /**
   * Queue `slot` for the cell, to be appended by `commitStaged` (a bulk load).
   * Staged slots land after the cell's current ones, in the order staged:
   * exactly where `add` would have put them.
   */
  stage(key: number, slot: number): void {
    let c = this.cellOf.get(key);
    if (c === undefined) {
      c = this.newCell();
      this.cellOf.set(key, c);
      this.start[c] = 0;
      this.capacity[c] = 0;
      this.length[c] = 0;
    }
    if (c >= this.extra.length) {
      const e = new Int32Array(Math.max(this.start.length, c + 1));
      e.set(this.extra);
      this.extra = e;
    }
    this.extra[c] = (this.extra[c] as number) + 1;
    if (this.stagedCount === this.stagedCell.length) {
      const n = this.stagedCell.length * 2;
      const cells = new Int32Array(n);
      cells.set(this.stagedCell);
      this.stagedCell = cells;
      const slots = new Int32Array(n);
      slots.set(this.stagedSlot);
      this.stagedSlot = slots;
    }
    this.stagedCell[this.stagedCount] = c;
    this.stagedSlot[this.stagedCount] = slot;
    this.stagedCount += 1;
  }

  private extra = new Int32Array(0);
  private stagedCell = new Int32Array(1024);
  private stagedSlot = new Int32Array(1024);
  private stagedCount = 0;

  /** Lay every list out again in one arena (with room to grow), then append the staged slots. Nothing a query returns changes beyond the staged slots. */
  commitStaged(): void {
    let total = 0;
    for (const c of this.cellOf.values()) total += CellLists.room((this.length[c] as number) + ((this.extra[c] as number) | 0));
    const arena = new Int32Array(total + (total >> 4) + 1024);
    let top = 0;
    for (const c of this.cellOf.values()) {
      const n = this.length[c] as number;
      const from = this.start[c] as number;
      if (n > 0) arena.set(this.arena.subarray(from, from + n), top);
      this.start[c] = top;
      this.capacity[c] = CellLists.room(n + ((this.extra[c] as number) | 0));
      top += this.capacity[c] as number;
    }
    for (let i = 0; i < this.stagedCount; i++) {
      const c = this.stagedCell[i] as number;
      const n = this.length[c] as number;
      arena[(this.start[c] as number) + n] = this.stagedSlot[i] as number;
      this.length[c] = n + 1;
    }
    this.entries += this.stagedCount;
    this.arena = arena;
    this.top = top;
    this.freeHead.fill(-1);
    this.extra = new Int32Array(0);
    this.stagedCell = new Int32Array(1024);
    this.stagedSlot = new Int32Array(1024);
    this.stagedCount = 0;
  }

  /** Re-pack every list in one arena with room to grow; nothing a query returns changes. */
  compact(): void {
    this.commitStaged();
  }

  /** Calls `hit` with every slot listed in the cell. */
  each(key: number, hit: (slot: number) => void): void {
    const c = this.cellOf.get(key);
    if (c === undefined) return;
    const arena = this.arena;
    const at = this.start[c] as number;
    const end = at + (this.length[c] as number);
    for (let i = at; i < end; i++) hit(arena[i] as number);
  }

  /** Every cell's slots, cells in the order they were first filled. */
  eachAll(hit: (slot: number) => void): void {
    const arena = this.arena;
    for (const c of this.cellOf.values()) {
      const at = this.start[c] as number;
      const end = at + (this.length[c] as number);
      for (let i = at; i < end; i++) hit(arena[i] as number);
    }
  }
}

export class UniformGrid {
  private readonly cells = new CellLists();
  /** Boxes too wide for the fine cells: 16-times-coarser cells. */
  private readonly coarse = new CellLists();
  /** Boxes too wide for the coarse cells too. */
  private readonly huge = new Set<number>();
  private readonly coarseMm: number;
  private boxes = new Float64Array(6 * 1024);
  private present = new Uint8Array(1024);
  /** 0: fine cells, 1: coarse cells, 2: the huge list. */
  private levelOf = new Uint8Array(1024);
  /** When a larger box was inserted: queries list larger boxes in this order. */
  private insertedAt = new Uint32Array(1024);
  private inserted = 0;
  private count = 0;
  private seen = new Uint32Array(1024);
  private stamp = 0;
  /** Between beginBulk and endBulk: inserts are staged per cell and laid out together at the end. */
  private bulk = false;
  /** Slots staged in this bulk load and not yet laid out (1). */
  private staged = new Uint8Array(1024);
  private stagedCount = 0;

  constructor(readonly cellMm = 609.6) {
    this.coarseMm = cellMm * LARGE_CELLS;
  }

  private ensure(slot: number): void {
    if (slot < this.present.length) return;
    let n = this.present.length;
    while (n <= slot) n *= 2;
    const boxes = new Float64Array(6 * n);
    boxes.set(this.boxes);
    this.boxes = boxes;
    const grow8 = (a: Uint8Array) => {
      const b = new Uint8Array(n);
      b.set(a);
      return b;
    };
    this.present = grow8(this.present);
    this.levelOf = grow8(this.levelOf);
    const at = new Uint32Array(n);
    at.set(this.insertedAt);
    this.insertedAt = at;
    const seen = new Uint32Array(n);
    seen.set(this.seen);
    this.seen = seen;
    const st = new Uint8Array(n);
    st.set(this.staged);
    this.staged = st;
  }

  /**
   * Start a bulk load (an index build): inserts are staged per cell and
   * `endBulk` lays them out in one arena per grid. Queries, removals and
   * boxes still answer exactly as if each insert had landed.
   */
  beginBulk(): void {
    this.bulk = true;
  }

  /** Lay out every staged insert (and re-pack the cell lists); back to one insert at a time. */
  endBulk(): void {
    if (!this.bulk) return;
    this.flush();
    this.bulk = false;
  }

  /** Lay out the slots staged so far (both grids' cell lists, re-packed). */
  private flush(): void {
    this.cells.commitStaged();
    this.coarse.commitStaged();
    if (this.stagedCount > 0) {
      this.staged.fill(0);
      this.stagedCount = 0;
    }
  }

  get size(): number {
    return this.count;
  }

  has(slot: number): boolean {
    return slot < this.present.length && this.present[slot] === 1;
  }

  /** The slot's box (a new object), or undefined. */
  box(slot: number): Aabb | undefined {
    if (!this.has(slot)) return undefined;
    const b = this.boxes;
    const o = slot * 6;
    return { min: { x: b[o] as number, y: b[o + 1] as number, z: b[o + 2] as number }, max: { x: b[o + 3] as number, y: b[o + 4] as number, z: b[o + 5] as number } };
  }

  /** Distance from the slot's box to `box` (0 when they meet), read in place. */
  distanceTo(slot: number, box: Aabb): number {
    const b = this.boxes;
    const o = slot * 6;
    const dx = Math.max(0, box.min.x - (b[o + 3] as number), (b[o] as number) - box.max.x);
    const dy = Math.max(0, box.min.y - (b[o + 4] as number), (b[o + 1] as number) - box.max.y);
    const dz = Math.max(0, box.min.z - (b[o + 5] as number), (b[o + 2] as number) - box.max.z);
    return Math.hypot(dx, dy, dz);
  }

  /** The plan centre of the slot's box, read in place. */
  centreX(slot: number): number {
    const o = slot * 6;
    return ((this.boxes[o] as number) + (this.boxes[o + 3] as number)) / 2;
  }

  centreY(slot: number): number {
    const o = slot * 6;
    return ((this.boxes[o + 1] as number) + (this.boxes[o + 4] as number)) / 2;
  }

  /** Cell keys of the slot's box at a cell size, or false when it spans more than LARGE_CELLS either way. */
  private eachCell(slot: number, size: number, fn: (k: number) => void): boolean {
    const b = this.boxes;
    const o = slot * 6;
    const x0 = Math.floor((b[o] as number) / size);
    const y0 = Math.floor((b[o + 1] as number) / size);
    const x1 = Math.floor((b[o + 3] as number) / size);
    const y1 = Math.floor((b[o + 4] as number) / size);
    if (x1 - x0 > LARGE_CELLS || y1 - y0 > LARGE_CELLS) return false;
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) fn(cellKey(cx, cy));
    return true;
  }

  insert(slot: number, box: Aabb): void {
    if (this.has(slot)) this.remove(slot);
    this.ensure(slot);
    const o = slot * 6;
    this.boxes[o] = box.min.x;
    this.boxes[o + 1] = box.min.y;
    this.boxes[o + 2] = box.min.z;
    this.boxes[o + 3] = box.max.x;
    this.boxes[o + 4] = box.max.y;
    this.boxes[o + 5] = box.max.z;
    this.present[slot] = 1;
    this.count += 1;
    this.place(slot, this.bulk);
    // The huge list takes a slot at once; cell lists take it when the load is laid out.
    if (this.bulk && this.levelOf[slot] !== 2) {
      this.staged[slot] = 1;
      this.stagedCount += 1;
    }
  }

  /** File a present slot's box in its level: fine cells, coarse cells or the huge list. */
  private place(slot: number, staged: boolean): void {
    const cells = this.cells;
    const coarse = this.coarse;
    if (this.eachCell(slot, this.cellMm, staged ? (k) => cells.stage(k, slot) : (k) => cells.add(k, slot))) {
      this.levelOf[slot] = 0;
      return;
    }
    if (this.inserted === 0xffffffff) this.renumber();
    this.insertedAt[slot] = this.inserted++;
    if (this.eachCell(slot, this.coarseMm, staged ? (k) => coarse.stage(k, slot) : (k) => coarse.add(k, slot))) {
      this.levelOf[slot] = 1;
      return;
    }
    this.levelOf[slot] = 2;
    this.huge.add(slot);
  }

  /** Insertion numbers ran out: number the larger boxes again from 0, in the same order. */
  private renumber(): void {
    const larger: number[] = [];
    for (let s = 0; s < this.present.length; s++) if (this.present[s] === 1 && this.levelOf[s] !== 0) larger.push(s);
    larger.sort((a, b) => (this.insertedAt[a] as number) - (this.insertedAt[b] as number));
    larger.forEach((s, i) => {
      this.insertedAt[s] = i;
    });
    this.inserted = larger.length;
  }

  /** Re-pack the cell lists: the same answers in less memory. */
  compact(): void {
    if (this.bulk && this.stagedCount > 0) this.flush();
    this.cells.compact();
    this.coarse.compact();
  }

  remove(slot: number): void {
    if (!this.has(slot)) return;
    // A slot leaves its cells by swapping the cell's last slot in: staged slots must be in place first.
    if (this.bulk && this.stagedCount > 0) this.flush();
    const level = this.levelOf[slot];
    if (level === 0) this.eachCell(slot, this.cellMm, (k) => this.cells.remove(k, slot));
    else if (level === 1) this.eachCell(slot, this.coarseMm, (k) => this.coarse.remove(k, slot));
    else this.huge.delete(slot);
    this.present[slot] = 0;
    this.count -= 1;
  }

  /** Slots whose box meets `q`, each once: fine-cell boxes in cell order, then larger ones in insertion order. */
  query(q: Aabb, out: number[] = []): number[] {
    if (this.bulk && this.stagedCount > 0) this.flush();
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const b = this.boxes;
    const hit = (slot: number) => {
      if (this.seen[slot] === stamp) return;
      this.seen[slot] = stamp;
      if (this.present[slot] !== 1) return;
      const o = slot * 6;
      if ((b[o] as number) <= q.max.x && (b[o + 3] as number) >= q.min.x && (b[o + 1] as number) <= q.max.y && (b[o + 4] as number) >= q.min.y && (b[o + 2] as number) <= q.max.z && (b[o + 5] as number) >= q.min.z) out.push(slot);
    };
    this.walk(this.cells, this.cellMm, q, hit);
    const first = out.length;
    this.walk(this.coarse, this.coarseMm, q, hit);
    for (const s of this.huge) hit(s);
    if (out.length - first > 1) {
      const at = this.insertedAt;
      const larger = out.slice(first).sort((x, y) => (at[x] as number) - (at[y] as number));
      for (let i = 0; i < larger.length; i++) out[first + i] = larger[i] as number;
    }
    return out;
  }

  private walk(lists: CellLists, size: number, q: Aabb, hit: (slot: number) => void): void {
    if (lists.size === 0) return;
    const x0 = Math.floor(q.min.x / size);
    const x1 = Math.floor(q.max.x / size);
    const y0 = Math.floor(q.min.y / size);
    const y1 = Math.floor(q.max.y / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > lists.size) {
      lists.eachAll(hit);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) lists.each(cellKey(cx, cy), hit);
  }
}
