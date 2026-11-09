/**
 * Incremental validation: what full validation found on a model, check by
 * check, and which elements each check read, so the next edit re-runs only
 * the checks that read something it changed and carries every other answer
 * forward. The result is the issue list full validation gives, in its order.
 *
 * A check is one of four units, in full validation's order:
 * - a connection (both ends meet, sizes agree);
 * - an element (its own rules, whatever they read through `model.elements`);
 * - a group (elements an element check files under one key, checked
 *   together, in key order of their first member);
 * - the whole model (one issue from a model-wide walk).
 *
 * What a check reads is recorded, not declared: each check runs against a
 * read-recording view of the element record, so a rule an add-on brings is
 * tracked exactly like a kernel rule, with no list of dependencies to keep in
 * step with the rules. A check that lists the whole record re-runs on every
 * edit. Recorded reads only accumulate along a model's revisions (a check
 * that stops reading an element is re-run once too often, never too rarely).
 * A connection's own two ends are not recorded (the topology index already
 * lists the connections at each element); anything else it reads is.
 *
 * Which add-on contributions each check reads is recorded too (round 9):
 * every read of a pack set while a check runs (`packs/set.ts`), into a
 * per-record point index. When the add-on set changes, only the checks that
 * read a contribution the two sets answer differently run again. A cold pass
 * builds the same index for a model with no ledger, after the save that ran
 * it (round 10, `validate.ts` `buildPointReads`): until it is built a switch
 * re-checks the whole model, as for any record with no index.
 *
 * A sparse ledger (round 9) records element reads only for the checks with
 * issues; every other check is valid and is re-run when an edit reaches it
 * through the topology (`UnitChecks.structural`), the rule `firstIssueAfter`
 * already applies to a valid model. It is what a switch or a cold pass leaves,
 * so neither pays a recorded pass over the whole model; it becomes a full
 * ledger on the first edit structure alone can't bound.
 */
import { firstPartyBaseRevision, PackSet, samePackSetRead, swapPackSetReadRecorder, type PackSetRead, type PackSetReadKind, type PackSetReadRecorder, type RecordedPoint } from "./packs/set";
import { elementOrder, elementReader, elementSlots, type ElementSlots } from "./store";
import { asElementId, type BimElement, type Connection, type ElementId, type ModelSettings, type ModelState } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

export interface LedgerIssue {
  readonly code: string;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

/** The checks full validation runs, one unit at a time. */
export interface UnitChecks<I extends LedgerIssue> {
  connection(model: ModelState, c: Connection, out: I[]): void;
  /** An element's issues; returns the group key it files the element under, or null. */
  element(model: ModelState, el: BimElement, out: I[]): ElementId | null;
  /** One group's issues; `members` in key order. */
  group(model: ModelState, key: ElementId, members: readonly BimElement[], out: I[]): void;
  /** The model-wide issue, or null. */
  whole(model: ModelState): I | null;
  /** True when the model-wide issue of `after` is `prior`'s (same connections, same reach). */
  sameWhole(prior: ModelState, after: ModelState, changed: readonly ElementId[]): boolean;
  /** Position of `c` in `model.connections`, or -1. */
  connectionPosition(model: ModelState, c: Connection): number;
  /** The connections at one end id in `model` (a connection's own ends are not recorded as reads; this finds them). */
  connectionsAt(model: ModelState, id: ElementId): readonly Connection[];
  /** The rule set in force: under a different pack set, checks that read a contribution the two answer differently are re-run; under anything else, all of them. */
  rules(): object;
  /**
   * The elements whose checks an edit can change besides those it changed,
   * from structure alone (hosts, references, links); null when structure
   * can't bound it (connections, settings or topology changed). Sparse
   * ledgers re-run these.
   */
  structural(prior: ModelState, after: ModelState, changed: readonly ElementId[]): readonly ElementId[] | null;
  /** The elements the topology files under group `key`, in key order (a sparse ledger's group members). */
  groupMembers(model: ModelState, key: ElementId): readonly ElementId[];
  /** Every group key the topology has (a sparse ledger re-checking every group). */
  groupKeys(model: ModelState): readonly ElementId[];
}

type Unit = ElementId | Connection;

/** Running totals, for tests and the perf gate: how often a full pass or a cold pass ran, and how much an update re-ran. */
export interface LedgerStats {
  fullPasses: number;
  /** Cold passes (`validate.ts` `coldFacts`): the other whole-model check. */
  coldPasses: number;
  updates: number;
  unitsRerun: number;
}

const stats: LedgerStats = { fullPasses: 0, coldPasses: 0, updates: 0, unitsRerun: 0 };

export function ledgerStats(): Readonly<LedgerStats> {
  return { ...stats };
}

/** Count one cold pass (the cold pass lives in validate.ts). */
export function noteColdPass(): void {
  stats.coldPasses += 1;
}

// ── Which checks read which add-on contributions ───────────────────────────

const READ_KINDS = 5;

/** One recorded read by id: a point's id, or a pack's for `PACK_SET_READ.pack`. */
export interface ReadKey {
  readonly kind: PackSetReadKind;
  readonly id: string;
}

/** Every pack-set read any check of one index made, numbered. */
class ReadKeys {
  readonly list: ReadKey[] = [];
  /** By point or pack id, one number per kind of read (-1: not yet read that way). */
  private readonly byId = new Map<string, Int32Array>();

  idOf(kind: PackSetReadKind, target: RecordedPoint | string): number {
    return this.idOfKey(kind, typeof target === "string" ? target : target.id);
  }

  idOfKey(kind: PackSetReadKind, key: string): number {
    let ids = this.byId.get(key);
    if (!ids) {
      ids = new Int32Array(READ_KINDS).fill(-1);
      this.byId.set(key, ids);
    }
    const known = ids[kind] ?? -1;
    if (known >= 0) return known;
    const id = this.list.length;
    this.list.push({ kind, id: key });
    ids[kind] = id;
    return id;
  }
}

/** How many recent read lists (`UnitReads`) and read sequences (`Signatures`) are compared directly before a map or trie lookup. */
const RECENT = 8;

/**
 * One check's reads, each once, in the order made: the first `count` of `ids`.
 * The buffer is kept across checks; a pass records one check per element, and
 * truncating an array frees its storage, so each check would allocate again.
 */
class UnitReads implements PackSetReadRecorder {
  private stamp = new Int32Array(64);
  private unit = 0;
  ids = new Int32Array(16);
  count = 0;
  /** A memo's read list (the same object every hit) as numbers, looked up once. */
  private readonly lists = new Map<readonly PackSetRead[], Int32Array>();
  /** The last few lists met, by identity: every check hits the same few tables, so most hits skip the map. */
  private readonly recentLists: (readonly PackSetRead[] | null)[] = new Array<readonly PackSetRead[] | null>(RECENT).fill(null);
  private readonly recentIds: Int32Array[] = new Array<Int32Array>(RECENT).fill(new Int32Array(0));
  private recentNext = 0;

  constructor(private readonly keys: ReadKeys) {}

  begin(): void {
    this.unit += 1;
    this.count = 0;
  }

  note(kind: PackSetReadKind, target: RecordedPoint | string): void {
    this.add(this.keys.idOf(kind, target));
  }

  noteAll(reads: readonly PackSetRead[]): void {
    let ids: Int32Array | undefined;
    for (let r = 0; r < RECENT; r++) {
      if (this.recentLists[r] === reads) {
        ids = this.recentIds[r];
        break;
      }
    }
    if (!ids) {
      ids = this.lists.get(reads);
      if (!ids) {
        ids = Int32Array.from(reads, (r) => this.keys.idOf(r.kind, r.target));
        this.lists.set(reads, ids);
      }
      this.recentLists[this.recentNext] = reads;
      this.recentIds[this.recentNext] = ids;
      this.recentNext = (this.recentNext + 1) % RECENT;
    }
    for (let i = 0; i < ids.length; i++) this.add(ids[i] ?? 0);
  }

  private add(id: number): void {
    if (id >= this.stamp.length) {
      const grown = new Int32Array(Math.max(id + 1, this.stamp.length * 2));
      grown.set(this.stamp);
      this.stamp = grown;
    }
    if (this.stamp[id] === this.unit) return;
    this.stamp[id] = this.unit;
    if (this.count === this.ids.length) {
      const grown = new Int32Array(this.ids.length * 2);
      grown.set(this.ids);
      this.ids = grown;
    }
    this.ids[this.count++] = id;
  }
}

/** A slot no check has been recorded for: always re-run. */
const UNRECORDED = 0xffff;
const NOTHING = 0;
/** Reads treated as all of them (an index past its signature limit). */
const EVERYTHING = 1;
const MAX_SIGNATURES = 0xfff0;

interface SignatureNode {
  next: Map<number, SignatureNode> | null;
  sig: number;
}

/** Interned sets of reads: most checks read the same few, so a slot holds a two-byte number. */
class Signatures {
  readonly reads: (readonly number[])[] = [[], []];
  private readonly byKey = new Map<string, number>([["", NOTHING]]);
  /** Read orders seen, walked one read at a time: no string built for a sequence met before. */
  private readonly root: SignatureNode = { next: null, sig: NOTHING };

  /**
   * The last few sequences met (the first `recentCounts[r]` of `recentIds[r]`) and their signatures:
   * neighbouring checks mostly read like one of the few kinds just before them.
   */
  private readonly recentIds: Int32Array[] = Array.from({ length: RECENT }, () => new Int32Array(8));
  private readonly recentCounts = new Int32Array(RECENT).fill(-1);
  private readonly recentSigs = new Int32Array(RECENT);
  private recentNext = 0;

  /** The signature of the first `count` reads of `ids`. Allocates only for a sequence never seen before. */
  ofReads(ids: Int32Array, count: number): number {
    for (let r = 0; r < RECENT; r++) {
      if (this.recentCounts[r] !== count) continue;
      const seen = this.recentIds[r];
      if (!seen) continue;
      let i = 0;
      while (i < count && ids[i] === seen[i]) i++;
      if (i === count) return this.recentSigs[r] ?? NOTHING;
    }
    const sig = this.walk(ids, count);
    const r = this.recentNext;
    let seen = this.recentIds[r] ?? new Int32Array(0);
    if (seen.length < count) {
      seen = new Int32Array(Math.max(count, seen.length * 2));
      this.recentIds[r] = seen;
    }
    for (let i = 0; i < count; i++) seen[i] = ids[i] ?? 0;
    this.recentCounts[r] = count;
    this.recentSigs[r] = sig;
    this.recentNext = (r + 1) % RECENT;
    return sig;
  }

  private walk(ids: Int32Array, count: number): number {
    let node = this.root;
    for (let i = 0; i < count; i++) {
      const id = ids[i] ?? 0;
      let next = node.next?.get(id);
      if (!next) {
        next = { next: null, sig: -1 };
        node.next ??= new Map();
        node.next.set(id, next);
      }
      node = next;
    }
    if (node.sig < 0) node.sig = this.intern(Array.from(ids.subarray(0, count)).sort((a, b) => a - b));
    return node.sig;
  }

  union(a: number, b: number): number {
    if (a === b || b === NOTHING || a === EVERYTHING) return a;
    if (a === NOTHING || b === EVERYTHING) return b;
    const merged = new Set([...(this.reads[a] ?? []), ...(this.reads[b] ?? [])]);
    return this.intern([...merged].sort((x, y) => x - y));
  }

  /** Intern a sorted list (reading a persisted index back, in its order). */
  internSorted(sorted: readonly number[]): number {
    return this.intern(sorted);
  }

  private intern(sorted: readonly number[]): number {
    const key = sorted.join(",");
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    if (this.reads.length >= MAX_SIGNATURES) return EVERYTHING;
    const sig = this.reads.length;
    this.reads.push(sorted);
    this.byKey.set(key, sig);
    return sig;
  }
}

/**
 * Which add-on contributions each check of one model lineage read: a
 * signature per element slot (slots of `table`, shared by sibling records),
 * and one for all connections, all groups and the whole-model check. Reads
 * only accumulate; a check recorded twice reads the union.
 */
class PointIndex {
  readonly keys = new ReadKeys();
  readonly signatures = new Signatures();
  readonly recorder: UnitReads;
  private bySlot: Uint16Array;
  connectionSig = NOTHING;
  groupSig = NOTHING;
  wholeSig = NOTHING;

  constructor(
    readonly table: ElementSlots["table"],
    readonly connections: readonly Connection[],
    readonly baseRevision: number,
    size: number,
  ) {
    this.recorder = new UnitReads(this.keys);
    this.bySlot = new Uint16Array(Math.max(size, 16)).fill(UNRECORDED);
  }

  slotSig(slot: number): number {
    return slot < this.bySlot.length ? (this.bySlot[slot] ?? UNRECORDED) : UNRECORDED;
  }

  /** Set a slot's signature outright (an index read back from storage). */
  setSlot(slot: number, sig: number): void {
    if (slot >= this.bySlot.length) {
      const grown = new Uint16Array(Math.max(slot + 1, this.bySlot.length * 2)).fill(UNRECORDED);
      grown.set(this.bySlot);
      this.bySlot = grown;
    }
    this.bySlot[slot] = sig;
  }

  /** The recorder's reads (the check just run) for the element at `slot`. */
  recordSlot(slot: number): void {
    if (slot >= this.bySlot.length) {
      const grown = new Uint16Array(Math.max(slot + 1, this.bySlot.length * 2)).fill(UNRECORDED);
      grown.set(this.bySlot);
      this.bySlot = grown;
    }
    const sig = this.signatures.ofReads(this.recorder.ids, this.recorder.count);
    const was = this.bySlot[slot] ?? UNRECORDED;
    this.bySlot[slot] = was === UNRECORDED ? sig : this.signatures.union(was, sig);
  }

  /** The recorder's reads for the element `id` (no slot in this table: a new element, left to the record's pending list). */
  recordId(id: string): void {
    const slot = this.table.slotOf.get(id);
    if (slot !== undefined) this.recordSlot(slot);
  }

  readSig(): number {
    return this.signatures.ofReads(this.recorder.ids, this.recorder.count);
  }
}

/** Ids changed since a record's index was built, closed over what they reach (see `carryPointReads`). */
interface Pending {
  readonly ids: readonly string[];
  readonly parent: Pending | null;
  readonly count: number;
}

interface RecordPoints {
  readonly index: PointIndex;
  readonly pending: Pending | null;
}

const pointsByRecord = new WeakMap<object, RecordPoints>();

/** Past this many changed ids a record keeps no index; its next switch takes a cold pass. */
const PENDING_LIMIT = 50_000;

/** A fresh index for `model`'s record, replacing any it carried (every check is about to be recorded). */
function freshPointIndex(model: ModelState, slots: ElementSlots): PointIndex {
  const index = new PointIndex(slots.table, model.connections, firstPartyBaseRevision(), slots.size);
  pointsByRecord.set(model.elements, { index, pending: null });
  return index;
}

/** Recording every check of a pass over `model` (the cold pass in validate.ts). */
export interface PassRecorder {
  /** Before a check runs: its reads are collected from here. */
  begin(): void;
  /** After a connection's check. */
  connection(): void;
  /** After the check of the element at `slot`. */
  element(slot: number): void;
  /** After a group's check. */
  group(): void;
  /** After the whole-model check. */
  whole(): void;
  /** No check is running (reads outside checks are not recorded). */
  pause(): void;
  /** Done: the recorder that was installed before is back. */
  end(): void;
}

/** Record a pass's checks into a fresh index for `model`'s record. */
export function recordPass(model: ModelState): PassRecorder {
  return recordInto(freshPointIndex(model, elementSlots(model.elements)));
}

/** An index for `model`'s record that no record carries yet: built a slice at a time after a save (`installPointIndex` when done). */
export type DetachedPointIndex = PointIndex;

export function detachedPointIndex(model: ModelState): DetachedPointIndex {
  const slots = elementSlots(model.elements);
  return new PointIndex(slots.table, model.connections, firstPartyBaseRevision(), slots.size);
}

/** Give `model`'s record the finished `index`, unless it already keeps a usable one. False when the index no longer fits the record. */
export function installPointIndex(model: ModelState, index: DetachedPointIndex): boolean {
  if (hasUsablePointReads(model)) return true;
  if (index.connections !== model.connections || index.baseRevision !== firstPartyBaseRevision() || elementSlots(model.elements).table !== index.table) return false;
  pointsByRecord.set(model.elements, { index, pending: null });
  return true;
}

/** Run `fn` with no pack-set read recorder installed (a pass that records nothing, as a recorded one runs with only its own). */
export function withoutPackSetRecorder<R>(fn: () => R): R {
  const outer = swapPackSetReadRecorder(null);
  try {
    return fn();
  } finally {
    swapPackSetReadRecorder(outer);
  }
}

/** Record checks into `index` (one pass, or one slice of one); `end()` puts back the recorder installed before. */
export function recordInto(index: DetachedPointIndex): PassRecorder {
  const rec = index.recorder;
  const outer = swapPackSetReadRecorder(null);
  return {
    begin: () => {
      rec.begin();
      swapPackSetReadRecorder(rec);
    },
    connection: () => {
      swapPackSetReadRecorder(null);
      index.connectionSig = index.signatures.union(index.connectionSig, index.readSig());
    },
    element: (slot) => {
      swapPackSetReadRecorder(null);
      index.recordSlot(slot);
    },
    group: () => {
      swapPackSetReadRecorder(null);
      index.groupSig = index.signatures.union(index.groupSig, index.readSig());
    },
    whole: () => {
      swapPackSetReadRecorder(null);
      index.wholeSig = index.signatures.union(index.wholeSig, index.readSig());
    },
    pause: () => {
      swapPackSetReadRecorder(null);
    },
    end: () => {
      swapPackSetReadRecorder(outer);
    },
  };
}

/** True when `elements` carries a point index (a carry has something to pass on). */
export function hasPointReads(elements: object): boolean {
  return pointsByRecord.has(elements);
}

/**
 * Pass `from`'s index on to `to`, which differs from it at `closure`: the
 * changed ids and every element whose checks they can reach (`structural`).
 * Those are re-run on a switch, since what they read may have changed. Null:
 * structure can't bound the edit, and `to` keeps no index.
 */
export function carryPointReads(from: object, to: object, closure: readonly string[] | null): void {
  const known = pointsByRecord.get(from);
  if (!known || from === to || closure === null || pointsByRecord.has(to)) return;
  if (closure.length === 0) {
    pointsByRecord.set(to, known);
    return;
  }
  const count = (known.pending?.count ?? 0) + closure.length;
  if (count > PENDING_LIMIT) return;
  pointsByRecord.set(to, { index: known.index, pending: { ids: closure, parent: known.pending, count } });
}

/**
 * After `model`'s checks named by `unitsReadingChanged` ran again (recorded),
 * the record's own reads are all in the index: it carries nothing pending.
 */
export function settlePointReads(model: ModelState): void {
  const known = pointsByRecord.get(model.elements);
  if (known?.pending) pointsByRecord.set(model.elements, { index: known.index, pending: null });
}

/**
 * A record's point index as plain data, to be kept beside the model and read
 * back by another process (`importPointReads`). Slots are named by element:
 * each kind's most common signature, plus the elements that differ from it.
 * Checks pending since the index was built are written as unrecorded.
 */
export interface PointReadsExport {
  readonly keys: readonly ReadKey[];
  /** Signatures 2 onward, each a sorted list of key numbers (0 reads nothing, 1 counts as reading everything). */
  readonly signatures: readonly (readonly number[])[];
  readonly byKind: Readonly<Record<string, number>>;
  readonly exceptionIds: readonly string[];
  readonly exceptionSigs: readonly number[];
  readonly connectionSig: number;
  readonly groupSig: number;
  readonly wholeSig: number;
}

function pendingIdsOf(known: RecordPoints): Set<string> {
  const out = new Set<string>();
  for (let p: Pending | null = known.pending; p; p = p.parent) for (const id of p.ids) out.add(id);
  return out;
}

/** `model`'s point index as plain data, or null when its record keeps no usable one. */
export function exportPointReads(model: ModelState): PointReadsExport | null {
  if (!hasUsablePointReads(model)) return null;
  const known = pointsByRecord.get(model.elements);
  if (!known) return null;
  const { index } = known;
  const pending = pendingIdsOf(known);
  const slots = elementSlots(model.elements);
  const sigOf = (slot: number, id: string): number => (pending.has(id) ? UNRECORDED : index.slotSig(slot));
  const counts = new Map<string, Map<number, number>>();
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    let byKind = counts.get(el.kind);
    if (!byKind) {
      byKind = new Map();
      counts.set(el.kind, byKind);
    }
    const sig = sigOf(slot, el.id);
    byKind.set(sig, (byKind.get(sig) ?? 0) + 1);
  }
  const byKind: Record<string, number> = {};
  for (const [kind, sigs] of counts) {
    let best = UNRECORDED;
    let most = -1;
    for (const [sig, n] of sigs) {
      if (n <= most) continue;
      best = sig;
      most = n;
    }
    byKind[kind] = best;
  }
  const exceptionIds: string[] = [];
  const exceptionSigs: number[] = [];
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    const sig = sigOf(slot, el.id);
    if (sig === byKind[el.kind]) continue;
    exceptionIds.push(el.id);
    exceptionSigs.push(sig);
  }
  return {
    keys: [...index.keys.list],
    signatures: index.signatures.reads.slice(EVERYTHING + 1),
    byKind,
    exceptionIds,
    exceptionSigs,
    connectionSig: index.connectionSig,
    groupSig: index.groupSig,
    wholeSig: index.wholeSig,
  };
}

/** Rebuild `model`'s point index from `exported` (written for this same state). False, and no index, when the data doesn't fit. */
export function importPointReads(model: ModelState, exported: PointReadsExport): boolean {
  const slots = elementSlots(model.elements);
  const index = new PointIndex(slots.table, model.connections, firstPartyBaseRevision(), slots.size);
  const sigCount = EVERYTHING + 1 + exported.signatures.length;
  const fits = (sig: number): boolean => sig === UNRECORDED || (Number.isInteger(sig) && sig >= 0 && sig < sigCount);
  try {
    exported.keys.forEach((key, n) => {
      if (!isReadKind(key.kind) || typeof key.id !== "string" || index.keys.idOfKey(key.kind, key.id) !== n) throw new PointReadsMismatch();
    });
    exported.signatures.forEach((reads, n) => {
      if (reads.some((id) => !Number.isInteger(id) || id < 0 || id >= exported.keys.length)) throw new PointReadsMismatch();
      if (index.signatures.internSorted(reads) !== EVERYTHING + 1 + n) throw new PointReadsMismatch();
    });
    if (![exported.connectionSig, exported.groupSig, exported.wholeSig].every(fits)) throw new PointReadsMismatch();
    if (exported.exceptionIds.length !== exported.exceptionSigs.length || !exported.exceptionSigs.every(fits)) throw new PointReadsMismatch();
    for (const sig of Object.values(exported.byKind)) if (!fits(sig)) throw new PointReadsMismatch();
  } catch (err) {
    if (err instanceof PointReadsMismatch) return false;
    throw err;
  }
  const exceptions = new Map<string, number>();
  exported.exceptionIds.forEach((id, n) => exceptions.set(id, exported.exceptionSigs[n] ?? UNRECORDED));
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    const sig = exceptions.get(el.id) ?? exported.byKind[el.kind] ?? UNRECORDED;
    if (sig !== UNRECORDED) index.setSlot(slot, sig);
  }
  index.connectionSig = exported.connectionSig;
  index.groupSig = exported.groupSig;
  index.wholeSig = exported.wholeSig;
  pointsByRecord.set(model.elements, { index, pending: null });
  return true;
}

/** Forget `model`'s point index (an adopted state that didn't check out). */
export function dropPointReads(model: ModelState): void {
  pointsByRecord.delete(model.elements);
}

class PointReadsMismatch extends Error {}

function isReadKind(kind: number): kind is PackSetReadKind {
  return Number.isInteger(kind) && kind >= 0 && kind < READ_KINDS;
}

/** What a change of pack set re-runs: checks that read a contribution the two sets answer differently. */
export interface RulesDirty {
  readonly elements: readonly ElementId[];
  /** Connections at these elements. */
  readonly connectionsAt: readonly ElementId[];
  readonly allConnections: boolean;
  /** These groups (every group when `allGroups`). */
  readonly groups: readonly ElementId[];
  readonly allGroups: boolean;
  readonly whole: boolean;
}

const NO_IDS: readonly ElementId[] = [];
const NOTHING_DIRTY: RulesDirty = { elements: NO_IDS, connectionsAt: NO_IDS, allConnections: false, groups: NO_IDS, allGroups: false, whole: false };

/** True when `model`'s record keeps an index a change of pack set can be read from (`unitsReadingChanged` won't be null). */
export function hasUsablePointReads(model: ModelState): boolean {
  const known = pointsByRecord.get(model.elements);
  return known !== undefined && known.index.connections === model.connections && known.index.baseRevision === firstPartyBaseRevision() && elementSlots(model.elements).table === known.index.table;
}

/** Every pack-set read this index's checks made whose answer differs between `from` and `to`. */
function changedReads(index: PointIndex, from: PackSet, to: PackSet): Uint8Array | null {
  const changed = new Uint8Array(index.keys.list.length);
  let any = false;
  index.keys.list.forEach((key, id) => {
    if (samePackSetRead(from, to, key.kind, key.id)) return;
    changed[id] = 1;
    any = true;
  });
  return any ? changed : null;
}

/**
 * The checks of `model` a change of pack set from `from` to `to` must re-run,
 * or null when its record keeps no usable index (then everything is).
 */
export function unitsReadingChanged(model: ModelState, from: PackSet, to: PackSet): RulesDirty | null {
  const known = pointsByRecord.get(model.elements);
  if (!known) return null;
  const { index } = known;
  if (index.connections !== model.connections || index.baseRevision !== firstPartyBaseRevision()) return null;
  const slots = elementSlots(model.elements);
  if (slots.table !== index.table) return null;
  const changed = changedReads(index, from, to);
  if (!changed && !known.pending) return NOTHING_DIRTY;
  const sigs = index.signatures.reads;
  const sigChanged = new Uint8Array(sigs.length);
  sigChanged[EVERYTHING] = 1;
  if (changed) for (let s = EVERYTHING + 1; s < sigs.length; s++) if ((sigs[s] ?? []).some((id) => changed[id] === 1)) sigChanged[s] = 1;
  const elements: ElementId[] = [];
  const keys = slots.table.keys;
  for (let slot = 0; slot < slots.size; slot++) {
    const sig = index.slotSig(slot);
    if (sig !== UNRECORDED && sigChanged[sig] !== 1) continue;
    const id = keys[slot];
    if (id !== undefined && slots.at(slot)) elements.push(asElementId(id));
  }
  // What changed since the index was built was never recorded as it is now (it may read a contribution no
  // recorded check read): re-run it, and the connections at it, whatever changed between the sets.
  const pendingIds: ElementId[] = [];
  if (known.pending) {
    const seen = new Set<string>(elements);
    for (let p: Pending | null = known.pending; p; p = p.parent) {
      for (const id of p.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        pendingIds.push(asElementId(id));
      }
    }
  }
  return {
    elements: pendingIds.length > 0 ? [...elements, ...pendingIds] : elements,
    connectionsAt: pendingIds,
    allConnections: sigChanged[index.connectionSig] === 1,
    groups: NO_IDS,
    allGroups: sigChanged[index.groupSig] === 1,
    whole: sigChanged[index.wholeSig] === 1,
  };
}

/** Readers of one id: one check inline (most ids), a short list, or a set once the list is long. */
type ReaderEntry = Unit | Unit[] | Set<Unit>;

const LIST_LIMIT = 16;
const NO_UNITS: readonly Unit[] = [];

/** Which checks read each element id. Shared by every revision of one lineage; only ever added to. */
class Readers {
  private readonly byId = new Map<string, ReaderEntry>();
  /** Checks that listed the whole record. */
  readonly everything = new Set<Unit>();

  /** Records `unit`'s reads, leaving out `skip` (its own id, or a connection's ends, which the topology index finds). */
  add(unit: Unit, reads: readonly string[], all: boolean, skip: (id: string) => boolean): void {
    if (all) this.everything.add(unit);
    for (const id of reads) {
      if (skip(id)) continue;
      const entry = this.byId.get(id);
      if (entry === undefined) this.byId.set(id, unit);
      else if (entry instanceof Set) entry.add(unit);
      else if (Array.isArray(entry)) {
        if (entry.includes(unit)) continue;
        if (entry.length < LIST_LIMIT) entry.push(unit);
        else this.byId.set(id, new Set([...entry, unit]));
      } else if (entry !== unit) this.byId.set(id, [entry, unit]);
    }
  }

  of(id: string): Iterable<Unit> {
    const entry = this.byId.get(id);
    if (entry === undefined) return NO_UNITS;
    if (entry instanceof Set || Array.isArray(entry)) return entry;
    return [entry];
  }
}

const ownId =
  (self: string) =>
  (id: string): boolean =>
    id === self;

const endsOf =
  (c: Connection) =>
  (id: string): boolean =>
    id === c.a.elementId || id === c.b.elementId;

/** A view of an element record that records every id read through it. */
class ReadTracker {
  reads: string[] = [];
  all = false;
  readonly record: Elements;

  constructor(source: Elements) {
    const read = elementReader(source);
    const note = (key: string): void => {
      if (!this.all) this.reads.push(key);
    };
    this.record = new Proxy<Record<string, BimElement>>(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== "string") return undefined;
          note(key);
          return read(key);
        },
        has: (_target, key) => {
          if (typeof key !== "string") return false;
          note(key);
          return read(key) !== undefined;
        },
        ownKeys: () => {
          this.all = true;
          return Reflect.ownKeys(source);
        },
        getOwnPropertyDescriptor: (_target, key) => {
          if (typeof key !== "string") return undefined;
          note(key);
          const value = read(key);
          return value === undefined ? undefined : { value, writable: false, enumerable: true, configurable: true };
        },
        set: () => {
          throw new TypeError("Validation reads the model; it never writes it");
        },
        deleteProperty: () => {
          throw new TypeError("Validation reads the model; it never writes it");
        },
        defineProperty: () => {
          throw new TypeError("Validation reads the model; it never writes it");
        },
      },
    );
  }

  start(): void {
    this.reads = [];
    this.all = false;
  }
}

export interface Ledger<I extends LedgerIssue> {
  readonly connections: readonly Connection[];
  readonly settings: ModelSettings;
  readonly rules: object;
  readonly readers: Readers;
  readonly byConnection: ReadonlyMap<Connection, readonly I[]>;
  /** Connections with issues, in list order, and their positions. */
  readonly connectionOrder: readonly Connection[];
  readonly connectionAt: ReadonlyMap<Connection, number>;
  readonly byElement: ReadonlyMap<ElementId, readonly I[]>;
  /** Elements with issues, in key order. */
  readonly elementOrder: readonly ElementId[];
  readonly groupOf: ReadonlyMap<ElementId, ElementId>;
  /** Each group's members in key order. */
  readonly members: ReadonlyMap<ElementId, readonly ElementId[]>;
  readonly byGroup: ReadonlyMap<ElementId, readonly I[]>;
  /** Groups with issues, in key order of their first member. */
  readonly groupOrder: readonly ElementId[];
  readonly whole: I | null;
  /** Every issue, in full validation's order. */
  readonly issues: readonly I[];
  /** The issue list this one was carried forward from (null when built from scratch). */
  readonly from: readonly I[] | null;
  /** Issues this step produced that are not objects of `from`. */
  readonly fresh: ReadonlySet<I>;
  /** Element reads are recorded only for `recorded` checks; every other check is valid and found through `UnitChecks.structural`. */
  readonly sparse: boolean;
  /** A sparse ledger's checks with recorded reads (those with issues). Empty for a full ledger. */
  readonly recorded: ReadonlySet<Unit>;
}

function assemble<I extends LedgerIssue>(
  connectionOrder: readonly Connection[],
  byConnection: ReadonlyMap<Connection, readonly I[]>,
  elementOrderList: readonly ElementId[],
  byElement: ReadonlyMap<ElementId, readonly I[]>,
  groupOrder: readonly ElementId[],
  byGroup: ReadonlyMap<ElementId, readonly I[]>,
  whole: I | null,
): I[] {
  const out: I[] = [];
  for (const c of connectionOrder) for (const issue of byConnection.get(c) ?? []) out.push(issue);
  for (const id of elementOrderList) for (const issue of byElement.get(id) ?? []) out.push(issue);
  for (const key of groupOrder) for (const issue of byGroup.get(key) ?? []) out.push(issue);
  if (whole) out.push(whole);
  return out;
}

/** Full validation, unit by unit, recording what each unit read. Throws where full validation throws. */
export function buildLedger<I extends LedgerIssue>(model: ModelState, checks: UnitChecks<I>): Ledger<I> {
  stats.fullPasses += 1;
  const pass = recordPass(model);
  try {
    return buildRecorded(model, checks, pass);
  } finally {
    pass.end();
  }
}

function buildRecorded<I extends LedgerIssue>(model: ModelState, checks: UnitChecks<I>, pass: PassRecorder): Ledger<I> {
  const tracker = new ReadTracker(model.elements);
  const tracked: ModelState = { ...model, elements: tracker.record };
  const readers = new Readers();

  const byConnection = new Map<Connection, readonly I[]>();
  const connectionOrder: Connection[] = [];
  const connectionAt = new Map<Connection, number>();
  model.connections.forEach((c, pos) => {
    tracker.start();
    const out: I[] = [];
    pass.begin();
    checks.connection(tracked, c, out);
    pass.connection();
    readers.add(c, tracker.reads, tracker.all, endsOf(c));
    if (out.length === 0) return;
    byConnection.set(c, out);
    connectionOrder.push(c);
    connectionAt.set(c, pos);
  });

  const byElement = new Map<ElementId, readonly I[]>();
  const elementOrderList: ElementId[] = [];
  const groupOf = new Map<ElementId, ElementId>();
  const members = new Map<ElementId, ElementId[]>();
  const slots = elementSlots(model.elements);
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    tracker.start();
    const out: I[] = [];
    pass.begin();
    const key = checks.element(tracked, el, out);
    pass.element(slot);
    readers.add(el.id, tracker.reads, tracker.all, ownId(el.id));
    if (key !== null) {
      groupOf.set(el.id, key);
      const list = members.get(key);
      if (list) list.push(el.id);
      else members.set(key, [el.id]);
    }
    if (out.length > 0) {
      byElement.set(el.id, out);
      elementOrderList.push(el.id);
    }
  }

  const byGroup = new Map<ElementId, readonly I[]>();
  const groupOrder: ElementId[] = [];
  for (const [key, ids] of members) {
    const out: I[] = [];
    pass.begin();
    checks.group(model, key, membersOf(model.elements, ids), out);
    pass.group();
    if (out.length === 0) continue;
    byGroup.set(key, out);
    groupOrder.push(key);
  }

  pass.begin();
  const whole = checks.whole(model);
  pass.whole();
  const issues = assemble(connectionOrder, byConnection, elementOrderList, byElement, groupOrder, byGroup, whole);
  return {
    connections: model.connections,
    settings: model.settings,
    rules: checks.rules(),
    readers,
    byConnection,
    connectionOrder,
    connectionAt,
    byElement,
    elementOrder: elementOrderList,
    groupOf,
    members,
    byGroup,
    groupOrder,
    whole,
    issues,
    from: null,
    fresh: new Set(issues),
    sparse: false,
    recorded: new Set(),
  };
}

/** A sparse ledger of a model every check of which is valid under `rules` (what a switch on a valid model starts from). */
export function validLedger<I extends LedgerIssue>(model: ModelState, rules: object): Ledger<I> {
  return {
    connections: model.connections,
    settings: model.settings,
    rules,
    readers: new Readers(),
    byConnection: new Map(),
    connectionOrder: [],
    connectionAt: new Map(),
    byElement: new Map(),
    elementOrder: [],
    groupOf: new Map(),
    members: new Map(),
    byGroup: new Map(),
    groupOrder: [],
    whole: null,
    issues: [],
    from: null,
    fresh: new Set(),
    sparse: true,
    recorded: new Set(),
  };
}

/**
 * A sparse ledger for `model` from the checks a cold pass found issues in
 * (`dirty`): those run again, recorded; every other check is known valid.
 * Null when one throws (the full ledger then answers).
 */
export function seedSparseLedger<I extends LedgerIssue>(model: ModelState, checks: UnitChecks<I>, dirty: RulesDirty): Ledger<I> | null {
  const rules = checks.rules();
  try {
    return update(validLedger<I>(model, rules), model, model, [], checks, rules, dirty, NO_IDS);
  } catch (err) {
    if (!(err instanceof NeedsFullPass)) throw err;
    return null;
  }
}

function membersOf(elements: Elements, ids: readonly ElementId[]): BimElement[] {
  const out: BimElement[] = [];
  for (const id of ids) {
    const el = elements[id];
    if (el) out.push(el);
  }
  return out;
}

function sameIssue(a: LedgerIssue, b: LedgerIssue): boolean {
  if (a.code !== b.code || a.message !== b.message || a.elementIds.length !== b.elementIds.length) return false;
  for (let i = 0; i < a.elementIds.length; i++) if (a.elementIds[i] !== b.elementIds[i]) return false;
  return true;
}

/** `next` when it differs from `prev`, else `prev` itself (so unchanged answers keep their identity). */
function keepSame<I extends LedgerIssue>(prev: readonly I[] | undefined, next: I[]): readonly I[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b || !sameIssue(a, b)) return next;
  }
  return prev;
}

/** Insert `item` into `list` (sorted by `key`) at its place. */
function insertSorted<T>(list: T[], item: T, key: (item: T) => number): void {
  const k = key(item);
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = list[mid];
    if (at !== undefined && key(at) < k) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

/** A map copied on its first write, so an edit that touches none of its keys shares the prior one. */
class CopyOnWrite<K, V> {
  private own: Map<K, V> | null = null;

  constructor(private readonly base: ReadonlyMap<K, V>) {}

  get(key: K): V | undefined {
    return (this.own ?? this.base).get(key);
  }

  has(key: K): boolean {
    return (this.own ?? this.base).has(key);
  }

  set(key: K, value: V): void {
    if (!this.own && this.base.get(key) === value && this.base.has(key)) return;
    this.write().set(key, value);
  }

  delete(key: K): void {
    if ((this.own ?? this.base).has(key)) this.write().delete(key);
  }

  keys(): IterableIterator<K> {
    return (this.own ?? this.base).keys();
  }

  get changed(): boolean {
    return this.own !== null;
  }

  result(): ReadonlyMap<K, V> {
    return this.own ?? this.base;
  }

  private write(): Map<K, V> {
    this.own ??= new Map(this.base);
    return this.own;
  }
}

/** Thrown inside an update when the exact answer needs a full pass (a check threw). */
class NeedsFullPass extends Error {}

/**
 * `after`'s ledger from `prev` (the ledger of `prior`), where `after` differs
 * from `prior` only in the elements `changed` lists and, possibly, in its
 * connection list. Re-runs the checks that read a changed element or a
 * changed connection, and nothing else. Falls back to a full pass when the
 * settings or the rule set differ, and when a re-run check throws (so the
 * error is the one full validation reports first).
 */
export function updateLedger<I extends LedgerIssue>(prev: Ledger<I>, prior: ModelState, after: ModelState, changed: readonly ElementId[], checks: UnitChecks<I>): Ledger<I> {
  const rules = checks.rules();
  if (after.settings !== prev.settings) return buildLedger(after, checks);
  let dirty: RulesDirty | null = null;
  if (rules !== prev.rules) {
    // Another pack set: re-run what reads a contribution it answers differently.
    dirty = prev.rules instanceof PackSet && rules instanceof PackSet ? unitsReadingChanged(after, prev.rules, rules) : null;
    if (!dirty) return buildLedger(after, checks);
  }
  const reach = prev.sparse ? checks.structural(prior, after, changed) : NO_IDS;
  if (!reach) return buildLedger(after, checks);
  try {
    return update(prev, prior, after, changed, checks, rules, dirty, reach);
  } catch (err) {
    if (!(err instanceof NeedsFullPass)) throw err;
    return buildLedger(after, checks);
  }
}

function update<I extends LedgerIssue>(
  prev: Ledger<I>,
  prior: ModelState,
  after: ModelState,
  changed: readonly ElementId[],
  checks: UnitChecks<I>,
  rules: object,
  dirty: RulesDirty | null,
  reach: readonly ElementId[],
): Ledger<I> {
  const outer = swapPackSetReadRecorder(null);
  try {
    return updateRecorded(prev, prior, after, changed, checks, rules, dirty, reach, outer);
  } finally {
    swapPackSetReadRecorder(outer);
  }
}

function updateRecorded<I extends LedgerIssue>(
  prev: Ledger<I>,
  prior: ModelState,
  after: ModelState,
  changed: readonly ElementId[],
  checks: UnitChecks<I>,
  rules: object,
  dirty: RulesDirty | null,
  reach: readonly ElementId[],
  outer: PackSetReadRecorder | null,
): Ledger<I> {
  const sparse = prev.sparse;
  const recorded = new Set<Unit>(prev.recorded);
  // What each re-run check reads of the pack set joins the record's index.
  const points = pointsByRecord.get(after.elements)?.index ?? null;
  const rec = points?.recorder ?? null;
  const begin = (): void => {
    rec?.begin();
    swapPackSetReadRecorder(rec);
  };
  const done = (): void => {
    swapPackSetReadRecorder(outer);
  };
  const changedSet = new Set<ElementId>(changed);
  const dirtyElements = new Set<ElementId>();
  const dirtyConnections = new Set<Connection>();
  const mark = (u: Unit): void => {
    if (typeof u === "string") dirtyElements.add(u);
    else dirtyConnections.add(u);
  };
  for (const id of changedSet) {
    dirtyElements.add(id);
    for (const u of prev.readers.of(id)) mark(u);
    for (const c of checks.connectionsAt(prior, id)) dirtyConnections.add(c);
  }
  for (const u of prev.readers.everything) mark(u);
  for (const id of reach) {
    dirtyElements.add(id);
    for (const c of checks.connectionsAt(prior, id)) dirtyConnections.add(c);
  }
  if (dirty) {
    for (const id of dirty.elements) dirtyElements.add(id);
    for (const id of dirty.connectionsAt) for (const c of checks.connectionsAt(prior, id)) dirtyConnections.add(c);
  }
  stats.updates += 1;
  stats.unitsRerun += dirtyElements.size + dirtyConnections.size;

  const tracker = new ReadTracker(after.elements);
  const tracked: ModelState = { ...after, elements: tracker.record };
  const fresh = new Set<I>();
  const take = (prevIssues: readonly I[] | undefined, out: I[]): readonly I[] => {
    const kept = keepSame(prevIssues, out);
    if (kept !== prevIssues) for (const issue of kept) fresh.add(issue);
    return kept;
  };
  const rerun = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      // The first error in full validation's order is what the edit reports: let a full pass find it.
      throw new NeedsFullPass(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Connections ─────────────────────────────────────────────────────────
  const byConnection = new CopyOnWrite(prev.byConnection);
  let connectionAt: CopyOnWrite<Connection, number>;
  const recheck: Array<{ c: Connection; pos: number }> = [];
  if (after.connections === prev.connections && dirty?.allConnections) {
    connectionAt = new CopyOnWrite(prev.connectionAt);
    after.connections.forEach((c, pos) => recheck.push({ c, pos }));
  } else if (after.connections === prev.connections) {
    connectionAt = new CopyOnWrite(prev.connectionAt);
    for (const c of dirtyConnections) {
      const pos = prev.connectionAt.get(c) ?? checks.connectionPosition(prior, c);
      if (pos >= 0) recheck.push({ c, pos });
    }
  } else {
    // Walk both lists together: what survives keeps its relative order; the rest of the new list is re-checked.
    connectionAt = new CopyOnWrite(new Map());
    const old = prev.connections;
    const now = after.connections;
    let i = 0;
    for (let j = 0; j < now.length; j++) {
      const c = now[j];
      if (!c) continue;
      while (i < old.length && old[i] !== c) {
        const gone = old[i];
        if (gone) byConnection.delete(gone);
        i++;
      }
      if (i < old.length) {
        i++;
        if (dirtyConnections.has(c)) recheck.push({ c, pos: j });
        else if (byConnection.has(c)) connectionAt.set(c, j);
      } else {
        byConnection.delete(c);
        recheck.push({ c, pos: j });
      }
    }
    for (; i < old.length; i++) {
      const gone = old[i];
      if (gone) byConnection.delete(gone);
    }
  }
  recheck.sort((a, b) => a.pos - b.pos);
  const rechecked = new Set(recheck.map((r) => r.c));
  const connectionOrder: Connection[] = prev.connectionOrder.filter((c) => byConnection.has(c) && connectionAt.has(c) && !rechecked.has(c));
  for (const { c, pos } of recheck) {
    tracker.start();
    let out: I[] = [];
    begin();
    try {
      rerun(() => checks.connection(sparse ? after : tracked, c, out));
    } finally {
      done();
    }
    if (points) points.connectionSig = points.signatures.union(points.connectionSig, points.readSig());
    if (!sparse) prev.readers.add(c, tracker.reads, tracker.all, endsOf(c));
    else if (out.length === 0) recorded.delete(c);
    else {
      // A sparse ledger records what a check with issues reads: run it again through the tracker.
      out = [];
      rerun(() => checks.connection(tracked, c, out));
      prev.readers.add(c, tracker.reads, tracker.all, endsOf(c));
      recorded.add(c);
    }
    if (out.length === 0) {
      byConnection.delete(c);
      connectionAt.delete(c);
      continue;
    }
    byConnection.set(c, take(prev.byConnection.get(c), out));
    connectionAt.set(c, pos);
    insertSorted(connectionOrder, c, (x) => connectionAt.get(x) ?? -1);
  }
  for (const c of [...connectionAt.keys()]) if (!byConnection.has(c)) connectionAt.delete(c);

  // ── Elements ────────────────────────────────────────────────────────────
  const priorElements = prior.elements;
  const priorOrder = elementOrder(priorElements);
  const priorSlot = (id: ElementId): number | undefined => (priorElements[id] !== undefined ? priorOrder.get(id) : undefined);
  const byElement = new CopyOnWrite(prev.byElement);
  const groupOf = new CopyOnWrite(prev.groupOf);
  const dirtyGroups = new Set<ElementId>();
  /** Re-run elements that are new to the record (or put back): their place in key order is the new record's. */
  let placedLate = false;
  const ordered = [...dirtyElements].map((id) => ({ id, slot: priorSlot(id) }));
  ordered.sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER));
  const issued = new Set<ElementId>();
  for (const { id, slot } of ordered) {
    const before = prev.groupOf.get(id);
    if (before !== undefined) dirtyGroups.add(before);
    const el = after.elements[id];
    if (!el) {
      byElement.delete(id);
      groupOf.delete(id);
      continue;
    }
    if (slot === undefined) placedLate = true;
    tracker.start();
    let out: I[] = [];
    begin();
    let key: ElementId | null;
    try {
      key = rerun(() => checks.element(sparse ? after : tracked, el, out));
    } finally {
      done();
    }
    points?.recordId(id);
    if (!sparse) prev.readers.add(id, tracker.reads, tracker.all, ownId(id));
    else if (out.length === 0) recorded.delete(id);
    else {
      out = [];
      key = rerun(() => checks.element(tracked, el, out));
      prev.readers.add(id, tracker.reads, tracker.all, ownId(id));
      recorded.add(id);
    }
    if (key === null) groupOf.delete(id);
    else if (sparse && !recorded.has(id)) {
      // A valid check files its element where the topology does: a sparse ledger keeps no entry for it.
      groupOf.delete(id);
      dirtyGroups.add(key);
    } else {
      groupOf.set(id, key);
      dirtyGroups.add(key);
    }
    if (out.length === 0) byElement.delete(id);
    else {
      byElement.set(id, take(prev.byElement.get(id), out));
      issued.add(id);
    }
  }

  // Key order of `after`: the prior record's for every element it keeps in place, the new record's once one was added.
  let afterOrder: ReadonlyMap<string, number> | null = null;
  const placeOf = (id: ElementId): number => {
    if (placedLate) {
      afterOrder ??= elementOrder(after.elements);
      return afterOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
    }
    return priorOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
  };

  // Untouched elements keep their relative order in either record, so the carried list stays sorted.
  let elementOrderList: readonly ElementId[] = prev.elementOrder;
  // Unchanged entries: the same elements have issues, in the same places.
  if (byElement.changed) {
    const list = prev.elementOrder.filter((id) => byElement.has(id) && !dirtyElements.has(id));
    for (const id of issued) insertSorted(list, id, placeOf);
    elementOrderList = list;
  }

  // ── Groups ──────────────────────────────────────────────────────────────
  const members = new CopyOnWrite(prev.members);
  const byGroup = new CopyOnWrite(prev.byGroup);
  const joining = new Map<ElementId, ElementId[]>();
  for (const id of dirtyElements) {
    const key = groupOf.get(id);
    if (key === undefined) continue;
    const list = joining.get(key);
    if (list) list.push(id);
    else joining.set(key, [id]);
  }
  if (dirty?.allGroups) for (const key of sparse ? checks.groupKeys(after) : prev.members.keys()) dirtyGroups.add(key);
  for (const id of dirty?.groups ?? NO_IDS) dirtyGroups.add(id);
  for (const key of dirtyGroups) {
    let kept: ElementId[];
    if (sparse) {
      // The topology's members, less checks with issues that file their element elsewhere (or nowhere).
      kept = checks.groupMembers(after, key).filter((id) => (groupOf.has(id) ? groupOf.get(id) === key : !recorded.has(id)));
    } else {
      kept = (prev.members.get(key) ?? []).filter((id) => groupOf.get(id) === key && !dirtyElements.has(id));
      for (const id of joining.get(key) ?? []) insertSorted(kept, id, placeOf);
    }
    if (kept.length === 0) {
      members.delete(key);
      byGroup.delete(key);
      continue;
    }
    members.set(key, kept);
    const out: I[] = [];
    begin();
    try {
      rerun(() => checks.group(after, key, membersOf(after.elements, kept), out));
    } finally {
      done();
    }
    if (points) points.groupSig = points.signatures.union(points.groupSig, points.readSig());
    if (out.length === 0) byGroup.delete(key);
    else byGroup.set(key, take(prev.byGroup.get(key), out));
  }
  const firstOf = (key: ElementId): number => {
    const first = members.get(key)?.[0];
    return first === undefined ? Number.MAX_SAFE_INTEGER : placeOf(first);
  };
  let groupOrder: readonly ElementId[] = prev.groupOrder;
  if (byGroup.changed || members.changed) {
    const list = prev.groupOrder.filter((key) => byGroup.has(key) && !dirtyGroups.has(key));
    for (const key of dirtyGroups) if (byGroup.has(key)) insertSorted(list, key, firstOf);
    groupOrder = list;
  }

  // ── The whole model ─────────────────────────────────────────────────────
  let whole = prev.whole;
  if (dirty?.whole || !checks.sameWhole(prior, after, changed)) {
    begin();
    let next: I | null;
    try {
      next = rerun(() => checks.whole(after));
    } finally {
      done();
    }
    if (points) points.wholeSig = points.signatures.union(points.wholeSig, points.readSig());
    whole = next && prev.whole && sameIssue(next, prev.whole) ? prev.whole : next;
    if (whole && whole !== prev.whole) fresh.add(whole);
  }

  const issues = assemble(connectionOrder, byConnection.result(), elementOrderList, byElement.result(), groupOrder, byGroup.result(), whole);
  return {
    connections: after.connections,
    settings: after.settings,
    rules,
    readers: prev.readers,
    byConnection: byConnection.result(),
    connectionOrder,
    connectionAt: connectionAt.result(),
    byElement: byElement.result(),
    elementOrder: elementOrderList,
    groupOf: groupOf.result(),
    members: members.result(),
    byGroup: byGroup.result(),
    groupOrder,
    whole,
    issues,
    from: prev.issues,
    fresh,
    sparse,
    recorded,
  };
}
