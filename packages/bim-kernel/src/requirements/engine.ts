import { QUANTITIES, QUANTITY_KEYS, ZERO_TOTALS, addTotals, round6, subtractTotals, type QuantityKey, type QuantityTotals } from "../quantities";
import { catalogElementId, connectionTypeOf } from "../catalog/model";
import { connectionTypeTrade, type CatalogTrade } from "../catalog/types";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { devicePartOf, isAreaEstimate, loadAnchorOf, loadStageOf, type LoadRecord } from "./anchor";
import { actualSpaceOf, allocationClassOf, claimOf, combineAllocated, countedAllocated, groupKeyOf, loadValueOf, scopeOfGroupKey, typicalOfLoad, typicalOfScope } from "./allocation";
import { scaleTotals, typicalCountOfGroup } from "../organization/typicals-totals";
import { typicalCount } from "../organization/typicals";
import { scopePolicyOf } from "./policy";
import { loadTradesOf } from "./facets";
import { NO_SPACES, type SpaceLocator } from "./locator";
import { loadStatusOf, type DrawnSourceCheck } from "./status";
import { DEFAULT_ALLOCATION_POLICY, type AllocatedActual, type AllocationPolicy, type LoadProgress, type LoadProgressScope, type LoadStage, type LoadStatus } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/** All the engine reads of a model: its elements (a `ModelState` is one). */
export type EngineModel = Pick<ModelState, "elements">;

/**
 * Status, progress and allocated-vs-actual for every load, kept up to date from
 * each edit's changed ids (KERNEL-REQUIREMENTS-MODEL §3.4, §7), the way the
 * plumbing network engine and the schedules engine are: the first read indexes
 * the loads once (`elementsOfKind`); `advance(model, changedIds)` re-derives
 * only the loads an edit touched or that read something it touched (their
 * host, part, source, space), and moves each counter by the difference.
 *
 *   progress({ kind: "project" })  → "Loads: 35 · 5 piped · 0 attached"
 *   allocatedActual(estimateId)    → "estimate 2 kW, devices so far 0.8 kW"
 *   counted()                      → project totals with no estimate counted twice
 */

const STATUSES: readonly LoadStatus[] = ["open", "assigned", "placed", "connected", "attached", "mismatch"];
const STAGES: readonly LoadStage[] = ["estimate", "concentrated", "device"];

interface Derived {
  readonly status: LoadStatus;
  readonly why: string | null;
  readonly stage: LoadStage;
  readonly scopes: readonly string[];
  readonly reads: readonly ElementId[];
  readonly value: QuantityTotals;
  readonly cls: string | null;
  /** Estimates: the group they make up. Real loads: the space they are in (claimed per group below). */
  readonly estimateGroup: string | null;
  readonly actualSpace: ElementId | undefined;
  /** A real load outside every space: the level to look on when a space there is drawn or moved. */
  readonly outsideOn: ElementId | null;
  /** The typical it is in (its group record's id), and that typical's instance count when derived (F6). */
  readonly typical: string | null;
  readonly count: number;
  /** A real load: the estimate group it counts against (null: none, or not claimed yet). Set by `claim`, cleared by `unclaim`. */
  claim: string | null;
}

interface Counter {
  total: number;
  byStatus: Record<LoadStatus, number>;
  byStage: Record<LoadStage, number>;
}

/**
 * One estimate group (space or zone, class). Values are kept per typical they
 * came from ("" for none), so a typical's count changing or the space joining
 * a typical re-reads one factor instead of every load.
 */
interface Group {
  allocatedBy: Map<string, QuantityTotals>;
  estimateIds: Set<ElementId>;
  actualBy: Map<string, QuantityTotals>;
  actualIds: Set<ElementId>;
  /** In the group's own terms: unit 001's bathroom counts its own fixtures once. */
  allocated: QuantityTotals;
  actual: QuantityTotals;
  counted: QuantityTotals;
  /** `counted` once per instance of the typical the group's space is in: what the project total adds. */
  projectCounted: QuantityTotals;
  /** The typical the group's space or zone is in, and its instance count. */
  typical: string | null;
  count: number;
  /** The space's own estimate-counting setting, else the model's. */
  policy: AllocationPolicy;
  /** The record `typical`, `count` and `policy` were read from: they are the record's alone, so a recount on the same record keeps them. */
  readAt: Elements | null;
  /** Bumped whenever `allocatedBy` changes; `allocated` is re-folded only when this, the typical or the record moved. */
  allocatedVersion: number;
  allocatedFor: { readonly version: number; readonly typical: string | null; readonly reading: Elements | null } | null;
}

function bucket(map: Map<string, QuantityTotals>, key: string, value: QuantityTotals, sign: 1 | -1): void {
  const prior = map.get(key) ?? ZERO_TOTALS;
  map.set(key, sign === 1 ? addTotals(prior, value) : subtractTotals(prior, value));
}

/** Each quantity and how it adds, read once: the counters below move on every load. */
const KEYS: readonly QuantityKey[] = [...QUANTITY_KEYS];
const ADDS: readonly string[] = KEYS.map((k) => QUANTITIES[k].add);
const roundTo6 = round6;

/** `into = addTotals(into, value)`, in place: the larger for a "max" quantity, else the sum. */
function addInto(into: Record<QuantityKey, number>, value: QuantityTotals): void {
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i] as QuantityKey;
    into[k] = ADDS[i] === "max" ? Math.max(into[k], value[k]) : into[k] + value[k];
  }
}

/** `into = subtractTotals(into, value)`, in place: summed quantities only, rounded as there. */
function subtractInto(into: Record<QuantityKey, number>, value: QuantityTotals): void {
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i] as QuantityKey;
    if (ADDS[i] === "sum") into[k] = roundTo6(into[k] - value[k]);
  }
}

export interface RequirementsEngineOptions {
  /**
   * Where spaces are. A function is called with each record the engine reads (the
   * spaces module's `modelSpaceLocator` answers for one record); a locator object
   * is used as is. Default: no spaces (estimates and devices never meet).
   */
  readonly locator?: SpaceLocator | ((elements: Elements) => SpaceLocator);
  /** The model setting, else the firm default (`max`). */
  readonly policy?: AllocationPolicy;
  /** Whether a piped load's network comes from the source it names (the plumbing adapter supplies one). */
  readonly drawnSource?: DrawnSourceCheck;
}

function scopeKey(scope: LoadProgressScope): string {
  if (scope.kind === "project") return "project";
  return scope.kind === "trade" ? `trade:${scope.trade}` : `${scope.kind}:${scope.id}`;
}

function emptyCounter(): Counter {
  const byStatus = {} as Record<LoadStatus, number>;
  for (const s of STATUSES) byStatus[s] = 0;
  const byStage = {} as Record<LoadStage, number>;
  for (const s of STAGES) byStage[s] = 0;
  return { total: 0, byStatus, byStage };
}

export class RequirementsEngine {
  private elements: Elements | null = null;
  private readonly derived = new Map<ElementId, Derived>();
  /** Loads that read an element: one id until a second load reads it, then a set (in the order they started reading). */
  private readonly dependents = new Map<ElementId, ElementId | Set<ElementId>>();
  private readonly counters = new Map<string, Counter>();
  private readonly groups = new Map<string, Group>();
  /** Real loads by the space they are in, so a new or removed estimate re-claims them. */
  private readonly actualBySpace = new Map<ElementId, Set<ElementId>>();
  /** Real loads outside every space, by level, so a space drawn around them claims them. */
  private readonly outsideByLevel = new Map<ElementId, Set<ElementId>>();
  /** Estimate groups by their scope ("space:<id>", "zone:<id>"), so a space's figures never look at other groups. */
  private readonly groupsByScope = new Map<string, Set<string>>();
  /** Per scope figures read since the last edit. */
  private readonly scopeMemo = new Map<string, ScopeFigures>();
  /** Moved in place, by the same arithmetic as `addTotals` / `subtractTotals` (no totals object per edit). */
  private readonly unclaimed: Record<QuantityKey, number> = { ...ZERO_TOTALS };
  private readonly countedTotal: Record<QuantityKey, number> = { ...ZERO_TOTALS };
  /** Scope keys ("space:S1", "trade:<discipline>") and group keys ("space:S1:*"), one string each per engine. */
  private readonly scopeKeys = new Map<string, Map<string, string>>();
  private readonly groupKeys = { space: new Map<string, Map<string, string>>(), zone: new Map<string, Map<string, string>>() };
  /** The record being read (the one an edit moves to), for a group's space, typical and setting. */
  private reading: Elements | null = null;
  readonly stats = { built: 0, rederived: 0 };
  private locator: SpaceLocator;
  private readonly policy: AllocationPolicy;

  constructor(private readonly options: RequirementsEngineOptions = {}) {
    this.locator = typeof options.locator === "object" ? options.locator : NO_SPACES;
    this.policy = options.policy ?? DEFAULT_ALLOCATION_POLICY;
  }

  private readLocator(elements: Elements): void {
    if (typeof this.options.locator === "function") this.locator = this.options.locator(elements);
  }

  private ensure(model: EngineModel): void {
    if (this.elements) return;
    this.stats.built += 1;
    this.readLocator(model.elements);
    this.elements = model.elements;
    this.reading = model.elements;
    for (const lp of elementsOfKind(model.elements, "load_point")) this.insert(model.elements, lp);
  }

  /** Bring everything up to `model` after an edit that changed `changedIds` (removed ids included). Returns the loads whose status or figures changed. */
  advance(model: EngineModel, changedIds: Iterable<string>): ElementId[] {
    if (!this.elements) {
      this.ensure(model);
      return [];
    }
    const elements = model.elements;
    const previous: Elements = this.elements;
    this.readLocator(elements);
    this.reading = elements;
    const touched = new Set<ElementId>();
    let spatialEdit = false;
    for (const raw of changedIds) {
      const id = raw as ElementId;
      const kinds = [previous[id]?.kind, elements[id]?.kind];
      if (kinds.includes("space") || kinds.includes("zone")) spatialEdit = true;
      if (this.derived.has(id) || elements[id]?.kind === "load_point") touched.add(id);
      const deps = this.dependents.get(id);
      if (typeof deps === "string") touched.add(deps);
      else if (deps) for (const dep of deps) touched.add(dep);
      // A space drawn, moved or deleted: the loads on its level that were outside every space may be inside it now.
      for (const el of [previous[id], elements[id]]) {
        // A zone gaining or losing a space: the real loads in that space may meet (or leave) the zone's estimate.
        if (el?.kind === "zone") {
          for (const s of el.spaceIds) for (const dep of this.actualBySpace.get(s) ?? []) touched.add(dep);
          continue;
        }
        if (el?.kind !== "space") continue;
        for (const dep of this.actualBySpace.get(id) ?? []) touched.add(dep);
        if (el.levelId) for (const dep of this.outsideByLevel.get(el.levelId) ?? []) touched.add(dep);
      }
    }
    const out: ElementId[] = [];
    // A space or zone edit can change a zone's spaces without touching a load: forget every scope read. Otherwise only the scopes the touched loads were or are in.
    if (spatialEdit) this.scopeMemo.clear();
    const forget = (d: Derived | undefined) => {
      if (spatialEdit || !d) return;
      for (const k of d.scopes) this.scopeMemo.delete(k);
    };
    for (const id of touched) {
      const before = this.derived.get(id);
      forget(before);
      this.remove(id);
      const now = elements[id];
      if (now?.kind === "load_point") this.insert(elements, now);
      const after = this.derived.get(id);
      forget(after);
      if (before?.status !== after?.status || before?.value !== after?.value) out.push(id);
    }
    this.stats.rederived += touched.size;
    this.elements = elements;
    return out.sort();
  }

  private derive(elements: Elements, lp: LoadRecord): Derived {
    const s = loadStatusOf(elements, lp, this.options.drawnSource);
    const a = loadAnchorOf(lp);
    const estimate = isAreaEstimate(lp);
    const actualSpace = estimate ? undefined : actualSpaceOf(lp, this.locator);
    const value = loadValueOf(elements, lp, this.locator);
    // In first-added order, each once (what a Set gives), without a Set or a new string per load.
    const scopes: string[] = ["project"];
    const ct = lp.connectionType ? connectionTypeOf(elements, lp.connectionType) : null;
    for (const t of loadTradesOf(lp.service, value, ct ? connectionTypeTrade(ct) : undefined)) this.addScope(scopes, "trade", t);
    const level = levelOf(elements, lp);
    if (level) this.addScope(scopes, "level", level);
    const space = a.kind === "space" ? a.id : actualSpace;
    if (space) {
      this.addScope(scopes, "space", space);
      for (const z of this.locator.zonesOf(space)) this.addScope(scopes, "zone", z);
    }
    if (a.kind === "zone") this.addScope(scopes, "zone", a.id);
    const outsideOn = !estimate && !actualSpace && a.kind !== "space" && a.kind !== "zone" ? level : null;
    if (lp.servedBy) this.addScope(scopes, "source", lp.servedBy);
    const cls = allocationClassOf(elements, lp);
    // A connection type edit changes the value; a space edit (outline, use, occupants) changes a density estimate and who is inside.
    const reads: ElementId[] = [...s.reads];
    if (lp.connectionType) reads.push(catalogElementId("connection_type", lp.connectionType));
    if (space) for (const r of this.locator.dependenciesOf?.(space) ?? [space]) reads.push(r);
    const part = devicePartOf(lp);
    if (part) for (const r of this.locator.dependenciesOf?.(part) ?? []) reads.push(r);
    // The group records its typical came from: copies changing (or a group becoming a typical) re-derives it.
    const t = typicalOfLoad(elements, lp, this.locator, actualSpace);
    for (const r of t.reads) reads.push(r as ElementId);
    return {
      status: s.status,
      why: s.why,
      stage: loadStageOf(lp),
      scopes,
      reads,
      value,
      cls,
      estimateGroup: estimate && (a.kind === "space" || a.kind === "zone") ? this.groupKey(a.kind, a.id, cls) : null,
      actualSpace,
      outsideOn,
      typical: t.typical?.groupId ?? null,
      count: t.typical ? typicalCount(t.typical.spec) : 1,
      claim: null,
    };
  }

  private insert(elements: Elements, lp: LoadRecord): void {
    const d = this.derive(elements, lp);
    this.derived.set(lp.id, d);
    for (const r of d.reads) {
      const deps = this.dependents.get(r);
      if (deps === undefined) this.dependents.set(r, lp.id);
      else if (typeof deps === "string") {
        if (deps !== lp.id) this.dependents.set(r, new Set([deps, lp.id]));
      } else deps.add(lp.id);
    }
    for (const k of d.scopes) this.count(k, d, 1);
    if (d.estimateGroup) {
      const g = this.group(d.estimateGroup);
      const fresh = g.estimateIds.size === 0;
      g.estimateIds.add(lp.id);
      bucket(g.allocatedBy, d.typical ?? "", d.value, 1);
      g.allocatedVersion += 1;
      this.recount(d.estimateGroup);
      if (fresh) this.reclaimAround(d.estimateGroup);
      return;
    }
    if (d.actualSpace) {
      let set = this.actualBySpace.get(d.actualSpace);
      if (!set) this.actualBySpace.set(d.actualSpace, (set = new Set()));
      set.add(lp.id);
    }
    if (d.outsideOn) {
      let set = this.outsideByLevel.get(d.outsideOn);
      if (!set) this.outsideByLevel.set(d.outsideOn, (set = new Set()));
      set.add(lp.id);
    }
    this.claim(lp.id, d);
  }

  private remove(id: ElementId): void {
    const d = this.derived.get(id);
    if (!d) return;
    this.derived.delete(id);
    for (const r of d.reads) {
      const deps = this.dependents.get(r);
      if (deps === id) this.dependents.delete(r);
      else if (typeof deps === "object") deps.delete(id);
    }
    for (const k of d.scopes) this.count(k, d, -1);
    if (d.estimateGroup) {
      const g = this.group(d.estimateGroup);
      g.estimateIds.delete(id);
      if (g.estimateIds.size === 0) g.allocatedBy.clear();
      else bucket(g.allocatedBy, d.typical ?? "", d.value, -1);
      g.allocatedVersion += 1;
      this.recount(d.estimateGroup);
      if (g.estimateIds.size === 0) this.reclaimAround(d.estimateGroup);
      return;
    }
    if (d.actualSpace) this.actualBySpace.get(d.actualSpace)?.delete(id);
    if (d.outsideOn) this.outsideByLevel.get(d.outsideOn)?.delete(id);
    this.unclaim(id, d);
  }

  private group(key: string): Group {
    let g = this.groups.get(key);
    if (!g) {
      this.groups.set(key, (g = { allocatedBy: new Map(), estimateIds: new Set(), actualBy: new Map(), actualIds: new Set(), allocated: ZERO_TOTALS, actual: ZERO_TOTALS, counted: ZERO_TOTALS, projectCounted: ZERO_TOTALS, typical: null, count: 1, policy: this.policy, readAt: null, allocatedVersion: 0, allocatedFor: null }));
      const scope = scopeOfGroup(key);
      let set = this.groupsByScope.get(scope);
      if (!set) this.groupsByScope.set(scope, (set = new Set()));
      set.add(key);
    }
    return g;
  }

  private groupExists = (key: string): boolean => (this.groups.get(key)?.estimateIds.size ?? 0) > 0;

  /** Add "prefix:id" to a load's scopes unless it is there (first-added order, each once). */
  private addScope(scopes: string[], prefix: string, id: string): void {
    const key = this.scopeKeyOf(prefix, id);
    if (!scopes.includes(key)) scopes.push(key);
  }

  /** `${prefix}:${id}`, one string per engine. */
  private scopeKeyOf(prefix: string, id: string): string {
    let byId = this.scopeKeys.get(prefix);
    if (!byId) this.scopeKeys.set(prefix, (byId = new Map()));
    let key = byId.get(id);
    if (key === undefined) byId.set(id, (key = `${prefix}:${id}`));
    return key;
  }

  /** `groupKeyOf({ kind, id }, cls)`, one string per engine. */
  private groupKey = (kind: "space" | "zone", id: string, cls: string | null): string => {
    const byScope = this.groupKeys[kind];
    let byCls = byScope.get(id);
    if (!byCls) byScope.set(id, (byCls = new Map()));
    const c = cls ?? "*";
    let key = byCls.get(c);
    if (key === undefined) byCls.set(c, (key = groupKeyOf({ kind, id }, cls)));
    return key;
  };

  private claim(id: ElementId, d: Derived): void {
    const key = claimOf(d.actualSpace, d.cls, this.groupExists, this.locator, this.groupKey);
    d.claim = key;
    if (key === null) {
      const counted = scaleTotals(d.value, d.count);
      addInto(this.unclaimed, counted);
      addInto(this.countedTotal, counted);
      return;
    }
    const g = this.group(key);
    g.actualIds.add(id);
    bucket(g.actualBy, d.typical ?? "", d.value, 1);
    this.recount(key);
  }

  private unclaim(id: ElementId, d: Derived): void {
    const key = d.claim;
    d.claim = null;
    if (key === null) {
      const counted = scaleTotals(d.value, d.count);
      subtractInto(this.unclaimed, counted);
      subtractInto(this.countedTotal, counted);
      return;
    }
    const g = this.group(key);
    g.actualIds.delete(id);
    if (g.actualIds.size === 0) g.actualBy.clear();
    else bucket(g.actualBy, d.typical ?? "", d.value, -1);
    this.recount(key);
  }

  /** An estimate group appeared or emptied: the real loads in its space (or the zone's spaces) may meet another group now. */
  private reclaimAround(key: string): void {
    const [kind, ...rest] = key.split(":");
    const scopeId = rest.slice(0, -1).join(":") as ElementId;
    const spaces = kind === "space" ? [scopeId] : this.locator.spacesOf(scopeId);
    for (const s of spaces) {
      for (const id of [...(this.actualBySpace.get(s) ?? [])]) {
        const d = this.derived.get(id);
        if (!d) continue;
        const now = claimOf(d.actualSpace, d.cls, this.groupExists, this.locator, this.groupKey);
        if (now === d.claim) continue;
        this.unclaim(id, d);
        this.claim(id, d);
      }
    }
  }

  /** Values from each typical, read in the group's own terms: once from its own typical (or none), once per instance from another. */
  private fold(by: ReadonlyMap<string, QuantityTotals>, own: string | null): QuantityTotals {
    let out = ZERO_TOTALS;
    for (const [t, v] of by) out = addTotals(out, t === "" || t === own || !this.reading ? v : scaleTotals(v, typicalCountOfGroup(this.reading, t)));
    return out;
  }

  private recount(key: string): void {
    const g = this.group(key);
    const before = g.projectCounted;
    if (this.reading === null || g.readAt !== this.reading) {
      const scope = scopeOfGroupKey(key);
      const t = this.reading ? typicalOfScope(this.reading, scope) : null;
      g.typical = t?.groupId ?? null;
      g.count = t ? typicalCount(t.spec) : 1;
      g.policy = this.reading ? scopePolicyOf(this.reading, scope, this.policy) : this.policy;
      g.readAt = this.reading;
    }
    const at = g.allocatedFor;
    if (at === null || at.version !== g.allocatedVersion || at.typical !== g.typical || at.reading !== this.reading) {
      g.allocated = this.fold(g.allocatedBy, g.typical);
      g.allocatedFor = { version: g.allocatedVersion, typical: g.typical, reading: this.reading };
    }
    g.actual = this.fold(g.actualBy, g.typical);
    g.counted = g.estimateIds.size === 0 ? ZERO_TOTALS : countedAllocated(g.allocated, g.actual, g.actualIds.size, g.policy);
    g.projectCounted = scaleTotals(g.counted, g.count);
    // addTotals(subtractTotals(total, before), after), key by key, in place.
    subtractInto(this.countedTotal, before);
    addInto(this.countedTotal, g.projectCounted);
    if (g.estimateIds.size === 0 && g.actualIds.size === 0) {
      this.groups.delete(key);
      const scope = scopeOfGroup(key);
      const set = this.groupsByScope.get(scope);
      set?.delete(key);
      if (set?.size === 0) this.groupsByScope.delete(scope);
    }
  }

  private count(key: string, d: Derived, delta: 1 | -1): void {
    let c = this.counters.get(key);
    if (!c) this.counters.set(key, (c = emptyCounter()));
    c.total += delta;
    c.byStatus[d.status] += delta;
    c.byStage[d.stage] += delta;
    if (c.total === 0) this.counters.delete(key);
  }

  // ---------------------------------------------------------------- reads

  progress(model: EngineModel, scope: LoadProgressScope = { kind: "project" }): LoadProgress {
    this.ensure(model);
    const c = this.counters.get(scopeKey(scope)) ?? emptyCounter();
    return { total: c.total, byStatus: { ...c.byStatus }, byStage: { ...c.byStage } };
  }

  statusOf(model: EngineModel, loadId: string): { readonly status: LoadStatus; readonly stage: LoadStage; readonly why: string | null } | null {
    this.ensure(model);
    const d = this.derived.get(loadId as ElementId);
    return d ? { status: d.status, stage: d.stage, why: d.why } : null;
  }

  /** The figures of the estimate group a load is part of (estimates), or of the group a real load counts against. */
  allocatedActual(model: EngineModel, loadId: string): AllocatedActual | null {
    this.ensure(model);
    const d = this.derived.get(loadId as ElementId);
    if (!d) return null;
    const key = d.estimateGroup ?? d.claim;
    const g = key ? this.groups.get(key) : undefined;
    if (!g || g.estimateIds.size === 0) return null;
    return combineAllocated(g.allocated, g.actual, [...g.actualIds].sort(), g.policy);
  }

  /** What one load needs, as numbers (its bag, count or density over its space); null when it isn't a load. */
  valueOf(model: EngineModel, loadId: string): QuantityTotals | null {
    this.ensure(model);
    return this.derived.get(loadId as ElementId)?.value ?? null;
  }

  /**
   * What one load adds to `counted()`, so a list of loads totals to the
   * project figure: its own value, except a quantity where the other side of
   * its estimate group governs (devices that exceed an estimate: the estimate
   * adds 0; an estimate the devices are still under: the devices add 0).
   * Summed over every load, each summed quantity is exactly `counted()`.
   */
  countedOf(model: EngineModel, loadId: string): QuantityTotals | null {
    this.ensure(model);
    const id = loadId as ElementId;
    const d = this.derived.get(id);
    if (!d) return null;
    const key = d.estimateGroup ?? d.claim;
    const g = key ? this.groups.get(key) : undefined;
    if (!g || g.estimateIds.size === 0) return scaleTotals(d.value, d.count);
    const side = d.estimateGroup ? "allocated" : "actual";
    const { governing } = combineAllocated(g.allocated, g.actual, [...g.actualIds], g.policy);
    // Once per instance of the group's typical, and of the load's own typical when it is another one.
    const times = (d.typical === null || d.typical === g.typical ? 1 : d.count) * g.count;
    const out = {} as Record<QuantityKey, number>;
    for (const k of QUANTITY_KEYS) {
      if (QUANTITIES[k].add !== "sum") out[k] = d.value[k];
      else out[k] = governing[k] === undefined || governing[k] === side ? d.value[k] * times : 0;
    }
    return out;
  }

  /**
   * Allocated vs actual for a whole space or zone: every estimate spread over
   * it (a zone's own and its spaces'), every real load standing in it, and
   * what it counts: each estimate group's counted figure, plus the real loads
   * no estimate inside this scope stands for. Indexed: the scope's groups and
   * the loads in its spaces, never the other loads.
   */
  scopeFigures(model: EngineModel, scope: { readonly kind: "space" | "zone"; readonly id: string }): ScopeFigures {
    this.ensure(model);
    const memoKey = `${scope.kind}:${scope.id}`;
    const hit = this.scopeMemo.get(memoKey);
    if (hit) return hit;
    const spaces = scope.kind === "space" ? [scope.id as ElementId] : this.locator.spacesOf(scope.id as ElementId);
    const scopes = new Set<string>(spaces.map((s) => `space:${s}`));
    // Inside typical unit 001 its own loads count once; a zone outside it counts each instance (F6).
    const own = typicalOfScope(model.elements, scope)?.groupId ?? null;
    if (scope.kind === "zone") scopes.add(memoKey);
    let allocated = ZERO_TOTALS;
    let actual = ZERO_TOTALS;
    let counted = ZERO_TOTALS;
    const estimateIds: ElementId[] = [];
    const actualIds: ElementId[] = [];
    for (const s of scopes) {
      for (const key of this.groupsByScope.get(s) ?? []) {
        const g = this.groups.get(key);
        if (!g || g.estimateIds.size === 0) continue;
        const f = g.typical === null || g.typical === own ? 1 : g.count;
        allocated = addTotals(allocated, scaleTotals(g.allocated, f));
        counted = addTotals(counted, scaleTotals(g.counted, f));
        estimateIds.push(...g.estimateIds);
      }
    }
    for (const s of spaces) {
      for (const id of this.actualBySpace.get(s) ?? []) {
        const d = this.derived.get(id);
        if (!d) continue;
        actualIds.push(id);
        const value = scaleTotals(d.value, d.typical === null || d.typical === own ? 1 : d.count);
        actual = addTotals(actual, value);
        const claim = d.claim;
        if (claim === null || !scopes.has(scopeOfGroup(claim))) counted = addTotals(counted, value);
      }
    }
    const governing: Partial<Record<QuantityKey, "allocated" | "actual">> = {};
    for (const k of QUANTITY_KEYS) {
      if (allocated[k] === 0 && actual[k] === 0) continue;
      const c = round6(counted[k]);
      governing[k] = estimateIds.length === 0 || (c === round6(actual[k]) && c !== round6(allocated[k])) ? "actual" : "allocated";
    }
    const figures: ScopeFigures = { allocated, actual, counted, governing, actualIds: actualIds.sort(), estimateIds: estimateIds.sort() };
    this.scopeMemo.set(memoKey, figures);
    return figures;
  }

  /** The engine is up to date with exactly this element record (the carry in `model-engine.ts` checks it before advancing). */
  isAt(elements: Elements): boolean {
    return this.elements === elements;
  }

  /** What the project counts: no estimate and the devices inside it twice. */
  counted(model: EngineModel): QuantityTotals {
    this.ensure(model);
    const out = {} as Record<QuantityKey, number>;
    for (const k of QUANTITY_KEYS) out[k] = round6(this.countedTotal[k]);
    return out;
  }
}

/** Allocated vs actual for a space or zone, with the estimates that make up `allocated`. */
export interface ScopeFigures extends AllocatedActual {
  readonly estimateIds: readonly ElementId[];
}

/** "space:S1:lighting" → "space:S1" (the class is the last segment and never holds a colon). */
function scopeOfGroup(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function levelOf(elements: Elements, lp: LoadRecord): ElementId | null {
  const a = loadAnchorOf(lp);
  if (a.kind === "point") return a.levelId;
  const id = a.kind === "run_end" ? a.hostId : devicePartOf(lp);
  const el = id ? elements[id] : undefined;
  if (el?.kind === "run_segment" || el?.kind === "run_fitting") return el.levelId;
  if (el?.kind === "part") return el.levelId ?? null;
  return null;
}

/** "Loads: 35 · 5 piped · 3 attached" (and "· 2 need attention" when any disagree with their source). */
export function progressLine(p: LoadProgress): string {
  const parts = [`Loads: ${p.total}`, `${p.byStatus.connected} piped`, `${p.byStatus.attached} attached`];
  if (p.byStatus.mismatch > 0) parts.push(`${p.byStatus.mismatch} need attention`);
  return parts.join(" · ");
}

/** How each trade's progress reads: what it is called, and the word for a load on its drawn run. */
export const LOAD_TRADE_PROGRESS: Readonly<Record<CatalogTrade, { readonly label: string; readonly done: string }>> = {
  plumbing: { label: "Water and drainage", done: "piped" },
  gas: { label: "Gas", done: "piped" },
  electrical: { label: "Power", done: "connected" },
  mechanical: { label: "Air", done: "ducted" },
};

/** One trade's progress (`progress(model, { kind: "trade", trade })`): "Water and drainage: 5 of 35 piped" (· 3 attached, · 2 need attention). */
export function tradeProgressLine(p: LoadProgress, trade: CatalogTrade): string {
  const t = LOAD_TRADE_PROGRESS[trade];
  const parts = [`${t.label}: ${p.byStatus.connected} of ${p.total} ${t.done}`];
  if (p.byStatus.attached > 0) parts.push(`${p.byStatus.attached} attached`);
  if (p.byStatus.mismatch > 0) parts.push(`${p.byStatus.mismatch} need attention`);
  return parts.join(" · ");
}
