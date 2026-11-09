import { pushTo } from "../../collections";
import { linksFedFrom } from "../../connections/model";
import { componentBeyond, isCouplerPart, isCouplingOutlet, networkCouplings, type NetworkCouplingDef } from "../../load-points/walk-loads";
import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import { resolveConnectors, type SystemKind } from "../../parts";
import type { FieldProvider, RelationshipResolver } from "../../registry/types";
import { isSource, runNeighbours } from "../../routing/derive";
import { loadIndexOf } from "../../requirements/load-index";
import { elementsOfKind } from "../../store";
import type { BimElement, ElementId, PartInstance } from "../../types";

/**
 * The `serves` / `source` relationships (SCHEDULES-PLAN §5d) and the
 * electrical `fed_from` / `feeds`, resolved by the walks the trades already
 * run, never a new one:
 *
 * - Gas: a meter or service regulator serves every appliance on its system;
 *   a line or appliance regulator serves the appliances in its zone and the
 *   zones below it (the Gas agent's `gasNetwork`). An outlet's `source` is its
 *   system's source.
 * - Water: a water heater serves the load points and fixtures beyond its hot
 *   outlets, and a pump or meter those beyond its discharge (the same run
 *   graph walk that makes the heater inlet carry its hot side). A connection's
 *   `source` is the heater or equipment at the root of that walk.
 * - Electrical: a panel feeds what its circuits and feeders serve; a circuit
 *   or feeder serves its members.
 *
 * What an item serves is a relationship, never a load of its own: a heater's
 * served fixture units are already counted on the fixtures, so they never
 * add into a system total.
 */

type Elements = Readonly<Record<string, BimElement>>;

/**
 * A trade's own `serves` walk (v1), for networks the shared piped walk below
 * doesn't cover (gas zones and their regulators). `rank` below 50 lists a
 * row's served items before the piped walk's, 50 and above after it.
 */
export interface ServesRuleDef {
  readonly id: string;
  readonly rank: number;
  /** System kinds this row walks itself: the piped walk skips connectors of these kinds. */
  readonly systemKinds?: readonly SystemKind[];
  /** What `id` serves through this walk, in walk order. */
  served(elements: Elements, id: ElementId): readonly ElementId[];
  /** Outlets and their sources through this walk (`sourceOf` reads them before any piped walk). */
  sources?(elements: Elements): Iterable<readonly [ElementId, ElementId]>;
  /** Elements other than parts that serve through this walk (regulators placed on a pipe), for `served_by`. */
  servers?(elements: Elements): Iterable<ElementId>;
  /** An outlet's source through this walk, or null. */
  sourceOf?(elements: Elements, id: ElementId): ElementId | null;
}

export const SERVES_RULE_POINT = defineExtensionPoint<ServesRuleDef>({ id: "kernel.serves_rule", version: 1, label: "Serves relationships", idOf: (r) => r.id });

function servesRules(): readonly ServesRuleDef[] {
  const set = activePackSet();
  return set.memo("kernel.serves_rule#ranked", () => set.items(SERVES_RULE_POINT).map((row, i) => ({ row, i })).sort((a, b) => a.row.rank - b.row.rank || a.i - b.i).map((r) => r.row));
}

function walkedKinds(): ReadonlySet<SystemKind> {
  const set = activePackSet();
  return set.memo("kernel.serves_rule#kinds", () => new Set(servesRules().flatMap((r) => r.systemKinds ?? [])));
}

function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

const isAccessory = (elements: Elements, part: PartInstance): boolean => {
  const t = elements[part.typeId];
  return t?.kind === "part_type" && (t.definition.category === "pipe_accessory" || t.definition.category === "duct_accessory");
};

/** Connectors a part supplies water through: a heater's hot outlets, a pump's or meter's discharge. A kind a serves rule walks itself (gas) is skipped. */
function supplyConnectors(elements: Elements, part: PartInstance): string[] {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  const connectors = resolveConnectors(type.definition, part.values);
  // Which way flow goes through a connector doesn't depend on parameters: read the definition.
  const declared = type.definition.connectors;
  const out: string[] = [];
  const skipped = walkedKinds();
  for (const id of Object.keys(part.links ?? {}).sort()) {
    if (isCouplingOutlet(elements, part, id)) {
      out.push(id);
      continue;
    }
    const c = connectors.find((x) => x.id === id);
    if (declared.find((x) => x.id === id)?.flowDirection === "out" && c?.domain === "pipe" && !skipped.has(c.systemKind)) out.push(id);
  }
  return out;
}

/** Load points and fixtures beyond a part's supply connectors, in walk order. A fixture attached to a load point is served through its point. */
function pipedServes(elements: Elements, part: PartInstance): ElementId[] {
  const points: ElementId[] = [];
  const parts: ElementId[] = [];
  const seen = new Set<string>();
  const attached = new Set<string>();
  const neighbours = (n: string) => runNeighbours(elements, n);
  for (const connector of supplyConnectors(elements, part)) {
    const link = part.links?.[connector];
    if (!link) continue;
    const far = elements[link.elementId];
    const start = far?.kind === "part" ? `${far.id}#${link.port}` : link.elementId;
    for (const node of componentBeyond(elements, part.id, start, neighbours)) {
      const hash = node.indexOf("#");
      const id = hash >= 0 ? node.slice(0, hash) : node;
      if (seen.has(id)) continue;
      const el = elements[id];
      if (hash >= 0) {
        const p = partOf(elements, id);
        if (!p || isAccessory(elements, p)) continue;
        seen.add(id);
        parts.push(p.id);
      } else if (el?.kind === "load_point") {
        seen.add(id);
        points.push(el.id);
        if (el.attachedPartId) attached.add(el.attachedPartId);
      }
    }
  }
  return [...points, ...parts.filter((p) => !attached.has(p))];
}

/** What a panel's circuits and feeders serve, or a circuit's or feeder's members. */
function electricalServes(elements: Elements, el: BimElement): ElementId[] {
  if (el.kind === "service_link") return el.members.map((m) => m.elementId);
  if (el.kind !== "part") return [];
  const out: ElementId[] = [];
  for (const link of linksFedFrom(elements, el.id)) for (const m of link.members) if (!out.includes(m.elementId)) out.push(m.elementId);
  return out;
}

/** The board an element is fed from: the source of the circuit or feeder serving it. */
function electricalFedFrom(elements: Elements, el: BimElement): ElementId | null {
  if (el.kind === "service_link") return el.source.elementId;
  if (el.kind !== "part") return null;
  for (const connector of Object.keys(el.served ?? {}).sort()) {
    const link = elements[el.served?.[connector] ?? ""];
    if (link?.kind === "service_link") return link.source.elementId;
  }
  return null;
}

function union(lists: readonly (readonly ElementId[])[]): ElementId[] {
  const out: ElementId[] = [];
  const seen = new Set<ElementId>();
  for (const list of lists) for (const id of list) if (!seen.has(id)) {
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Loads that name this element as their source before (or regardless of) any drawing: "served by WH-1". From the load index. */
function logicallyServed(elements: Elements, id: ElementId): readonly ElementId[] {
  return loadIndexOf(elements).servedBy(id);
}

/** Everything an element serves, every trade: drawn (piped, gas zones, circuits) first, then loads that name it as their source. */
export function servesOf(elements: Elements, el: BimElement): ElementId[] {
  return union(drawnServes(elements, el, el.kind === "part" ? pipedServes(elements, el) : []));
}

/** The rows' walks around the piped one (by rank), then circuits and the loads that name it. */
function drawnServes(elements: Elements, el: BimElement, piped: readonly ElementId[]): (readonly ElementId[])[] {
  const rules = servesRules();
  const before = rules.filter((r) => r.rank < 50).map((r) => r.served(elements, el.id));
  const after = rules.filter((r) => r.rank >= 50).map((r) => r.served(elements, el.id));
  return [...before, piped, ...after, electricalServes(elements, el), logicallyServed(elements, el.id)];
}

interface ServesIndex {
  readonly servedBy: ReadonlyMap<ElementId, readonly ElementId[]>;
  readonly sourceFor: ReadonlyMap<ElementId, ElementId>;
  readonly sourceOf: ReadonlyMap<ElementId, readonly ElementId[]>;
}

const indexes = new WeakMap<Elements, { readonly rules: readonly ServesRuleDef[]; readonly couplings: readonly NetworkCouplingDef[]; readonly index: ServesIndex }>();

/** Who serves what, read backwards, once per model state and serves rules: every supplying part and gas regulator, walked once. */
function servesIndex(elements: Elements): ServesIndex {
  const cached = indexes.get(elements);
  if (cached && cached.rules === servesRules() && cached.couplings === networkCouplings()) return cached.index;
  const servedBy = new Map<ElementId, ElementId[]>();
  const sourceFor = new Map<ElementId, ElementId>();
  const push = (to: ElementId, from: ElementId) => {
    const list = servedBy.get(to);
    if (!list) servedBy.set(to, [from]);
    else if (!list.includes(from)) list.push(from);
  };
  const rules = servesRules();
  for (const rule of rules) if (rule.sources) for (const [to, from] of rule.sources(elements)) sourceFor.set(to, from);
  for (const rule of rules) {
    if (!rule.servers) continue;
    for (const id of rule.servers(elements)) {
      const el = elements[id];
      if (el && el.kind !== "part") for (const to of servesOf(elements, el)) push(to, id);
    }
  }
  // Heaters and system sources first, so a connection's source is the root of its walk, not a pump on the way.
  const inline: Array<readonly [ElementId, readonly ElementId[]]> = [];
  for (const part of elementsOfKind(elements, "part")) {
    const piped = pipedServes(elements, part);
    for (const to of union(drawnServes(elements, part, piped))) push(to, part.id);
    if (piped.length === 0) continue;
    if (isCouplerPart(elements, part) || isSource(elements, part)) {
      for (const to of piped) if (!sourceFor.has(to)) sourceFor.set(to, part.id);
    } else {
      inline.push([part.id, piped]);
    }
  }
  for (const [from, piped] of inline) for (const to of piped) if (!sourceFor.has(to)) sourceFor.set(to, from);
  const sourceOf = new Map<ElementId, ElementId[]>();
  for (const [to, from] of sourceFor) pushTo(sourceOf, from, to);
  const index: ServesIndex = { servedBy, sourceFor, sourceOf };
  indexes.set(elements, { rules, couplings: networkCouplings(), index });
  return index;
}

/** The piping source of an outlet: a serves rule's (its gas system's source), else the heater or equipment its water comes from. */
export function sourceOf(elements: Elements, el: BimElement): ElementId | null {
  for (const rule of servesRules()) {
    const s = rule.sourceOf?.(elements, el.id);
    if (s) return s;
  }
  const drawn = servesIndex(elements).sourceFor.get(el.id);
  if (drawn) return drawn;
  // Not drawn yet: the source the load names.
  return el.kind === "load_point" && el.servedBy ? el.servedBy : null;
}

const serves: RelationshipResolver = (el, ctx) => servesOf(ctx.elements, el);
const servedBy: RelationshipResolver = (el, ctx) => servesIndex(ctx.elements).servedBy.get(el.id) ?? [];
const source: RelationshipResolver = (el, ctx) => {
  const s = sourceOf(ctx.elements, el);
  return s ? [s] : [];
};
const sourceOfResolver: RelationshipResolver = (el, ctx) => servesIndex(ctx.elements).sourceOf.get(el.id) ?? [];
const fedFrom: RelationshipResolver = (el, ctx) => {
  const s = electricalFedFrom(ctx.elements, el);
  return s ? [s] : [];
};
const feeds: RelationshipResolver = (el, ctx) => electricalServes(ctx.elements, el);

export const SERVES_PROVIDER: FieldProvider = {
  id: "mep.serves",
  resolvers: { serves, served_by: servedBy, source, source_of: sourceOfResolver, fed_from: fedFrom, feeds },
};
