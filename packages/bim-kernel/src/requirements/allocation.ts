import { connectionTypeOf } from "../catalog/model";
import { connectionLoadKind, withConnectionStandIns } from "../catalog/connection-field-point";
import { QUANTITIES, QUANTITY_KEYS, ZERO_TOTALS, addTotals, mergeBags, totalsOf, type QuantityKey, type QuantityTotals } from "../quantities";
import type { BimElement, ElementId } from "../types";
import { loadTypicalOf, scaleTotals, typicalFactor, type LoadTypical } from "../organization/typicals-totals";
import { typicalOf, type TypicalRef } from "../organization/typicals";
import { anchorTargetOf, devicePartOf, isAreaEstimate, loadAnchorOf, type LoadRecord } from "./anchor";
import { loadIndexOf } from "./load-index";
import type { SpaceLocator, SpaceMeasure } from "./locator";
import { scopePolicyOf } from "./policy";
import type { AllocatedActual, AllocationPolicy } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Allocated vs actual (Product decision, Oct 27, decision 4): an estimate on a space or
 * zone keeps counting until the real loads inside it add up to more, quantity
 * by quantity. Totals above the space count `counted`, never the estimate and
 * the devices inside it both.
 *
 * Which real loads an estimate stands for: the ones in its space (or zone) of
 * the same kind. The kind is the connection type's electrical load class
 * (lighting, receptacle, kitchen, hvac, motor…) when the load names one, so a
 * "lighting 5 kW" estimate is not satisfied by a fryer. A real load first meets
 * an estimate of its own class in its space, then a class-less estimate in its
 * space, then the same in each zone listing the space; otherwise it counts as
 * itself. Plumbing, gas and air loads have no class, so a "toilet room 12 WSFU"
 * estimate meets the fixtures in the toilet room.
 */

/** What a load needs, as numbers: its bag (connection type, own values on top), times its count, or its rates times its space's area or occupants. */
export function loadValueOf(elements: Elements, lp: LoadRecord, locator: SpaceLocator): QuantityTotals {
  const bag = mergeBags(lp.connectionType ? connectionTypeOf(elements, lp.connectionType)?.quantities : undefined, lp.values);
  if (lp.basis === "density") {
    const m = measureOfAnchor(lp, locator);
    const out = { ...ZERO_TOTALS } as Record<QuantityKey, number>;
    if (!m) return out;
    for (const r of lp.rates ?? []) out[r.key] += r.value * (r.per === "area" ? m.areaSqM : m.occupants);
    return out;
  }
  const t = fieldTotals(elements, lp, totalsOf(bag));
  if (lp.basis !== "count") return t;
  const n = lp.count ?? 1;
  const out = {} as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) out[k] = QUANTITIES[k].add === "sum" ? t[k] * n : t[k];
  return out;
}

/** A connection type's own fields stand in for the quantities its bag leaves empty (`kernel.connection_field`); the bag's value, when set, wins. */
function fieldTotals(elements: Elements, lp: LoadRecord, t: QuantityTotals): QuantityTotals {
  if (!lp.connectionType) return t;
  const ct = connectionTypeOf(elements, lp.connectionType);
  return ct ? withConnectionStandIns(ct, t) : t;
}

function measureOfAnchor(lp: LoadRecord, locator: SpaceLocator): SpaceMeasure | undefined {
  const a = loadAnchorOf(lp);
  if (a.kind === "space") return locator.measureOf(a.id);
  if (a.kind !== "zone") return undefined;
  let area = 0;
  let occupants = 0;
  let any = false;
  for (const s of locator.spacesOf(a.id)) {
    const m = locator.measureOf(s);
    if (!m) continue;
    any = true;
    area += m.areaSqM;
    occupants += m.occupants;
  }
  return any ? { areaSqM: area, occupants } : undefined;
}

/** The kind of load, for matching real loads to estimates: its connection type's load kind (the field that names one, where it applies), else none. */
export function allocationClassOf(elements: Elements, lp: Pick<LoadRecord, "connectionType">): string | null {
  if (!lp.connectionType) return null;
  const ct = connectionTypeOf(elements, lp.connectionType);
  if (!ct) return null;
  return connectionLoadKind(ct, true);
}

/** The space a real load is in: its part's, its pipe's, or its point's. */
export function actualSpaceOf(lp: LoadRecord, locator: SpaceLocator): ElementId | undefined {
  const part = devicePartOf(lp);
  if (part) return locator.spaceOf(part);
  const a = loadAnchorOf(lp);
  if (a.kind === "run_end") return locator.spaceOf(a.hostId);
  if (a.kind === "point") return locator.spaceAt(a.levelId, a.position);
  return undefined;
}

/** Which side counts for one quantity under the policy (both sides 0 count nothing either way). */
function governingSide(policy: AllocationPolicy, a: number, r: number, anyActual: boolean): "allocated" | "actual" {
  return policy === "allocation_only" ? "allocated" : policy === "actual_only" ? (anyActual ? "actual" : "allocated") : r > a ? "actual" : "allocated";
}

/** Per quantity: which side counts under the policy, and the counted totals. */
export function combineAllocated(allocated: QuantityTotals, actual: QuantityTotals, actualIds: readonly ElementId[], policy: AllocationPolicy): AllocatedActual {
  const counted = {} as Record<QuantityKey, number>;
  const governing: Partial<Record<QuantityKey, "allocated" | "actual">> = {};
  for (const k of QUANTITY_KEYS) {
    const a = allocated[k];
    const r = actual[k];
    if (a === 0 && r === 0) {
      counted[k] = 0;
      continue;
    }
    const side = governingSide(policy, a, r, actualIds.length > 0);
    governing[k] = side;
    counted[k] = side === "actual" ? r : a;
  }
  return { allocated, actual, counted, governing, actualIds };
}

/** `combineAllocated(...).counted` alone, from how many real loads there are rather than their ids. */
export function countedAllocated(allocated: QuantityTotals, actual: QuantityTotals, actualCount: number, policy: AllocationPolicy): QuantityTotals {
  const counted = {} as Record<QuantityKey, number>;
  for (const k of QUANTITY_KEYS) {
    const a = allocated[k];
    const r = actual[k];
    counted[k] = a === 0 && r === 0 ? 0 : governingSide(policy, a, r, actualCount > 0) === "actual" ? r : a;
  }
  return counted;
}

/** The group an estimate belongs to: its scope and class. */
export function groupKeyOf(scope: { readonly kind: "space" | "zone"; readonly id: string }, cls: string | null): string {
  return `${scope.kind}:${scope.id}:${cls ?? "*"}`;
}

/** `groupKeyOf` in the form `claimOf` takes. */
function plainGroupKey(kind: "space" | "zone", id: string, cls: string | null): string {
  return groupKeyOf({ kind, id }, cls);
}

/** The class's group in this space or zone, then the class-less one, if either has an estimate. */
function groupMet(kind: "space" | "zone", id: string, cls: string | null, groupExists: (key: string) => boolean, keyOf: (kind: "space" | "zone", id: string, cls: string | null) => string): string | null {
  if (cls !== null) {
    const key = keyOf(kind, id, cls);
    if (groupExists(key)) return key;
  }
  const any = keyOf(kind, id, null);
  return groupExists(any) ? any : null;
}

/**
 * Which estimate group a real load meets, if any: its class's group in its
 * space, then the class-less one, then the same in each zone listing the
 * space. `keyOf` builds a group key (`groupKeyOf`; the engine passes one that
 * reuses its strings).
 */
export function claimOf(actualSpace: ElementId | undefined, cls: string | null, groupExists: (key: string) => boolean, locator: SpaceLocator, keyOf: (kind: "space" | "zone", id: string, cls: string | null) => string = plainGroupKey): string | null {
  if (!actualSpace) return null;
  const inSpace = groupMet("space", actualSpace, cls, groupExists, keyOf);
  if (inSpace !== null) return inSpace;
  for (const z of locator.zonesOf(actualSpace)) {
    const inZone = groupMet("zone", z, cls, groupExists, keyOf);
    if (inZone !== null) return inZone;
  }
  return null;
}

/**
 * The typical a load is in (F6): its own group's, its device's, the element it
 * sits on (space, zone, pipe, part), or the space it stands in. With the group
 * records read, for a dependency list.
 */
export function typicalOfLoad(elements: Elements, lp: LoadRecord, locator: SpaceLocator, actualSpace?: ElementId): LoadTypical {
  const space = actualSpace ?? (isAreaEstimate(lp) ? undefined : actualSpaceOf(lp, locator));
  return loadTypicalOf(elements, lp, [devicePartOf(lp), anchorTargetOf(loadAnchorOf(lp)), space]);
}

/** The typical a space or zone is in (unit 001's bathroom), or null. */
export function typicalOfScope(elements: Elements, scope: { readonly kind: "space" | "zone"; readonly id: string }): TypicalRef | null {
  return typicalOf(elements, elements[scope.id]);
}

/** The scope key's space or zone ("space:S1:lighting" → { space, S1 }). */
export function scopeOfGroupKey(key: string): { readonly kind: "space" | "zone"; readonly id: string } {
  const kind = key.startsWith("zone:") ? "zone" : "space";
  return { kind, id: key.slice(kind.length + 1, key.lastIndexOf(":")) };
}

export interface AllocationGroup {
  readonly key: string;
  readonly estimateIds: readonly ElementId[];
  /** In the group's own terms: unit 001's bathroom counts its own fixtures once. */
  readonly figures: AllocatedActual;
  /** How many times the group counts in this allocation's total: a typical's instance count when the total is taken from outside it, else 1. */
  readonly factor: number;
}

/** Where an allocation's total is taken: the group the source (or space) is in, so a unit's own panel counts its unit once. Absent: the whole project. */
export interface AllocationScope {
  readonly groupId?: string | null;
}

export interface Allocation {
  /** One entry per estimate group (space or zone, class). */
  readonly groups: readonly AllocationGroup[];
  /** The group figures each estimate is part of. */
  readonly byEstimate: ReadonlyMap<ElementId, AllocatedActual>;
  /** What the whole set counts: every group's counted (times its factor), plus every real load no estimate stands for. */
  readonly counted: QuantityTotals;
  /** The same set added up as if estimates did not exist (every load once per instance): what totals were before this design. */
  readonly naive: QuantityTotals;
}

/**
 * Allocated vs actual over a set of loads (a space, a zone, a source, the
 * project). Batch form: the derived engine (engine.ts) keeps the same figures
 * up to date per group from each edit's changed ids.
 *
 * Typicals (F6): a load in typical unit 001 counts once inside unit 001
 * (its group's figures, a total taken for unit 001's own panel) and once per
 * instance in a total taken from outside it (the project, a house source).
 * Each space's own estimate-counting setting decides its groups
 * (`scopePolicyOf`); `policy` is the model's.
 */
export function allocate(elements: Elements, loads: Iterable<LoadRecord>, locator: SpaceLocator, policy: AllocationPolicy, scope: AllocationScope = {}): Allocation {
  const at = scope.groupId ?? null;
  const estimates = new Map<string, { ids: ElementId[]; total: QuantityTotals; typical: TypicalRef | null }>();
  const actualLoads: Array<{ lp: LoadRecord; value: QuantityTotals; cls: string | null; space: ElementId | undefined; typical: TypicalRef | null }> = [];
  let naive = ZERO_TOTALS;
  const groupTypical = (key: string) => {
    const known = estimates.get(key);
    return known ? known.typical : typicalOfScope(elements, scopeOfGroupKey(key));
  };
  for (const lp of loads) {
    const value = loadValueOf(elements, lp, locator);
    const space = isAreaEstimate(lp) ? undefined : actualSpaceOf(lp, locator);
    const typical = typicalOfLoad(elements, lp, locator, space).typical;
    naive = addTotals(naive, scaleTotals(value, typicalFactor(typical, at)));
    const cls = allocationClassOf(elements, lp);
    if (isAreaEstimate(lp)) {
      const a = loadAnchorOf(lp);
      if (a.kind !== "space" && a.kind !== "zone") continue;
      const key = groupKeyOf({ kind: a.kind, id: a.id }, cls);
      const g = estimates.get(key) ?? { ids: [], total: ZERO_TOTALS, typical: typicalOfScope(elements, a) };
      g.ids.push(lp.id);
      g.total = addTotals(g.total, scaleTotals(value, typicalFactor(typical, g.typical?.groupId)));
      estimates.set(key, g);
    } else actualLoads.push({ lp, value, cls, space, typical });
  }
  const actualOf = new Map<string, { ids: ElementId[]; total: QuantityTotals }>();
  let unclaimed = ZERO_TOTALS;
  for (const a of actualLoads) {
    const key = claimOf(a.space, a.cls, (k) => estimates.has(k), locator);
    if (key === null) {
      unclaimed = addTotals(unclaimed, scaleTotals(a.value, typicalFactor(a.typical, at)));
      continue;
    }
    const g = actualOf.get(key) ?? { ids: [], total: ZERO_TOTALS };
    g.ids.push(a.lp.id);
    g.total = addTotals(g.total, scaleTotals(a.value, typicalFactor(a.typical, groupTypical(key)?.groupId)));
    actualOf.set(key, g);
  }
  const groups: AllocationGroup[] = [];
  const byEstimate = new Map<ElementId, AllocatedActual>();
  let counted = unclaimed;
  for (const [key, e] of estimates) {
    const actual = actualOf.get(key);
    const figures = combineAllocated(e.total, actual?.total ?? ZERO_TOTALS, actual?.ids ?? [], scopePolicyOf(elements, scopeOfGroupKey(key), policy));
    const factor = typicalFactor(e.typical, at);
    groups.push({ key, estimateIds: e.ids, figures, factor });
    for (const id of e.ids) byEstimate.set(id, figures);
    counted = addTotals(counted, scaleTotals(figures.counted, factor));
  }
  return { groups, byEstimate, counted, naive };
}

/** "estimate 2 kW, devices so far 0.8 kW" for one quantity. */
export function allocatedActualLine(figures: AllocatedActual, key: QuantityKey, format: (key: QuantityKey, value: number) => string): string {
  const side = figures.governing[key];
  const est = format(key, figures.allocated[key]);
  const act = format(key, figures.actual[key]);
  // A space set to count devices only counts them while they are still under the estimate: say so, not "exceed".
  if (side === "actual") return figures.actual[key] > figures.allocated[key] ? `devices ${act} exceed the estimate ${est}; the devices count` : `the devices count: ${act} (estimate ${est})`;
  return `estimate ${est}, devices so far ${act}`;
}

/**
 * What a source sees from the loads that name it (servedBy): panel P1, the
 * service, WH-1, the gas meter. Estimates and the devices inside them count
 * once; a typical unit's loads count once per instance at a source outside
 * the unit, once at the unit's own. Indexed: the loads of that source, never
 * a pass over the model.
 */
export function allocateServedBy(elements: Elements, sourceId: string, locator: SpaceLocator, policy: AllocationPolicy): Allocation {
  const loads: LoadRecord[] = [];
  for (const lid of loadIndexOf(elements).servedBy(sourceId)) {
    const el = elements[lid];
    if (el?.kind === "load_point") loads.push(el);
  }
  return allocate(elements, loads, locator, policy, { groupId: elements[sourceId]?.groupId ?? null });
}
