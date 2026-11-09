import { isWalkedService, serviceById } from "../services/registry";
import type { ServiceAdapterId } from "../services/types";
import type { BimElement, ElementId, ModelState, PartInstance, Vec2 } from "../types";
import { defineExtensionPoint } from "../packs/contract";
import type { FirstPartyPackId } from "../packs/first-party/manifests";
import { activePackSet } from "../packs/scope";
import { firstPartyBaseRevision, firstPartyOwnerOf, packSetReadsRecorded, type PackSet } from "../packs/set";
import type { NetworkAggregation, NetworkQuantities, TradeAdapter } from "./adapter";
import type { TreeNetworkFace } from "../tree-network";
import type { ConnectFace, ConnectPlan, SourceCandidate, SourceCandidates, SourceEndRef, SourcesForFace, TranslateContext, TranslateFace } from "./faces";
import type { Monoid } from "./aggregate";
import { networkTotals } from "./network";
import { SERVICE_TRADES, linkAdapterId, type ServiceLink, type ServiceTrade } from "./types";
import { partOf } from "./links";

export { linksFedFrom, linkServing, occupiedPositions, serviceNeighbours, serviceFingerprint } from "./links";

type Elements = Readonly<Record<string, BimElement>>;

/** The network adapter ids this release ships. Any other id is a pack's (`<pack>.<name>`); readers keep it as stored and list its service without walking it. */
export const KNOWN_NETWORK_ADAPTER_IDS = SERVICE_TRADES;
export type KnownNetworkAdapterId = ServiceTrade;

export function isKnownNetworkAdapterId(id: string): id is KnownNetworkAdapterId {
  return (KNOWN_NETWORK_ADAPTER_IDS as readonly string[]).includes(id);
}

/**
 * One network adapter on the pack contract: what a service row's `adapter`
 * names. It brings either face or both: `adapter`, the served-from link rules
 * (sources, connectors, positions; its `trade` is the stored link trade its
 * links carry, so it is one of the link trades this release stores), and
 * `aggregation`, a physical or served-from network the kernel walks and
 * totals for any service (a load path, a storm network). A third face,
 * `tree`, speaks for the connected-element tree the kernel indexes: which
 * kinds host taps, where a tap sits, and what the tree totals.
 */
export interface NetworkAdapterItem {
  /** What service rows and links name it by (`ServiceDef.adapter`, `ServiceLink.adapter`). Built-ins are bare; a pack's are `<pack>.<name>`. */
  readonly id: ServiceAdapterId;
  readonly adapter?: TradeAdapter;
  readonly aggregation?: NetworkAggregation;
  /** The connected-element tree's face (tree-network.ts): kinds that host taps, and quantities the tree totals. */
  readonly tree?: TreeNetworkFace;
  /** Contract 1.10.0: an unserved end and the sources that could take it (connections/faces.ts). */
  readonly sourcesFor?: SourcesForFace;
  /** Contract 1.10.0: moving one of this network's elements and what follows it (connections/faces.ts). */
  readonly translate?: TranslateFace;
  /** Contract 1.10.0: connect an unserved end to a source `sourcesFor` offered (connections/faces.ts). */
  readonly connect?: ConnectFace;
}

/**
 * Network adapters (v1): what walks, sizes and checks a service's links. No
 * built-in rows: the first-party trades' adapters are their packs'
 * contributions (installed under every set), asked in first-party order.
 */
export const NETWORK_ADAPTER_POINT = defineExtensionPoint<NetworkAdapterItem>({
  id: "kernel.network_adapter",
  version: 1,
  label: "Network adapters",
  idOf: (item) => item.id,
});

/** The first-party pack an installed adapter row belongs to, for listing; null for another pack's row. */
export function networkAdapterOwner(item: Pick<NetworkAdapterItem, "id">): FirstPartyPackId | null {
  return firstPartyOwnerOf(NETWORK_ADAPTER_POINT, item.id);
}

const TABLE_KEY = "kernel.network_adapter#table";

function tableFor(set: PackSet): ReadonlyMap<ServiceAdapterId, TradeAdapter> {
  const table = new Map<ServiceAdapterId, TradeAdapter>();
  for (const item of set.items(NETWORK_ADAPTER_POINT)) if (item.adapter) table.set(item.id, item.adapter);
  return table;
}

/** The adapter table of the set in force: built once per set, so a lookup is one map read. */
let last: { readonly set: PackSet; readonly base: number; readonly table: ReadonlyMap<ServiceAdapterId, TradeAdapter> } | null = null;

function adapterTable(): ReadonlyMap<ServiceAdapterId, TradeAdapter> {
  const set = activePackSet();
  const base = firstPartyBaseRevision();
  if (last !== null && last.set === set && last.base === base && !packSetReadsRecorded()) return last.table;
  const table = set.memo(TABLE_KEY, tableFor);
  // A recorded pass comes through here once per check: keep the holder when nothing changed.
  if (last === null || last.table !== table || last.set !== set || last.base !== base) last = { set, base, table };
  return table;
}

/** The adapter registered under an id (a trade, or a pack's adapter id), or null when none is: that network is listed, not walked. */
export function tradeAdapter(trade: ServiceTrade | ServiceAdapterId): TradeAdapter | null {
  return adapterTable().get(trade) ?? null;
}

/** The adapter a stored link belongs to (`adapter ?? trade`), or null when this release has none for it. */
export function linkAdapter(link: Pick<ServiceLink, "trade" | "adapter">): TradeAdapter | null {
  return tradeAdapter(linkAdapterId(link));
}

/** The adapter that walks a service row (`sanitary` → plumbing), or null when the row names none, none is registered, or the id is unknown. */
export function adapterForService(serviceId: string): TradeAdapter | null {
  const row = serviceById(serviceId);
  // A regime or connector this release doesn't know: listed, not walked.
  const id = row && isWalkedService(row) ? row.adapter : undefined;
  return id ? (adapterTable().get(id) ?? null) : null;
}

const adapterItemsOf = (set: PackSet): ReadonlyMap<string, NetworkAdapterItem> => new Map(set.items(NETWORK_ADAPTER_POINT).map((i) => [i.id, i] as const));

/** The network adapter item a service row names in the pack set in force (both faces), or null: listed, not walked. */
export function networkForService(serviceId: string): NetworkAdapterItem | null {
  const row = serviceById(serviceId);
  const id = row && isWalkedService(row) ? row.adapter : undefined;
  if (!id) return null;
  return activePackSet().memo("kernel.network_adapter#items", adapterItemsOf).get(id) ?? null;
}

/** The first network in the set in force (in first-party order) that answers for an unserved end, or null when none does. */
export function sourcesFor(model: ModelState, end: SourceEndRef): SourceCandidates | null {
  for (const item of activePackSet().items(NETWORK_ADAPTER_POINT)) {
    const answer = item.sourcesFor?.(model, end) ?? null;
    if (answer) return answer;
  }
  return null;
}

/** Connect an end to a source through the first network that plans it; refused in words when none in the set in force does. */
export function connectToSource(model: ModelState, end: SourceEndRef, source: SourceCandidate, newId: string): ConnectPlan {
  for (const item of activePackSet().items(NETWORK_ADAPTER_POINT)) {
    const plan = item.connect?.(model, end, source, newId) ?? null;
    if (plan) return plan;
  }
  return { ok: false, reason: `Nothing loaded here can connect to ${source.label} yet. Use the add-on's own Add command instead.` };
}

/** Move one element through the first network that takes it; false when no network in the set in force does. */
export function translateThroughNetworks(ctx: TranslateContext, id: ElementId, delta: Vec2): boolean {
  for (const item of activePackSet().items(NETWORK_ADAPTER_POINT)) if (item.translate?.(ctx, id, delta) === true) return true;
  return false;
}

/** Sums each quantity key; a key a node doesn't carry adds nothing. */
export const quantityRecordMonoid: Monoid<NetworkQuantities> = {
  empty: () => ({}),
  add(a, b) {
    const out: Record<string, number> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
    return out;
  },
};

function scaleQuantities(value: NetworkQuantities, times: number): NetworkQuantities {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) out[k] = v * times;
  return out;
}

export type ServiceNetworkTotals =
  | {
      readonly ok: true;
      readonly serviceId: string;
      readonly quantities: readonly string[];
      readonly direction: string;
      /** Each node's own quantities plus everything below it, by element id. */
      readonly totals: ReadonlyMap<string, NetworkQuantities>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Walk and total one service's network in this model through its adapter's
 * `aggregation` (the kernel's `networkTotals`, each quantity key summed). Any
 * trade, any pack: a structural load path, a storm network. Fails in words
 * when the service has no adapter that aggregates, or the model has no such
 * network.
 */
export function serviceNetworkTotals(model: ModelState, serviceId: string): ServiceNetworkTotals {
  const row = serviceById(serviceId);
  if (!row) return { ok: false, reason: `"${serviceId}" isn't a service this model knows` };
  const item = networkForService(serviceId);
  if (!item?.aggregation) return { ok: false, reason: `${row.label} has no network this release can total${row.adapter ? ` (its adapter ${row.adapter} adds none)` : ""}` };
  const network = item.aggregation.network(model, { serviceId });
  if (!network) return { ok: false, reason: `This model has no ${row.label.toLowerCase()} network to total` };
  const keys = new Set(item.aggregation.quantities);
  const own = (n: string): NetworkQuantities | undefined => {
    const q = network.ownQuantities(n);
    if (!q) return undefined;
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(q)) if (keys.has(k) && Number.isFinite(v)) kept[k] = v;
    return kept;
  };
  const factor = network.edgeFactor?.bind(network);
  const split = network.across?.bind(network);
  const walk = { roots: () => network.roots(), children: (n: string) => network.children(n), ownQuantities: own, ...(factor ? { edgeFactor: factor } : {}), ...(split ? { across: split } : {}) };
  const totals = networkTotals(walk, quantityRecordMonoid, scaleQuantities);
  return { ok: true, serviceId, quantities: item.aggregation.quantities, direction: item.aggregation.direction, totals };
}

/** The first trade a part can be a source in, with what it offers. */
export function sourceTradeOf(elements: Elements, part: PartInstance): { adapter: TradeAdapter; info: NonNullable<ReturnType<TradeAdapter["source"]>> } | null {
  for (const adapter of adapterTable().values()) {
    const info = adapter.source(elements, part);
    if (info) return { adapter, info };
  }
  return null;
}

/** How a link is named on drawings: the source and its positions ("L1-1,3,5"), else the source and what it feeds. */
export function serviceLinkName(elements: Elements, link: ServiceLink): string {
  const source = partOf(elements, link.source.elementId);
  const sourceName = source ? (sourceTradeOf(elements, source)?.info.name ?? (source.mark || source.id)) : link.source.elementId;
  if (link.source.positions.length > 0) return `${sourceName}-${[...link.source.positions].sort((a, b) => a - b).join(",")}`;
  const first = link.members[0];
  const member = first ? partOf(elements, first.elementId) : null;
  const memberName = member ? (sourceTradeOf(elements, member)?.info.name ?? (member.mark || member.id)) : "";
  return memberName ? `${sourceName} to ${memberName}` : sourceName;
}
