// Round 9's network index (packages/bim-kernel/src/network.ts at 4c169c013, the class and its helpers only;
// the module-level revision carry and record facts are left out). A/B reference for k10-perf.test.ts only; never imported by src.
import { connectionEndSlots, elementSlots, elementsOfKind, type ElementSlots } from "../../src/store";
import { asElementId, type BimElement, type Connection, type ConnectorEnd, type ElementId } from "../../src/types";
import { type NetworkElement } from "@permitzip/bim-pack-mechanical";
import { treeNetwork, type TreeNetwork, type TreeTotal } from "../../src/tree-network";

/**
 * Tree orientation: every system is a tree rooted at an equipment port.
 * Each kind has a fixed upstream end and downstream ends; taps hang off their
 * host segment through `hostId` rather than a connection.
 */
export const DOWNSTREAM_ENDS: Record<BimElement["kind"], readonly ConnectorEnd[]> = {
  equipment: ["out"],
  duct_segment: ["end"],
  tap: ["branch"],
  elbow: ["out"],
  terminal: [],
  wall: [],
  slab: [],
  opening: [],
  room: [],
  grid: [],
  column: [],
  beam: [],
  riser_segment: [],
  component: [],
  view: [],
  sheet: [],
  tag: [],
  dimension: [],
  viewport: [],
  drawing_item: [],
  level: [],
  mounting_plane: [],
  part_type: [],
  element_type: [],
  site: [],
  part: [],
  mep_system: [],
  run_segment: [],
  run_fitting: [],
  organization: [],
  service_link: [],
  service_catalog: [],
  load_point: [],
  space: [],
  zone: [],
  drawing_underlay: [],
  question: [],
  ceiling: [],
  determination: [],
  rule: [],
  requirement_state: [],
  observation: [],
  construction_stage: [],
  space_separator: [],
  reference_plane: [],
};

const MAX_DOWNSTREAM_ENDS = Math.max(...Object.values(DOWNSTREAM_ENDS).map((ends) => ends.length));

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

const NETWORK_KINDS: ReadonlySet<BimElement["kind"]> = new Set(["equipment", "duct_segment", "tap", "elbow", "terminal"]);

export function isNetworkElement(el: BimElement): el is NetworkElement {
  return NETWORK_KINDS.has(el.kind);
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
 * What the topology passes need to know of a slot's kind, one byte per slot:
 * which connector ends lead downstream (`DOWNSTREAM_ENDS`). Whether a slot
 * hosts taps is the tree's (`TreeNetwork.hostsTaps`), not its kind code's.
 */
const SlotKind = { Empty: 0, Other: 1, Equipment: 2, Segment: 3, Tap: 4, Elbow: 5, Terminal: 6, Riser: 7, Reference: 8 } as const;

/** The slot codes `kinds` map to, as a bit mask (`1 << code`). */
function codeMaskOf(kinds: readonly string[]): number {
  let mask = 0;
  for (const kind of kinds) mask |= 1 << slotKindOf(kind);
  return mask;
}

function slotKindOf(kind: string): number {
  switch (kind) {
    case "equipment":
      return SlotKind.Equipment;
    case "duct_segment":
      return SlotKind.Segment;
    case "tap":
      return SlotKind.Tap;
    case "elbow":
      return SlotKind.Elbow;
    case "terminal":
      return SlotKind.Terminal;
    case "riser_segment":
      return SlotKind.Riser;
    case "opening":
    case "tag":
    case "dimension":
      return SlotKind.Reference;
    default:
      return SlotKind.Other;
  }
}

/** The kinds `isNetworkElement` accepts. */
function isNetworkSlot(k: number): boolean {
  return k >= SlotKind.Equipment && k <= SlotKind.Terminal;
}

const NO_IDS: readonly ElementId[] = [];
const NO_ENDS: readonly ConnectorEnd[] = [];
const OUT_END: readonly ConnectorEnd[] = ["out"];
const END_END: readonly ConnectorEnd[] = ["end"];
const BRANCH_END: readonly ConnectorEnd[] = ["branch"];
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

/**
 * `DOWNSTREAM_ENDS[kind]` without a keyed read per element (a kind written by
 * a later build, in a rolling deploy, has none this build knows of). A test
 * holds the two equal.
 */
export function downstreamEndsOf(kind: string): readonly ConnectorEnd[] {
  switch (kind) {
    case "equipment":
    case "elbow":
      return OUT_END;
    case "duct_segment":
      return END_END;
    case "tap":
      return BRANCH_END;
    default:
      return NO_ENDS;
  }
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
    for (let s = 0; s < n; s++) {
      const el = slots.at(s);
      if (!el) continue;
      const code = slotKindOf(el.kind);
      slotKinds[s] = code;
      if (code === SlotKind.Other || code === SlotKind.Equipment || code === SlotKind.Segment || code === SlotKind.Elbow || code === SlotKind.Terminal) continue;
      if (el.kind === "tap") {
        const host = this.slotFor(el.hostId);
        refFirst[s] = host;
        if (host === NO_SLOT) listFor(this.tapsUnslotted, el.hostId).push(el.id);
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
    const kidItems = new Int32Array(n * MAX_DOWNSTREAM_ENDS + tapKeys.length);
    let kidCount = 0;
    const unslottedCode = new Map<string, number>();
    let tree = true;
    const tapStart = this.taps.start;
    for (let s = 0; s < n; s++) {
      kidStart[s] = kidCount;
      const code = slotKinds[s] ?? SlotKind.Empty;
      // Only kinds with downstream ends, and slots with taps on them, have children.
      const hasEnds = code === SlotKind.Equipment || code === SlotKind.Segment || code === SlotKind.Tap || code === SlotKind.Elbow;
      // Read the element only where taps hang on it: whether its kind hosts them is the tree's.
      const hostsTaps = tapStart[s] !== tapStart[s + 1] && declared.hostsTaps(slots.at(s)?.kind ?? "");
      if (!hasEnds && !hostsTaps) continue;
      // The kind code says which ends; the element itself need not be read (its slot is its id here).
      const ends = !hasEnds ? NO_ENDS : code === SlotKind.Segment ? END_END : code === SlotKind.Tap ? BRANCH_END : OUT_END;
      const first = kidCount;
      for (const end of ends) {
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
    for (const id of changedIds) {
      const s = prev.slotFor(id);
      if (s === NO_SLOT) return null;
      const before = prev.slots.at(s);
      const now = slots.at(s);
      if (before === now) continue;
      dirty.add(s);
      for (const el of [before, now]) {
        if (!el) continue;
        if (el.kind === "tap") {
          tapsChanged = true;
          const host = prev.slotFor(el.hostId);
          if (host !== NO_SLOT) dirty.add(host);
        } else if (el.kind === "riser_segment") risersChanged = true;
        else if (el.kind === "opening" || el.kind === "tag" || el.kind === "dimension") refsChanged = true;
        else if (el.kind === "equipment") equipmentTouched = true;
      }
    }
    const n = prev.size;

    let taps = prev.taps;
    let tapsUnslotted = prev.tapsUnslotted;
    if (tapsChanged) {
      const keys: number[] = [];
      const values: number[] = [];
      tapsUnslotted = new Map();
      for (const tap of elementsOfKind(elements, "tap")) {
        const s = prev.slotFor(tap.id);
        const host = prev.slotFor(tap.hostId);
        if (host === NO_SLOT) listFor(tapsUnslotted, tap.hostId).push(tap.id);
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
      const code = el ? slotKindOf(el.kind) : SlotKind.Empty;
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
        if (el.kind === "tap") refFirst[s] = prev.slotFor(el.hostId);
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
      const ends = el ? downstreamEndsOf(el.kind) : NO_ENDS;
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
    const isEquipment = (code: number) => code >= 0 && (slots.at(code)?.kind === "equipment" || prev.slots.at(code)?.kind === "equipment");
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
    return codeMaskOf(kinds);
  }

  /** True when the element at `slot` may be of one of the kinds `mask` was made from (`kindMask`); exact for the network's own kinds. */
  slotIn(slot: number, mask: number): boolean {
    return (mask & (1 << (this.slotKinds[slot] ?? SlotKind.Empty))) !== 0;
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
        if (el?.kind !== "equipment" || order.has(el.id)) continue;
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
      const tree = rootEl?.kind === "equipment" ? equipment.get(rootEl.id) : undefined;
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
      if (up === undefined) return this.elements[x]?.kind === "equipment" ? x : undefined;
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
      for (let s = 0; s < n; s++) if (this.slotKinds[s] === SlotKind.Equipment) stack.push(s);
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
    const ownCodes = codeMaskOf(quantity.ownKinds);
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
        let sum = el ? (quantity.own(el) ?? 0) : 0;
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
    for (let s = 0; s < n; s++) if (this.slots.at(s)?.kind === "equipment") this.walkFrom(s, seen, seenUnslotted, done);
    for (let s = 0; s < n; s++) if (this.slots.at(s)) this.walkFrom(s, seen, seenUnslotted, done);
    return rank;
  }
}

