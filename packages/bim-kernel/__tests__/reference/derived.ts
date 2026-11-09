// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { downstreamOf } from "./topology";
import { roundVec } from "../../src/geometry";
import { tapPosition } from "./model";
import type { BimElement, ElementId, ModelState } from "./types";

export interface DerivedResult {
  readonly model: ModelState;
  /** Elements whose derived fields changed (never counted as authored intent). */
  readonly changedIds: readonly ElementId[];
}

/**
 * Recompute every derived value from authored values: tap world positions
 * (from host + s) and airflow totals (sum of terminals served). Derived values
 * always recompute against the latest state and are never typed in.
 */
export function recomputeDerived(model: ModelState): DerivedResult {
  const next: Record<string, BimElement> = { ...model.elements };
  const changed = new Set<ElementId>();

  for (const el of Object.values(model.elements)) {
    if (el.kind !== "tap") continue;
    const host = model.elements[el.hostId];
    if (!host || host.kind !== "duct_segment") continue;
    const position = roundVec(tapPosition(host, el));
    if (position.x !== el.position.x || position.y !== el.position.y) {
      next[el.id] = { ...el, position };
      changed.add(el.id);
    }
  }

  const withTaps: ModelState = { ...model, elements: next };
  const flows = computeAirflow(withTaps);
  for (const [id, cfm] of flows) {
    const el = next[id];
    if (!el) continue;
    if (el.kind === "duct_segment" && el.flowCfm !== cfm) {
      next[id] = { ...el, flowCfm: cfm };
      changed.add(el.id);
    } else if (el.kind === "equipment" && el.totalCfm !== cfm) {
      next[id] = { ...el, totalCfm: cfm };
      changed.add(el.id);
    }
  }

  return { model: { ...model, elements: next }, changedIds: [...changed] };
}

/**
 * Airflow per element: the sum of terminal CFM downstream of it in the tree
 * rooted at the equipment. Supply flows away from the unit; return / exhaust
 * flow toward it, but the magnitude served is the same sum.
 */
export function computeAirflow(model: ModelState): Map<ElementId, number> {
  const totals = new Map<ElementId, number>();
  const visiting = new Set<ElementId>();

  const visit = (id: ElementId): number => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const el = model.elements[id];
    let sum = el && el.kind === "terminal" ? el.cfm : 0;
    for (const child of downstreamOf(model, id)) sum += visit(child);
    totals.set(id, sum);
    return sum;
  };

  for (const el of Object.values(model.elements)) {
    if (el.kind === "equipment") visit(el.id);
  }
  // Make sure orphaned pieces still get a value (0 or their own terminals).
  for (const el of Object.values(model.elements)) {
    if (!totals.has(el.id)) visit(el.id);
  }
  return totals;
}
