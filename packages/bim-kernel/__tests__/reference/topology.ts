// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { connectionAt, otherEnd } from "./model";
import type { BimElement, ConnectorEnd, ConnectorRef, ElementId, ModelState } from "./types";

/**
 * Tree orientation: every system is a tree rooted at an equipment port.
 * Each kind has a fixed upstream end and downstream ends; taps hang off their
 * host segment through `hostId` rather than a connection.
 */
const DOWNSTREAM_ENDS: Record<BimElement["kind"], readonly ConnectorEnd[]> = {
  equipment: ["out"],
  duct_segment: ["end"],
  tap: ["branch"],
  elbow: ["out"],
  terminal: [],
};

export const UPSTREAM_END: Record<BimElement["kind"], ConnectorEnd | null> = {
  equipment: null,
  duct_segment: "start",
  tap: "host",
  elbow: "in",
  terminal: "in",
};

export function downstreamOf(model: ModelState, id: ElementId): ElementId[] {
  const el = model.elements[id];
  if (!el) return [];
  const out: ElementId[] = [];
  for (const end of DOWNSTREAM_ENDS[el.kind]) {
    const ref: ConnectorRef = { elementId: id, end };
    const c = connectionAt(model, ref);
    if (c) out.push(otherEnd(c, ref).elementId);
  }
  if (el.kind === "duct_segment") {
    for (const other of Object.values(model.elements)) {
      if (other.kind === "tap" && other.hostId === id) out.push(other.id);
    }
  }
  return out;
}

/** True when every non-equipment element is reachable from exactly one equipment root. */
export function findDisconnected(model: ModelState): ElementId[] {
  const reached = new Set<ElementId>();
  const stack: ElementId[] = Object.values(model.elements)
    .filter((el) => el.kind === "equipment")
    .map((el) => el.id);
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reached.has(id)) continue;
    reached.add(id);
    stack.push(...downstreamOf(model, id));
  }
  return Object.values(model.elements)
    .filter((el) => !reached.has(el.id))
    .map((el) => el.id);
}
