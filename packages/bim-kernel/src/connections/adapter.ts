import type { BimElement, ModelState, PartInstance } from "../types";
import type { NetworkAdapter } from "./network";
import type { NetworkSolveContext, NetworkSolveProblem } from "./solve";
import type { ElectricalLinkDesign, ServiceRole, ServiceTrade } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/** What a part offers as a source of a trade's links. */
export interface SourceInfo {
  readonly name: string;
  /** The output links leave from. */
  readonly port: string;
  /** How many numbered positions it has; null: numbered without a known limit; "none": no positions at all. */
  readonly spaces: number | null | "none";
  /** The connector a link feeding this source lands on (it can itself be served), or null. */
  readonly input: string | null;
  /** Other connectors a feeder may land on (a transfer switch's emergency side). */
  readonly alternateInputs?: readonly string[];
}

/** A member connector being served, as the adapter judges it. */
export interface MemberCandidate {
  readonly part: PartInstance;
  readonly connector: string;
}

/**
 * One trade's rules for served-from links. The core (connections/commands.ts)
 * owns ids, back-links, slot bookkeeping, undo and validation; an adapter says
 * what can serve what and how many positions a member takes.
 */
export interface TradeAdapter {
  readonly trade: ServiceTrade;
  /** The part as a source, or null when it can't serve anything in this trade. */
  source(elements: Elements, part: PartInstance): SourceInfo | null;
  /** Connectors of a part this trade can serve, for choosing one when the sender didn't. */
  connectors(elements: Elements, part: PartInstance): string[];
  /** Positions a member takes at a numbered source (poles), or null when it does not say. */
  positionsNeeded(elements: Elements, member: MemberCandidate, role: ServiceRole): number | null;
  /** Why the source can't serve this member through `positions`, in plain words; null when it can. */
  refusal(elements: Elements, source: PartInstance, positions: readonly number[], member: MemberCandidate, role: ServiceRole): string | null;
  /** Why these positions can't be used together at this source (spacing, phase), or null. */
  positionsRefusal(elements: Elements, source: PartInstance, positions: readonly number[]): string | null;
  /**
   * A default design for a new link (an electrical breaker rating), from its
   * members; what the sender gives wins. Keyed like `ServiceLink.design`
   * (electrical returns `{ electrical }`; a pack returns its own adapter id).
   */
  defaultDesign?(elements: Elements, members: readonly MemberCandidate[], role: ServiceRole, positions: readonly number[]): { readonly electrical?: ElectricalLinkDesign } & Readonly<Record<string, unknown>>;
  /** Roles a link of this adapter can take. Absent: `["branch", "feeder"]`. */
  readonly roles?: readonly string[];
  /** Validates `ServiceLink.design[adapterId]` for this adapter (a zod schema or anything with `safeParse`). */
  readonly designSchema?: { safeParse(value: unknown): { readonly success: boolean } };
  /**
   * A looped network's problem for `solveNetwork` (connections/solve.ts):
   * nodes, edges, demands and the drop law; the kernel iterates. Null:
   * nothing looped to solve here.
   */
  solve?(model: ModelState, ctx: NetworkSolveContext): NetworkSolveProblem | null;
  /**
   * Which of the free position groups (each allowed, lowest first) a link
   * should take when the sender left positions out; absent: the lowest.
   * Electrical picks the one that best balances the phases. `except` is the
   * link being moved, whose own load doesn't count where it is now.
   */
  rankPositions?(elements: Elements, source: PartInstance, candidates: readonly (readonly number[])[], members: readonly MemberCandidate[], role: ServiceRole, except: string): readonly number[] | null;
}

/** Which way a network's totals run, for people reading them: loads toward their source, runoff to an outfall, gravity loads to a footing. The walk always totals from the leaves to the roots. */
export const KNOWN_AGGREGATION_DIRECTIONS = ["toward_source", "downstream", "downward"] as const;
export type AggregationDirection = (typeof KNOWN_AGGREGATION_DIRECTIONS)[number];

/** What a network is made of: served-from links (a source and what it serves), physical runs and connections (pipes, members bearing on members), or both. */
export const KNOWN_NETWORK_LINKS = ["served_from", "physical"] as const;
export type NetworkLinkKind = (typeof KNOWN_NETWORK_LINKS)[number];

/** Per node of a network: a value per quantity key it adds itself. */
export type NetworkQuantities = Readonly<Record<string, number>>;

/** What `NetworkAggregation.network` is told. */
export interface NetworkWalkContext {
  readonly serviceId: string;
}

/**
 * A network the kernel can walk and total for any service: a structural load
 * path (members down to footings), a storm network (catchments to an outfall),
 * a served-from tree. The adapter says which quantities add up, which way, over
 * which links, and gives the network as nodes (element ids), roots and
 * children; `serviceNetworkTotals` (connections/model.ts) totals it with the
 * kernel's `networkTotals`, summing each quantity key.
 */
export interface NetworkAggregation {
  /** Parameter keys that add up along it (`struct.dead_load`, `civil.runoff`). */
  readonly quantities: readonly string[];
  readonly direction: AggregationDirection | (string & {});
  readonly over: readonly (NetworkLinkKind | (string & {}))[];
  /**
   * The network of one service in this model, or null when the model has
   * none. A node id is an element id, or `<elementId>@<port>` for one end or
   * port of an element that acts as several nodes (a beam's `@start` and
   * `@end`). A child listed under two parents reaches both; the network's
   * `across` says what share reaches each.
   */
  network(model: ModelState, ctx: NetworkWalkContext): NetworkAdapter<string, NetworkQuantities> | null;
  /**
   * A looped network's problem for `solveNetwork` (a ring main, a gridded
   * storm network), when this service has no link rules of its own: nodes,
   * edges, demands and the drop law; the kernel iterates. Null: nothing looped.
   */
  solve?(model: ModelState, ctx: NetworkSolveContext): NetworkSolveProblem | null;
}
