import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { BimElement, PartInstance } from "../types";
import { loadPointAt, loadPointLoad, loadPointsOnHost } from "./model";

type Elements = Readonly<Record<string, BimElement>>;
/** A run graph node: a run element id, a load point id, or `part#connector`. */
type Node = string;

/**
 * Loads from load points, for the run walks (routing/derive.ts segment flow,
 * the pipe hydraulics reports, connections/network.ts engine). One
 * implementation so a pipe's flow, its report and its "Carries…" line agree.
 */

/** Run graph neighbours a run element gains from load points on its ends and ports. */
export function loadPointNeighbours(elements: Elements, hostId: string): Node[] {
  return loadPointsOnHost(elements, hostId).map((lp) => lp.id);
}

/** Does a load point sit on this open end, so the end is a fixture, not a loose pipe end? */
export function endHasLoadPoint(elements: Elements, hostId: string, port: string): boolean {
  return loadPointAt(elements, hostId, port) !== null;
}

export interface LoadTree {
  readonly order: readonly Node[];
  readonly parent: ReadonlyMap<Node, Node | null>;
}

export interface LoadPointLoads {
  /** Own load per node: load points, and what network couplings add (what crosses a coupler, an adjustment where its two sides meet). */
  readonly own: ReadonlyMap<Node, number>;
  /** Parts attached to a load point in this walk: the point counts, so the part must not count again. */
  readonly attachedParts: ReadonlySet<string>;
  /** Load points read (their values change the totals). */
  readonly loadPointIds: readonly string[];
  /** Elements on the other side of a coupler that were read. */
  readonly alsoRead: readonly string[];
}

const isPartNode = (n: Node) => n.includes("#");

function component(elements: Elements, start: Node, neighbours: (n: Node) => readonly Node[]): Node[] {
  const seen = new Set<Node>([start]);
  const stack = [start];
  const out: Node[] = [];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    out.push(n);
    for (const m of neighbours(n)) {
      if (seen.has(m) || (!isPartNode(m) && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return out;
}

/**
 * Everything one connector of a part reaches without coming back through the
 * part: the run graph beyond a coupler's outlet, a pump's discharge. Coupling
 * carries and the `serves` relationship (fields/providers) both read it, so
 * what a coupler serves is what its inlet carries.
 */
export function componentBeyond(elements: Elements, partId: string, start: Node, neighbours: (n: Node) => readonly Node[]): Node[] {
  return component(elements, start, (x) => neighbours(x).filter((y) => !y.startsWith(`${partId}#`)));
}

/** What a coupling adds to one walked tree's own loads (`NetworkCouplingDef.carry`). */
export interface CouplingCarry {
  readonly elements: Elements;
  readonly tree: LoadTree;
  /** The walked system's kind, or null when the walk has none. */
  readonly systemKind: string | null;
  readonly neighbours: (n: Node) => readonly Node[];
  /** Own load per node so far (load points); a carry adds to it. */
  readonly own: Map<Node, number>;
  /** Elements beyond a coupler that the carry read; a carry appends to it. */
  readonly alsoRead: string[];
}

/**
 * A part that joins two systems (v1): the source of one and a load on the
 * other (a heat exchanger, a pump skid, a transformer). `isOutlet` says which
 * of its connectors feed the system they are on (the walk's root, as a meter
 * or panel is); `carry` adds what crosses it to a walked tree's own loads.
 */
export interface NetworkCouplingDef {
  readonly id: string;
  couples(elements: Elements, part: PartInstance): boolean;
  isOutlet(elements: Elements, part: PartInstance, connectorId: string): boolean;
  carry?(input: CouplingCarry): void;
}

/** Network couplings (`kernel.network_coupling`, contract 1.3.0), read by the run walks and `serves`. No built-ins: a trade's couplers are its add-on's. */
export const NETWORK_COUPLING_POINT = defineExtensionPoint<NetworkCouplingDef>({ id: "kernel.network_coupling", version: 1, label: "Network couplings", idOf: (r) => r.id });

/** The couplings of the set in force. */
export function networkCouplings(): readonly NetworkCouplingDef[] {
  return activePackSet().items(NETWORK_COUPLING_POINT);
}

/** Whether a part joins two systems under the set in force. */
export function isCouplerPart(elements: Elements, part: PartInstance, couplings: readonly NetworkCouplingDef[] = networkCouplings()): boolean {
  return couplings.some((c) => c.couples(elements, part));
}

/** Whether a part's connector is a coupler's outlet: where the system it is on is fed from. */
export function isCouplingOutlet(elements: Elements, part: PartInstance, connectorId: string, couplings: readonly NetworkCouplingDef[] = networkCouplings()): boolean {
  return couplings.some((c) => c.isOutlet(elements, part, connectorId));
}

/** Own loads from load points for one walked tree, then what each coupling in the set carries into it. */
export function loadPointLoads(elements: Elements, tree: LoadTree, systemKind: string | null, neighbours: (n: Node) => readonly Node[]): LoadPointLoads {
  const own = new Map<Node, number>();
  const attached = new Set<string>();
  const ids: string[] = [];
  const alsoRead: string[] = [];
  for (const n of tree.order) {
    const el = elements[n];
    if (el?.kind !== "load_point") continue;
    ids.push(el.id);
    own.set(n, loadPointLoad(elements, el));
    if (el.attachedPartId) attached.add(el.attachedPartId);
  }
  for (const coupling of networkCouplings()) coupling.carry?.({ elements, tree, systemKind, neighbours, own, alsoRead });
  return { own, attachedParts: attached, loadPointIds: ids, alsoRead };
}
