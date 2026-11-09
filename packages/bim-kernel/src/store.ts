import type { BimElement } from "./types";
import { shareElementKind } from "./kind-share";

/**
 * Copy-on-write element records with structural sharing.
 *
 * `ModelState.elements` stays a plain-looking record at every boundary
 * (property reads, `in`, `Object.keys/values/entries`, spread,
 * `JSON.stringify`, key order), but each revision shares every unchanged
 * chunk of elements with the revision it came from. A commit on a
 * million-element model copies the few chunks it touched instead of the
 * whole record.
 *
 * Layout: each id gets a slot in key order; values live in fixed-size chunks
 * indexed by slot. Revisions with the same keys share one slot table, and a
 * chunk is copied only when one of its elements changes. A removed element
 * leaves a hole in its slot, so a delete copies only its chunk too.
 *
 * Sibling revisions (two predictions over the same head, a refused attempt
 * and the one that wins, every step of a batch after a preview) all append
 * to the one slot table: a revision's own new ids take slots after its last
 * live slot, and the slots between that other revisions appended are holes
 * here. An id keeps its slot in every revision that holds it, so the same
 * edit predicted twice lands in the same slots. A new key that cannot keep
 * key order that way (an id whose slot comes before one this revision just
 * placed; a live id removed and put back) forks the table: a copy of the key
 * prefix over the same chunks, where the id takes a new slot. Integer-like
 * ids, and a record more than an eighth holes, rebuild it.
 *
 * Constraints: a plain record handed to the kernel is indexed once and cached
 * by identity, so it must not be mutated afterwards (the topology index
 * already relied on this). Proxies cannot be structured-cloned: anything sent
 * through `structuredClone` / `postMessage` takes `plainElements()` first;
 * JSON needs nothing.
 */

const CHUNK_BITS = 10;
const CHUNK = 1 << CHUNK_BITS;
const MASK = CHUNK - 1;

type Elements = Record<string, BimElement>;

/**
 * Id → slot of one slot table. A root table owns one map. A fork (a revision
 * that had to put an id somewhere other than the slot its table gave it) reads
 * the map it forked from below `cut` and keeps the ids it appended or moved in
 * a small map of its own, so forking costs the key prefix, not a new map.
 */
class SlotIndex implements ReadonlyMap<string, number> {
  constructor(
    private readonly base: Map<string, number>,
    private readonly cut: number,
    /** `base` itself for a root table. */
    private readonly own: Map<string, number>,
    private readonly ids: readonly string[],
  ) {}

  static root(map: Map<string, number>, ids: readonly string[]): SlotIndex {
    return new SlotIndex(map, Number.POSITIVE_INFINITY, map, ids);
  }

  /** The index of a table holding this one's first `cut` slots, for `ids` (that prefix of this one's keys). */
  fork(cut: number, ids: readonly string[]): SlotIndex {
    const own = new Map<string, number>();
    if (this.own !== this.base) for (const [id, s] of this.own) if (s < cut) own.set(id, s);
    // Ids a fork moved accumulate; past a quarter of the table, one flat map again.
    if (own.size > Math.max(16 * CHUNK, cut >> 2)) {
      const flat = new Map<string, number>();
      for (let s = 0; s < cut; s++) {
        const id = ids[s];
        if (id !== undefined && this.get(id) === s) flat.set(id, s);
      }
      return SlotIndex.root(flat, ids);
    }
    return new SlotIndex(this.base, Math.min(cut, this.cut), own, ids);
  }

  get(id: string): number | undefined {
    const s = this.own.get(id);
    if (s !== undefined || this.own === this.base) return s;
    const b = this.base.get(id);
    return b !== undefined && b < this.cut ? b : undefined;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  set(id: string, slot: number): void {
    this.own.set(id, slot);
  }

  get size(): number {
    if (this.own === this.base) return this.own.size;
    let n = 0;
    for (const _ of this.entries()) n += 1;
    return n;
  }

  *entries(): MapIterator<[string, number]> {
    if (this.own === this.base) {
      yield* this.own.entries();
      return;
    }
    for (let s = 0; s < this.ids.length; s++) {
      const id = this.ids[s];
      if (id !== undefined && this.get(id) === s) yield [id, s];
    }
  }

  *keys(): MapIterator<string> {
    for (const [id] of this.entries()) yield id;
  }

  *values(): MapIterator<number> {
    for (const [, s] of this.entries()) yield s;
  }

  [Symbol.iterator](): MapIterator<[string, number]> {
    return this.entries();
  }

  forEach(callback: (value: number, key: string, map: ReadonlyMap<string, number>) => void): void {
    for (const [id, s] of this.entries()) callback(s, id, this);
  }
}

/** Shared by every revision with the same key prefix; only ever appended to. */
interface SlotTable {
  readonly slotOf: SlotIndex;
  readonly keys: string[];
}

/** A new table holding `table`'s first `cut` slots, the same ids in the same slots. */
function forkTable(table: SlotTable, cut: number): SlotTable {
  const keys = table.keys.slice(0, cut);
  return { slotOf: table.slotOf.fork(cut, keys), keys };
}

class ElementStore {
  private liveKeys: readonly string[] | null = null;

  constructor(
    readonly table: SlotTable,
    /** Keys of `table` this revision has; later revisions may have appended more. */
    readonly size: number,
    readonly chunks: Array<Array<BimElement | undefined>>,
    /** Slots below `size` with no element here: removed, or appended by a sibling revision. */
    readonly holes = 0,
    /** No slot at or above this holds one of this revision's elements (an upper bound). */
    readonly liveEnd = size,
  ) {}

  slot(id: string): number | undefined {
    const s = this.table.slotOf.get(id);
    return s !== undefined && s < this.size ? s : undefined;
  }

  get(id: string): BimElement | undefined {
    const s = this.slot(id);
    return s === undefined ? undefined : this.at(s);
  }

  /** True when the id has a slot here but its element was removed. */
  isHole(id: string): boolean {
    const s = this.slot(id);
    return s !== undefined && this.at(s) === undefined;
  }

  at(slot: number): BimElement | undefined {
    return this.chunks[slot >> CHUNK_BITS]?.[slot & MASK];
  }

  keys(): readonly string[] {
    if (this.holes === 0) return this.size === this.table.keys.length ? this.table.keys : this.table.keys.slice(0, this.size);
    if (!this.liveKeys) {
      const out: string[] = [];
      for (let s = 0; s < this.size; s++) {
        const key = this.table.keys[s];
        if (key !== undefined && this.at(s) !== undefined) out.push(key);
      }
      this.liveKeys = out;
    }
    return this.liveKeys;
  }
}

/** Canonical array-index keys sort numerically ahead of other keys in plain-object order. */
function isIndexKey(key: string): boolean {
  if (key.length === 0 || key.length > 10) return false;
  if (key.length > 1 && key.charCodeAt(0) === 48) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return Number(key) < 4294967295;
}

/** Plain-object key order for keys listed in insertion order. */
function plainOrder(keys: readonly string[]): string[] {
  const index = keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
  if (index.length === 0) return [...keys];
  return [...index, ...keys.filter((k) => !isIndexKey(k))];
}

class StoreBuilder {
  readonly slotOf = new Map<string, number>();
  readonly keys: string[] = [];
  readonly chunks: Array<Array<BimElement | undefined>> = [];

  add(key: string, el: BimElement | undefined): void {
    const s = this.keys.length;
    this.slotOf.set(key, s);
    this.keys.push(key);
    const c = s >> CHUNK_BITS;
    const chunk = this.chunks[c] ?? [];
    this.chunks[c] = chunk;
    chunk.push(el);
  }

  /** A later row for a key already added: its element, at the key's first position. */
  replace(slot: number, el: BimElement): void {
    const chunk = this.chunks[slot >> CHUNK_BITS];
    if (!chunk) throw new Error(`StoreBuilder.replace: slot ${slot} was never added`);
    chunk[slot & MASK] = el;
  }

  build(): ElementStore {
    return new ElementStore({ slotOf: SlotIndex.root(this.slotOf, this.keys), keys: this.keys }, this.keys.length, this.chunks);
  }
}

function storeFromEntries(entries: Iterable<readonly [string, BimElement]>): ElementStore {
  const builder = new StoreBuilder();
  for (const [key, el] of entries) builder.add(key, el);
  return builder.build();
}

/** Same as `storeFromEntries(Object.entries(record))`, without a pair per key (about twice as fast on a large record). */
function storeFromRecord(record: Readonly<Elements>): ElementStore {
  const builder = new StoreBuilder();
  for (const key of Object.keys(record)) {
    const value: unknown = record[key];
    // Indexed once and cached by identity: a whole ModelState here would answer [] for every kind, forever.
    if (value !== undefined && !isElementLike(value)) {
      throw new TypeError(`Not an element record: "${key}" holds ${value === null ? "null" : typeof value}, not an element. Pass model.elements, not the model.`);
    }
    if (value !== undefined) shareElementKind(value);
    builder.add(key, value);
  }
  return builder.build();
}

/**
 * A committed record straight from rows read from storage (a model server's
 * boot pages): the same content and key order as
 * `Object.fromEntries(rows.map((e) => [e.id, e]))` (a repeated id keeps its
 * first position and its last element), indexed and with shared kinds as it
 * is built, instead of a plain object the first read then indexes again.
 * Rows with an integer-like id take the plain path, whose key order puts
 * those ids first.
 */
export function elementsFromRows(rows: readonly BimElement[]): Readonly<Elements> {
  const builder = new StoreBuilder();
  for (const el of rows) {
    if (!isElementLike(el)) throw new TypeError(`Not an element row: ${el === null ? "null" : typeof el}`);
    if (isIndexKey(el.id)) return freezeElements(Object.fromEntries(rows.map((r) => [r.id, r])));
    shareElementKind(el);
    const s = builder.slotOf.get(el.id);
    if (s === undefined) builder.add(el.id, el);
    else builder.replace(s, el);
  }
  return recordForStore(builder.build());
}

/**
 * Slots for a revision's new keys, in key order: the slot an id already has in
 * the table (a sibling revision appended it, or it is a hole) when that comes
 * after every live slot so far, else one appended at the table's end (`fresh`,
 * not yet written to the table). An id whose slot comes too early moves to a
 * fresh slot when `move` (a forked table, where it may), else no answer.
 */
function placeTail(table: SlotTable, liveEnd: number, tail: readonly string[], move: boolean): { readonly slots: number[]; readonly fresh: string[]; readonly end: number } | null {
  const slots: number[] = [];
  const fresh: string[] = [];
  let floor = liveEnd;
  let next = table.keys.length;
  for (const id of tail) {
    const known = table.slotOf.get(id);
    let slot: number;
    if (known !== undefined && known >= floor) slot = known;
    else if (known === undefined || move) {
      slot = next++;
      fresh.push(id);
    } else return null;
    slots.push(slot);
    floor = slot + 1;
  }
  return { slots, fresh, end: floor };
}

/** Pending writes on top of a store: what a command builds before it is committed. */
class Draft {
  readonly overlay = new Map<string, BimElement>();
  /** Base keys removed, or removed and re-added (which moves them to the end, as on a plain object). */
  readonly removed = new Set<string>();
  /** Keys after the base's keys, in plain-object insertion order. */
  added: string[] = [];
  private version = 0;
  private sealed: { version: number; store: ElementStore } | null = null;

  constructor(readonly base: ElementStore) {}

  get(id: string): BimElement | undefined {
    const v = this.overlay.get(id);
    if (v !== undefined) return v;
    return this.removed.size > 0 && this.removed.has(id) ? undefined : this.base.get(id);
  }

  set(id: string, el: BimElement): void {
    // Not held (never was, a hole, or removed here): a new key, at the end of the key order.
    if (this.get(id) === undefined) this.added.push(id);
    this.overlay.set(id, el);
    this.version += 1;
  }

  delete(id: string): void {
    if (this.get(id) === undefined) return;
    this.overlay.delete(id);
    if (this.base.slot(id) !== undefined) this.removed.add(id);
    this.added = this.added.filter((k) => k !== id);
    this.version += 1;
  }

  keys(): string[] {
    const tail = this.added.filter((k) => this.overlay.has(k));
    const head = this.removed.size === 0 ? this.base.keys() : this.base.keys().filter((k) => !this.removed.has(k));
    if (tail.length === 0) return [...head];
    return tail.some(isIndexKey) ? plainOrder([...head, ...tail]) : [...head, ...tail];
  }

  /** The store `seal` last built, when nothing was written since; never builds one. */
  sealedStore(): ElementStore | null {
    return this.sealed && this.sealed.version === this.version ? this.sealed.store : null;
  }

  /** The draft as its own store, sharing every chunk it did not write. */
  seal(): ElementStore {
    if (this.sealed && this.sealed.version === this.version) return this.sealed.store;
    const store = this.build();
    this.sealed = { version: this.version, store };
    return store;
  }

  private build(): ElementStore {
    const base = this.base;
    const tail = this.added.filter((k) => this.overlay.has(k));
    // Plain-object key order puts integer-like keys first, ahead of every slot.
    if (tail.some(isIndexKey)) return storeFromEntries(this.entries());
    // A live key removed and re-added here moves to the end of the key order: it needs a new slot.
    const moves = [...this.removed].some((k) => this.overlay.has(k));
    const shared = moves ? null : placeTail(base.table, base.liveEnd, tail, false);
    // Otherwise a table of our own over the same first slots (and the same chunks), where an id can move.
    const table = shared ? base.table : forkTable(base.table, base.size);
    const placed = shared ?? placeTail(table, base.liveEnd, tail, true);
    if (!placed) throw new Error("Draft.build: a forked slot table refused a key");
    const { slots: tailSlots, end: floor } = placed;
    const size = Math.max(base.size, floor);
    let removedLive = 0;
    for (const id of this.removed) {
      const slot = base.slot(id);
      if (slot !== undefined && base.at(slot) !== undefined) removedLive += 1;
    }
    const holes = base.holes + removedLive + (size - base.size) - tail.length;
    if (holes > Math.max(4 * CHUNK, size >> 3)) return storeFromEntries(this.entries());
    for (const id of placed.fresh) {
      table.slotOf.set(id, table.keys.length);
      table.keys.push(id);
    }
    const isTail = new Set(tail);
    const chunks = base.chunks.slice();
    const copied = new Set<number>();
    const write = (slot: number, el: BimElement | undefined): void => {
      const c = slot >> CHUNK_BITS;
      let chunk = chunks[c];
      if (!copied.has(c) || !chunk) {
        chunk = chunk ? chunk.slice() : [];
        chunks[c] = chunk;
        copied.add(c);
      }
      chunk[slot & MASK] = el;
    };
    for (const [id, el] of this.overlay) {
      if (isTail.has(id)) continue;
      const slot = base.slot(id);
      if (slot !== undefined) write(slot, el);
    }
    for (const id of this.removed) {
      const slot = base.slot(id);
      if (slot !== undefined && base.at(slot) !== undefined) write(slot, undefined);
    }
    tail.forEach((id, i) => {
      const el = this.overlay.get(id);
      const slot = tailSlots[i];
      if (el !== undefined && slot !== undefined) write(slot, el);
    });
    return new ElementStore(table, size, chunks, holes, tail.length > 0 ? floor : base.liveEnd);
  }

  *entries(): Generator<readonly [string, BimElement]> {
    for (const key of this.keys()) {
      const el = this.get(key);
      if (el !== undefined) yield [key, el];
    }
  }
}

// Each proxy has its own empty target; traps find their state through it.
const storeOfTarget = new WeakMap<object, ElementStore>();
const draftOfTarget = new WeakMap<object, Draft>();
const storeOfRecord = new WeakMap<object, ElementStore>();
const draftOfRecord = new WeakMap<object, Draft>();
const storeOfPlain = new WeakMap<object, ElementStore>();

const IMMUTABLE = "Committed element records are immutable; build changes with draftElements()";

const storeHandler: ProxyHandler<Elements> = {
  get(target, key) {
    if (typeof key === "string") {
      const v = storeOfTarget.get(target)?.get(key);
      if (v !== undefined) return v;
    }
    return Reflect.get(target, key);
  },
  has(target, key) {
    if (typeof key === "string" && storeOfTarget.get(target)?.get(key) !== undefined) return true;
    return Reflect.has(target, key);
  },
  ownKeys(target) {
    return [...(storeOfTarget.get(target)?.keys() ?? [])];
  },
  getOwnPropertyDescriptor(target, key) {
    if (typeof key !== "string") return undefined;
    const v = storeOfTarget.get(target)?.get(key);
    return v === undefined ? undefined : { value: v, writable: false, enumerable: true, configurable: true };
  },
  set() {
    throw new TypeError(IMMUTABLE);
  },
  deleteProperty() {
    throw new TypeError(IMMUTABLE);
  },
  defineProperty() {
    throw new TypeError(IMMUTABLE);
  },
};

const draftHandler: ProxyHandler<Elements> = {
  get(target, key) {
    if (typeof key === "string") {
      const v = draftOfTarget.get(target)?.get(key);
      if (v !== undefined) return v;
    }
    return Reflect.get(target, key);
  },
  has(target, key) {
    if (typeof key === "string" && draftOfTarget.get(target)?.get(key) !== undefined) return true;
    return Reflect.has(target, key);
  },
  ownKeys(target) {
    return draftOfTarget.get(target)?.keys() ?? [];
  },
  getOwnPropertyDescriptor(target, key) {
    if (typeof key !== "string") return undefined;
    const v = draftOfTarget.get(target)?.get(key);
    return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
  },
  set(target, key, value: unknown) {
    const draft = draftOfTarget.get(target);
    if (typeof key !== "string" || !draft || !isElementLike(value)) return false;
    draft.set(key, value);
    return true;
  },
  deleteProperty(target, key) {
    const draft = draftOfTarget.get(target);
    if (typeof key !== "string" || !draft) return false;
    draft.delete(key);
    return true;
  },
  defineProperty(target, key, descriptor) {
    const draft = draftOfTarget.get(target);
    const value: unknown = descriptor.value;
    if (typeof key !== "string" || !draft || !isElementLike(value)) return false;
    draft.set(key, value);
    return true;
  },
};

function isElementLike(value: unknown): value is BimElement {
  return typeof value === "object" && value !== null && "id" in value && "kind" in value;
}

function recordForStore(store: ElementStore): Elements {
  const target: Elements = {};
  storeOfTarget.set(target, store);
  const proxy = new Proxy(target, storeHandler);
  storeOfRecord.set(proxy, store);
  return proxy;
}

function recordForDraft(draft: Draft): Elements {
  const target: Elements = {};
  draftOfTarget.set(target, draft);
  const proxy = new Proxy(target, draftHandler);
  draftOfRecord.set(proxy, draft);
  return proxy;
}

/** The store behind any element record (plain records are indexed once and cached). */
function storeOf(record: Readonly<Elements>): ElementStore {
  const asStore = storeOfRecord.get(record);
  if (asStore) return asStore;
  const draft = draftOfRecord.get(record);
  if (draft) return draft.seal();
  const cached = storeOfPlain.get(record);
  if (cached) return cached;
  const built = storeFromRecord(record);
  storeOfPlain.set(record, built);
  return built;
}

/**
 * A writable copy of `record` that shares everything it does not write.
 * Behaves like `{ ...record }` for reads, writes, deletes and key order.
 */
export function draftElements(record: Readonly<Elements>): Elements {
  return recordForDraft(new Draft(storeOf(record)));
}

/**
 * The kinds `record` wrote since `earlier` (the old and the new kind of every
 * element it set, added or removed), read from its pending writes in
 * O(writes): for a derived read cached per record that only some kinds
 * change. Null unless `record` is a draft made directly on `earlier` (what
 * `executeCommand` returns for the next edit); the caller then compares
 * the two itself.
 */
export function kindsWrittenSince(record: Readonly<Elements>, earlier: Readonly<Elements>): ReadonlySet<string> | null {
  const draft = draftOfRecord.get(record);
  if (!draft) return null;
  const earlierStore = storeOfRecord.get(earlier) ?? storeOfPlain.get(earlier) ?? draftOfRecord.get(earlier)?.sealedStore() ?? null;
  if (earlierStore === null || draft.base !== earlierStore) return null;
  const kinds = new Set<string>();
  for (const [id, el] of draft.overlay) {
    kinds.add(el.kind);
    const was = draft.base.get(id);
    if (was !== undefined) kinds.add(was.kind);
  }
  for (const id of draft.removed) {
    const was = draft.base.get(id);
    if (was !== undefined) kinds.add(was.kind);
  }
  return kinds;
}

/** An immutable record with the same content and key order as `record`, sharing its chunks. */
export function freezeElements(record: Readonly<Elements>): Readonly<Elements> {
  return storeOfRecord.has(record) ? record : recordForStore(storeOf(record));
}

/** True for records produced by `freezeElements` (writes throw). */
export function isFrozenElements(record: Readonly<Elements>): boolean {
  return storeOfRecord.has(record);
}

/**
 * A record's slot layout, read-only: `table.keys[s]` is the id at slot `s`,
 * `at(s)` its element (undefined where this revision removed it). Slots below
 * `size` are this record's, in key order. The table is shared with sibling
 * revisions and may hold more keys than `size`.
 */
export interface ElementSlots {
  readonly table: { readonly slotOf: ReadonlyMap<string, number>; readonly keys: readonly string[] };
  readonly size: number;
  at(slot: number): BimElement | undefined;
}

export function elementSlots(record: Readonly<Elements>): ElementSlots {
  return storeOf(record);
}

/** What `connectionEndSlots` reads of a connection. */
interface ConnectionEndIds {
  readonly a: { readonly elementId: string };
  readonly b: { readonly elementId: string };
}

export interface ConnectionEndSlots {
  /** Slot of each connection's `a` / `b` end, -1 when the id has no slot below the layout's size. Never written. */
  readonly a: Int32Array;
  readonly b: Int32Array;
}

const endSlotsOf = new WeakMap<object, { readonly table: ElementSlots["table"]; readonly size: number; readonly ends: ConnectionEndSlots }>();

/**
 * Every connection end's slot in `slots`, looked up once per connection list
 * and slot layout: the area index (first join) and the topology index (first
 * commit) both need them, and on a cold million-element head the id lookups
 * are a large share of either.
 */
export function connectionEndSlots(connections: readonly ConnectionEndIds[], slots: ElementSlots): ConnectionEndSlots {
  const cached = endSlotsOf.get(connections);
  if (cached && cached.table === slots.table && cached.size === slots.size) return cached.ends;
  const { slotOf } = slots.table;
  const n = slots.size;
  const slotFor = (id: string): number => {
    const s = slotOf.get(id);
    return s !== undefined && s < n ? s : -1;
  };
  const m = connections.length;
  const a = new Int32Array(m);
  const b = new Int32Array(m);
  for (let pos = 0; pos < m; pos++) {
    const c = connections[pos];
    if (!c) continue;
    const sa = slotFor(c.a.elementId);
    a[pos] = sa;
    b[pos] = c.b.elementId === c.a.elementId ? sa : slotFor(c.b.elementId);
  }
  const ends = { a, b };
  endSlotsOf.set(connections, { table: slots.table, size: n, ends });
  return ends;
}

/**
 * `(id) => record[id]` for a hot loop over a committed or draft record: reads
 * the store or draft directly instead of through the proxy's traps (about
 * 100 ns a read at 250k elements). Answers exactly as `record[id]`; a miss
 * still takes the record's own path.
 */
export function elementReader(record: Readonly<Elements>): (id: string) => BimElement | undefined {
  const asStore = storeOfRecord.get(record);
  if (asStore) return (id) => asStore.get(id) ?? record[id];
  const draft = draftOfRecord.get(record);
  if (draft) return (id) => draft.get(id) ?? record[id];
  return (id) => record[id];
}

/** A record read by slot of a slot table it shares (see `slotReaderOf`). */
export interface SlotReader {
  readonly table: ElementSlots["table"];
  /** Slots below this are the record's own (or its base's, for a draft). */
  readonly size: number;
  /** The record's element at `slot`, as `record[table.keys[slot]]` answers for an element; undefined for a hole. */
  at(slot: number): BimElement | undefined;
}

/**
 * Read a committed record (or a draft, through its base's slots with its
 * pending writes applied) by slot instead of by id: no string hashing. Null
 * for a plain record not indexed yet. The overlay is mapped to slots once,
 * here (O(pending writes)).
 */
export function slotReaderOf(record: Readonly<Elements>): SlotReader | null {
  const asStore = storeOfRecord.get(record) ?? storeOfPlain.get(record);
  if (asStore) return { table: asStore.table, size: asStore.size, at: (slot) => (slot < asStore.size ? asStore.at(slot) : undefined) };
  const draft = draftOfRecord.get(record);
  if (!draft) return null;
  const { base, overlay, removed } = draft;
  if (overlay.size === 0 && removed.size === 0) return { table: base.table, size: base.size, at: (slot) => (slot < base.size ? base.at(slot) : undefined) };
  const pending = new Map<number, BimElement | null>();
  for (const [id, el] of overlay) {
    const slot = base.slot(id);
    if (slot !== undefined) pending.set(slot, el);
  }
  for (const id of removed) {
    const slot = base.slot(id);
    if (slot !== undefined && !pending.has(slot)) pending.set(slot, null);
  }
  return {
    table: base.table,
    size: base.size,
    at: (slot) => {
      if (slot >= base.size) return undefined;
      const written = pending.get(slot);
      return written === undefined ? base.at(slot) : (written ?? undefined);
    },
  };
}

/**
 * `elementSlots` for a committed or plain record (a plain one is indexed once
 * and cached, as any later commit on it needs); null for a draft, which
 * would have to be sealed (see `draftValues`).
 */
export function recordSlots(record: Readonly<Elements>): ElementSlots | null {
  return draftOfRecord.has(record) ? null : storeOf(record);
}

/**
 * Position of every key in key order, for sorting by element order. Shared
 * across revisions with the same keys; it may also hold keys appended by
 * later revisions, which never appear in this record.
 */
export function elementOrder(record: Readonly<Elements>): ReadonlyMap<string, number> {
  return storeOf(record).table.slotOf;
}

function iterableStore(record: Readonly<Elements>): ElementStore | null {
  return storeOfRecord.get(record) ?? storeOfPlain.get(record) ?? null;
}

/**
 * A draft (an unconfirmed prediction, what `executeCommand` returns) walked
 * over its base's slots with the overlay applied, instead of key by key
 * through proxy traps (50-70 ms at 250k elements). Sealing would be as fast
 * but uses up the shared slot table's append, making the next confirmed
 * commit rebuild the record. Null when the draft's key order needs the slow
 * path (an integer-like id added).
 */
function draftValues(draft: Draft): BimElement[] | null {
  if (draft.added.some(isIndexKey)) return null;
  const { base, overlay, removed } = draft;
  const keys = base.table.keys;
  const out: BimElement[] = [];
  for (let s = 0; s < base.size; s++) {
    const el = base.at(s);
    if (el === undefined) continue;
    const key = keys[s];
    if (key === undefined || (removed.size > 0 && removed.has(key))) continue;
    out.push(overlay.size > 0 ? (overlay.get(key) ?? el) : el);
  }
  for (const key of draft.added) {
    const el = overlay.get(key);
    if (el !== undefined) out.push(el);
  }
  return out;
}

/** The record's values in key order; identical to `Object.values(record)`, without per-key proxy traps. */
export function elementValues(record: Readonly<Elements>): BimElement[] {
  const asStore = iterableStore(record);
  if (asStore) {
    const out: BimElement[] = [];
    for (let s = 0; s < asStore.size; s++) {
      const el = asStore.at(s);
      if (el !== undefined) out.push(el);
    }
    return out;
  }
  const draft = draftOfRecord.get(record);
  if (draft) return draftValues(draft) ?? [...draft.entries()].map(([, el]) => el);
  return Object.values(record);
}

/** How many elements the record holds; identical to `Object.keys(record).length`, without listing them. */
export function elementCount(record: Readonly<Elements>): number {
  const asStore = iterableStore(record);
  if (asStore) return asStore.size - asStore.holes;
  const draft = draftOfRecord.get(record);
  if (draft) {
    let removedLive = 0;
    for (const key of draft.removed) if (draft.base.get(key) !== undefined) removedLive += 1;
    let added = 0;
    for (const key of draft.added) if (draft.overlay.has(key)) added += 1;
    return draft.base.size - draft.base.holes - removedLive + added;
  }
  return Object.keys(record).length;
}

/** The record's ids in key order; identical to `Object.keys(record)`. */
export function elementKeys(record: Readonly<Elements>): string[] {
  const asStore = iterableStore(record);
  if (asStore) return [...asStore.keys()];
  const draft = draftOfRecord.get(record);
  return draft ? draft.keys() : Object.keys(record);
}

/**
 * Per chunk, the offsets of its elements by kind. Chunks are never written
 * after their store is built and a commit copies only the chunks it touched,
 * so each revision re-indexes a handful of chunks, not the model.
 */
const kindsOfChunk = new WeakMap<ReadonlyArray<BimElement | undefined>, ReadonlyMap<string, readonly number[]>>();

function chunkKinds(chunk: ReadonlyArray<BimElement | undefined>): ReadonlyMap<string, readonly number[]> {
  const cached = kindsOfChunk.get(chunk);
  if (cached) return cached;
  const byKind = new Map<string, number[]>();
  for (let i = 0; i < chunk.length; i++) {
    const el = chunk[i];
    if (el === undefined) continue;
    const list = byKind.get(el.kind);
    if (list) list.push(i);
    else byKind.set(el.kind, [i]);
  }
  kindsOfChunk.set(chunk, byKind);
  return byKind;
}

/**
 * Every element of the given kinds, in key order, from an index that is
 * reused across revisions: the work is the matches plus one lookup per 1,024
 * elements, not a pass over the model. Prefer this to filtering
 * `elementValues` by kind.
 */
export function elementsOfKind<K extends BimElement["kind"]>(record: Readonly<Elements>, ...kinds: readonly K[]): Array<Extract<BimElement, { kind: K }>> {
  const isKind = (el: BimElement): el is Extract<BimElement, { kind: K }> => (kinds as readonly string[]).includes(el.kind);
  return matchingRecords(record, kinds, isKind);
}

/** `elementsOfKind` for kinds named at run time (an add-on's kinds, which the union doesn't name), from the same index. */
export function recordsOfKinds(record: Readonly<Elements>, kinds: readonly string[]): BimElement[] {
  if (kinds.length === 0) return [];
  return matchingRecords(record, kinds, (el): el is BimElement => kinds.includes(el.kind));
}

function matchingRecords<T extends BimElement>(record: Readonly<Elements>, kinds: readonly string[], isKind: (el: BimElement) => el is T): T[] {
  const out: T[] = [];
  const draft = draftOfRecord.get(record);
  // A prediction: its base's index, with the few elements the command wrote or removed applied.
  if (draft && !draft.added.some(isIndexKey) && [...draft.overlay].every(([id, el]) => draft.base.get(id)?.kind === undefined || draft.base.get(id)?.kind === el.kind)) {
    for (const el of elementsOfKindInStore(draft.base, kinds, isKind)) {
      if (draft.removed.has(el.id)) continue;
      const written = draft.overlay.get(el.id);
      out.push(written !== undefined && isKind(written) ? written : el);
    }
    for (const key of draft.added) {
      const el = draft.overlay.get(key);
      if (el !== undefined && isKind(el)) out.push(el);
    }
    return out;
  }
  if (draft) {
    for (const el of elementValues(record)) if (isKind(el)) out.push(el);
    return out;
  }
  // A plain record is indexed once and cached by identity (it must not be mutated afterwards).
  return elementsOfKindInStore(storeOf(record), kinds, isKind);
}

function elementsOfKindInStore<T extends BimElement>(asStore: ElementStore, kinds: readonly string[], isKind: (el: BimElement) => el is T): T[] {
  const out: T[] = [];
  const chunkCount = Math.ceil(asStore.size / CHUNK);
  for (let c = 0; c < chunkCount; c++) {
    const chunk = asStore.chunks[c];
    if (!chunk) continue;
    const index = chunkKinds(chunk);
    const offsets = kinds.length === 1 ? (index.get(kinds[0] ?? "") ?? []) : kinds.flatMap((k) => index.get(k) ?? []).sort((a, b) => a - b);
    for (const offset of offsets) {
      if ((c << CHUNK_BITS) + offset >= asStore.size) break;
      const el = chunk[offset];
      if (el !== undefined && isKind(el)) out.push(el);
    }
  }
  return out;
}

/** `[id, element]` pairs in key order; identical to `Object.entries(record)`. */
export function elementEntries(record: Readonly<Elements>): Array<[string, BimElement]> {
  const asStore = iterableStore(record);
  if (asStore) {
    const keys = asStore.table.keys;
    const out: Array<[string, BimElement]> = [];
    for (let s = 0; s < asStore.size; s++) {
      const key = keys[s];
      const el = asStore.at(s);
      if (key !== undefined && el !== undefined) out.push([key, el]);
    }
    return out;
  }
  return Object.entries(record);
}

/** A real plain-object copy, for code that must hold its own mutable record. */
export function plainElements(record: Readonly<Elements>): Elements {
  return Object.fromEntries(elementEntries(record));
}
