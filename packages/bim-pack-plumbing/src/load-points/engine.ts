import { IncrementalTotals, type NetworkAdapter, formatQuantity, type QuantityKey, mergePipeDesign, serviceOf, type PipeDesign, elementValues, loadPointLoad, primaryQuantity, runEndOf, typicalEdgeFactor } from "@permitzip/bim-kernel";
import { waterHeaterKind } from "./water-heater";
import { elementHydraulics, PipeHydraulicsEngine, pipeLoadWalk, type PipeWarning } from "../routing/pipe/hydraulics";
import type { MepSystem, BimElement, ElementId, ModelState } from "@permitzip/bim-kernel";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * What every pipe carries, kept live: the plumbing adapter on the network
 * engine (connections/network.ts). The tree and each node's own load come
 * from the same walk as the pipe report (`pipeLoadWalk`), so a pipe's
 * "Carries…" line, its report and its field values agree.
 *
 * `advance(model, changedIds)` is told what an edit changed. A load point
 * whose value changed moves only its own branch (O(depth)); anything that
 * changes the shape of a system rebuilds that system on the next read.
 */
export interface PipeCarries {
  readonly systemId: ElementId;
  readonly quantity: QuantityKey;
  readonly value: number;
}

interface CachedSystem {
  readonly system: MepSystem;
  readonly totals: IncrementalTotals<string>;
  /** Elements the walk read, as read: a different object means the system changed. */
  readonly members: Map<string, BimElement | undefined>;
  /** A water heater joins this system to another: edits on either side rebuild both. */
  readonly coupled: boolean;
  /** Group records the walk's typical factors read (also in `members`). */
  readonly groupIds: readonly string[];
}

export interface PlumbingEngineOptions {
  readonly firm?: PipeDesign;
}

export class PlumbingNetworkEngine {
  private readonly systems = new Map<string, CachedSystem>();
  private readonly systemOfMember = new Map<string, string>();
  /** Group records each cached system read: one typical's records can cross its cold, hot and sanitary systems. */
  private readonly systemsOfGroup = new Map<string, Set<string>>();
  private elementsSeen: Elements | null = null;
  readonly stats = { built: 0, deltas: 0, rebuilds: 0 };

  constructor(private readonly options: PlumbingEngineOptions = {}) {}

  /** What a pipe (segment or fitting) carries, in its system's quantity. Null for vent, duct and unrouted systems. */
  carries(model: ModelState, elementId: string): PipeCarries | null {
    const el = model.elements[elementId];
    if (el?.kind !== "run_segment" && el?.kind !== "run_fitting") return null;
    const cached = this.system(model, el.systemId, el.id);
    if (!cached || !cached.totals.has(el.id)) return null;
    const quantity = primaryQuantity(cached.system.systemKind);
    return quantity ? { systemId: cached.system.id, quantity, value: cached.totals.totalOf(el.id) } : null;
  }

  /** What a whole system carries at its root (the service, the outfall). */
  systemTotal(model: ModelState, systemId: string): PipeCarries | null {
    const system = model.elements[systemId];
    if (system?.kind !== "mep_system") return null;
    const cached = this.system(model, systemId, system.entryId);
    if (!cached) return null;
    const quantity = primaryQuantity(system.systemKind);
    let total = 0;
    for (const [id, parent] of cached.totals.parents()) if (parent === null) total += cached.totals.totalOf(id);
    return quantity ? { systemId: system.id, quantity, value: total } : null;
  }

  /**
   * Bring cached totals up to `model` after an edit that changed `changedIds`.
   * Returns the run elements whose carried value changed, plus every member of
   * a system that has to be rebuilt.
   */
  advance(model: ModelState, changedIds: Iterable<string>): string[] {
    const elements = model.elements;
    const changed = new Set<string>();
    const rebuild = new Set<string>();
    for (const id of changedIds) {
      // A group record: a typical's count (or a group becoming one) changes every system it crosses.
      const crossing = this.systemsOfGroup.get(id);
      if (crossing) for (const s of crossing) rebuild.add(s);
      const now = elements[id];
      const nowEnd = now?.kind === "load_point" ? runEndOf(now) : null;
      const sysId = this.systemOfMember.get(id) ?? (nowEnd ? this.systemOfMember.get(nowEnd.elementId) : undefined);
      if (now?.kind === "service_catalog") {
        for (const s of this.systems.keys()) rebuild.add(s);
        continue;
      }
      const cached = sysId ? this.systems.get(sysId) : undefined;
      if (now?.kind === "load_point" && cached && !cached.coupled) {
        const before = cached.members.get(id);
        const beforeEnd = before?.kind === "load_point" ? runEndOf(before) : null;
        if (before?.kind === "load_point" && beforeEnd && nowEnd && beforeEnd.elementId === nowEnd.elementId && beforeEnd.port === nowEnd.port && before.attachedPartId === now.attachedPartId && before.groupId === now.groupId) {
          this.stats.deltas += 1;
          cached.members.set(id, now);
          for (const n of cached.totals.setOwn(id, loadPointLoad(elements, now))) if (elements[n]?.kind !== "load_point") changed.add(n);
          continue;
        }
      }
      // A pipe whose only change is the flow derivation wrote on it: the tree is the same.
      const before = cached?.members.get(id);
      if (cached && now && before && sameShape(before, now)) {
        cached.members.set(id, now);
        continue;
      }
      if (sysId) rebuild.add(sysId);
      if ((now?.kind === "run_segment" || now?.kind === "run_fitting") && now.systemId) rebuild.add(now.systemId);
    }
    for (const s of rebuild) {
      const cached = this.systems.get(s);
      if (!cached) continue;
      if (cached.coupled) for (const [other, c] of this.systems) if (c.coupled) this.drop(other, changed);
      this.drop(s, changed);
    }
    this.elementsSeen = elements;
    return [...changed].sort();
  }

  private drop(systemId: string, changed: Set<string>): void {
    const cached = this.systems.get(systemId);
    if (!cached) return;
    this.stats.rebuilds += 1;
    for (const id of cached.members.keys()) {
      if (this.systemOfMember.get(id) === systemId) this.systemOfMember.delete(id);
      changed.add(id);
    }
    for (const g of cached.groupIds) {
      const set = this.systemsOfGroup.get(g);
      set?.delete(systemId);
      if (set?.size === 0) this.systemsOfGroup.delete(g);
    }
    this.systems.delete(systemId);
  }

  private system(model: ModelState, systemId: string, anchor: string | undefined): CachedSystem | null {
    const elements = model.elements;
    const known = this.systems.get(systemId);
    if (known && (this.elementsSeen === elements || [...known.members].every(([id, el]) => elements[id] === el) && known.system === elements[systemId])) {
      this.elementsSeen = elements;
      return known;
    }
    if (known) this.drop(systemId, new Set());
    const system = elements[systemId];
    if (system?.kind !== "mep_system" || system.domain !== "pipe") return null;
    const service = serviceOf(system.systemKind);
    if (service === null || service === "vent") return null;
    const start = anchor && elements[anchor] ? anchor : firstMember(elements, systemId);
    if (!start) return null;
    const warnings: PipeWarning[] = [];
    const lw = pipeLoadWalk(elements, system, start as ElementId, mergePipeDesign(this.options.firm, system.design?.pipe), warnings);
    const adapter: NetworkAdapter<string> = {
      roots: () => [lw.root],
      children: (n) => lw.walk.children.get(n) ?? [],
      ownQuantities: (n) => lw.own.get(n),
      // The same factor the pipe report's walk uses, so "Carries…" and the report agree.
      edgeFactor: (c, p) => typicalEdgeFactor(elements, c, p),
    };
    const totals = IncrementalTotals.build(adapter, lw.walk.parent);
    const members = new Map<string, BimElement | undefined>();
    let coupled = false;
    for (const n of lw.nodes) {
      const id = n.includes("#") ? n.slice(0, n.indexOf("#")) : n;
      const el = elements[id];
      members.set(id, el);
      if (el?.kind === "part" && waterHeaterKind(elements, el)) coupled = true;
    }
    for (const id of lw.points.alsoRead) members.set(id, elements[id]);
    const cached: CachedSystem = { system, totals, members, coupled, groupIds: lw.groupIds };
    this.systems.set(systemId, cached);
    const groups = new Set(lw.groupIds);
    for (const id of members.keys()) if (!groups.has(id)) this.systemOfMember.set(id, systemId);
    for (const g of lw.groupIds) {
      let set = this.systemsOfGroup.get(g);
      if (!set) this.systemsOfGroup.set(g, (set = new Set()));
      set.add(systemId);
    }
    this.stats.built += 1;
    this.elementsSeen = elements;
    return cached;
  }
}

/** Same place in the tree: only derived fields (flow) or the version moved. A group change can change a typical's edge factor. */
function sameShape(a: BimElement, b: BimElement): boolean {
  if (a.groupId !== b.groupId) return false;
  if (a.kind === "run_segment" && b.kind === "run_segment") return a.systemId === b.systemId && a.links === b.links && a.branches === b.branches && a.start === b.start && a.end === b.end && a.size === b.size;
  if (a.kind === "run_fitting" && b.kind === "run_fitting") return a.systemId === b.systemId && a.ports === b.ports && a.host === b.host;
  return false;
}

function firstMember(elements: Elements, systemId: string): string | null {
  for (const el of elementValues(elements)) if ((el.kind === "run_segment" || el.kind === "run_fitting") && el.systemId === systemId) return el.id;
  return null;
}

/**
 * The line the Properties panel shows on a pipe: "Carries 12 DFU · 18.4 gpm",
 * from the pipe report (the same walk), so it never disagrees with it. Null
 * when the pipe carries nothing countable (vent, a system with no loads yet).
 */
export function pipeCarriesLine(engine: PipeHydraulicsEngine, model: ModelState, elementId: string): string | null {
  const el = model.elements[elementId];
  if (el?.kind !== "run_segment") return null;
  const system = model.elements[el.systemId];
  if (system?.kind !== "mep_system") return null;
  if (system.domain === "duct") return el.flow > 0 ? `Carries ${formatQuantity("cfm", el.flow)}` : null;
  const quantity = primaryQuantity(system.systemKind);
  if (!quantity) return null;
  const h = elementHydraulics(engine, model, elementId);
  const seg = h?.segment;
  if (!seg) return el.flow > 0 ? `Carries ${formatQuantity(quantity, el.flow)}` : null;
  if ("mbh" in seg) return `Carries ${formatQuantity("mbh", seg.mbh)} · ${round1(seg.cfh)} cfh`;
  const gpm = "designGpm" in seg ? seg.designGpm : "gpm" in seg ? seg.gpm : 0;
  return `Carries ${formatQuantity(quantity, seg.fixtureUnits)}${gpm > 0 ? ` · ${round1(gpm)} gpm` : ""}`;
  return null;
}

const round1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

