/**
 * Connected-element trees (one per system, rooted at a unit: segments, taps,
 * elbows, leaves): what the kernel walks, and what an add-on says about it.
 *
 * The kernel indexes the tree (network.ts) and keeps derived values current
 * (derived.ts), but it knows no trade: which element kinds host taps, where
 * a tap sits on its host, and which quantity the tree totals (what a leaf
 * adds, where a node keeps its total) are an add-on's, declared on its
 * network adapter row (`NetworkAdapterItem.tree`, `NETWORK_ADAPTER_POINT`).
 * Any add-on may declare them, each its own host kinds and quantities, side
 * by side. With none declared, no kind hosts taps and nothing is totalled.
 */
import { NETWORK_ADAPTER_POINT } from "./connections/model";
import { activePackSet } from "./packs/scope";
import { firstPartyBaseRevision, packSetReadsRecorded, type PackSet } from "./packs/set";
import type { BimElement, Vec2 } from "./types";

/** Where a hosted record sits on its host: its distance along it and the side it leaves from (+1 left of travel, -1 right). */
export interface HostedAlong {
  readonly s: number;
  readonly side: 1 | -1;
}

/** One element kind that hosts taps: they hang under it in the tree, after its own connections. */
export interface TreeTapHost {
  readonly kind: string;
  /** Where `tap` sits on `host` (the tap's derived position, before rounding), or null to leave the tap where it is. */
  place(host: BimElement, tap: HostedAlong): Vec2 | null;
  /** How far `s` runs along `host` (its length, for end clearance), or null when `host` isn't this kind. */
  span(host: BimElement): number | null;
}

/**
 * A quantity the tree totals: each node's total is its own value plus its
 * children's totals, in child order. Asked of every element the walk reads.
 */
export interface TreeTotal {
  /** Names the quantity (`<pack>.<name>`), for listing and messages. */
  readonly id: string;
  /** The kinds whose own value counts (a leaf's design value). `own` is undefined for every other kind. */
  readonly ownKinds: readonly string[];
  /** What `el` adds of its own, or undefined when its kind adds nothing. */
  own(el: BimElement): number | undefined;
  /** The kinds that keep a total. `stored` is undefined for every other kind. */
  readonly storedKinds: readonly string[];
  /** The total `el` keeps, or undefined when it keeps none. */
  stored(el: BimElement): number | undefined;
  /** `el` keeping `total`. Called only where `stored` is defined and differs from `total`. */
  withTotal(el: BimElement, total: number): BimElement;
}

/** What one network adapter row says about the connected-element tree. */
export interface TreeNetworkFace {
  readonly tapHosts?: readonly TreeTapHost[];
  readonly totals?: readonly TreeTotal[];
}

/** The tree as the pack set in force declares it: every row's faces, merged. */
export interface TreeNetwork {
  /** True when an add-on declares that `kind` hosts taps. */
  hostsTaps(kind: string): boolean;
  /** `tap`'s derived position on `host`, or null when no add-on places taps on that kind (or its rule declines). */
  placeTap(host: BimElement, tap: HostedAlong): Vec2 | null;
  /** How far a tap's `s` runs along `host`, or null when no add-on lets that kind host taps (a tap on it has no valid host). */
  tapSpan(host: BimElement): number | null;
  /** The quantities the tree totals, in row order. */
  readonly totals: readonly TreeTotal[];
}

function resolve(faces: readonly TreeNetworkFace[]): TreeNetwork {
  const hosts = new Map<string, TreeTapHost>();
  const totals: TreeTotal[] = [];
  const totalIds = new Set<string>();
  const problems: string[] = [];
  for (const face of faces) {
    for (const host of face.tapHosts ?? []) {
      if (hosts.has(host.kind)) problems.push(`two add-ons declare that ${host.kind} hosts taps`);
      else hosts.set(host.kind, host);
    }
    for (const total of face.totals ?? []) {
      if (totalIds.has(total.id)) problems.push(`two add-ons total ${total.id} over the tree`);
      else {
        totalIds.add(total.id);
        totals.push(total);
      }
    }
  }
  if (problems.length > 0) {
    const message = `[bim-kernel/tree-network] the tree's declarations conflict: ${problems.join("; ")}`;
    console.error(message);
    throw new Error(message);
  }
  const byKind: ReadonlyMap<string, TreeTapHost> = hosts;
  return Object.freeze({
    hostsTaps: (kind: string) => byKind.has(kind),
    placeTap: (host: BimElement, tap: HostedAlong) => byKind.get(host.kind)?.place(host, tap) ?? null,
    tapSpan: (host: BimElement) => byKind.get(host.kind)?.span(host) ?? null,
    totals: Object.freeze(totals),
  });
}

/**
 * One resolved tree per distinct list of faces (by identity), so every set
 * that carries the same rows (each model's set over the same first-party
 * base) shares one value, and an index built under one is reused under the
 * others.
 */
const interned: Array<{ readonly faces: readonly TreeNetworkFace[]; readonly tree: TreeNetwork }> = [];

function internedFor(faces: readonly TreeNetworkFace[]): TreeNetwork {
  for (const entry of interned) {
    if (entry.faces.length === faces.length && entry.faces.every((f, i) => f === faces[i])) return entry.tree;
  }
  const tree = resolve(faces);
  interned.push({ faces, tree });
  return tree;
}

const MEMO_KEY = "kernel.network_adapter#tree";

const resolveTree = (set: PackSet): TreeNetwork => internedFor(set.items(NETWORK_ADAPTER_POINT).flatMap((item) => (item.tree ? [item.tree] : [])));

function treeOf(set: PackSet): TreeNetwork {
  return set.memo(MEMO_KEY, resolveTree);
}

let last: { readonly set: PackSet; readonly base: number; readonly tree: TreeNetwork } | null = null;

/** The tree the pack set in force declares: one map read once resolved for that set. */
export function treeNetwork(): TreeNetwork {
  const set = activePackSet();
  const base = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.base === base && !packSetReadsRecorded()) return last.tree;
  const tree = treeOf(set);
  // A recorded pass comes through here once per check: keep the holder when nothing changed.
  if (last === null || last.tree !== tree || last.set !== set || last.base !== base) last = { set, base, tree };
  return tree;
}
