import { type BimElement, type ElementId, type Command, elementsOfKind, catalogElementId, devicePartOf, isAreaEstimate, loadAnchorOf, allocateServedBy, allocationClassOf, loadValueOf, loadIndexOf, allocationPolicyOf, LOAD_POLICY_NAME, modelSpaceLocator, combineNode, type ElectricalLoadClass, type LoadPointElement } from "@permitzip/bim-kernel";
import { EMPTY_INVENTORY, inventoryMonoid, memberInventory, type Inventory } from "./inventory";
import { loadClassLabel, parseLoadClass } from "./loads";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Loads that name a piece of distribution equipment as their source before
 * anything is circuited (ROADMAP E1: "lighting 5 kW, receptacles 2 kW" on the
 * service during schematic design). They count in that equipment's connected
 * load, and so in everything above it, like a circuit would:
 *
 * - an estimate on a space or zone counts what the allocation policy says is
 *   still uncovered by the real loads inside it (policy `max`: the estimate
 *   until the devices exceed it), so an estimate and its devices never count
 *   twice;
 * - a real load (a typed row, a load point, a device's load) counts itself,
 *   unless its device is already on an electrical circuit, which counts it.
 *
 * The allocation is the requirements engine's (`allocateServedBy`); nothing
 * is recomputed here but which share is not already on a circuit.
 */

export interface EstimateShare {
  /** The loads this share stands for (an estimate group, or one real load). */
  readonly loadIds: readonly ElementId[];
  /** "Lighting estimate", "RTU-1 (load, not circuited)". */
  readonly label: string;
  readonly loadClass: ElectricalLoadClass;
  readonly va: number;
  readonly kind: "estimate" | "load";
}

export interface NodeEstimates {
  readonly shares: readonly EstimateShare[];
  readonly inventory: Inventory;
  readonly va: number;
}

const POLICY_ID = catalogElementId("load_policy", LOAD_POLICY_NAME);

function classOf(elements: Elements, lp: Parameters<typeof allocationClassOf>[1]): ElectricalLoadClass {
  const cls = allocationClassOf(elements, lp);
  return (cls ? parseLoadClass(cls) : null) ?? "other";
}

/** A device already on an electrical circuit: the circuit counts its load. */
function circuited(elements: Elements, partId: string | null): boolean {
  if (!partId) return false;
  const part = elements[partId];
  if (part?.kind !== "part") return false;
  return Object.values(part.served ?? {}).some((linkId) => {
    const link = elements[linkId];
    return link?.kind === "service_link" && link.trade === "electrical";
  });
}

/**
 * What the loads naming `nodeId` add at that node, spread evenly over its
 * `phaseCount` phases; null when nothing names it. Every record read is pushed
 * onto `deps` so the engine's cache knows when to read again.
 */
export function estimatesAt(elements: Elements, nodeId: string, phaseCount: number, deps: Array<readonly [string, BimElement | undefined]>): NodeEstimates | null {
  const ids = loadIndexOf(elements).servedBy(nodeId);
  if (ids.length === 0) return null;
  deps.push([POLICY_ID, elements[POLICY_ID]]);
  const loads: LoadPointElement[] = [];
  for (const id of ids) {
    const lp = elements[id];
    deps.push([id, lp]);
    if (lp?.kind !== "load_point") continue;
    loads.push(lp);
    if (lp.connectionType) {
      const ctId = catalogElementId("connection_type", lp.connectionType);
      deps.push([ctId, elements[ctId]]);
    }
    const anchor = loadAnchorOf(lp);
    if (anchor.kind === "space" || anchor.kind === "zone") deps.push([anchor.id, elements[anchor.id]]);
    const part = devicePartOf(lp);
    if (part) deps.push([part, elements[part]]);
  }
  if (loads.length === 0) return null;
  const locator = modelSpaceLocator(elements);
  const allocation = allocateServedBy(elements, nodeId, locator, allocationPolicyOf(elements));
  const shares: EstimateShare[] = [];
  for (const g of allocation.groups) {
    const uncovered = g.figures.counted.va - g.figures.actual.va;
    if (uncovered <= 1e-6) continue;
    const first = elements[g.estimateIds[0] ?? ""];
    const loadClass = first?.kind === "load_point" ? classOf(elements, first) : "other";
    shares.push({ loadIds: g.estimateIds, label: `${loadClassLabel(loadClass)} estimate`, loadClass, va: uncovered, kind: "estimate" });
  }
  for (const lp of loads) {
    if (isAreaEstimate(lp) || circuited(elements, devicePartOf(lp))) continue;
    const va = loadValueOf(elements, lp, locator).va;
    if (va <= 0) continue;
    const loadClass = classOf(elements, lp);
    shares.push({ loadIds: [lp.id], label: `${lp.mark || lp.connectionType || loadClassLabel(loadClass)} (not on a circuit)`, loadClass, va, kind: "load" });
  }
  if (shares.length === 0) return { shares, inventory: EMPTY_INVENTORY, va: 0 };
  const phases = Array.from({ length: Math.max(1, phaseCount) }, (_, i) => i);
  const inventory = combineNode(
    undefined,
    shares.map((s) => memberInventory({ elementId: s.loadIds[0] ?? nodeId, connector: "", name: s.label, va: s.va, loadClass: s.loadClass, continuous: false, classFrom: "connection_type", from: "connection_type" }, phases)),
    inventoryMonoid,
  );
  return { shares, inventory, va: inventory.va };
}

export interface UnassignedEstimate {
  readonly loadId: ElementId;
  /** "Lighting estimate (Kitchen)". */
  readonly label: string;
  readonly va: number;
}

/**
 * Electrical estimates on spaces and zones that name no source yet: nothing
 * counts them at a panel or the service. Indexed read of the load points.
 */
export function unassignedElectricalEstimates(elements: Elements): UnassignedEstimate[] {
  const locator = modelSpaceLocator(elements);
  const out: UnassignedEstimate[] = [];
  for (const lp of elementsOfKind(elements, "load_point")) {
    if (lp.servedBy || !isAreaEstimate(lp)) continue;
    const va = loadValueOf(elements, lp, locator).va;
    if (va <= 0) continue;
    const anchor = loadAnchorOf(lp);
    const scope = anchor.kind === "space" || anchor.kind === "zone" ? elements[anchor.id] : undefined;
    const where = scope?.kind === "space" || scope?.kind === "zone" ? ` (${scope.name})` : "";
    out.push({ loadId: lp.id, label: `${loadClassLabel(classOf(elements, lp))} estimate${where}`, va });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || (a.loadId < b.loadId ? -1 : 1));
}

/** One undo step: these estimates name `nodeId` as their source, so it counts them. */
export function countEstimatesAtCommand(nodeId: string, nodeName: string, loadIds: readonly string[]): Command | null {
  if (loadIds.length === 0) return null;
  return {
    type: "batch_edits",
    label: `Count ${loadIds.length} estimate${loadIds.length === 1 ? "" : "s"} on ${nodeName}`,
    commands: loadIds.map((loadId) => ({ type: "edit_load_point" as const, loadId, servedBy: nodeId })),
  };
}
