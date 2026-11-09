import { accumulateBelow, sumMonoid, type Monoid } from "./aggregate";

/**
 * A network any trade can total: where it is fed from (`roots`), what is
 * below each node (`children`) and what each node adds itself
 * (`ownQuantities`). The electrical engine walks panels and circuits; the
 * plumbing adapter (load-points/engine.ts) walks pipe systems from their
 * source or outfall. Totals come from `accumulateBelow` with the quantity's
 * monoid, so a non-additive quantity (a Hunter curve's gpm) is never summed:
 * demand is taken from a node's total afterwards.
 */
export interface NetworkAdapter<N, V = number> {
  roots(): readonly N[];
  children(node: N): readonly N[];
  ownQuantities(node: N): V | undefined;
  /**
   * How many times a child's total counts at its parent: a typical unit's
   * branch joining the building drain counts once per instance
   * (`typicalEdgeFactor`). Absent: once everywhere.
   */
  edgeFactor?(child: N, parent: N): number;
  /**
   * How a child's total reads at one parent, per quantity: a beam's load
   * split between its two supports by load case (uniform 1/2 : 1/2, an
   * off-centre point load 2/3 : 1/3). Applied after `edgeFactor`. Absent:
   * the child's total, unchanged, at every parent that lists it.
   */
  across?(child: N, parent: N, total: V): V;
}

/**
 * Every node's total: its own plus everything below it. Iterative (no
 * recursion depth limit). An adapter with `edgeFactor` needs `scale` to count
 * a child's total that many times (additive quantities only).
 */
export function networkTotals<N, V>(adapter: NetworkAdapter<N, V>, monoid: Monoid<V>, scale?: (value: V, times: number) => V): Map<N, V> {
  const order: N[] = [];
  const seen = new Set<N>();
  const queue = [...adapter.roots()];
  for (const r of queue) seen.add(r);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as N;
    order.push(n);
    for (const c of adapter.children(n)) {
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(c);
    }
  }
  const factor = adapter.edgeFactor?.bind(adapter);
  if (factor && !scale) throw new Error("networkTotals: an adapter with an edge factor needs a scale for its values");
  const walk = parentsFirst(adapter, order, seen);
  const scaled = factor && scale ? (c: N, p: N, t: V) => {
    const k = factor(c, p);
    return k === 1 ? t : scale(t, k);
  } : undefined;
  const split = adapter.across?.bind(adapter);
  const across = split ? (c: N, p: N, t: V) => split(c, p, scaled ? scaled(c, p, t) : t) : scaled;
  return accumulateBelow(walk, (n) => adapter.children(n), (n) => adapter.ownQuantities(n), monoid, across);
}

/**
 * The walk order totals are folded in: breadth-first for a tree (unchanged, so
 * sums keep their order), parents before children when a node has two or more
 * parents (a beam on columns at different depths), else a parent could be
 * folded before that child and drop its load.
 */
function parentsFirst<N>(adapter: Pick<NetworkAdapter<N, unknown>, "children">, order: readonly N[], walked: ReadonlySet<N>): readonly N[] {
  const indegree = new Map<N, number>();
  let shared = false;
  for (const n of order) {
    for (const c of adapter.children(n)) {
      if (!walked.has(c)) continue;
      const d = (indegree.get(c) ?? 0) + 1;
      if (d > 1) shared = true;
      indegree.set(c, d);
    }
  }
  if (!shared) return order;
  const ready = order.filter((n) => !indegree.get(n));
  for (let i = 0; i < ready.length; i++) {
    for (const c of adapter.children(ready[i] as N)) {
      if (!walked.has(c)) continue;
      const d = (indegree.get(c) ?? 0) - 1;
      indegree.set(c, d);
      if (d === 0) ready.push(c);
    }
  }
  if (ready.length !== order.length) {
    console.error("[bim-kernel] networkTotals: the network has a loop through shared nodes; totalling it in walk order", { nodes: order.length, ordered: ready.length });
    return order;
  }
  return ready;
}

const scaleNumber = (v: number, k: number) => v * k;

/**
 * Totals kept up to date one node at a time: when a node's own value changes
 * by Δ, it and every ancestor change by Δ (times each edge's factor on the
 * way up). O(depth) per edit, for additive quantities (fixture units, CFM,
 * MBH, VA). Anything that changes the tree's shape, or a factor, rebuilds it.
 *
 * A node may have several parents (a beam bearing on two supports) and an
 * adapter's `across` may split what reaches each one: then the change is
 * carried up every path, each edge reading the child's old and new totals
 * through `across`, deepest nodes first so a node shared by two paths moves
 * once with both changes.
 */
export class IncrementalTotals<N> {
  private readonly total: Map<N, number>;
  private readonly own: Map<N, number>;
  /** Present when a node has more than one parent or an edge has `across`. */
  private readonly dag: { readonly ups: ReadonlyMap<N, readonly N[]>; readonly rank: ReadonlyMap<N, number>; readonly across: ((child: N, parent: N, total: number) => number) | null; readonly factorOf: (child: N, parent: N) => number } | null;

  constructor(
    private readonly parent: ReadonlyMap<N, N | null>,
    own: ReadonlyMap<N, number>,
    total: ReadonlyMap<N, number>,
    /** Each node's edge factor to its parent; absent nodes count once. */
    private readonly factor: ReadonlyMap<N, number> = new Map(),
    dag: IncrementalTotals<N>["dag"] = null,
  ) {
    this.own = new Map(own);
    this.total = new Map(total);
    this.dag = dag;
  }

  /** `parent`: each node's parent (null for a root), or its parents when it has several. */
  static build<N>(adapter: NetworkAdapter<N>, parent: ReadonlyMap<N, N | null | readonly N[]>): IncrementalTotals<N> {
    const totals = networkTotals(adapter, sumMonoid, scaleNumber);
    const own = new Map<N, number>();
    const factor = new Map<N, number>();
    const single = new Map<N, N | null>();
    const ups = new Map<N, readonly N[]>();
    let multi = false;
    for (const [n, p] of parent) {
      const list: readonly N[] = p === null ? [] : isList(p) ? p : [p];
      ups.set(n, list);
      if (list.length > 1) multi = true;
      single.set(n, list[0] ?? null);
    }
    for (const n of totals.keys()) {
      own.set(n, adapter.ownQuantities(n) ?? 0);
      const p = single.get(n);
      if (adapter.edgeFactor && p !== null && p !== undefined) {
        const k = adapter.edgeFactor(n, p);
        if (k !== 1) factor.set(n, k);
      }
    }
    if (!multi && !adapter.across) return new IncrementalTotals(single, own, totals, factor);
    const rank = topologicalRank([...totals.keys()], (n) => adapter.children(n));
    const edgeFactor = adapter.edgeFactor?.bind(adapter);
    const across = adapter.across?.bind(adapter) ?? null;
    return new IncrementalTotals(single, own, totals, factor, { ups, rank, across, factorOf: (c, p) => (edgeFactor ? edgeFactor(c, p) : 1) });
  }

  /** Each node and its (first) parent (null for a root). */
  parents(): ReadonlyMap<N, N | null> {
    return this.parent;
  }

  has(node: N): boolean {
    return this.parent.has(node);
  }

  totalOf(node: N): number {
    return this.total.get(node) ?? 0;
  }

  ownOf(node: N): number {
    return this.own.get(node) ?? 0;
  }

  /** Sets a node's own value; returns the nodes whose totals changed (it and its ancestors), nearest first. */
  setOwn(node: N, value: number): N[] {
    let delta = value - (this.own.get(node) ?? 0);
    if (delta === 0 || !this.parent.has(node)) return [];
    this.own.set(node, value);
    if (this.dag) return this.carry(this.dag, node, delta);
    const changed: N[] = [];
    for (let n: N | null | undefined = node; n !== null && n !== undefined; n = this.parent.get(n)) {
      this.total.set(n, Math.round(((this.total.get(n) ?? 0) + delta) * 1e9) / 1e9);
      changed.push(n);
      delta *= this.factor.get(n) ?? 1;
    }
    return changed;
  }

  private carry(dag: NonNullable<IncrementalTotals<N>["dag"]>, node: N, delta: number): N[] {
    const pending = new Map<N, number>([[node, delta]]);
    const changed: N[] = [];
    const rankOf = (n: N) => dag.rank.get(n) ?? -1;
    while (pending.size > 0) {
      // The deepest pending node: every path into it has already added its change.
      let n: N | undefined;
      for (const k of pending.keys()) if (n === undefined || rankOf(k) > rankOf(n)) n = k;
      if (n === undefined) break;
      const d = pending.get(n) ?? 0;
      pending.delete(n);
      const before = this.total.get(n) ?? 0;
      const after = Math.round((before + d) * 1e9) / 1e9;
      this.total.set(n, after);
      changed.push(n);
      for (const p of dag.ups.get(n) ?? []) {
        const k = dag.factorOf(n, p);
        const up = dag.across ? dag.across(n, p, after * k) - dag.across(n, p, before * k) : (after - before) * k;
        if (up !== 0) pending.set(p, (pending.get(p) ?? 0) + up);
      }
    }
    return changed;
  }
}

/** Each node's place in an order where every parent comes before its children (Kahn's algorithm over `children`). */
function topologicalRank<N>(nodes: readonly N[], children: (n: N) => readonly N[]): Map<N, number> {
  const inside = new Set(nodes);
  const indegree = new Map<N, number>(nodes.map((n) => [n, 0]));
  for (const n of nodes) for (const c of children(n)) if (inside.has(c)) indegree.set(c, (indegree.get(c) ?? 0) + 1);
  const queue = nodes.filter((n) => (indegree.get(n) ?? 0) === 0);
  const rank = new Map<N, number>();
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as N;
    rank.set(n, i);
    for (const c of children(n)) {
      if (!inside.has(c)) continue;
      const left = (indegree.get(c) ?? 0) - 1;
      indegree.set(c, left);
      if (left === 0) queue.push(c);
    }
  }
  // A cycle leaves nodes unranked; they take the end, in model order.
  for (const n of nodes) if (!rank.has(n)) rank.set(n, rank.size);
  return rank;
}

function isList<N>(p: N | readonly N[]): p is readonly N[] {
  return Array.isArray(p);
}
