import { QUANTITIES, QUANTITY_KEYS, type QuantityKey, type QuantityTotals } from "../quantities";
import type { BimElement } from "../types";
import { typicalOf, typicalOfGroup, typicalCount, type TypicalRef } from "./typicals";

/**
 * Typicals in every trade's totals (KERNEL-REQUIREMENTS-MODEL §3.8, F6): the
 * pieces a network walk or a requirement total needs to count a typical once
 * per instance. Nothing here walks a network or scans the model; each answer
 * reads the one group record the element names.
 *
 * Callers: the pipe walk (`routing/pipe/hydraulics.ts`), the plumbing network
 * engine (`load-points/engine.ts`), the requirement totals
 * (`requirements/allocation.ts`, `requirements/engine.ts`). Electrical keeps
 * its own `typicalMultiplier` (phase rotation needs the copy order).
 */

type Elements = Readonly<Record<string, BimElement>>;

/** How many times something in typical `t` counts in a total taken for `scopeGroupId`: once inside that same typical (or outside every typical), else once per instance. */
export function typicalFactor(t: TypicalRef | null, scopeGroupId: string | null | undefined): number {
  return !t || t.groupId === scopeGroupId ? 1 : typicalCount(t.spec);
}

/** The typical a group id names, with its instance count; 1 when it is not (or no longer) a typical. */
export function typicalCountOfGroup(elements: Elements, groupId: string | null | undefined): number {
  const t = typicalOfGroup(elements, groupId ?? undefined);
  return t ? typicalCount(t.spec) : 1;
}

export interface LoadTypical {
  /** The typical the load is in, or null. */
  readonly typical: TypicalRef | null;
  /** The group records the answer read (whether typicals or not), for a caller's dependency list. */
  readonly reads: readonly string[];
}

/**
 * The typical a load is in: its own group's, else its device's, else the
 * element it sits on (space, zone, pipe, part), else the space it stands in.
 * A fixture drawn in unit 001's bathroom counts with unit 001 even when only
 * the space (or only the pipes) were put in the group.
 */
export function loadTypicalOf(elements: Elements, load: BimElement | undefined, also: readonly (string | null | undefined)[] = []): LoadTypical {
  const reads: string[] = [];
  let typical: TypicalRef | null = null;
  const chain: Array<BimElement | undefined> = [load, ...also.map((id) => (id ? elements[id] : undefined))];
  for (const el of chain) {
    const g = el?.groupId;
    if (!g) continue;
    if (!reads.includes(g)) reads.push(g);
    if (typical === null) typical = typicalOfGroup(elements, g);
  }
  return { typical, reads };
}

/** The element a network node stands for: pipe walks name connector nodes `<partId>#<connector>`. */
export function nodeElementId(node: string): string {
  const hash = node.indexOf("#");
  return hash < 0 ? node : node.slice(0, hash);
}

/**
 * How many times a child's total counts at its parent in a network: the
 * typical's instance count when the child is in a typical and the parent is
 * not in that same typical (the bathroom's branch joining the building drain),
 * else once (pipes inside unit 001 add up as drawn). Same rule as
 * `typicalMultiplier` for electrical, keyed by node ids.
 */
export function typicalEdgeFactor(elements: Elements, childNode: string, parentNode: string): number {
  const child = elements[nodeElementId(childNode)];
  const t = typicalOf(elements, child);
  if (!t) return 1;
  const parent = elements[nodeElementId(parentNode)];
  return parent?.groupId === t.groupId ? 1 : typicalCount(t.spec);
}

/**
 * How many times a load counts in a total taken for `scopeGroupId` (the group
 * of the space, zone or source the total is for; undefined for the whole
 * project): its typical's count unless the scope is inside that same typical.
 */
export function typicalLoadCount(elements: Elements, load: BimElement | undefined, scopeGroupId: string | undefined): number {
  const t = typicalOf(elements, load);
  if (!t || scopeGroupId === t.groupId) return 1;
  return typicalCount(t.spec);
}

/** The instance count of the typical a scope (space, zone) belongs to, for scaling its counted figures into a project total; 1 outside a typical. */
export function typicalScopeCount(elements: Elements, scopeGroupId: string | undefined): number {
  const t = typicalOfGroup(elements, scopeGroupId);
  return t ? typicalCount(t.spec) : 1;
}

/** Totals for `n` instances: additive quantities (fixture units, MBH, CFM, VA) times `n`; the rest (a minimum inlet pressure) unchanged. */
export function scaleTotals(t: QuantityTotals, n: number): QuantityTotals {
  if (n === 1) return t;
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) throw new Error(`scaleTotals: instance count must be a whole number of at least 1, got ${n}`);
  const out = {} as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) out[k] = QUANTITIES[k].add === "sum" ? t[k] * n : t[k];
  return out;
}

/** How many stubs a group's typical puts in the model: its stubs per instance times its instances (1 when it isn't a typical). */
export function typicalStubCount(elements: Elements, groupId: string, stubsPerInstance: number): number {
  return stubsPerInstance * typicalCountOfGroup(elements, groupId);
}
