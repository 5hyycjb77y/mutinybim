import type { BimElement } from "../types";

/**
 * What a routed system's flow walk computed, kept so a load-point edit can
 * re-derive only the edited points' paths to the root instead of walking the
 * whole system again (routing/derive.ts `deriveRunsAfter`).
 *
 * Exactness: a node's total is refolded exactly as `flowComponent` folds it
 * (children in descending walk order, starting from 0, then its own load), so
 * every flow written is the same number a full walk writes, bit for bit.
 *
 * Snapshots: a model's trees are never changed in place. A local edit makes
 * new trees whose own and total values are layers over the previous ones
 * (flattened every few edits), so an older model (undo, a preview) still reads
 * its own numbers.
 */
type Node = string;

/** A number per node, as a thin layer over the previous snapshot's values. */
export class NodeValues {
  private constructor(
    private readonly below: NodeValues | null,
    private readonly values: ReadonlyMap<Node, number>,
    private readonly depth: number,
  ) {}

  static of(values: ReadonlyMap<Node, number>): NodeValues {
    return new NodeValues(null, values, 0);
  }

  get(n: Node): number | undefined {
    for (let layer: NodeValues | null = this; layer !== null; layer = layer.below) {
      const v = layer.values.get(n);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** A new layer with `changes` on top; folded into one map once the stack is deep. */
  with(changes: ReadonlyMap<Node, number>, all: readonly Node[]): NodeValues {
    if (changes.size === 0) return this;
    if (this.depth + 1 < MAX_LAYERS) return new NodeValues(this, changes, this.depth + 1);
    const flat = new Map<Node, number>();
    for (const n of all) {
      const v = changes.get(n) ?? this.get(n);
      if (v !== undefined) flat.set(n, v);
    }
    return new NodeValues(null, flat, 0);
  }
}

const MAX_LAYERS = 16;

export interface FlowTree {
  /** The walk order from the root (the full walk's BFS order). */
  readonly order: readonly Node[];
  readonly index: ReadonlyMap<Node, number>;
  readonly parent: ReadonlyMap<Node, Node | null>;
  /** Each node's children, in the order the full walk folds them (descending walk order). */
  readonly children: ReadonlyMap<Node, readonly Node[]>;
  readonly own: NodeValues;
  /** Each node's total before rounding: its children's totals folded, plus its own. */
  readonly total: NodeValues;
  /** A water heater joins this system to another: its loads aren't local to one walk. */
  readonly coupled: boolean;
}

/** The trees of one model snapshot, by node. */
export interface FlowForest {
  readonly treeOf: ReadonlyMap<Node, FlowTree>;
}

const forests = new WeakMap<Readonly<Record<string, BimElement>>, FlowForest>();

export function flowForestOf(elements: Readonly<Record<string, BimElement>>): FlowForest | undefined {
  return forests.get(elements);
}

export function setFlowForest(elements: Readonly<Record<string, BimElement>>, forest: FlowForest): void {
  forests.set(elements, forest);
}

/** The same kept walks on a copy of `from` that differs only in element versions. */
export function carryFlowForest(from: Readonly<Record<string, BimElement>>, to: Readonly<Record<string, BimElement>>): void {
  const forest = forests.get(from);
  if (forest) forests.set(to, forest);
}

/** A forest with `trees` replacing whatever trees their nodes were in. */
export function forestWith(base: FlowForest | undefined, keep: (tree: FlowTree) => boolean, trees: readonly FlowTree[]): FlowForest {
  const treeOf = new Map<Node, FlowTree>();
  if (base) for (const [n, t] of base.treeOf) if (keep(t)) treeOf.set(n, t);
  for (const t of trees) for (const n of t.order) treeOf.set(n, t);
  return { treeOf };
}

/** A captured walk: order, parents, own loads and the totals the full walk summed. */
export function captureTree(order: readonly Node[], parent: ReadonlyMap<Node, Node | null>, own: ReadonlyMap<Node, number>, total: ReadonlyMap<Node, number>, coupled: boolean): FlowTree {
  const index = new Map<Node, number>();
  order.forEach((n, i) => index.set(n, i));
  const children = new Map<Node, Node[]>();
  // Ascending walk order, reversed below: the full walk folds a node's children from the last one back.
  for (const n of order) {
    const up = parent.get(n);
    if (up === null || up === undefined) continue;
    const list = children.get(up);
    if (list) list.push(n);
    else children.set(up, [n]);
  }
  for (const list of children.values()) list.reverse();
  return { order, index, parent, children, own: NodeValues.of(own), total: NodeValues.of(total), coupled };
}

/** A node's total as the full walk computes it, from its children's totals and its own load. */
export function refold(tree: FlowTree, n: Node, own: (n: Node) => number, total: (n: Node) => number): number {
  let acc: number | undefined;
  for (const c of tree.children.get(n) ?? []) acc = (acc ?? 0) + total(c);
  return (acc ?? 0) + own(n);
}

/**
 * `tree` with new own loads for some nodes: every ancestor of a changed node
 * refolded, deepest first. Returns the new tree and the nodes whose total moved.
 */
export function withOwn(tree: FlowTree, ownChanges: ReadonlyMap<Node, number>): { tree: FlowTree; moved: Node[] } {
  const dirty = new Set<Node>();
  for (const n of ownChanges.keys()) for (let a: Node | null | undefined = n; a !== null && a !== undefined && !dirty.has(a); a = tree.parent.get(a)) dirty.add(a);
  const byDepth = [...dirty].sort((a, b) => (tree.index.get(b) ?? 0) - (tree.index.get(a) ?? 0));
  const totals = new Map<Node, number>();
  const ownOf = (n: Node): number => ownChanges.get(n) ?? tree.own.get(n) ?? 0;
  const totalOf = (n: Node): number => totals.get(n) ?? tree.total.get(n) ?? 0;
  const moved: Node[] = [];
  for (const n of byDepth) {
    const t = refold(tree, n, ownOf, totalOf);
    if (t !== (tree.total.get(n) ?? 0)) moved.push(n);
    totals.set(n, t);
  }
  return {
    tree: { ...tree, own: tree.own.with(ownChanges, tree.order), total: tree.total.with(totals, tree.order) },
    moved,
  };
}
