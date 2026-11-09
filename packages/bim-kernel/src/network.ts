import { registerRevisionCarry } from "./revision-carry";
import { connectionEndSlots, elementSlots, elementsOfKind, recordsOfKinds, type ElementSlots } from "./store";
import type { ValidationIssue } from "./validate";
import { asElementId, type BimElement, type Connection, type ConnectorEnd, type ElementId, type ModelSettings, type ModelState } from "./types";
import { connectorEndsTable, FIRST_ENDS_CODE as ENDS_FIRST, ROOT_FLAG as ENDS_ROOT, SHARED_ENDS_CODE as ENDS_SHARED, type ConnectorEndsTable } from "./kinds/ends";
import { storedField } from "./kinds";
import { treeNetwork, type TreeNetwork, type TreeTotal } from "./tree-network";
import { activePackSet, modelStatePackSet, withPackSet } from "./packs/scope";
import type { PackSet } from "./packs/set";
import { isModelSetupRecordId } from "./organization/setup";

/**
 * Tree orientation: every system is a tree rooted at a source. Which kinds
 * start a tree, which connector ends lead downstream and which kinds hang
 * on a host without a connection are the add-ons' kind rows
 * (`ELEMENT_KIND_POINT` `connectorEnds`, resolved in `kinds/ends.ts`); a
 * kind no row gives ends to joins no tree.
 */
export { downstreamEndsOf, upstreamEndOf } from "./kinds/ends";

/** Kinds with no connectors and no references to other elements. */
const DOCUMENT_ONLY_KINDS: ReadonlySet<BimElement["kind"]> = new Set(["view", "sheet", "viewport", "drawing_item", "organization"]);

/**
 * Kinds that sit outside the connected network and the reference graph: a
 * command may add them without changing any topology index (placed parts
 * reach their type and level by id, checked by validation, not by the index).
 * Routed runs are the same: their links live on the elements at both ends
 * (routing/), so adding, linking or removing them never rebuilds the index.
 */
const ISOLATED_KINDS: ReadonlySet<BimElement["kind"]> = new Set(["level", "mounting_plane", "part_type", "element_type", "part", "mep_system", "run_segment", "run_fitting", "service_link", "service_catalog", "load_point", "space", "zone", "drawing_underlay", "question", "ceiling", "determination", "rule", "requirement_state", "observation", "construction_stage"]);

export function isIsolatedElement(el: BimElement): boolean {
  return ISOLATED_KINDS.has(el.kind);
}

/** True when a kind row in force gives `el`'s kind connector ends (it belongs to a tree). */
export function isNetworkElement(el: Pick<BimElement, "kind">): boolean {
  return connectorEndsTable().isNetworkKind(el.kind);
}

/** Elements whose own position or value depends on another element: hosted openings, tags, dimensions. */
function referencesOf(el: BimElement): readonly ElementId[] {
  switch (el.kind) {
    case "opening":
      return [el.hostId];
    case "tag":
      return [el.targetId];
    case "dimension":
      return [el.aId, el.bId];
    default:
      return NO_IDS;
  }
}

/**
 * What the topology passes need to know of a slot's kind, one byte per slot.
 * The low codes are the index's own; a kind with connector ends has its
 * code from the ends table (`FIRST_ENDS_CODE` up), which says its downstream
 * ends, whether it starts a tree and whether it hangs on a host. Whether a
 * slot hosts others is the tree's (`TreeNetwork.hostsTaps`), not its code's.
 */
const SlotKind = { Empty: 0, Other: 1, Riser: 2, Reference: 3 } as const;

// Read once: a module's exported constants can be getters after compilation, too slow for a pass over every slot.
const FIRST_ENDS_CODE: number = ENDS_FIRST;
const SHARED_ENDS_CODE: number = ENDS_SHARED;
const ROOT_FLAG: number = ENDS_ROOT;

const FIXED_CODES: ReadonlyMap<string, number> = new Map([
  ["riser_segment", SlotKind.Riser],
  ["opening", SlotKind.Reference],
  ["tag", SlotKind.Reference],
  ["dimension", SlotKind.Reference],
]);

/**
 * Every kind's slot code under one ends table (the index's own codes plus the
 * table's), resolved once per table. A short list is scanned (record and row
 * kind strings are interned, so the scan compares by identity); a long one is a map.
 */
interface SlotCodes {
  readonly kinds: readonly string[];
  readonly codes: readonly number[];
  readonly map: ReadonlyMap<string, number> | null;
}

const SCAN_LIMIT = 16;
const codesByTable = new WeakMap<ConnectorEndsTable, SlotCodes>();

function codesOf(ends: ConnectorEndsTable): SlotCodes {
  let codes = codesByTable.get(ends);
  if (!codes) {
    // Kinds with ends first: in a connected model they are most of the records.
    const all = new Map<string, number>();
    for (const kind of ends.kinds) if (!FIXED_CODES.has(kind)) all.set(kind, ends.code(kind));
    for (const [kind, code] of FIXED_CODES) all.set(kind, code);
    codes = { kinds: [...all.keys()], codes: [...all.values()], map: all.size > SCAN_LIMIT ? all : null };
    codesByTable.set(ends, codes);
  }
  return codes;
}

function codeIn(codes: SlotCodes, kind: string): number {
  if (codes.map !== null) return codes.map.get(kind) ?? SlotKind.Other;
  const { kinds } = codes;
  for (let i = 0; i < kinds.length; i++) if (kinds[i] === kind) return codes.codes[i] ?? SlotKind.Other;
  return SlotKind.Other;
}

function slotKindOf(kind: string, ends: ConnectorEndsTable): number {
  return codeIn(codesOf(ends), kind);
}

/** The slot codes `kinds` map to, as a bit mask (`1 << code`). */
function codeMaskOf(kinds: readonly string[], ends: ConnectorEndsTable): number {
  let mask = ends.mask(kinds);
  for (const kind of kinds) if (!ends.isNetworkKind(kind)) mask |= 1 << slotKindOf(kind, ends);
  return mask;
}

/** The kinds `isNetworkElement` accepts. */
function isNetworkSlot(k: number): boolean {
  return k >= FIRST_ENDS_CODE;
}

/** True when `code` stands for exactly one kind: an ends-table code short of the shared one, or the riser's. */
function isSingleKindCode(code: number): boolean {
  return (code >= FIRST_ENDS_CODE && code !== SHARED_ENDS_CODE) || code === SlotKind.Riser;
}

/** Whether the kind at `s` hosts taps, asked once per code where the code names one kind (`byCode`: -1 not asked yet). */
function hostsTapsAt(tree: TreeNetwork, byCode: Int8Array, code: number, slots: ElementSlots, s: number): boolean {
  if (!isSingleKindCode(code)) return tree.hostsTaps(slots.at(s)?.kind ?? "");
  const known = byCode[code] ?? -1;
  if (known >= 0) return known === 1;
  const answer = tree.hostsTaps(slots.at(s)?.kind ?? "");
  byCode[code] = answer ? 1 : 0;
  return answer;
}

const NO_IDS: readonly ElementId[] = [];
const NO_ENDS: readonly ConnectorEnd[] = [];
const NO_CONNECTIONS: readonly Connection[] = [];
const NO_POSITIONS: readonly number[] = [];

/** An id this index has no slot for: absent from the record's key table, or appended by a later revision. */
const NO_SLOT = -1;

/** Per-slot lists of ints: row `r` is `items[start[r]]` up to `items[start[r + 1] - 1]`. */
interface Rows {
  readonly start: Int32Array;
  readonly items: Int32Array;
}

/** Groups `values[i]` under row `keys[i]`, keeping the order of `i` within each row. */
function rowsOf(rows: number, keys: readonly number[], values: readonly number[]): Rows {
  const start = new Int32Array(rows + 1);
  for (const k of keys) start[k + 1] = (start[k + 1] ?? 0) + 1;
  for (let r = 0; r < rows; r++) start[r + 1] = (start[r + 1] ?? 0) + (start[r] ?? 0);
  const fill = start.slice(0, rows);
  const items = new Int32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] ?? 0;
    const at = fill[k] ?? 0;
    items[at] = values[i] ?? 0;
    fill[k] = at + 1;
  }
  return { start, items };
}

/**
 * Both ends of a connection name the same element. Ids with a slot are equal
 * exactly when their slots are, so only unslotted ends compare the id strings.
 */
function sameEnds(c: Connection, a: number, b: number): boolean {
  if (a !== NO_SLOT) return a === b;
  return b === NO_SLOT && c.a.elementId === c.b.elementId;
}

/** The stored host id of an element of a hosted kind (`hostedBy.field`), or null. */
function hostIdOf(el: BimElement, field: string | null): string | null {
  if (field === null) return null;
  const id = storedField(el, field);
  return typeof id === "string" ? id : null;
}

/** The most downstream ends any kind in `ends` has (for sizing the child rows). */
function maxDownstream(ends: ConnectorEndsTable): number {
  let max = 0;
  for (const kind of ends.kinds) max = Math.max(max, ends.downstream(kind).length);
  return max;
}

function listFor<T>(map: Map<string, T[]>, key: string): T[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

/**
 * Topology of one model: who connects to whom. Depends only on the element
 * set, element kinds, tap hosts and the connection list, none of which a
 * command changes, so one index serves every revision of a model.
 *
 * Elements are addressed by their slot in the record's key table (an
 * element's id is its key), so building the index allocates a few int arrays
 * rather than an entry and a list per element. Ids with no slot here (a
 * connection to an element that does not exist, a tap whose host is gone)
 * are kept in small side maps.
 */
/** What `NetworkIndex.after` hands its constructor: the rows it rebuilt and the ones it shares. */
interface PatchedRows {
  readonly tree: TreeNetwork;
  readonly ends: ConnectorEndsTable;
  readonly slots: ElementSlots;
  readonly conns: Rows;
  readonly connA: Int32Array;
  readonly connB: Int32Array;
  readonly connsUnslotted: Map<string, number[]>;
  readonly taps: Rows;
  readonly tapsUnslotted: Map<string, ElementId[]>;
  readonly refs: Rows;
  readonly refsUnslotted: Map<string, ElementId[]>;
  readonly refFirst: Int32Array;
  readonly refSecond: Map<number, number>;
  readonly slotKinds: Uint8Array;
  readonly risers: Map<string, ElementId[]>;
  readonly kids: Rows;
  readonly unslotted: string[];
  readonly parentOf: Int32Array;
  readonly parentUnslotted: Map<string, number>;
  readonly equipmentOrder: Map<ElementId, number> | null;
  readonly nestedEquipment: boolean;
}

export class NetworkIndex {
  /** Position of each element id in the record's key order (iteration order). */
  readonly order: ReadonlyMap<string, number>;
  /** Slots below this are the indexed record's. */
  readonly size: number;
  /** The tree's declarations this index was built under (which kinds host taps, what is totalled). */
  readonly tree: TreeNetwork;
  /** The kinds' connector ends this index was built under (the add-ons' kind rows). */
  readonly ends: ConnectorEndsTable;
  private readonly ids: readonly string[];
  private readonly slots: ElementSlots;
  /** Connection positions at each slot, in connection order. */
  private readonly conns: Rows;
  /** Each connection's end slots (NO_SLOT when the end has no slot). */
  private readonly connA: Int32Array;
  private readonly connB: Int32Array;
  private readonly connsUnslotted = new Map<string, number[]>();
  /** Tap slots per host slot, in element order. */
  private readonly taps: Rows;
  private readonly tapsUnslotted = new Map<string, ElementId[]>();
  /** Opening / tag / dimension slots per referenced slot, in element order. */
  private readonly refs: Rows;
  private readonly refsUnslotted = new Map<string, ElementId[]>();
  /**
   * Forward references by slot: a tap's host, an opening's host, a tag's
   * target, a dimension's first end (NO_SLOT for other kinds and for ids with
   * no slot); `refSecond` holds a dimension's second end. Cold full-model
   * checks read referenced elements through these instead of by id.
   */
  private readonly refFirst: Int32Array;
  private readonly refSecond: Map<number, number>;
  /** Each slot's kind as a `SlotKind` (0: no element), so later walks skip slots without reading them. */
  private readonly slotKinds: Uint8Array;
  private readonly risers = new Map<string, ElementId[]>();
  /** Downstream neighbours per slot: a slot, or `-1 - i` for `unslotted[i]`. */
  private readonly kids: Rows;
  private readonly unslotted: string[] = [];
  /** Parent slot per slot (NO_SLOT for a root); unslotted children's parents in the side map. */
  private readonly parentOf: Int32Array;
  private readonly parentUnslotted = new Map<string, number>();
  /** False when some element has two parents or the graph has a cycle. */
  readonly isTree: boolean;
  private rank: Map<ElementId, number> | null = null;
  /** Per-equipment-tree post order, built on first use of that tree. */
  private readonly treeRank = new Map<ElementId, Map<ElementId, number>>();
  /** Equipment in element order, and whether any equipment sits under another (then only the global walk is exact). */
  private equipmentOrder: Map<ElementId, number> | null = null;
  private nestedEquipment = false;
  private unreached: readonly ElementId[] | null = null;

  constructor(
    readonly connections: readonly Connection[],
    private readonly elements: Readonly<Record<string, BimElement>>,
    patched?: PatchedRows,
  ) {
    if (patched) {
      const { slots } = patched;
      this.tree = patched.tree;
      this.ends = patched.ends;
      this.slots = slots;
      this.order = slots.table.slotOf;
      this.ids = slots.table.keys;
      this.size = slots.size;
      this.conns = patched.conns;
      this.connA = patched.connA;
      this.connB = patched.connB;
      this.connsUnslotted = patched.connsUnslotted;
      this.taps = patched.taps;
      this.tapsUnslotted = patched.tapsUnslotted;
      this.refs = patched.refs;
      this.refsUnslotted = patched.refsUnslotted;
      this.refFirst = patched.refFirst;
      this.refSecond = patched.refSecond;
      this.slotKinds = patched.slotKinds;
      this.risers = patched.risers;
      this.kids = patched.kids;
      this.unslotted = patched.unslotted;
      this.parentOf = patched.parentOf;
      this.parentUnslotted = patched.parentUnslotted;
      this.isTree = true;
      this.equipmentOrder = patched.equipmentOrder;
      this.nestedEquipment = patched.nestedEquipment;
      return;
    }
    const declared = treeNetwork();
    this.tree = declared;
    const endsTable = connectorEndsTable();
    this.ends = endsTable;
    const slots = elementSlots(elements);
    this.slots = slots;
    this.order = slots.table.slotOf;
    this.ids = slots.table.keys;
    const n = slots.size;
    this.size = n;

    const m = connections.length;
    // Shared with the area index, which resolved the same ends on the first join.
    const { a: connA, b: connB } = connectionEndSlots(connections, slots);
    // Count, then fill: each slot's row lists its connections in connection order.
    const connStart = new Int32Array(n + 1);
    for (let pos = 0; pos < m; pos++) {
      const c = connections[pos];
      if (!c) continue;
      const a = connA[pos] ?? NO_SLOT;
      const b = connB[pos] ?? NO_SLOT;
      if (a !== NO_SLOT) connStart[a + 1] = (connStart[a + 1] ?? 0) + 1;
      else listFor(this.connsUnslotted, c.a.elementId).push(pos);
      if (sameEnds(c, a, b)) continue;
      if (b !== NO_SLOT) connStart[b + 1] = (connStart[b + 1] ?? 0) + 1;
      else listFor(this.connsUnslotted, c.b.elementId).push(pos);
    }
    for (let s = 0; s < n; s++) connStart[s + 1] = (connStart[s + 1] ?? 0) + (connStart[s] ?? 0);
    const connItems = new Int32Array(connStart[n] ?? 0);
    const connFill = connStart.slice(0, n);
    for (let pos = 0; pos < m; pos++) {
      const a = connA[pos] ?? NO_SLOT;
      const b = connB[pos] ?? NO_SLOT;
      if (a !== NO_SLOT) {
        const at = connFill[a] ?? 0;
        connItems[at] = pos;
        connFill[a] = at + 1;
      }
      const c = connections[pos];
      if (b !== NO_SLOT && c && !sameEnds(c, a, b)) {
        const at = connFill[b] ?? 0;
        connItems[at] = pos;
        connFill[b] = at + 1;
      }
    }
    this.connA = connA;
    this.connB = connB;
    this.conns = { start: connStart, items: connItems };

    const tapKeys: number[] = [];
    const tapValues: number[] = [];
    const refKeys: number[] = [];
    const refValues: number[] = [];
    const refFirst = new Int32Array(n).fill(NO_SLOT);
    const refSecond = new Map<number, number>();
    const slotKinds = new Uint8Array(n);
    const codes = codesOf(endsTable);
    const hostFields = endsTable.hostFieldByCode;
    // Records of one kind tend to sit together: the last kind's code is reused without a map read.
    let lastKind = "";
    let lastCode: number = SlotKind.Empty;
    for (let s = 0; s < n; s++) {
      const el = slots.at(s);
      if (!el) continue;
      const kind = el.kind;
      if (kind !== lastKind) {
        lastKind = kind;
        lastCode = codeIn(codes, kind);
      }
      const code = lastCode;
      slotKinds[s] = code;
      if (code === SlotKind.Other) continue;
      if (code >= FIRST_ENDS_CODE) {
        const field = code === SHARED_ENDS_CODE ? endsTable.hostField(kind) : (hostFields[code] ?? null);
        if (field === null) continue;
        const hostId = hostIdOf(el, field);
        if (hostId === null) continue;
        const host = this.slotFor(hostId);
        refFirst[s] = host;
        if (host === NO_SLOT) listFor(this.tapsUnslotted, hostId).push(el.id);
        else {
          tapKeys.push(host);
          tapValues.push(s);
        }
      } else if (el.kind === "riser_segment") listFor(this.risers, el.riserId).push(el.id);
      else if (el.kind === "opening" || el.kind === "tag" || el.kind === "dimension") {
        const refs = referencesOf(el);
        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i] ?? "";
          const target = this.slotFor(ref);
          if (i === 0) refFirst[s] = target;
          else if (target !== NO_SLOT) refSecond.set(s, target);
          if (target === NO_SLOT) listFor(this.refsUnslotted, ref).push(el.id);
          else {
            refKeys.push(target);
            refValues.push(s);
          }
        }
      }
    }
    this.refFirst = refFirst;
    this.refSecond = refSecond;
    this.slotKinds = slotKinds;
    this.taps = rowsOf(n, tapKeys, tapValues);
    this.refs = rowsOf(n, refKeys, refValues);

    // Children are written slot by slot, so their rows come out in order without a grouping pass.
    const parentOf = new Int32Array(n).fill(NO_SLOT);
    const kidStart = new Int32Array(n + 1);
    // At most one connection per downstream end, plus the hosted taps.
    const kidItems = new Int32Array(n * maxDownstream(endsTable) + tapKeys.length);
    let kidCount = 0;
    const unslottedCode = new Map<string, number>();
    let tree = true;
    const tapStart = this.taps.start;
    const endsByCode = endsTable.downstreamByCode;
    // Whether a kind hosts taps, by kind code where the code names one kind (-1: not asked yet).
    const codeHostsTaps = new Int8Array(SHARED_ENDS_CODE + 1).fill(-1);
    for (let s = 0; s < n; s++) {
      kidStart[s] = kidCount;
      const code = slotKinds[s] ?? SlotKind.Empty;
      // Only kinds with downstream ends, and slots with taps on them, have children.
      // The kind code says which ends; the element itself need not be read (its slot is its id here), except for a shared code.
      const ends = code < FIRST_ENDS_CODE ? NO_ENDS : code === SHARED_ENDS_CODE ? endsTable.downstream(slots.at(s)?.kind ?? "") : (endsByCode[code] ?? NO_ENDS);
      // Read the element only where taps hang on it, and only for a code shared by several kinds: whether its kind hosts them is the tree's.
      const hostsTaps = tapStart[s] !== tapStart[s + 1] && hostsTapsAt(declared, codeHostsTaps, code, slots, s);
      if (ends.length === 0 && !hostsTaps) continue;
      const first = kidCount;
      for (let e = 0; e < ends.length; e++) {
        const end = ends[e] ?? "";
        const pos = this.positionAt(s, this.ids[s] ?? "", end);
        if (pos === NO_SLOT) continue;
        const c = connections[pos];
        if (!c) continue;
        const aIsHere = this.connA[pos] === s && c.a.end === end;
        const otherSlot = (aIsHere ? this.connB[pos] : this.connA[pos]) ?? NO_SLOT;
        if (otherSlot !== NO_SLOT) kidItems[kidCount++] = otherSlot;
        else {
          const otherId = aIsHere ? c.b.elementId : c.a.elementId;
          let unslottedAt = unslottedCode.get(otherId);
          if (unslottedAt === undefined) {
            unslottedAt = -1 - this.unslotted.length;
            this.unslotted.push(otherId);
            unslottedCode.set(otherId, unslottedAt);
          }
          kidItems[kidCount++] = unslottedAt;
        }
      }
      // A tap host lists its hosted taps after its connections.
      if (hostsTaps) {
        const ts = tapStart[s] ?? 0;
        const te = tapStart[s + 1] ?? 0;
        for (let i = ts; i < te; i++) kidItems[kidCount++] = this.taps.items[i] ?? 0;
      }
      for (let i = first; i < kidCount; i++) {
        const kid = kidItems[i] ?? 0;
        if (kid >= 0) {
          if (parentOf[kid] !== NO_SLOT || kid === s) tree = false;
          parentOf[kid] = s;
        } else {
          const id = this.unslotted[-1 - kid] ?? "";
          if (this.parentUnslotted.has(id)) tree = false;
          this.parentUnslotted.set(id, s);
        }
      }
    }
    kidStart[n] = kidCount;
    this.kids = { start: kidStart, items: kidItems.slice(0, kidCount) };
    this.parentOf = parentOf;
    this.isTree = tree && !this.hasCycle();
  }

  /**
   * The index of `elements`, a record that differs from `prev`'s only at
   * `changedIds` (written or removed, none added) over the same connections:
   * the touched slots' rows rebuilt, everything else shared. Answers exactly
   * as a fresh build would. Null when that can't be shown cheaply (an element
   * added, another slot table, `prev` not a tree, the edit makes two parents
   * or a cycle): then build fresh.
   */
  static after(prev: NetworkIndex, elements: Readonly<Record<string, BimElement>>, changedIds: Iterable<string>): NetworkIndex | null {
    if (!prev.isTree) return null;
    const slots = elementSlots(elements);
    if (slots.table !== prev.slots.table || slots.size !== prev.size) return null;
    const dirty = new Set<number>();
    let tapsChanged = false;
    let refsChanged = false;
    let risersChanged = false;
    let equipmentTouched = false;
    const endsTable = prev.ends;
    for (const id of changedIds) {
      const s = prev.slotFor(id);
      if (s === NO_SLOT) return null;
      const before = prev.slots.at(s);
      const now = slots.at(s);
      if (before === now) continue;
      dirty.add(s);
      for (const el of [before, now]) {
        if (!el) continue;
        const hostField = endsTable.hostField(el.kind);
        if (hostField !== null) {
          tapsChanged = true;
          const hostId = hostIdOf(el, hostField);
          const host = hostId === null ? NO_SLOT : prev.slotFor(hostId);
          if (host !== NO_SLOT) dirty.add(host);
        } else if (el.kind === "riser_segment") risersChanged = true;
        else if (el.kind === "opening" || el.kind === "tag" || el.kind === "dimension") refsChanged = true;
        else if (endsTable.isRoot(el.kind)) equipmentTouched = true;
      }
    }
    const n = prev.size;

    let taps = prev.taps;
    let tapsUnslotted = prev.tapsUnslotted;
    if (tapsChanged) {
      const keys: number[] = [];
      const values: number[] = [];
      tapsUnslotted = new Map();
      for (const tap of recordsOfKinds(elements, endsTable.hostedKinds)) {
        const hostId = hostIdOf(tap, endsTable.hostField(tap.kind));
        if (hostId === null) continue;
        const s = prev.slotFor(tap.id);
        const host = prev.slotFor(hostId);
        if (host === NO_SLOT) listFor(tapsUnslotted, hostId).push(tap.id);
        else {
          keys.push(host);
          values.push(s);
        }
      }
      taps = rowsOf(n, keys, values);
    }
    let refs = prev.refs;
    let refsUnslotted = prev.refsUnslotted;
    if (refsChanged) {
      const keys: number[] = [];
      const values: number[] = [];
      refsUnslotted = new Map();
      for (const el of elementsOfKind(elements, "opening", "tag", "dimension")) {
        const s = prev.slotFor(el.id);
        for (const ref of referencesOf(el)) {
          const target = prev.slotFor(ref);
          if (target === NO_SLOT) listFor(refsUnslotted, ref).push(el.id);
          else {
            keys.push(target);
            values.push(s);
          }
        }
      }
      refs = rowsOf(n, keys, values);
    }
    let slotKinds = prev.slotKinds;
    for (const s of dirty) {
      const el = slots.at(s);
      const code = el ? slotKindOf(el.kind, endsTable) : SlotKind.Empty;
      if (code === slotKinds[s]) continue;
      if (slotKinds === prev.slotKinds) slotKinds = prev.slotKinds.slice();
      slotKinds[s] = code;
    }
    let refFirst = prev.refFirst;
    let refSecond = prev.refSecond;
    if (tapsChanged || refsChanged) {
      refFirst = prev.refFirst.slice();
      refSecond = new Map(prev.refSecond);
      for (const s of dirty) {
        refFirst[s] = NO_SLOT;
        refSecond.delete(s);
        const el = slots.at(s);
        if (!el) continue;
        const hostId = hostIdOf(el, endsTable.hostField(el.kind));
        if (hostId !== null) refFirst[s] = prev.slotFor(hostId);
        else if (el.kind === "opening" || el.kind === "tag" || el.kind === "dimension") {
          const refs = referencesOf(el);
          for (let i = 0; i < refs.length; i++) {
            const target = prev.slotFor(refs[i] ?? "");
            if (i === 0) refFirst[s] = target;
            else if (target !== NO_SLOT) refSecond.set(s, target);
          }
        }
      }
    }
    let risers = prev.risers;
    if (risersChanged) {
      risers = new Map();
      for (const el of elementsOfKind(elements, "riser_segment")) listFor(risers, el.riserId).push(el.id);
    }

    // The touched rows' children, in the order a fresh build writes them.
    const unslotted = [...prev.unslotted];
    const unslottedCode = new Map<string, number>(unslotted.map((id, i) => [id, -1 - i]));
    const rows = new Map<number, number[]>();
    for (const s of dirty) {
      const out: number[] = [];
      const el = slots.at(s);
      const ends = el ? endsTable.downstream(el.kind) : NO_ENDS;
      const hostsTaps = el !== undefined && prev.tree.hostsTaps(el.kind);
      if (el && (ends.length > 0 || hostsTaps)) {
        for (const end of ends) {
          const pos = prev.positionAt(s, el.id, end);
          if (pos === NO_SLOT) continue;
          const c = prev.connections[pos];
          if (!c) continue;
          const aIsHere = c.a.elementId === el.id && c.a.end === end;
          const otherSlot = (aIsHere ? prev.connB[pos] : prev.connA[pos]) ?? NO_SLOT;
          if (otherSlot !== NO_SLOT) out.push(otherSlot);
          else {
            const otherId = aIsHere ? c.b.elementId : c.a.elementId;
            let code = unslottedCode.get(otherId);
            if (code === undefined) {
              code = -1 - unslotted.length;
              unslotted.push(otherId);
              unslottedCode.set(otherId, code);
            }
            out.push(code);
          }
        }
        if (hostsTaps) {
          const stop = taps.start[s + 1] ?? 0;
          for (let i = taps.start[s] ?? 0; i < stop; i++) out.push(taps.items[i] ?? 0);
        }
      }
      rows.set(s, out);
    }

    const parentOf = prev.parentOf.slice();
    const parentUnslotted = new Map(prev.parentUnslotted);
    const prevKids = prev.kids;
    let equipmentMoved = equipmentTouched;
    const isEquipment = (code: number) => code >= 0 && (endsTable.isRoot(slots.at(code)?.kind ?? "") || endsTable.isRoot(prev.slots.at(code)?.kind ?? ""));
    for (const s of dirty) {
      const stop = prevKids.start[s + 1] ?? 0;
      for (let i = prevKids.start[s] ?? 0; i < stop; i++) {
        const kid = prevKids.items[i] ?? 0;
        if (isEquipment(kid)) equipmentMoved = true;
        if (kid >= 0) {
          if (parentOf[kid] === s) parentOf[kid] = NO_SLOT;
        } else {
          const id = unslotted[-1 - kid] ?? "";
          if (parentUnslotted.get(id) === s) parentUnslotted.delete(id);
        }
      }
    }
    for (const [s, kids] of rows) {
      for (const kid of kids) {
        if (isEquipment(kid)) equipmentMoved = true;
        if (kid >= 0) {
          if (parentOf[kid] !== NO_SLOT || kid === s) return null;
          parentOf[kid] = s;
        } else {
          const id = unslotted[-1 - kid] ?? "";
          if (parentUnslotted.has(id)) return null;
          parentUnslotted.set(id, s);
        }
      }
    }
    // A cycle the edit made runs through one of its new edges: the child is then above its parent.
    for (const [s, kids] of rows) {
      for (const kid of kids) {
        if (kid < 0) continue;
        let x = s;
        for (let steps = 0; x !== NO_SLOT; steps++) {
          if (x === kid || steps > n) return null;
          x = parentOf[x] ?? NO_SLOT;
        }
      }
    }

    // The kid rows, copied around the rebuilt ones.
    let total = prevKids.items.length;
    for (const [s, kids] of rows) total += kids.length - ((prevKids.start[s + 1] ?? 0) - (prevKids.start[s] ?? 0));
    const start = new Int32Array(n + 1);
    const items = new Int32Array(total);
    const order = [...rows.keys()].sort((a, b) => a - b);
    let w = 0;
    let from = 0;
    const copyUpTo = (end: number) => {
      const a = prevKids.start[from] ?? 0;
      const b = prevKids.start[end] ?? 0;
      const delta = w - a;
      for (let s = from; s < end; s++) start[s] = (prevKids.start[s] ?? 0) + delta;
      items.set(prevKids.items.subarray(a, b), w);
      w += b - a;
    };
    for (const s of order) {
      copyUpTo(s);
      start[s] = w;
      for (const kid of rows.get(s) ?? []) items[w++] = kid;
      from = s + 1;
    }
    copyUpTo(n);
    start[n] = w;

    return new NetworkIndex(prev.connections, elements, {
      tree: prev.tree,
      ends: prev.ends,
      slots,
      conns: prev.conns,
      connA: prev.connA,
      connB: prev.connB,
      connsUnslotted: prev.connsUnslotted,
      taps,
      tapsUnslotted,
      refs,
      refsUnslotted,
      refFirst,
      refSecond,
      slotKinds,
      risers,
      kids: { start, items },
      unslotted,
      parentOf,
      parentUnslotted,
      equipmentOrder: equipmentMoved ? null : prev.equipmentOrder,
      nestedEquipment: equipmentMoved ? false : prev.nestedEquipment,
    });
  }

  /**
   * The slot a tap / opening / tag / dimension at `slot` refers to (`second`:
   * a dimension's other end), or NO_SLOT when it has none here; then read the
   * reference by id.
   */
  referencedSlot(slot: number, second = false): number {
    return second ? (this.refSecond.get(slot) ?? NO_SLOT) : (this.refFirst[slot] ?? NO_SLOT);
  }

  /** `kinds` as a mask for `slotIn`: a few bits, so a pass over every slot tests a kind without reading the element. */
  kindMask(kinds: readonly string[]): number {
    return codeMaskOf(kinds, this.ends);
  }

  /** True when the element at `slot` may be of one of the kinds `mask` was made from (`kindMask`); exact for the network's own kinds. */
  slotIn(slot: number, mask: number): boolean {
    return (mask & (1 << (this.slotKinds[slot] ?? SlotKind.Empty))) !== 0;
  }

  /** True when the element at `slot` starts a tree (its kind row says `root`). */
  private isRootSlot(slot: number): boolean {
    const code = this.slotKinds[slot] ?? SlotKind.Empty;
    if (code < FIRST_ENDS_CODE) return false;
    return code === SHARED_ENDS_CODE ? this.ends.isRoot(this.slots.at(slot)?.kind ?? "") : ((this.ends.flagsByCode[code] ?? 0) & ROOT_FLAG) !== 0;
  }

  /** This index's slot for an id, or NO_SLOT. */
  slotFor(id: string): number {
    const s = this.order.get(id);
    return s !== undefined && s < this.size ? s : NO_SLOT;
  }

  /** Position of the first connection (in connection order) at this connector end, or NO_SLOT. */
  private positionAt(slot: number, id: string, end: ConnectorEnd): number {
    if (slot === NO_SLOT) {
      for (const pos of this.connsUnslotted.get(id) ?? NO_POSITIONS) {
        const c = this.connections[pos];
        if (c && ((c.a.elementId === id && c.a.end === end) || (c.b.elementId === id && c.b.end === end))) return pos;
      }
      return NO_SLOT;
    }
    const startAt = this.conns.start[slot] ?? 0;
    const stop = this.conns.start[slot + 1] ?? 0;
    for (let i = startAt; i < stop; i++) {
      const pos = this.conns.items[i] ?? 0;
      const c = this.connections[pos];
      if (c && ((this.connA[pos] === slot && c.a.end === end) || (this.connB[pos] === slot && c.b.end === end))) return pos;
    }
    return NO_SLOT;
  }

  /** Slot of one end of the connection at `pos` (NO_SLOT when that end has none). */
  endSlot(pos: number, end: "a" | "b"): number {
    return (end === "a" ? this.connA[pos] : this.connB[pos]) ?? NO_SLOT;
  }

  /** The first connection (in connection order) at this connector end. */
  connectionAt(id: string, end: ConnectorEnd): Connection | undefined {
    const pos = this.positionAt(this.slotFor(id), id, end);
    return pos === NO_SLOT ? undefined : this.connections[pos];
  }

  /** Positions in `connections` of every connection at this element, in connection order. */
  connectionPositionsOf(id: string): readonly number[] {
    const s = this.slotFor(id);
    if (s === NO_SLOT) return this.connsUnslotted.get(id) ?? NO_POSITIONS;
    const startAt = this.conns.start[s] ?? 0;
    const stop = this.conns.start[s + 1] ?? 0;
    if (startAt === stop) return NO_POSITIONS;
    return Array.from(this.conns.items.subarray(startAt, stop));
  }

  connectionsOf(id: string): readonly Connection[] {
    const positions = this.connectionPositionsOf(id);
    if (positions.length === 0) return NO_CONNECTIONS;
    const out: Connection[] = [];
    for (const pos of positions) {
      const c = this.connections[pos];
      if (c) out.push(c);
    }
    return out;
  }

  private idsOfRow(rows: Rows, slot: number): readonly ElementId[] {
    const startAt = rows.start[slot] ?? 0;
    const stop = rows.start[slot + 1] ?? 0;
    if (startAt === stop) return NO_IDS;
    const out: ElementId[] = [];
    for (let i = startAt; i < stop; i++) out.push(this.idAt(rows.items[i] ?? 0));
    return out;
  }

  /** The id at a slot or child code. */
  private idAt(code: number): ElementId {
    return asElementId((code >= 0 ? this.ids[code] : this.unslotted[-1 - code]) ?? "");
  }

  /** Taps hosted on a segment, in element order. */
  /** Slots of the taps hosted on the element at `hostSlot`, in element order (`start` inclusive, `end` exclusive into `tapSlotAt`). */
  hostedTapRange(hostSlot: number): { readonly start: number; readonly end: number } {
    return { start: this.taps.start[hostSlot] ?? 0, end: this.taps.start[hostSlot + 1] ?? 0 };
  }

  tapSlotAt(i: number): number {
    return this.taps.items[i] ?? NO_SLOT;
  }

  hostedTaps(hostId: string): readonly ElementId[] {
    const s = this.slotFor(hostId);
    return s === NO_SLOT ? (this.tapsUnslotted.get(hostId) ?? NO_IDS) : this.idsOfRow(this.taps, s);
  }

  /** Openings hosted on, and tags / dimensions pointing at, an element, in element order. */
  dependents(id: string): readonly ElementId[] {
    const s = this.slotFor(id);
    return s === NO_SLOT ? (this.refsUnslotted.get(id) ?? NO_IDS) : this.idsOfRow(this.refs, s);
  }

  /** Every level's piece of one riser, in element order. */
  riserSegments(riserId: string): readonly ElementId[] {
    return this.risers.get(riserId) ?? NO_IDS;
  }

  /** Downstream neighbours in the order the airflow walk visits them. */
  children(id: string): readonly ElementId[] {
    const s = this.slotFor(id);
    return s === NO_SLOT ? NO_IDS : this.idsOfRow(this.kids, s);
  }

  parent(id: string): ElementId | undefined {
    const s = this.slotFor(id);
    const p = s === NO_SLOT ? this.parentUnslotted.get(id) : this.parentOf[s];
    return p === undefined || p === NO_SLOT ? undefined : this.idAt(p);
  }

  /**
   * Post-order position of each element in the airflow walk (equipment roots
   * in element order, then anything not reached). Derived-change lists are
   * ordered by this so they match a full recompute exactly.
   */
  airflowRank(id: ElementId): number {
    if (!this.rank) this.rank = this.computeRank();
    return this.rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * Orders ids exactly as `airflowRank` would, but only walks the equipment
   * trees the ids belong to. Falls back to the global walk whenever an id is
   * not under an equipment root or equipment is nested under equipment.
   */
  sortByAirflow(ids: Iterable<ElementId>): ElementId[] {
    const list = [...ids];
    if (list.length === 0) return list;
    const equipment = this.ensureEquipmentOrder();
    const keyed: Array<{ id: ElementId; tree: number; pos: number }> = [];
    for (const id of list) {
      const root = this.rootOf(id);
      const tree = root === undefined ? undefined : equipment.get(root);
      if (this.nestedEquipment || root === undefined || tree === undefined) {
        return list.sort((a, b) => this.airflowRank(a) - this.airflowRank(b));
      }
      keyed.push({ id, tree, pos: this.postOrderIn(root).get(id) ?? Number.MAX_SAFE_INTEGER });
    }
    return keyed.sort((a, b) => a.tree - b.tree || a.pos - b.pos).map((k) => k.id);
  }

  private ensureEquipmentOrder(): Map<ElementId, number> {
    if (!this.equipmentOrder) {
      const order = new Map<ElementId, number>();
      let nested = false;
      for (let s = 0; s < this.size; s++) {
        const el = this.slots.at(s);
        if (!el || !this.ends.isRoot(el.kind) || order.has(el.id)) continue;
        order.set(el.id, order.size);
        if (this.parent(el.id) !== undefined) nested = true;
      }
      this.equipmentOrder = order;
      this.nestedEquipment = nested;
    }
    return this.equipmentOrder;
  }

  /** Post-order position of each slot within its equipment tree (`postOrderIn`'s numbering), filled one tree at a time. */
  private postBySlot: Int32Array | null = null;
  private readonly postFilled = new Set<number>();
  private onPathScratch: Int32Array | null = null;

  private postPositionsFrom(root: number): Int32Array {
    const post = (this.postBySlot ??= new Int32Array(this.size));
    if (!this.postFilled.has(root)) {
      let next = 0;
      this.walkFrom(root, new Uint8Array(this.size), new Set(), (code) => {
        if (code >= 0) post[code] = next;
        next += 1;
      });
      this.postFilled.add(root);
    }
    return post;
  }

  /**
   * For a tree: `quantity`'s totals after the elements `changed` changed their
   * own value, worked out by slot: every slot on a path from one of them to
   * its unit re-summed once, children first, exactly as the id walk in
   * `recomputeDerivedAfter` sums them (own value, then each child in child
   * order; a child off every path gives its stored total, or its own
   * children's when it stores none). `read` is the element at a slot as the
   * edit leaves it. The slots come back in `sortByAirflow` order. Null when
   * the slot walk can't match the id walk exactly (not a tree, an id or child
   * with no slot, a path that ends at no unit, a unit under another unit).
   */
  totalsAfter(quantity: TreeTotal, changed: readonly ElementId[], read: (slot: number) => BimElement | undefined): { readonly slots: readonly number[]; readonly totals: readonly number[] } | null {
    if (!this.isTree || changed.length === 0) return null;
    const equipment = this.ensureEquipmentOrder();
    if (this.nestedEquipment) return null;
    const { start, items } = this.kids;
    const parentOf = this.parentOf;
    // Position + 1 in `slots` of each slot on a path (0: on none). Cleared before returning.
    const onPath = (this.onPathScratch ??= new Int32Array(this.size));
    const slots: number[] = [];
    const keys: number[] = [];
    const stride = this.size + this.unslotted.length + 1;
    const path: number[] = [];
    const clear = (): null => {
      for (const s of slots) onPath[s] = 0;
      return null;
    };
    for (const id of changed) {
      const s = this.slotFor(id);
      if (s === NO_SLOT) return clear();
      path.length = 0;
      let root = s;
      for (let x = s; x !== NO_SLOT; x = parentOf[x] ?? NO_SLOT) {
        path.push(x);
        root = x;
        if (path.length > this.size) return clear();
      }
      const rootEl = this.slots.at(root);
      const tree = rootEl !== undefined && this.ends.isRoot(rootEl.kind) ? equipment.get(rootEl.id) : undefined;
      if (tree === undefined) return clear();
      const post = this.postPositionsFrom(root);
      for (const x of path) {
        if (onPath[x]) continue;
        slots.push(x);
        onPath[x] = slots.length;
        keys.push(tree * stride + (post[x] ?? 0));
      }
    }
    const order = new Uint32Array(slots.length);
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0));

    // By position in `slots`: each path slot's new total.
    const totals = new Float64Array(slots.length);
    const stored = new Map<number, number>();
    let refused = false;
    const storedTotal = (s: number): number => {
      const cached = stored.get(s);
      if (cached !== undefined) return cached;
      const el = read(s);
      const kept = el ? quantity.stored(el) : undefined;
      if (kept !== undefined) return kept;
      let sum = el ? (quantity.own(el) ?? 0) : 0;
      if (el) {
        const stop = start[s + 1] ?? 0;
        for (let k = start[s] ?? 0; k < stop; k++) {
          const kid = items[k] ?? 0;
          if (kid < 0) {
            refused = true;
            return 0;
          }
          const at = onPath[kid] ?? 0;
          sum += at === 0 ? storedTotal(kid) : (totals[at - 1] ?? 0);
        }
      }
      stored.set(s, sum);
      return sum;
    };
    const sorted: number[] = new Array<number>(slots.length);
    const sortedTotals: number[] = new Array<number>(slots.length);
    for (let i = 0; i < order.length; i++) {
      const at = order[i] ?? 0;
      const s = slots[at] ?? 0;
      const el = read(s);
      let sum = el ? (quantity.own(el) ?? 0) : 0;
      if (el) {
        const stop = start[s + 1] ?? 0;
        for (let k = start[s] ?? 0; k < stop; k++) {
          const kid = items[k] ?? 0;
          if (kid < 0) return clear();
          const kidAt = onPath[kid] ?? 0;
          sum += kidAt === 0 ? storedTotal(kid) : (totals[kidAt - 1] ?? 0);
        }
      }
      if (refused) return clear();
      totals[at] = sum;
      sorted[i] = s;
      sortedTotals[i] = sum;
    }
    clear();
    return { slots: sorted, totals: sortedTotals };
  }

  private rootOf(id: ElementId): ElementId | undefined {
    let x: ElementId = id;
    for (let guard = 0; guard <= this.order.size; guard++) {
      const up = this.parent(x);
      if (up === undefined) return this.ends.isRoot(this.elements[x]?.kind ?? "") ? x : undefined;
      x = up;
    }
    return undefined;
  }

  /**
   * Depth-first from `root` (a slot or child code) over children not yet seen,
   * in child order; `done` gets each code as it finishes (post order).
   */
  private walkFrom(root: number, seen: Uint8Array, seenUnslotted: Set<number>, done: (code: number) => void): void {
    const mark = (code: number): boolean => {
      if (code >= 0) {
        if (seen[code]) return false;
        seen[code] = 1;
        return true;
      }
      if (seenUnslotted.has(code)) return false;
      seenUnslotted.add(code);
      return true;
    };
    if (!mark(root)) return;
    const stack: number[] = [root];
    const next: number[] = [root >= 0 ? (this.kids.start[root] ?? 0) : 0];
    while (stack.length > 0) {
      const top = stack.length - 1;
      const code = stack[top] ?? 0;
      const stop = code >= 0 ? (this.kids.start[code + 1] ?? 0) : 0;
      const i = next[top] ?? 0;
      if (i < stop) {
        next[top] = i + 1;
        const child = this.kids.items[i] ?? 0;
        if (mark(child)) {
          stack.push(child);
          next.push(child >= 0 ? (this.kids.start[child] ?? 0) : 0);
        }
        continue;
      }
      stack.pop();
      next.pop();
      done(code);
    }
  }

  private postOrderIn(root: ElementId): Map<ElementId, number> {
    const cached = this.treeRank.get(root);
    if (cached) return cached;
    const rank = new Map<ElementId, number>();
    const s = this.slotFor(root);
    if (s === NO_SLOT) rank.set(root, 0);
    else this.walkFrom(s, new Uint8Array(this.size), new Set(), (code) => rank.set(this.idAt(code), rank.size));
    this.treeRank.set(root, rank);
    return rank;
  }

  /** Network elements not reachable from any equipment, in element order. Walls, rooms and annotations are not part of a system. */
  disconnected(): readonly ElementId[] {
    if (!this.unreached) {
      const n = this.size;
      const reached = new Uint8Array(n);
      const stack: number[] = [];
      for (let s = 0; s < n; s++) if (this.isRootSlot(s)) stack.push(s);
      while (stack.length > 0) {
        const s = stack.pop();
        if (s === undefined || reached[s]) continue;
        reached[s] = 1;
        const stop = this.kids.start[s + 1] ?? 0;
        // Unslotted children are not elements, so they are never reported.
        for (let i = this.kids.start[s] ?? 0; i < stop; i++) {
          const kid = this.kids.items[i] ?? 0;
          if (kid >= 0 && !reached[kid]) stack.push(kid);
        }
      }
      const unreached: ElementId[] = [];
      for (let s = 0; s < n; s++) {
        if (reached[s] || !isNetworkSlot(this.slotKinds[s] ?? SlotKind.Empty)) continue;
        const el = this.slots.at(s);
        if (el) unreached.push(el.id);
      }
      this.unreached = unreached;
    }
    return this.unreached;
  }

  /**
   * For a tree: every slot's `quantity` total as the full recompute defines
   * it (its own value, then each child's total added in child order, so the
   * sums match bit for bit), reading values with `elementAt`. Null when the
   * graph is not a tree.
   */
  totalsBySlot(quantity: TreeTotal, elementAt: (slot: number) => BimElement | undefined): Float64Array | null {
    if (!this.isTree) return null;
    const n = this.size;
    const { start, items } = this.kids;
    const totals = new Float64Array(n);
    const ownCodes = codeMaskOf(quantity.ownKinds, this.ends);
    // Walk down from every root; a slot is summed once all its children are (each has one parent, no cycles).
    const stack = new Int32Array(n);
    const next = new Int32Array(n);
    for (let root = 0; root < n; root++) {
      if (this.parentOf[root] !== NO_SLOT) continue;
      // A root with no children sums to its own value, which only an own kind has (totals start at 0).
      if (start[root] === start[root + 1] && (ownCodes & (1 << (this.slotKinds[root] ?? SlotKind.Empty))) === 0) continue;
      let depth = 0;
      stack[0] = root;
      next[0] = start[root] ?? 0;
      while (depth >= 0) {
        const s = stack[depth] ?? 0;
        const i = next[depth] ?? 0;
        if (i < (start[s + 1] ?? 0)) {
          next[depth] = i + 1;
          const kid = items[i] ?? 0;
          if (kid >= 0) {
            depth += 1;
            stack[depth] = kid;
            next[depth] = start[kid] ?? 0;
          }
          continue;
        }
        const el = elementAt(s);
        // `own` is undefined for every kind outside `ownKinds`: a slot whose code can't be one of them isn't asked.
        let sum = el && (ownCodes & (1 << (this.slotKinds[s] ?? SlotKind.Empty))) !== 0 ? (quantity.own(el) ?? 0) : 0;
        // A missing element walks no children; a child that is no element adds 0.
        if (el) {
          const stop = start[s + 1] ?? 0;
          for (let k = start[s] ?? 0; k < stop; k++) {
            const kid = items[k] ?? 0;
            sum += kid >= 0 ? (totals[kid] ?? 0) : 0;
          }
        }
        totals[s] = sum;
        depth -= 1;
      }
    }
    return totals;
  }

  /** Reads `record`'s element at each of this index's slots (`record` must be one this index serves). */
  readerFor(record: Readonly<Record<string, BimElement>>): (slot: number) => BimElement | undefined {
    const slots = elementSlots(record);
    if (slots.table.slotOf === this.order) return (s) => (s < slots.size ? slots.at(s) : undefined);
    return (s) => record[this.ids[s] ?? ""];
  }

  private hasCycle(): boolean {
    const n = this.size;
    // 1: on the current walk, 2: finished. Every element on a cycle has a parent, so walks from roots can be skipped.
    const state = new Uint8Array(n);
    // One walk's slots; a walk visits each slot once, so n is enough. A typed stack: emptying a JS array per walk reallocates it.
    const path = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (this.parentOf[start] === NO_SLOT || state[start]) continue;
      let x = start;
      let length = 0;
      while (x !== NO_SLOT && !state[x]) {
        state[x] = 1;
        path[length++] = x;
        x = this.parentOf[x] ?? NO_SLOT;
      }
      if (x !== NO_SLOT && state[x] === 1) return true;
      for (let i = 0; i < length; i++) state[path[i] ?? 0] = 2;
    }
    return false;
  }

  private computeRank(): Map<ElementId, number> {
    const rank = new Map<ElementId, number>();
    const n = this.size;
    const seen = new Uint8Array(n);
    const seenUnslotted = new Set<number>();
    const done = (code: number): void => {
      rank.set(this.idAt(code), rank.size);
    };
    for (let s = 0; s < n; s++) if (this.isRootSlot(s)) this.walkFrom(s, seen, seenUnslotted, done);
    for (let s = 0; s < n; s++) if (this.slots.at(s)) this.walkFrom(s, seen, seenUnslotted, done);
    return rank;
  }
}

const indexes = new WeakMap<object, NetworkIndex>();

/** The topology index for a model, built once per element record, connection list and tree (`treeNetwork`, the pack set's). */
export function networkOf(model: Pick<ModelState, "elements" | "connections">): NetworkIndex {
  const cached = indexes.get(model.elements);
  if (cached && cached.connections === model.connections && cached.tree === treeNetwork() && cached.ends === connectorEndsTable()) return cached;
  const built = new NetworkIndex(model.connections, model.elements);
  indexes.set(model.elements, built);
  return built;
}

/**
 * Reuse `from`'s index for `to` when `to` differs only in the listed elements
 * and none of them changed kind or tap host (true of every command). Anything
 * else is left to be rebuilt on first use.
 */
export function shareNetwork(
  from: Readonly<Record<string, BimElement>>,
  to: Readonly<Record<string, BimElement>>,
  changedIds: Iterable<string>,
): boolean {
  const index = indexes.get(from);
  if (!index || from === to) return false;
  if (!sameTopology(from, to, changedIds)) return false;
  indexes.set(to, index);
  return true;
}

/**
 * Give `to` an index derived from `from`'s when `to` differs only at
 * `changedIds` and adds no element (a removal, a re-hosted tap, a moved
 * reference): only the touched rows are rebuilt. False when it doesn't apply;
 * `networkOf` then builds `to`'s index on first use.
 */
export function deriveNetwork(
  from: Readonly<Record<string, BimElement>>,
  to: Readonly<Record<string, BimElement>>,
  connections: readonly Connection[],
  changedIds: Iterable<string>,
): boolean {
  const index = indexes.get(from);
  if (!index || from === to || index.connections !== connections) return false;
  if (indexes.get(to)?.connections === connections) return true;
  const next = NetworkIndex.after(index, to, changedIds);
  if (!next) return false;
  indexes.set(to, next);
  return true;
}

// A new revision keeps or derives its topology index (an index for other connections is rebuilt by `networkOf`, which checks them).
registerRevisionCarry("network", (from, to, changedIds) => {
  const index = indexes.get(from);
  if (!index || indexes.has(to)) return;
  if (!shareNetwork(from, to, changedIds)) deriveNetwork(from, to, index.connections, changedIds);
});

export function sameTopology(
  from: Readonly<Record<string, BimElement>>,
  to: Readonly<Record<string, BimElement>>,
  changedIds: Iterable<string>,
): boolean {
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    // A new view, sheet or sheet content touches no connector, host or reference.
    if (!a && b && DOCUMENT_ONLY_KINDS.has(b.kind)) continue;
    // A new part, level or part type joins no tree and points at nothing the index tracks.
    if (!a && b && isIsolatedElement(b)) continue;
    // Removing one that nothing points at leaves every other entry of the index true.
    if (a && !b && isIsolatedElement(a) && indexes.get(from)?.dependents(id).length === 0) continue;
    if (!a || !b || a.kind !== b.kind) return false;
    const hostField = connectorEndsTable().hostField(a.kind);
    if (hostField !== null && hostIdOf(a, hostField) !== hostIdOf(b, hostField)) return false;
    if (a.kind === "riser_segment" && b.kind === "riser_segment" && a.riserId !== b.riserId) return false;
    const ra = referencesOf(a);
    const rb = referencesOf(b);
    if (ra.length !== rb.length || ra.some((ref, i) => ref !== rb[i])) return false;
  }
  return true;
}

/**
 * What is already known about an element record, so a command on a known-good
 * head re-derives and re-validates only what it touched. Facts are tied to the
 * connections and settings they were established with, and to the add-on set
 * they hold under (`factsPackSet`): an add-on switched on or off gives the
 * state a different set, so nothing known under the old one is trusted.
 */
interface RecordFacts {
  readonly connections: readonly Connection[];
  readonly settings: ModelSettings;
  /** The set these facts hold under; a mark leaves it to the first read (the record's organization index isn't carried yet when it is marked). */
  rules?: PackSet;
  /** The set in force when marked: the answer when the state resolves none of its own. */
  readonly markedUnder?: PackSet;
  /** Every derived value equals what a full recompute gives. */
  consistent?: boolean;
  /** Full validation finds no issues. */
  valid?: boolean;
  /** Every issue full validation finds, when known. */
  issues?: readonly ValidationIssue[];
  /** What was known under another set, for the first read to carry across (`registerFactsTranslation`). */
  from?: { readonly rules: PackSet; readonly issues: readonly ValidationIssue[] };
}

const facts = new WeakMap<object, RecordFacts>();

/**
 * The add-on set facts about `model` hold under: the set its own state
 * resolves to (`withModelStatePacks`), else the one in force. Every fact is
 * established inside it, and a caller marking facts must have checked under it.
 */
export function factsPackSet(model: ModelState): PackSet {
  return modelStatePackSet(model) ?? activePackSet();
}

/**
 * Records made by an edit that wrote a setup record (an add-on switched on or
 * off, a firm discipline pinned): the edit was checked under the set before
 * it (the one its predecessor's facts hold under, kept here), which this
 * record may not resolve to. Facts marked on it hold under that set; the first
 * read under the record's own set carries them across (or, with no set kept,
 * re-establishes them once).
 */
const setupWritten = new WeakMap<object, PackSet | null>();

registerRevisionCarry("network.facts-setup", (from, to, changedIds) => {
  if (changedIds.some(isModelSetupRecordId)) setupWritten.set(to, facts.get(from)?.rules ?? null);
});

function factsFor(model: ModelState): RecordFacts {
  const own = modelStatePackSet(model);
  const rules = own ?? activePackSet();
  const known = facts.get(model.elements);
  let from: RecordFacts["from"];
  if (known && known.connections === model.connections && known.settings === model.settings) {
    // Marked facts resolve their set on first read: after the command has carried the record's indexes.
    // A setup write was checked under the set its predecessor's facts hold under.
    if (known.rules === undefined) known.rules = setupWritten.has(model.elements) ? (setupWritten.get(model.elements) ?? undefined) : (own ?? known.markedUnder);
    if (known.rules === rules) return known;
    // Under another set: what validation found there is where the first read starts (only checks reading a changed contribution re-run).
    const issues = known.issues ?? (known.valid === true ? [] : undefined);
    if (known.rules && issues) from = { rules: known.rules, issues };
  }
  const fresh: RecordFacts = { connections: model.connections, settings: model.settings, rules, from };
  facts.set(model.elements, fresh);
  return fresh;
}

/** A fresh entry for facts a command just checked (under `factsPackSet(model)`). */
function markedFacts(model: ModelState): RecordFacts {
  const fresh: RecordFacts = { connections: model.connections, settings: model.settings, markedUnder: activePackSet() };
  facts.set(model.elements, fresh);
  return fresh;
}

/** Establishes "fully derived" and "valid" together in one cold pass (validate.ts registers it). */
type ColdFactsPass = (model: ModelState) => { readonly consistent: boolean; readonly issues: readonly ValidationIssue[] } | null;

let coldFactsPass: ColdFactsPass | null = null;

/** Facts under the set in force from the issues found under `from`, re-running only what reads a contribution the sets answer differently; null when it can't (validate.ts registers it). */
type FactsTranslation = (model: ModelState, from: PackSet, issues: readonly ValidationIssue[]) => { readonly consistent: boolean; readonly issues: readonly ValidationIssue[] } | null;

let factsTranslation: FactsTranslation | null = null;

export function registerFactsTranslation(pass: FactsTranslation): void {
  factsTranslation = pass;
}

/** Facts read back from a persisted validation state offered for this record, or null (validate-state.ts registers it). */
type FactsAdoption = (model: ModelState) => { readonly consistent: boolean; readonly issues: readonly ValidationIssue[] } | null;

let factsAdoption: FactsAdoption | null = null;

export function registerFactsAdoption(pass: FactsAdoption): void {
  factsAdoption = pass;
}

/**
 * What is established about `model` under the set it resolves to, without
 * establishing anything: null unless both its issues and "fully derived" are
 * known under that set (what a persisted validation state is written from).
 */
export function establishedFacts(model: ModelState): { readonly rules: PackSet; readonly consistent: boolean; readonly issues: readonly ValidationIssue[] } | null {
  const known = facts.get(model.elements);
  if (!known || known.connections !== model.connections || known.settings !== model.settings || known.consistent === undefined) return null;
  const own = modelStatePackSet(model);
  const rules = own ?? activePackSet();
  const held = known.rules ?? (setupWritten.has(model.elements) ? (setupWritten.get(model.elements) ?? undefined) : (own ?? known.markedUnder));
  if (held !== rules) return null;
  const issues = known.issues ?? (known.valid === true ? [] : undefined);
  return issues ? { rules, consistent: known.consistent, issues } : null;
}

/**
 * True when what is known about `model` holds under another add-on set than
 * the one it resolves to (an add-on was switched since), so the first read
 * carries it across, re-running only the checks that read a contribution the
 * sets answer differently. Establishes nothing. False when nothing is known
 * (that read would be a cold pass) or the facts already hold under its set.
 */
export function factsAwaitSetCarry(model: ModelState): boolean {
  const known = facts.get(model.elements);
  if (!known || known.connections !== model.connections || known.settings !== model.settings) return false;
  const own = modelStatePackSet(model);
  const rules = own ?? activePackSet();
  if (known.rules === rules) return known.from !== undefined && known.consistent === undefined && known.issues === undefined;
  const held = known.rules ?? (setupWritten.has(model.elements) ? (setupWritten.get(model.elements) ?? undefined) : (own ?? known.markedUnder));
  if (held === undefined || held === rules) return false;
  return (known.issues ?? (known.valid === true ? [] : undefined)) !== undefined;
}
/** Records whose cold pass is running: a check inside it asking about the same record takes its own path. */
const coldInProgress = new WeakSet<RecordFacts>();

export function registerColdFacts(pass: ColdFactsPass): void {
  coldFactsPass = pass;
}

/**
 * On a record nothing is known about yet (a freshly loaded head), the first
 * fact asked for establishes both in one pass: every edit needs both.
 */
function establishCold(model: ModelState, f: RecordFacts): void {
  if (!coldFactsPass || coldInProgress.has(f) || f.consistent !== undefined || f.valid !== undefined || f.issues !== undefined) return;
  coldInProgress.add(f);
  let cold: ReturnType<ColdFactsPass>;
  const pass = coldFactsPass;
  const from = f.from;
  const translate = factsTranslation;
  const adopt = factsAdoption;
  f.from = undefined;
  try {
    cold =
      (from && translate ? withPackSet(f.rules, () => translate(model, from.rules, from.issues)) : null) ??
      (adopt ? withPackSet(f.rules, () => adopt(model)) : null) ??
      withPackSet(f.rules, () => pass(model));
  } finally {
    coldInProgress.delete(f);
  }
  if (!cold) return;
  f.consistent = cold.consistent;
  f.issues = cold.issues;
  f.valid = cold.issues.length === 0;
}

export function knownConsistent(model: ModelState, establish: () => boolean): boolean {
  const f = factsFor(model);
  if (f.consistent === undefined) establishCold(model, f);
  if (f.consistent === undefined) f.consistent = withPackSet(f.rules, establish);
  return f.consistent;
}

export function knownValid(model: ModelState, establish: () => boolean): boolean {
  const f = factsFor(model);
  if (f.valid === undefined) establishCold(model, f);
  if (f.valid === undefined) f.valid = f.issues ? f.issues.length === 0 : withPackSet(f.rules, establish);
  return f.valid;
}

/** Full validation's issues for `model`, computed once per model state. */
export function knownIssues(model: ModelState, establish: () => readonly ValidationIssue[]): readonly ValidationIssue[] {
  const f = factsFor(model);
  if (f.issues === undefined && f.valid === undefined) establishCold(model, f);
  if (f.issues === undefined) {
    if (f.valid === true) f.issues = [];
    else {
      f.issues = withPackSet(f.rules, establish);
      f.valid = f.issues.length === 0;
    }
  }
  return f.issues;
}

/** Record that `model` was produced fully derived and fully valid (checked under `factsPackSet(model)`). */
export function markKnownGood(model: ModelState): void {
  const f = markedFacts(model);
  f.consistent = true;
  f.valid = true;
  f.issues = [];
}

/** Record that `model` was produced fully derived, with exactly these issues (checked under `factsPackSet(model)`). */
export function markKnownIssues(model: ModelState, issues: readonly ValidationIssue[]): void {
  if (issues.length === 0) return markKnownGood(model);
  const f = markedFacts(model);
  f.consistent = true;
  f.valid = false;
  f.issues = issues;
}

/** The topology index `elements` already has, or null (a revision carry reads its predecessor's without building one). */
export function knownNetworkOf(elements: Readonly<Record<string, BimElement>>): NetworkIndex | null {
  return indexes.get(elements) ?? null;
}

/** Stable sort by a numeric key, each key computed once (a Map lookup per comparison costs more than the sort at thousands of ids). */
export function sortBy<T>(items: Iterable<T>, key: (item: T) => number): T[] {
  const list = [...items];
  if (list.length < 2) return list;
  const keys = new Float64Array(list.length);
  const index = new Uint32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    keys[i] = key(list[i] as T);
    index[i] = i;
  }
  index.sort((a, b) => (keys[a] as number) - (keys[b] as number) || a - b);
  const out: T[] = new Array<T>(list.length);
  for (let i = 0; i < list.length; i++) out[i] = list[index[i] as number] as T;
  return out;
}
