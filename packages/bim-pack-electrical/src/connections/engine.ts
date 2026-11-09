import { elementsOfKind, type BimElement, type ElementId, type ModelState, type PartInstance, combineNode, catalogElementId, linkServing, serviceLinkName, type ConductorSet, type ServiceLink, rotatesPhases, rotationCounts, typicalMultiplier, loadIndexOf } from "@permitzip/bim-kernel";
import { branchRefusal, electricalAdapter } from "./adapter";
import { linkConstruction } from "../catalog/feeder-types";
import { acrossFeeder, demandLoads, EMPTY_INVENTORY, inventoryMonoid, memberInventory, scaleInventory, type Inventory } from "./inventory";
import { electricalLoadOf, type MemberLoad } from "./loads";
import { estimatesAt, type EstimateShare, type NodeEstimates } from "./estimates";
import type { DemandResult, ElectricalRules } from "./rules";
import { equipmentNameplate } from "./equipment";
import { fedFromTextMismatch } from "./fed-from";
import { PHASE_UNBALANCE_LIMIT, phaseUnbalance } from "./balance";
import { distributionOf, electricalConnectorOf, electricalName, hotConductors, phaseOfSlot, PHASE_NAMES, voltageSystemLabel, type DistributionInfo, type VoltageSystem } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Loads at every piece of distribution equipment: connected VA by load class
 * and phase from the raw loads of everything below it, the code rules'
 * demand on that raw inventory (never the sum of the demands of the panels
 * it feeds), the capacity chain, and findings.
 *
 * Each node's loads are cached and re-used while the node, its links, their
 * members (and member types) and the nodes below are the same objects, so an
 * edit recomputes only the nodes on its path to the top. The identity check
 * runs once per node per model state.
 */

export interface LinkLoad {
  readonly linkId: ElementId;
  /** "L1-1,3" or "MDP to H1". */
  readonly name: string;
  readonly role: ServiceLink["role"];
  readonly description: string;
  readonly positions: readonly number[];
  /** Phase of each position (0 = A). */
  readonly phases: readonly number[];
  readonly ratingA: number | null;
  readonly conductors: ConductorSet | null;
  readonly lengthFt: number | null;
  readonly feederType: string | null;
  /** What it carries, at this node, in this node's phases. */
  readonly inventory: Inventory;
  /** Branch circuits: each member's load. Feeders: none (the fed node has its own report). */
  readonly members: readonly MemberLoad[];
  /** Feeders: the node fed. */
  readonly feeds: ElementId | null;
  /** Members this source can't serve since a later edit (voltage, poles), in plain words. */
  readonly refusals: readonly { readonly elementId: ElementId; readonly message: string }[];
  /** What it serves is a typical counted this many times here (absent: once). */
  readonly typicalCount?: number;
}

export interface NodeLoads {
  readonly nodeId: ElementId;
  readonly info: DistributionInfo;
  readonly inventory: Inventory;
  readonly links: readonly LinkLoad[];
  /** Loads that name this node as their source and are not on a circuit (absent: none). Counted in `inventory`. */
  readonly estimates?: NodeEstimates;
}

interface CacheEntry {
  readonly deps: ReadonlyArray<readonly [string, BimElement | undefined]>;
  /** The fed nodes' loads this value was built from. */
  readonly children: ReadonlyArray<readonly [string, NodeLoads]>;
  /** The loads naming this node as their source when it was built (a load that starts naming it is not in `deps`). */
  readonly servedBy: string;
  readonly value: NodeLoads;
}

/** Line current for a load on a system: VA over √3·V for three-phase, over V otherwise. */
export function lineAmps(va: number, s: VoltageSystem): number {
  return va / vaPerAmp(s);
}

/** VA per amp of line current on a system. */
export function vaPerAmp(s: VoltageSystem): number {
  return s.phases === 3 ? Math.sqrt(3) * s.lineToLine : s.lineToLine;
}

/** The current a branch circuit's breaker is sized for: its connected load, continuous loads at 125%, at the circuit's voltage. */
export function branchSizingA(link: Pick<LinkLoad, "inventory" | "positions">, system: VoltageSystem): number {
  let sizingVa = 0;
  for (const b of link.inventory.buckets.values()) sizingVa += b.continuous ? b.va * 1.25 : b.va;
  return sizingVa / circuitVaPerAmp(system, Math.max(1, link.positions.length));
}

/** One phase's current from the VA on it: over line-to-neutral, else (delta) over V/√3. */
export function phaseAmps(va: number, s: VoltageSystem): number {
  if (s.lineToNeutral !== null) return va / s.lineToNeutral;
  return s.phases === 3 ? va / (s.lineToLine / Math.sqrt(3)) : va / s.lineToLine;
}

/** The voltage a branch circuit of `poles` poles runs at on a system, and its VA per amp. */
function circuitVaPerAmp(s: VoltageSystem, poles: number): number {
  if (poles >= 3) return Math.sqrt(3) * s.lineToLine;
  if (poles === 2) return s.lineToLine;
  return s.lineToNeutral ?? s.lineToLine;
}

/** Phases moved `step` places along a source with `modulus` phases (A-B → B-C → C-A). */
function rotated(phases: readonly number[], step: number, modulus: number): number[] {
  return phases.map((p) => (p + step) % modulus);
}

/** `n` instances of a typical, copy k on its phases rotated k places: the inventory of each rotation, times the copies that take it. */
function onRotatedPhases(n: number, modulus: number, at: (step: number) => Inventory): Inventory {
  return rotationCounts(n, modulus).reduce((sum, copies, step) => inventoryMonoid.add(sum, scaleInventory(at(step), copies)), EMPTY_INVENTORY);
}

function phasesOf(link: ServiceLink, system: VoltageSystem, poles: number): number[] {
  if (link.source.positions.length > 0) return link.source.positions.map((p) => phaseOfSlot(p, system));
  return Array.from({ length: Math.min(poles, hotConductors(system)) }, (_, i) => i);
}

export class ElectricalLoadEngine {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly demands = new WeakMap<NodeLoads, DemandResult>();
  private readonly reports = new Map<string, ReportEntry>();
  private index: { readonly elements: Elements; readonly ids: ReadonlySet<ElementId> } | null = null;
  /** Nodes already checked against `checkedFor` (one model state). */
  private checkedFor: Elements | null = null;
  private readonly checked = new Set<string>();
  readonly stats = { computed: 0, reused: 0, demands: 0 };

  constructor(readonly rules: ElectricalRules) {}

  /** Connected loads at a piece of distribution equipment, or null when it isn't one. */
  loads(model: Pick<ModelState, "elements">, nodeId: string): NodeLoads | null {
    if (this.checkedFor !== model.elements) {
      this.checkedFor = model.elements;
      this.checked.clear();
    }
    return this.node(model.elements, nodeId, new Set());
  }

  /** The rules' demand at a node, from its raw inventory (cached with the loads). */
  demand(loads: NodeLoads): DemandResult {
    const known = this.demands.get(loads);
    if (known) return known;
    const result = this.rules.demand({ node: loads.info.name, system: loads.info.system, loads: demandLoads(loads.inventory) });
    this.demands.set(loads, result);
    this.stats.demands += 1;
    return result;
  }

  private node(elements: Elements, nodeId: string, stack: Set<string>): NodeLoads | null {
    const part = elements[nodeId];
    if (part?.kind !== "part") return null;
    // Commands refuse a feeder loop; a hand-edited model that has one stops here rather than recursing forever.
    if (stack.has(nodeId)) return null;
    const cached = this.cache.get(nodeId);
    if (cached && this.checked.has(nodeId)) {
      this.stats.reused += 1;
      return cached.value;
    }
    stack.add(nodeId);
    try {
      const servedBy = loadIndexOf(elements).servedBy(nodeId).join(",");
      if (cached && cached.servedBy === servedBy && cached.deps.every(([id, el]) => elements[id] === el) && cached.children.every(([id, v]) => this.node(elements, id, stack) === v)) {
        this.checked.add(nodeId);
        this.stats.reused += 1;
        return cached.value;
      }
      const info = distributionOf(elements, part);
      if (!info) {
        this.cache.delete(nodeId);
        return null;
      }
      const deps: Array<readonly [string, BimElement | undefined]> = [
        [nodeId, part],
        [part.typeId, elements[part.typeId]],
      ];
      const children: Array<readonly [string, NodeLoads]> = [];
      const links: LinkLoad[] = [];
      for (const linkId of part.feeds ?? []) {
        const link = elements[linkId];
        deps.push([linkId, link]);
        if (link?.kind !== "service_link" || link.trade !== "electrical") continue;
        links.push(this.linkLoad(elements, part, info, link, deps, children, stack));
      }
      const estimates = estimatesAt(elements, nodeId, hotConductors(info.system), deps);
      const linked = combineNode(undefined, links.map((l) => l.inventory), inventoryMonoid);
      const value: NodeLoads = estimates && estimates.va > 0 ? { nodeId: part.id, info, inventory: inventoryMonoid.add(linked, estimates.inventory), links, estimates } : { nodeId: part.id, info, inventory: linked, links };
      this.cache.set(nodeId, { deps, children, servedBy, value });
      this.checked.add(nodeId);
      this.stats.computed += 1;
      return value;
    } finally {
      stack.delete(nodeId);
    }
  }

  private linkLoad(elements: Elements, source: PartInstance, info: DistributionInfo, link: ServiceLink, deps: Array<readonly [string, BimElement | undefined]>, children: Array<readonly [string, NodeLoads]>, stack: Set<string>): LinkLoad {
    const e = link.electrical;
    if (e?.feederType) {
      const ftId = catalogElementId("feeder_type", e.feederType);
      deps.push([ftId, elements[ftId]]);
    }
    const built = linkConstruction(elements, link);
    const base = {
      linkId: link.id,
      name: serviceLinkName(elements, link),
      role: link.role,
      description: link.description,
      positions: link.source.positions,
      ratingA: e?.ratingA ?? null,
      conductors: built.conductors,
      lengthFt: e?.lengthFt ?? null,
      feederType: e?.feederType ?? null,
    };
    if (link.role === "feeder") {
      const m = link.members[0];
      if (m) deps.push([m.elementId, elements[m.elementId]]);
      const fed = m ? this.node(elements, m.elementId, stack) : null;
      if (m && fed) children.push([m.elementId, fed]);
      const phases = phasesOf(link, info.system, fed ? hotConductors(fed.info.supply) : 0);
      const fedPart = m ? elements[m.elementId] : undefined;
      const why = m && fedPart?.kind === "part" ? electricalAdapter.refusal(elements, source, link.source.positions, { part: fedPart, connector: m.connector }, "feeder") : null;
      const typical = typicalMultiplier(elements, fedPart, source);
      if (typical.groupId) deps.push([typical.groupId, elements[typical.groupId]]);
      const breaker = link.source.positions.length > 0 ? phases : [];
      const rotate = typical.spec !== null && breaker.length > 0 && rotatesPhases(typical.spec, true);
      const carried = !fed ? EMPTY_INVENTORY : rotate ? onRotatedPhases(typical.count, hotConductors(info.system), (step) => acrossFeeder(fed.inventory, rotated(breaker, step, hotConductors(info.system)))) : scaleInventory(acrossFeeder(fed.inventory, breaker), typical.count);
      return { ...base, phases, inventory: carried, members: [], feeds: m ? m.elementId : null, refusals: why && m ? [{ elementId: m.elementId, message: why }] : [], ...(typical.count > 1 ? { typicalCount: typical.count } : {}) };
    }
    const memberLoads: MemberLoad[] = [];
    const parts: Inventory[] = [];
    const refusals: Array<{ elementId: ElementId; message: string }> = [];
    let typicalMax = 1;
    const first = link.members[0];
    const firstPart = first ? elements[first.elementId] : undefined;
    const poles = first && firstPart?.kind === "part" ? (electricalConnectorOf(elements, firstPart, first.connector)?.poles ?? 1) : 1;
    const phases = phasesOf(link, info.system, poles);
    for (const m of link.members) {
      const member = elements[m.elementId];
      deps.push([m.elementId, member]);
      if (member?.kind !== "part") continue;
      deps.push([member.typeId, elements[member.typeId]]);
      const ct = member.values.connection_type;
      if (typeof ct === "string" && ct.trim() !== "") {
        const ctId = catalogElementId("connection_type", ct);
        deps.push([ctId, elements[ctId]]);
      }
      const why = branchRefusal(elements, info, link.source.positions, { part: member, connector: m.connector });
      if (why) refusals.push({ elementId: member.id, message: why });
      const load = electricalLoadOf(elements, link, m, electricalName(elements, member), this.rules);
      memberLoads.push(load);
      const typical = typicalMultiplier(elements, member, source);
      if (typical.groupId) deps.push([typical.groupId, elements[typical.groupId]]);
      if (typical.count > 1) typicalMax = Math.max(typicalMax, typical.count);
      parts.push(typical.spec !== null && rotatesPhases(typical.spec, false) ? onRotatedPhases(typical.count, hotConductors(info.system), (step) => memberInventory(load, rotated(phases, step, hotConductors(info.system)))) : scaleInventory(memberInventory(load, phases), typical.count));
    }
    return { ...base, phases, inventory: combineNode(undefined, parts, inventoryMonoid), members: memberLoads, feeds: null, refusals, ...(typicalMax > 1 ? { typicalCount: typicalMax } : {}) };
  }

  /** The panel-schedule numbers at a node, its supply, capacity chain and findings. */
  report(model: Pick<ModelState, "elements">, nodeId: string): ElectricalNodeReport | null {
    return buildNodeReport(this, this.reports, model, nodeId, new Set());
  }

  /** Every piece of distribution equipment, sources first (each node before the ones it feeds), then by name. */
  distribution(model: Pick<ModelState, "elements">): ElementId[] {
    const elements = model.elements;
    const nodes = [...this.distributionIds(model)].flatMap((id) => {
      const el = elements[id];
      const info = el?.kind === "part" ? distributionOf(elements, el) : null;
      return info ? [{ id, name: info.name, fed: info.input !== null && linkServing(elements, id, info.input) !== null }] : [];
    });
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => cmp(a.name, b.name) || cmp(a.id, b.id);
    nodes.sort(byName);
    const out: ElementId[] = [];
    const seen = new Set<string>();
    const visit = (id: ElementId) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
      for (const l of this.loads(model, id)?.links ?? []) if (l.feeds) visit(l.feeds);
    };
    for (const n of nodes) if (!n.fed) visit(n.id);
    for (const n of nodes) visit(n.id);
    return out;
  }

  /**
   * Tell the engine `model` is the last model it read with only `changedIds`
   * changed or removed (a committed changeset: pass its changed and removed
   * ids). The engine then trusts every node off the changed elements' paths
   * to the top without checking them again, and carries its list of
   * distribution equipment over instead of reading every element. A changed
   * part type makes it check everything once more (still correct, just not
   * shortcut).
   */
  advance(model: Pick<ModelState, "elements">, changedIds: Iterable<string>): void {
    const prev = this.checkedFor ?? this.index?.elements ?? null;
    if (!prev || prev === model.elements) return;
    const next = model.elements;
    const changed = [...changedIds];
    const ids = this.index?.elements === prev ? new Set(this.index.ids) : null;
    const stale = new Set<string>();
    let typeChanged = false;
    const sourceOf = (els: Elements, linkId: string) => {
      const l = els[linkId];
      if (l?.kind === "service_link") stale.add(l.source.elementId);
    };
    for (const id of changed) {
      for (const [els, el] of [
        [prev, prev[id]],
        [next, next[id]],
      ] as const) {
        if (!el) continue;
        if (el.kind === "part_type" || el.kind === "service_catalog") typeChanged = true;
        else if (el.kind === "service_link") stale.add(el.source.elementId);
        else if (el.kind === "space" || el.kind === "zone") {
          // An estimate spread over it (area, occupants, which devices are inside) counts at its source.
          const index = loadIndexOf(els);
          for (const lid of el.kind === "space" ? index.inSpace(el.id) : index.inZone(el.id)) {
            const lp = els[lid];
            if (lp?.kind === "load_point" && lp.servedBy) stale.add(lp.servedBy);
          }
        } else if (el.kind === "load_point") {
          if (el.servedBy) stale.add(el.servedBy);
        } else if (el.kind === "part") {
          stale.add(el.id);
          for (const linkId of Object.values(el.served ?? {})) sourceOf(els, linkId);
          // A device's load that names a source counts there until the device is circuited.
          for (const lid of loadIndexOf(els).ofPart(el.id)) {
            const lp = els[lid];
            if (lp?.kind === "load_point" && lp.servedBy) stale.add(lp.servedBy);
          }
        }
      }
      if (ids) {
        const el = next[id];
        if (el?.kind === "part" && distributionOf(next, el)) ids.add(el.id);
        else ids.delete(id as ElementId);
      }
    }
    this.index = ids && !typeChanged ? { elements: next, ids } : null;
    if (typeChanged || this.checkedFor !== prev) {
      this.checkedFor = null;
      return;
    }
    // Everything fed through a stale node is stale too, up to the service.
    const queue = [...stale];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i] ?? "";
      for (const els of [prev, next]) {
        const part = els[id];
        if (part?.kind !== "part") continue;
        for (const linkId of Object.values(part.served ?? {})) {
          const l = els[linkId];
          if (l?.kind === "service_link" && !stale.has(l.source.elementId)) {
            stale.add(l.source.elementId);
            queue.push(l.source.elementId);
          }
        }
      }
    }
    for (const id of stale) this.checked.delete(id);
    this.checkedFor = next;
  }

  private distributionIds(model: Pick<ModelState, "elements">): ReadonlySet<ElementId> {
    if (this.index?.elements === model.elements) return this.index.ids;
    const ids = new Set<ElementId>();
    const types = new Set<string>();
    for (const el of elementsOfKind(model.elements, "part_type")) if (el.definition.category === "electrical_equipment") types.add(el.id);
    for (const el of elementsOfKind(model.elements, "part")) if (types.has(el.typeId) && distributionOf(model.elements, el)) ids.add(el.id);
    this.index = { elements: model.elements, ids };
    return ids;
  }
}

// ------------------------------------------------------------------ reports

export interface PhaseTotal {
  readonly phase: "A" | "B" | "C";
  readonly va: number;
  readonly amps: number;
}

export interface SupplyFrom {
  readonly linkId: ElementId;
  readonly sourceId: ElementId;
  readonly sourceName: string;
  /** "MDP-1,3,5", or "T1 to L1" for a transformer secondary. */
  readonly name: string;
  readonly positions: readonly number[];
  readonly ratingA: number | null;
  readonly poles: number;
  readonly conductors: ConductorSet | null;
  readonly feederType: string | null;
  /** "MDP via 225 A 3-pole breaker (F225)". */
  readonly text: string;
}

export type CapacityLimitKind = "bus" | "main" | "transformer" | "feeding_breaker" | "feeder_conductors" | "upstream";

export interface CapacityLimit {
  readonly kind: CapacityLimitKind;
  /** Amps at this node's output. */
  readonly amps: number;
  readonly description: string;
  /** Where the limit sits (the feeding source for the breaker, the conductors and upstream). */
  readonly at: ElementId;
  readonly cite: readonly string[];
}

export interface CapacityResult {
  readonly limitA: number | null;
  readonly limitedBy: CapacityLimit | null;
  readonly limits: readonly CapacityLimit[];
  /** The sizing current (continuous loads at 125%) against the limit. */
  readonly loadA: number;
  readonly headroomA: number | null;
  /** The limiting chain in one sentence. */
  readonly reason: string;
}

export type FindingKind = "incompatible" | "overloaded" | "circuit_overloaded" | "unbalanced" | "bus_above_feeding_breaker" | "breaker_above_bus" | "no_load" | "missing_feeder_type" | "feeder_type_mismatch" | "equipment_protection" | "fed_from_text_mismatch";

export interface ElectricalFinding {
  readonly kind: FindingKind;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

export interface ElectricalNodeReport {
  readonly nodeId: ElementId;
  readonly name: string;
  readonly kind: DistributionInfo["kind"];
  readonly system: string;
  readonly supplyFrom: SupplyFrom | null;
  readonly connectedVa: number;
  readonly connectedA: number;
  readonly perPhase: readonly PhaseTotal[];
  readonly demand: DemandResult;
  readonly demandA: number;
  /** The current conductors and the device are sized for (continuous at 125%). */
  readonly sizingA: number;
  readonly capacity: CapacityResult;
  readonly findings: readonly ElectricalFinding[];
  readonly links: readonly LinkLoad[];
  readonly rules: { readonly id: string; readonly label: string; readonly placeholder: boolean };
  /** Loads naming this node and on no circuit (estimates still uncovered, typed loads): counted in `connectedVa`. Absent: none. */
  readonly estimates?: readonly EstimateShare[];
}

export { PHASE_UNBALANCE_FLOOR_VA, PHASE_UNBALANCE_LIMIT } from "./balance";

const amps = (a: number) => `${Math.round(a)} A`;
const vaText = (va: number) => `${Math.round(va).toLocaleString("en-US")} VA`;

interface Supply {
  readonly link: ServiceLink;
  readonly source: PartInstance;
  readonly sourceInfo: DistributionInfo;
  readonly supply: SupplyFrom;
}

function supplyOf(elements: Elements, part: PartInstance, info: DistributionInfo): Supply | null {
  const link = info.input ? linkServing(elements, part.id, info.input) : null;
  const source = link ? elements[link.source.elementId] : undefined;
  if (!link || source?.kind !== "part") return null;
  const sourceInfo = distributionOf(elements, source);
  if (!sourceInfo) return null;
  const e = link.electrical;
  const built = linkConstruction(elements, link);
  const poles = link.source.positions.length;
  const device = e?.ratingA !== undefined ? ` via ${e.ratingA} A ${poles > 0 ? `${poles}-pole ` : ""}breaker` : "";
  const text = `${sourceInfo.name}${device}${e?.feederType ? ` (${e.feederType})` : ""}`;
  return {
    link,
    source,
    sourceInfo,
    supply: { linkId: link.id, sourceId: source.id, sourceName: sourceInfo.name, name: serviceLinkName(elements, link), positions: link.source.positions, ratingA: e?.ratingA ?? null, poles, conductors: built.conductors, feederType: e?.feederType ?? null, text },
  };
}

function capacityOf(rules: ElectricalRules, part: PartInstance, info: DistributionInfo, demand: DemandResult, s: Supply | null, up: ElectricalNodeReport | null): CapacityResult {
  const limits: CapacityLimit[] = [];
  const here = vaPerAmp(info.system);
  // Limits on the supply side (a transformer's primary breaker and conductors) read at the output by VA.
  const supplyToOutput = vaPerAmp(info.supply) / here;
  const bused = info.kind === "panelboard" || info.kind === "switchboard";
  if (info.busA !== null) limits.push({ kind: "bus", amps: info.busA, description: bused ? `its ${amps(info.busA)} bus` : `its ${amps(info.busA)} rating`, at: part.id, cite: [] });
  if (info.mainA !== null) limits.push({ kind: "main", amps: info.mainA, description: info.kind === "disconnect" ? `its ${amps(info.mainA)} fuses` : `its ${amps(info.mainA)} main breaker`, at: part.id, cite: [] });
  if (info.kva !== null) {
    const a = (info.kva * 1000) / here;
    limits.push({ kind: "transformer", amps: a, description: `its ${info.kva} kVA ${info.kind === "generator" ? "generator " : ""}rating (${amps(a)} at ${voltageSystemLabel(info.system)})`, at: part.id, cite: [] });
  }
  if (s) {
    const { link, source, sourceInfo } = s;
    const rating = link.electrical?.ratingA;
    if (rating !== undefined) limits.push({ kind: "feeding_breaker", amps: rating * supplyToOutput, description: `the ${amps(rating)} breaker in ${sourceInfo.name} that feeds it${supplyToOutput !== 1 ? ` (${amps(rating)} at ${voltageSystemLabel(info.supply)})` : ""}`, at: source.id, cite: [] });
    const c = s.supply.conductors;
    const amp = c ? rules.conductorAmpacity(c, rating ?? null) : null;
    if (c && amp) {
      limits.push({ kind: "feeder_conductors", amps: amp.amps * supplyToOutput, description: `its feeder conductors (${c.sets > 1 ? `${c.sets} sets of ` : ""}#${c.phaseSize} ${c.material.toUpperCase()}, ${amps(amp.amps)}: ${amp.basis})`, at: source.id, cite: amp.cite });
    }
    if (up && up.capacity.limitA !== null) {
      const upPer = vaPerAmp(sourceInfo.system);
      const leftVa = up.capacity.limitA * upPer - up.demand.sizingVa;
      const a = (demand.sizingVa + leftVa) / here;
      limits.push({ kind: "upstream", amps: a, description: `what is left in ${sourceInfo.name} (${amps(Math.max(0, leftVa / upPer))} spare of ${amps(up.capacity.limitA)})`, at: source.id, cite: [] });
    }
  }
  const limitedBy = limits.reduce<CapacityLimit | null>((low, l) => (low === null || l.amps < low.amps - 1e-9 ? l : low), null);
  const loadA = demand.sizingVa / here;
  const others = limits.filter((l) => l !== limitedBy).map((l) => `${l.description}: ${amps(l.amps)}`);
  const reason = limitedBy
    ? `${info.name} can carry ${amps(limitedBy.amps)}, limited by ${limitedBy.description}${others.length > 0 ? ` (also ${others.join("; ")})` : ""}`
    : `${info.name} has no rating to limit it: give it a bus or main rating, or rate the breaker that feeds it`;
  return { limitA: limitedBy?.amps ?? null, limitedBy, limits, loadA, headroomA: limitedBy ? limitedBy.amps - loadA : null, reason };
}

function findingsOf(elements: Elements, part: PartInstance, info: DistributionInfo, loads: NodeLoads, perPhase: readonly PhaseTotal[], capacity: CapacityResult, s: Supply | null): ElectricalFinding[] {
  const supply = s?.supply ?? null;
  const out: ElectricalFinding[] = [];
  for (const l of loads.links) for (const r of l.refusals) out.push({ kind: "incompatible", severity: "error", message: `${l.name}: ${r.message}`, elementIds: [r.elementId, l.linkId] });
  if (capacity.limitedBy && capacity.loadA > capacity.limitedBy.amps + 1e-9) {
    out.push({ kind: "overloaded", severity: "error", message: `${info.name} is overloaded: it needs ${amps(capacity.loadA)} (the calculated load with continuous loads at 125%) and can carry ${amps(capacity.limitedBy.amps)}, limited by ${capacity.limitedBy.description}`, elementIds: [part.id] });
  }
  for (const l of loads.links) {
    if (l.role !== "branch" || l.ratingA === null || l.inventory.va === 0) continue;
    const a = branchSizingA(l, info.system);
    if (a > l.ratingA + 1e-9) out.push({ kind: "circuit_overloaded", severity: "warning", message: `${l.name}${l.description ? ` (${l.description})` : ""} needs ${a.toFixed(1)} A with continuous loads at 125%, on a ${amps(l.ratingA)} breaker`, elementIds: [l.linkId] });
  }
  const unbalance = loads.inventory.va > 0 ? phaseUnbalance(perPhase) : null;
  if (unbalance) {
    const { worst, average: avg, fraction: off } = unbalance;
    out.push({ kind: "unbalanced", severity: "warning", message: `${info.name}'s phases are unbalanced: ${perPhase.map((p) => `${p.phase} ${vaText(p.va)}`).join(", ")}; ${worst.phase} is ${Math.round(off * 100)}% ${worst.va < avg ? "below" : "above"} the average (design target ${Math.round(PHASE_UNBALANCE_LIMIT * 100)}%). Move circuits ${worst.va < avg ? `onto ${worst.phase}` : `off ${worst.phase}`}`, elementIds: [part.id] });
  }
  if (supply?.ratingA !== null && supply?.ratingA !== undefined && info.busA !== null && supply.ratingA < info.busA && (info.kind === "panelboard" || info.kind === "switchboard")) {
    // A warning, not a note: bus and feeding breaker normally match, and a changed bus with a forgotten breaker is the classic miss (V3).
    out.push({ kind: "bus_above_feeding_breaker", severity: "warning", message: `${info.name}'s ${amps(info.busA)} bus is fed by a ${amps(supply.ratingA)} breaker in ${supply.sourceName}, so it can carry no more than the breaker`, elementIds: [part.id, supply.linkId] });
  }
  if (supply?.ratingA !== null && supply?.ratingA !== undefined && info.busA !== null && supply.ratingA > info.busA && (info.kind === "panelboard" || info.kind === "switchboard")) {
    out.push({ kind: "breaker_above_bus", severity: "warning", message: `${info.name}'s ${amps(info.busA)} bus is fed by a ${amps(supply.ratingA)} breaker in ${supply.sourceName}, larger than the bus it protects`, elementIds: [part.id, supply.linkId] });
  }
  if (s) {
    const built = linkConstruction(elements, s.link);
    if (built.missingFeederType) {
      out.push({ kind: "missing_feeder_type", severity: "warning", message: `${supply?.name ?? info.name} names feeder type ${built.missingFeederType}, which isn't in the project's feeder types; add it or pick another`, elementIds: [s.link.id] });
    } else if (built.feederType && supply?.ratingA !== null && supply?.ratingA !== undefined && built.feederType.ratingA !== supply.ratingA) {
      out.push({ kind: "feeder_type_mismatch", severity: "warning", message: `${supply.name} has a ${amps(supply.ratingA)} breaker but feeder type ${built.feederType.mark} is for ${amps(built.feederType.ratingA)}; change the breaker or the feeder type`, elementIds: [s.link.id] });
    }
  }
  const typed = fedFromTextMismatch(elements, part.id);
  if (typed) {
    out.push({ kind: "fed_from_text_mismatch", severity: "warning", message: `${info.name}'s typed Fed from says "${typed.typed}", but its feeder comes from ${typed.linkedSourceName}; schedules print ${typed.linkedSourceName}. Clear the typed text or re-feed ${info.name}`, elementIds: [part.id, typed.linkedSourceId] });
  }
  for (const l of loads.links) {
    if (l.role !== "branch" || l.members.length !== 1 || l.ratingA === null) continue;
    const m = l.members[0];
    const member = m ? elements[m.elementId] : undefined;
    if (!m || member?.kind !== "part") continue;
    const plate = equipmentNameplate(elements, member);
    if (plate.mocpA !== null && l.ratingA > plate.mocpA + 1e-9) {
      out.push({ kind: "equipment_protection", severity: "error", message: `${l.name}: ${m.name}'s ${amps(l.ratingA)} breaker is above its ${amps(plate.mocpA)} maximum overcurrent protection (nameplate); use ${amps(plate.mocpA)} or less`, elementIds: [l.linkId, member.id] });
    } else if (plate.mcaA !== null && l.ratingA + 1e-9 < plate.mcaA) {
      out.push({ kind: "equipment_protection", severity: "warning", message: `${l.name}: ${m.name}'s minimum circuit ampacity is ${amps(plate.mcaA)}, more than its ${amps(l.ratingA)} breaker; the breaker would trip under normal load`, elementIds: [l.linkId, member.id] });
    }
  }
  const unloaded = loads.links.flatMap((l) => l.members.filter((m) => m.va <= 0).map((m) => ({ m, l })));
  if (unloaded.length > 0) {
    out.push({ kind: "no_load", severity: "info", message: `${unloaded.length === 1 ? `${unloaded[0]?.m.name} on ${unloaded[0]?.l.name} has` : `${unloaded.length} loads on ${info.name}'s circuits have`} no load to count: give the connector a design load, or set load_va (or watts, or MCA)`, elementIds: unloaded.map((u) => u.m.elementId as ElementId) });
  }
  return out;
}

interface ReportEntry {
  readonly loads: NodeLoads;
  readonly supplyLink: ServiceLink | null;
  /** The catalog record of the supply's feeder type (its conductors set a capacity limit). */
  readonly feederTypeRecord: BimElement | undefined;
  readonly up: ElectricalNodeReport | null;
  readonly report: ElectricalNodeReport;
}

/** Reports by node, re-used while the node's loads, its feeder and the report upstream are the same objects. */
function buildNodeReport(engine: ElectricalLoadEngine, cache: Map<string, ReportEntry>, model: Pick<ModelState, "elements">, nodeId: string, seen: Set<string>): ElectricalNodeReport | null {
  const elements = model.elements;
  const part = elements[nodeId];
  if (part?.kind !== "part") return null;
  const loads = engine.loads(model, nodeId);
  if (!loads) return null;
  seen.add(nodeId);
  const info = loads.info;
  const s = supplyOf(elements, part, info);
  const up = s && !seen.has(s.source.id) ? buildNodeReport(engine, cache, model, s.source.id, seen) : null;
  const prior = cache.get(nodeId);
  const mark = s?.link.electrical?.feederType;
  const feederTypeRecord = mark ? elements[catalogElementId("feeder_type", mark)] : undefined;
  if (prior && prior.loads === loads && prior.supplyLink === (s?.link ?? null) && prior.up === up && prior.feederTypeRecord === feederTypeRecord) return prior.report;
  const demand = engine.demand(loads);
  const hots = hotConductors(info.system);
  const perPhase = loads.inventory.perPhase.slice(0, hots).map((va, i) => ({ phase: PHASE_NAMES[i] ?? "A", va, amps: phaseAmps(va, info.system) }));
  const capacity = capacityOf(engine.rules, part, info, demand, s, up);
  const supply = s?.supply ?? null;
  const report: ElectricalNodeReport = {
    nodeId: part.id,
    name: info.name,
    kind: info.kind,
    system: voltageSystemLabel(info.system),
    supplyFrom: supply,
    connectedVa: loads.inventory.va,
    connectedA: lineAmps(loads.inventory.va, info.system),
    perPhase,
    demand,
    demandA: lineAmps(demand.demandVa, info.system),
    sizingA: lineAmps(demand.sizingVa, info.system),
    capacity,
    findings: findingsOf(elements, part, info, loads, perPhase, capacity, s),
    links: loads.links,
    rules: { id: engine.rules.id, label: engine.rules.label, placeholder: engine.rules.placeholder },
    ...(loads.estimates ? { estimates: loads.estimates.shares } : {}),
  };
  cache.set(nodeId, { loads, supplyLink: s?.link ?? null, feederTypeRecord, up, report });
  return report;
}
