import { type Monoid, ELECTRICAL_LOAD_CLASSES, type ElectricalLoadClass } from "@permitzip/bim-kernel";
import { loadClassLabel, type MemberLoad } from "./loads";
import type { DemandLoad } from "./rules";

/**
 * The raw connected inventory below a node, kept exactly enough for any
 * demand rule: per load class and continuity, the number of loads, their
 * total VA and the two largest (220.56's floor is the two largest kitchen
 * loads; the motor adder is the largest motor). Adding two inventories is
 * exact, so a node's inventory is its own loads plus its children's
 * inventories, and demand is always computed from that, never from the
 * children's demands.
 */

export interface Largest {
  readonly va: number;
  readonly label: string;
}

export interface Bucket {
  readonly loadClass: ElectricalLoadClass;
  readonly continuous: boolean;
  readonly count: number;
  readonly va: number;
  /** The two largest loads, largest first (ties: the label that sorts first). */
  readonly largest: readonly Largest[];
}

export interface Inventory {
  /** Keyed `${class}|c` (continuous) or `${class}|n`. */
  readonly buckets: ReadonlyMap<string, Bucket>;
  /** Connected VA on each phase, in this node's phases (A, B, C). */
  readonly perPhase: readonly [number, number, number];
  readonly va: number;
  /** Members served below this node, and how many have no load to count. */
  readonly members: number;
  readonly unloaded: number;
}

const NO_PHASES: readonly [number, number, number] = [0, 0, 0];

export const EMPTY_INVENTORY: Inventory = { buckets: new Map(), perPhase: NO_PHASES, va: 0, members: 0, unloaded: 0 };

function before(a: Largest, b: Largest): boolean {
  return a.va > b.va || (a.va === b.va && a.label < b.label);
}

function topTwo(a: readonly Largest[], b: readonly Largest[]): Largest[] {
  const all = [...a, ...b];
  all.sort((x, y) => (before(x, y) ? -1 : before(y, x) ? 1 : 0));
  return all.slice(0, 2);
}

function addBuckets(a: ReadonlyMap<string, Bucket>, b: ReadonlyMap<string, Bucket>): Map<string, Bucket> {
  const out = new Map(a);
  for (const [key, t] of b) {
    const prev = out.get(key);
    out.set(key, prev ? { ...prev, count: prev.count + t.count, va: prev.va + t.va, largest: topTwo(prev.largest, t.largest) } : t);
  }
  return out;
}

export const inventoryMonoid: Monoid<Inventory> = {
  empty: () => EMPTY_INVENTORY,
  add(a, b) {
    if (b === EMPTY_INVENTORY) return a;
    if (a === EMPTY_INVENTORY) return b;
    return {
      buckets: addBuckets(a.buckets, b.buckets),
      perPhase: [a.perPhase[0] + b.perPhase[0], a.perPhase[1] + b.perPhase[1], a.perPhase[2] + b.perPhase[2]],
      va: a.va + b.va,
      members: a.members + b.members,
      unloaded: a.unloaded + b.unloaded,
    };
  },
};

/** One member's load as an inventory, spread evenly over the phases its breaker poles sit on. */
export function memberInventory(load: MemberLoad, phases: readonly number[]): Inventory {
  if (load.va <= 0) return { ...EMPTY_INVENTORY, members: 1, unloaded: 1 };
  const perPhase: [number, number, number] = [0, 0, 0];
  const on = phases.length > 0 ? phases : [0];
  for (const p of on) perPhase[p as 0 | 1 | 2] += load.va / on.length;
  const key = `${load.loadClass}|${load.continuous ? "c" : "n"}`;
  const bucket: Bucket = { loadClass: load.loadClass, continuous: load.continuous, count: 1, va: load.va, largest: [{ va: load.va, label: load.name }] };
  return { buckets: new Map([[key, bucket]]), perPhase, va: load.va, members: 1, unloaded: 0 };
}

/**
 * `n` identical copies of an inventory (a typical unit counted once per
 * instance): counts, VA and phases times n; the two largest become the
 * largest two of n copies, so a demand rule sees exactly what n real copies
 * would give it.
 */
export function scaleInventory(inv: Inventory, n: number): Inventory {
  if (n === 1 || inv === EMPTY_INVENTORY) return inv;
  const buckets = new Map<string, Bucket>();
  for (const [key, b] of inv.buckets) {
    const copies = Array.from({ length: Math.min(n, 2) }, () => b.largest).flat();
    buckets.set(key, { ...b, count: b.count * n, va: b.va * n, largest: topTwo(copies, []) });
  }
  return {
    buckets,
    perPhase: [inv.perPhase[0] * n, inv.perPhase[1] * n, inv.perPhase[2] * n],
    va: inv.va * n,
    members: inv.members * n,
    unloaded: inv.unloaded * n,
  };
}

/** A fed node's inventory read at the breaker feeding it: its phase i lands on the breaker's i-th pole. No poles (a transformer secondary): unchanged. */
export function acrossFeeder(inv: Inventory, phases: readonly number[]): Inventory {
  if (phases.length === 0 || inv.va === 0) return inv;
  const perPhase: [number, number, number] = [0, 0, 0];
  inv.perPhase.forEach((va, i) => {
    const to = phases[i % phases.length] ?? 0;
    perPhase[to as 0 | 1 | 2] += va;
  });
  return { ...inv, perPhase };
}

function classOrder(c: ElectricalLoadClass): number {
  return ELECTRICAL_LOAD_CLASSES.indexOf(c);
}

/**
 * The inventory as demand-rule input: the two largest of each bucket as
 * themselves, the rest as identical units of their average VA. The count,
 * the total and the largest loads are exact, which is everything the demand
 * rules read.
 */
export function demandLoads(inv: Inventory): DemandLoad[] {
  const out: DemandLoad[] = [];
  const buckets = [...inv.buckets.values()].sort((a, b) => classOrder(a.loadClass) - classOrder(b.loadClass) || Number(b.continuous) - Number(a.continuous));
  for (const b of buckets) {
    let restVa = b.va;
    for (const l of b.largest) {
      out.push({ label: l.label, loadClass: b.loadClass, va: l.va, quantity: 1, continuous: b.continuous });
      restVa -= l.va;
    }
    const restCount = b.count - b.largest.length;
    if (restCount > 0 && restVa > 0) out.push({ label: `${restCount} other ${loadClassLabel(b.loadClass).toLowerCase()} load${restCount === 1 ? "" : "s"}`, loadClass: b.loadClass, va: restVa / restCount, quantity: restCount, continuous: b.continuous });
  }
  return out;
}
