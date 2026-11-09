/**
 * The aggregation core every trade uses: each node's total is its own raw
 * quantities plus the raw totals of the nodes below it. Demand is computed
 * from that raw total *at each node* by the trade's rules (fixture units to
 * gpm, NEC demand factors by load class), never by adding up the children's
 * demands: a kitchen count at the MDP is not the serving panel's count, and
 * a Hunter curve is not additive.
 */

export interface Monoid<T> {
  empty(): T;
  /** `a` then `b`, as a new value (callers keep the parts they passed in). */
  add(a: T, b: T): T;
}

/** One node's raw total: its own value first, then each child's total in order, so floating-point sums are reproducible. */
export function combineNode<T>(own: T | undefined, children: Iterable<T>, m: Monoid<T>): T {
  let sum = own ?? m.empty();
  for (const c of children) sum = m.add(sum, c);
  return sum;
}

/**
 * Totals below every node of a tree. `order` lists parents before their
 * children (a breadth- or depth-first order from the root).
 */
export function accumulateBelow<N, T>(
  order: readonly N[],
  childrenOf: (n: N) => readonly N[],
  own: (n: N) => T | undefined,
  m: Monoid<T>,
  /** How a child's total reads at its parent (electrical: onto the feeding breaker's phases). Default: unchanged. */
  across?: (child: N, parent: N, total: T) => T,
): Map<N, T> {
  const total = new Map<N, T>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    if (n === undefined) continue;
    const below: T[] = [];
    for (const c of childrenOf(n)) {
      const t = total.get(c);
      if (t !== undefined) below.push(across ? across(c, n, t) : t);
    }
    total.set(n, combineNode(own(n), below, m));
  }
  return total;
}

export const sumMonoid: Monoid<number> = {
  empty: () => 0,
  add: (a, b) => a + b,
};
