import { add, distance, round, roundVec } from "./geometry";
import { anchorOf, openingPosition } from "./model";
import { deriveNetwork, isNetworkElement, knownConsistent, networkOf, sameTopology, shareNetwork, sortBy, type NetworkIndex } from "./network";
import { draftElements, elementSlots, elementValues, freezeElements } from "./store";
import type { BimElement, Dimension, ElementId, ModelState, Opening, Tag } from "./types";
import { connectorEndsTable, type HostedPlacement } from "./kinds/ends";
import { hostedAt, withHostedPosition } from "./kinds/hosted";
import { treeNetwork, type TreeNetwork, type TreeTotal } from "./tree-network";
import { deriveRuns, deriveRunsAfter } from "./routing/derive";
import { loadPointsNaming } from "./load-points/model";
import { runEndOf, type LoadRecord } from "./requirements/anchor";
import { shareLoadIndex } from "./requirements/load-index";
import { routingNeighbours } from "./routing/validate";

export interface DerivedResult {
  readonly model: ModelState;
  /** Elements whose derived fields changed (never counted as authored intent). */
  readonly changedIds: readonly ElementId[];
  /**
   * Those of `changedIds` the command did not touch whose only change is a
   * tree total (`TreeTotal.stored`, an add-on's quantity). No validation rule
   * reads tree totals, so they need no re-check. Absent when not worked out.
   */
  readonly airflowOnlyIds?: readonly ElementId[];
}

/** What the tree's totals cover: network elements, and any kind an add-on declares hosts taps. */
function inTree(tree: TreeNetwork, el: BimElement): boolean {
  return isNetworkElement(el) || tree.hostsTaps(el.kind);
}

/**
 * A placed hosted record (`hostedBy.placement`) re-placed on its host by the
 * tree's rule, or null when unchanged, its host is gone, no add-on places
 * records on that host or the record isn't stored in its row's form.
 */
function retapped(tree: TreeNetwork, elements: Readonly<Record<string, BimElement>>, el: BimElement, placement: HostedPlacement): BimElement | null {
  const at = hostedAt(el, placement);
  if (at === null) return null;
  const host = elements[at.hostId];
  const placed = host ? tree.placeTap(host, at) : null;
  if (!placed) return null;
  const position = roundVec(placed);
  return position.x !== at.position.x || position.y !== at.position.y ? withHostedPosition(el, placement, position) : null;
}

/**
 * Writes `total`'s value for each element that keeps it and differs, in
 * `values` order, into `next`; adds them to `changed`. `layered`: an earlier
 * quantity may have written the element, so read it back from `next`.
 */
function writeTotals(total: TreeTotal, values: Iterable<readonly [ElementId, number]>, read: Readonly<Record<string, BimElement>>, next: Record<string, BimElement>, changed: Set<ElementId>, layered: boolean): void {
  for (const [id, value] of values) {
    // Totals only land on elements that keep one, which the tap pass never rewrote.
    const el = layered ? next[id] : read[id];
    if (!el) continue;
    const kept = total.stored(el);
    if (kept !== undefined && kept !== value) {
      next[id] = total.withTotal(el, value);
      changed.add(el.id);
    }
  }
}

/**
 * Recompute every derived value from authored values: tap world positions
 * (from host + s, where the tree's add-on places them) and the tree's totals
 * (each node's own value plus everything downstream of it). Derived values
 * always recompute against the latest state and are never typed in.
 */
export function recomputeDerived(model: ModelState): DerivedResult {
  const tree = treeNetwork();
  const next = draftElements(model.elements);
  const all = elementValues(model.elements);
  const changed = new Set<ElementId>();

  const ends = connectorEndsTable();
  for (const el of all) {
    const placement = ends.placement(el.kind);
    if (placement === null) continue;
    const updated = retapped(tree, model.elements, el, placement);
    if (updated) {
      next[el.id] = updated;
      changed.add(el.id);
    }
  }

  shareNetwork(model.elements, next, changed);
  const withTaps: ModelState = { ...model, elements: next };
  // With no tap moved the draft reads exactly like the base, and the base reads without the draft's per-element
  // lookups. The index still comes from the draft: one built on a loaded record would keep that record alive.
  const read = changed.size === 0 ? model.elements : next;
  const net = networkOf(withTaps);
  net.tree.totals.forEach((total, i) => writeTotals(total, totalsOver(total, net, read), read, next, changed, i > 0));

  // Routed runs: branch fittings follow their trunks, segments carry their system's loads.
  const runSeeds: ElementId[] = [];
  for (const el of all) {
    if (el.kind === "run_segment" || el.kind === "run_fitting" || el.kind === "load_point" || (el.kind === "part" && el.links)) runSeeds.push(el.id);
  }
  if (runSeeds.length > 0) for (const id of deriveRuns(next, runSeeds)) changed.add(id);

  // Openings follow their walls, then annotations follow whatever they point at.
  for (const el of all) {
    if (el.kind !== "opening") continue;
    const updated = rederiveOpening(next, el);
    if (updated) {
      next[el.id] = updated;
      changed.add(el.id);
    }
  }
  for (const el of all) {
    if (el.kind !== "tag" && el.kind !== "dimension") continue;
    const updated = rederiveAnnotation(next, el);
    if (updated) {
      next[el.id] = updated;
      changed.add(el.id);
    }
  }

  const elements = freezeElements(next);
  shareNetwork(model.elements, elements, changed);
  shareLoadIndex(model.elements, elements, changed);
  return { model: { ...model, elements }, changedIds: [...changed] };
}

/**
 * True exactly when `recomputeDerived(model)` would change nothing, without
 * copying the model: the same formulas compared against the stored values,
 * the tree's totals summed over the topology index's slots in the same order,
 * routed runs re-derived on a draft only when the model has any. Checks keep running
 * after a mismatch so every element is evaluated, as in the recompute.
 */
export function isFullyDerived(model: ModelState): boolean {
  const check = derivedCheck(model);
  if (!check) return recomputeDerived(model).changedIds.length === 0;
  const slots = elementSlots(model.elements);
  for (let s = 0; s < slots.size; s++) {
    const el = slots.at(s);
    if (el) check.visit(s, el);
  }
  return check.result();
}

/** `isFullyDerived` one element at a time, so a cold pass over the model can run other checks on the same read. */
export interface DerivedCheck {
  /** Check the element at `slot` of the model's own slot layout. Slots are visited in order. */
  visit(slot: number, el: BimElement): void;
  /** True exactly when `recomputeDerived(model)` would change nothing. Call once, after every slot. */
  result(): boolean;
}

/**
 * The per-element checks of `isFullyDerived`. Referenced elements (a tap's
 * host, an opening's host, an annotation's ends) are read by slot through the
 * topology index's forward rows, not by id. Null when only a full recompute
 * can answer (not a tree, or a total not summable by slot).
 */
export function derivedCheck(model: ModelState): DerivedCheck | null {
  const net = networkOf(model);
  if (!net.isTree) return null;
  const tree = net.tree;
  const ends = net.ends;
  const elements = model.elements;
  const slots = elementSlots(elements);
  const sameSlots = slots.table.slotOf === net.order;
  const reader = net.readerFor(elements);
  const quantities = tree.totals;
  const keepMasks = quantities.map((q) => net.kindMask(q.storedKinds));
  const keepAny = keepMasks.reduce((all, mask) => all | mask, 0);
  const totals: Float64Array[] = [];
  for (const quantity of quantities) {
    const bySlot = net.totalsBySlot(quantity, reader);
    if (!bySlot) return null;
    totals.push(bySlot);
  }
  let derived = true;
  // Not in the index: only a revision that added network elements, which never shares one. Then only the recompute answers.
  let recompute = false;
  const runSeeds: ElementId[] = [];
  const indexed = (slot: number): boolean => sameSlots && slot < net.size;
  const ref = (slot: number, id: ElementId, second: boolean): BimElement | undefined => {
    const at = indexed(slot) ? net.referencedSlot(slot, second) : -1;
    return at >= 0 && at < slots.size ? slots.at(at) : elements[id];
  };
  return {
    visit(s, el) {
      if (recompute) return;
      const isIndexed = indexed(s);
      // The slot's kind code rules most elements out without asking the add-on: one test for every quantity.
      if (!isIndexed || net.slotIn(s, keepAny)) {
        for (let q = 0; q < quantities.length; q++) {
          if (isIndexed && !net.slotIn(s, keepMasks[q] ?? 0)) continue;
          const kept = quantities[q]?.stored(el);
          // The full recompute totals only the tree's elements; a value kept anywhere else is left alone.
          if (kept === undefined || !inTree(tree, el)) continue;
          const at = isIndexed ? s : net.slotFor(el.id);
          if (at < 0) {
            recompute = true;
            return;
          }
          if (kept !== (totals[q]?.[at] ?? 0)) derived = false;
        }
      }
      const placement = ends.placement(el.kind);
      if (placement !== null) {
        const at = hostedAt(el, placement);
        const host = at === null ? undefined : ref(s, at.hostId, false);
        const placed = host && at ? tree.placeTap(host, at) : null;
        if (placed) {
          const position = roundVec(placed);
          if (at && (position.x !== at.position.x || position.y !== at.position.y)) derived = false;
        }
        return;
      }
      switch (el.kind) {
        case "run_segment":
        case "run_fitting":
          runSeeds.push(el.id);
          break;
        case "part":
          if (el.links) runSeeds.push(el.id);
          break;
        case "opening": {
          const host = ref(s, el.hostId, false);
          if (host && host.kind === "wall" && openingMoved(host, el)) derived = false;
          break;
        }
        case "tag": {
          const target = ref(s, el.targetId, false);
          if (target && tagMoved(target, el)) derived = false;
          break;
        }
        case "dimension": {
          const a = ref(s, el.aId, false);
          const b = ref(s, el.bId, true);
          if (dimensionChanged(a, b, el)) derived = false;
          break;
        }
        default:
          break;
      }
    },
    result() {
      if (recompute) return recomputeDerived(model).changedIds.length === 0;
      if (runSeeds.length > 0 && deriveRuns(draftElements(elements), runSeeds).length > 0) derived = false;
      return derived;
    },
  };
}

function openingMoved(host: Extract<BimElement, { kind: "wall" }>, el: Opening): boolean {
  const position = roundVec(openingPosition(host, el.offset));
  return position.x !== el.position.x || position.y !== el.position.y;
}

function tagMoved(target: BimElement, el: Tag): boolean {
  const anchor = anchorOf(target);
  if (!anchor) return false;
  const position = roundVec(add(anchor, el.offset));
  return position.x !== el.position.x || position.y !== el.position.y;
}

function dimensionChanged(a: BimElement | undefined, b: BimElement | undefined, el: Dimension): boolean {
  const pa = a ? anchorOf(a) : null;
  const pb = b ? anchorOf(b) : null;
  if (!pa || !pb) return false;
  return round(distance(pa, pb), 1) !== el.valueMm;
}

/** The opening with its derived position recomputed, or null when unchanged / host missing. */
function rederiveOpening(elements: Readonly<Record<string, BimElement>>, el: Opening): Opening | null {
  const host = elements[el.hostId];
  if (!host || host.kind !== "wall") return null;
  const position = roundVec(openingPosition(host, el.offset));
  return position.x !== el.position.x || position.y !== el.position.y ? { ...el, position } : null;
}

/** The tag / dimension with derived values recomputed, or null when unchanged / target missing. */
function rederiveAnnotation(elements: Readonly<Record<string, BimElement>>, el: Tag | Dimension): Tag | Dimension | null {
  if (el.kind === "tag") {
    const target = elements[el.targetId];
    const anchor = target ? anchorOf(target) : null;
    if (!anchor) return null;
    const position = roundVec(add(anchor, el.offset));
    return position.x !== el.position.x || position.y !== el.position.y ? { ...el, position } : null;
  }
  const a = elements[el.aId];
  const b = elements[el.bId];
  const pa = a ? anchorOf(a) : null;
  const pb = b ? anchorOf(b) : null;
  if (!pa || !pb) return null;
  const valueMm = round(distance(pa, pb), 1);
  return valueMm !== el.valueMm ? { ...el, valueMm } : null;
}

/**
 * `quantity` per network element: its own value plus everything downstream
 * of it in the tree rooted at the unit. Elements outside the network (walls,
 * rooms, annotations) have no entry. An add-on names the quantity
 * (`TreeTotal`); the kernel only walks.
 */
export function computeTreeTotals(model: ModelState, quantity: TreeTotal): Map<ElementId, number> {
  return totalsOver(quantity, networkOf(model), model.elements);
}

/** `computeTreeTotals` over `net`, reading elements from `elements` (the same element set `net` indexes). */
function totalsOver(quantity: TreeTotal, net: NetworkIndex, elements: Readonly<Record<string, BimElement>>): Map<ElementId, number> {
  const totals = new Map<ElementId, number>();
  // Only a graph with a cycle can revisit an element still in progress.
  const visiting = net.isTree ? null : new Set<ElementId>();

  const visit = (id: ElementId): number => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;
    if (visiting) {
      if (visiting.has(id)) return 0;
      visiting.add(id);
    }
    const el = elements[id];
    let sum = el ? (quantity.own(el) ?? 0) : 0;
    if (el) for (const child of net.children(id)) sum += visit(child);
    totals.set(id, sum);
    return sum;
  };

  const all = elementValues(elements);
  const ends = connectorEndsTable();
  for (const el of all) {
    if (ends.isRoot(el.kind)) visit(el.id);
  }
  // Make sure orphaned pieces still get a value (0 or their own values).
  for (const el of all) {
    if (inTree(net.tree, el) && !totals.has(el.id)) visit(el.id);
  }
  return totals;
}

/**
 * Derived values after a command touched `touched` in `working` (a copy of
 * `base.elements`; taken over and updated in place). When `base` is fully
 * derived, only the touched elements' taps and, for each of the tree's
 * totals, the path from each element whose own value changed to its unit are
 * recomputed; the result, including the
 * order of `changedIds`, equals `recomputeDerived` on the whole model.
 */
export function recomputeDerivedAfter(
  base: ModelState,
  working: Record<string, BimElement>,
  touched: readonly ElementId[],
): DerivedResult {
  const draft: ModelState = { ...base, elements: working };
  const net = networkOf(base);
  const incremental =
    net.isTree &&
    sameTopology(base.elements, working, touched) &&
    knownConsistent(base, () => isFullyDerived(base));
  // The id walk below: a topology edit on a known-good tree (its touched paths in the old tree and the new one), or a tree the slot walk refuses.
  if (!incremental) {
    shareNetwork(base.elements, working, touched);
    deriveNetwork(base.elements, working, base.connections, touched);
    const walk = net.isTree && knownConsistent(base, () => isFullyDerived(base)) ? topologyWalk(draft, net, touched) : null;
    if (!walk) return recomputeDerived(draft);
    const totalChanged: ElementId[] = [];
    for (const quantity of walk.net.tree.totals) totalChanged.push(...totalsByIdAfter(quantity, walk.net, working, walk.seeds));
    return deriveRest(base, draft, walk.net, touched, walk.tapChanged, totalChanged);
  }
  shareNetwork(base.elements, working, touched);
  const tapChanged = retapTouched(net, working, touched);
  const written = [...touched, ...tapChanged];
  const totalChanged: ElementId[] = [];
  for (const quantity of net.tree.totals) {
    // A total depends only on topology and own values: walk up from each element whose own value changed.
    const seeds = ownChanged(quantity, base.elements, working, touched);
    if (seeds.length === 0) continue;
    // The slot walk, else the same pass walked by id (any tree the slot walk refuses).
    totalChanged.push(...(totalsBySlotAfter(quantity, net, base, working, written, seeds) ?? totalsByIdAfter(quantity, net, working, seeds)));
  }
  return deriveRest(base, draft, net, touched, tapChanged, totalChanged);
}

/** Those of `touched` whose own value of `quantity` changed (added, or a different value), in `touched` order. */
function ownChanged(quantity: TreeTotal, before: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, touched: readonly ElementId[]): ElementId[] {
  const out: ElementId[] = [];
  for (const id of touched) {
    const now = working[id];
    const value = now ? quantity.own(now) : undefined;
    if (!now || value === undefined) continue;
    const was = before[id];
    if (was && quantity.own(was) === value) continue;
    out.push(now.id);
  }
  return out;
}

interface TopologyWalk {
  readonly net: NetworkIndex;
  readonly tapChanged: readonly ElementId[];
  /** Where the id walk starts: it re-sums each seed and everything above it. */
  readonly seeds: readonly ElementId[];
}

/**
 * The walk after a command that changed the network's shape (added, removed
 * or re-hosted network elements, references moved) on a fully derived tree.
 * An element's summed total changes only when a touched element is in its
 * subtree in the old tree or the new one (a parent edge changes only at a
 * touched end: children come from each element's own downstream ends), so
 * the seeds are the touched elements and their old-tree ancestors; the walk
 * adds their new-tree ancestors and keeps every other stored total. Taps,
 * runs, openings and annotations then follow the touched elements as in the
 * incremental path. Equals `recomputeDerived`, including the order of
 * `changedIds`. Null when the new network is not a tree.
 */
function topologyWalk(draft: ModelState, before: NetworkIndex, touched: readonly ElementId[]): TopologyWalk | null {
  const working = draft.elements as Record<string, BimElement>;
  const net = networkOf(draft);
  if (!net.isTree) return null;
  const tapChanged = retapTouched(net, working, touched);
  const seeds = new Set<ElementId>();
  for (const id of touched) {
    const now = working[id];
    if (now && inTree(net.tree, now)) seeds.add(id);
    const seen = new Set<ElementId>();
    for (let x = before.parent(id); x !== undefined && !seen.has(x); x = before.parent(x)) {
      seen.add(x);
      const el = working[x];
      if (el && inTree(net.tree, el)) seeds.add(x);
    }
  }
  return { net, tapChanged, seeds: [...seeds] };
}

/** Taps among `touched` or hosted on a touched tap host, re-placed on their hosts; the ones that moved, in element order. */
function retapTouched(net: NetworkIndex, working: Record<string, BimElement>, touched: readonly ElementId[]): ElementId[] {
  const tree = net.tree;
  const ends = net.ends;
  const tapCandidates = new Set<ElementId>();
  for (const id of touched) {
    const el = working[id];
    if (el && ends.placement(el.kind) !== null) tapCandidates.add(el.id);
    else if (el && tree.hostsTaps(el.kind)) for (const tapId of net.hostedTaps(id)) tapCandidates.add(tapId);
  }
  const tapChanged: ElementId[] = [];
  for (const id of sortBy(tapCandidates, (x) => net.order.get(x) ?? Number.MAX_SAFE_INTEGER)) {
    const el = working[id];
    const placement = el ? ends.placement(el.kind) : null;
    if (!el || placement === null) continue;
    const updated = retapped(tree, working, el, placement);
    if (updated) {
      working[el.id] = updated;
      tapChanged.push(el.id);
    }
  }
  return tapChanged;
}

/**
 * `seeds`' paths re-summed by slot for `quantity` (no id lookups per
 * element); writes the totals that differ into `working` and returns those
 * ids in `sortByAirflow` order. Null when the slot walk doesn't apply.
 */
function totalsBySlotAfter(quantity: TreeTotal, net: NetworkIndex, base: ModelState, working: Record<string, BimElement>, written: readonly ElementId[], seeds: readonly ElementId[]): ElementId[] | null {
  const baseRead = net.readerFor(base.elements);
  // `working` differs from the base only in what the command and the tap pass wrote.
  const own = new Map<number, BimElement | undefined>();
  for (const id of written) {
    const s = net.order.get(id);
    if (s === undefined || s >= net.size) continue;
    own.set(s, working[id]);
  }
  const read = (s: number): BimElement | undefined => (own.has(s) ? own.get(s) : baseRead(s));
  const after = net.totalsAfter(quantity, seeds, read);
  if (!after) return null;
  const changed: ElementId[] = [];
  after.slots.forEach((s, i) => {
    const el = read(s);
    if (!el) return;
    const value = after.totals[i] ?? 0;
    const kept = quantity.stored(el);
    if (kept !== undefined && kept !== value) {
      working[el.id] = quantity.withTotal(el, value);
      changed.push(el.id);
    }
  });
  return changed;
}

/** The same pass walked by id: any tree the slot walk refuses. Writes the totals that differ into `working`; returns those ids in `sortByAirflow` order. */
function totalsByIdAfter(quantity: TreeTotal, net: NetworkIndex, working: Record<string, BimElement>, seeds: readonly ElementId[]): ElementId[] {
  const dirty = new Set<ElementId>();
  for (const seed of seeds) {
    let x: ElementId | undefined = seed;
    while (x !== undefined && !dirty.has(x)) {
      dirty.add(x);
      x = net.parent(x);
    }
  }
  const memo = new Map<ElementId, number>();
  const total = (id: ElementId): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const el = working[id];
    const kept = el && !dirty.has(id) ? quantity.stored(el) : undefined;
    if (kept !== undefined) return kept;
    let sum = el ? (quantity.own(el) ?? 0) : 0;
    if (el) for (const child of net.children(id)) sum += total(child);
    memo.set(id, sum);
    return sum;
  };
  const changed: ElementId[] = [];
  for (const id of net.sortByAirflow(dirty)) {
    const el = working[id];
    if (!el) continue;
    const value = total(id);
    const kept = quantity.stored(el);
    if (kept !== undefined && kept !== value) {
      working[id] = quantity.withTotal(el, value);
      changed.push(el.id);
    }
  }
  return changed;
}

/** After taps and the tree's totals: routed runs, openings, then annotations. */
function deriveRest(base: ModelState, draft: ModelState, net: NetworkIndex, touched: readonly ElementId[], tapChanged: readonly ElementId[], flowChanged: readonly ElementId[]): DerivedResult {
  const working = draft.elements as Record<string, BimElement>;
  const runSeeds = new Set<ElementId>();
  for (const id of touched) {
    const now = working[id];
    if (now?.kind === "run_segment" || now?.kind === "run_fitting" || now?.kind === "part" || now?.kind === "load_point") runSeeds.add(id);
    // A load point added, edited or removed changes what its pipe carries.
    for (const lp of [now, base.elements[id]]) if (lp?.kind === "load_point") addRunEnd(runSeeds, lp);
    for (const ct of [now, base.elements[id]]) if (ct?.kind === "service_catalog" && ct.entry.type === "connection_type") for (const lp of loadPointsNaming(working, ct.entry.designator)) addRunEnd(runSeeds, lp);
    for (const n of routingNeighbours(now)) runSeeds.add(n);
    for (const n of routingNeighbours(base.elements[id])) runSeeds.add(n);
  }
  const runChanged = runSeeds.size > 0 ? deriveRunsAfter(base.elements, working, touched, runSeeds) : [];

  const byOrder = (x: ElementId): number => net.order.get(x) ?? Number.MAX_SAFE_INTEGER;
  const openingCandidates = new Set<ElementId>();
  for (const id of touched) {
    if (working[id]?.kind === "opening") openingCandidates.add(id);
    for (const dep of net.dependents(id)) if (working[dep]?.kind === "opening") openingCandidates.add(dep);
  }
  const openingChanged: ElementId[] = [];
  for (const id of sortBy(openingCandidates, byOrder)) {
    const el = working[id];
    if (!el || el.kind !== "opening") continue;
    const updated = rederiveOpening(working, el);
    if (updated) {
      working[id] = updated;
      openingChanged.push(id);
    }
  }

  const annotationCandidates = annotationsOf(net, working, [...touched, ...tapChanged, ...runChanged, ...openingChanged]);
  const annotationChanged: ElementId[] = [];
  for (const id of sortBy(annotationCandidates, byOrder)) {
    const el = working[id];
    if (!el || (el.kind !== "tag" && el.kind !== "dimension")) continue;
    const updated = rederiveAnnotation(working, el);
    if (updated) {
      working[id] = updated;
      annotationChanged.push(id);
    }
  }

  const touchedSet = new Set(touched);
  const airflowOnlyIds = flowChanged.filter((id) => !touchedSet.has(id));
  return { model: draft, changedIds: [...tapChanged, ...flowChanged, ...runChanged, ...openingChanged, ...annotationChanged], airflowOnlyIds };
}

/** Tags and dimensions among `ids` or pointing at any of them. */
function annotationsOf(net: NetworkIndex, working: Readonly<Record<string, BimElement>>, ids: readonly ElementId[]): Set<ElementId> {
  const out = new Set<ElementId>();
  const isAnnotation = (id: ElementId): boolean => {
    const kind = working[id]?.kind;
    return kind === "tag" || kind === "dimension";
  };
  for (const id of ids) {
    if (isAnnotation(id)) out.add(id);
    for (const dep of net.dependents(id)) if (isAnnotation(dep)) out.add(dep);
  }
  return out;
}

/** A load on a run end re-derives its pipe; an estimate, a row or a device load is on no pipe. */
function addRunEnd(seeds: Set<ElementId>, lp: LoadRecord): void {
  const at = runEndOf(lp);
  if (at) seeds.add(at.elementId);
}
