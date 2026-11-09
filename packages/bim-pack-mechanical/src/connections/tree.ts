import { computeTreeTotals, readKindValue, type BimElement, type ElementId, type ModelState, type TreeNetworkFace, type TreeTapHost, type TreeTotal } from "@permitzip/bim-kernel";
import { segmentLength, tapPosition } from "../types";
import { AIRFLOW_KEY, DUCT_AIRFLOW, TERMINAL_AIRFLOW, UNIT_AIRFLOW, carriesAir, withAirflow } from "../kinds";

/**
 * The air side of the connected-element tree (the kernel's tree-network
 * hook, `NetworkAdapterItem.tree`): duct segments host taps, a tap sits on
 * the duct's face at `s` along its centreline, and the tree totals airflow.
 *
 * Airflow per network element is the sum of air terminals' design values
 * downstream of it in the tree rooted at the unit. Supply flows away from the
 * unit; return and exhaust flow toward it, but the magnitude served is the
 * same sum. Ducts and units keep it as their airflow (`kinds.ts`). Only what
 * carries air counts and keeps it: a pipe on the same tree adds nothing.
 */

/** Taps hang on duct segments, on the side of the duct face their `side` names. */
export const DUCT_TAP_HOST: TreeTapHost = {
  kind: "duct_segment",
  place: (host, tap) => (host.kind === "duct_segment" ? tapPosition(host, tap) : null),
  span: (host) => (host.kind === "duct_segment" ? segmentLength(host) : null),
};

function own(el: BimElement): number | undefined {
  return el.kind === "terminal" && carriesAir(el) ? (readKindValue(el, TERMINAL_AIRFLOW) ?? undefined) : undefined;
}

function stored(el: BimElement): number | undefined {
  if (!carriesAir(el)) return undefined;
  if (el.kind === "duct_segment") return readKindValue(el, DUCT_AIRFLOW) ?? undefined;
  if (el.kind === "equipment") return readKindValue(el, UNIT_AIRFLOW) ?? undefined;
  return undefined;
}

/** Airflow: air terminals' design values summed toward the unit. */
export const AIRFLOW_TOTAL: TreeTotal = {
  id: AIRFLOW_KEY,
  ownKinds: ["terminal"],
  own,
  storedKinds: ["duct_segment", "equipment"],
  stored,
  withTotal(el: BimElement, total: number): BimElement {
    if (el.kind === "duct_segment" || el.kind === "equipment") return withAirflow(el, total);
    const message = `[bim-pack-mechanical] airflow can't be kept on a ${el.kind}`;
    console.error(message, { id: el.id });
    throw new Error(message);
  },
};

export const AIR_TREE: TreeNetworkFace = { tapHosts: [DUCT_TAP_HOST], totals: [AIRFLOW_TOTAL] };

/** Airflow per network element (see above). Walls, rooms, annotations and other elements outside the network have no entry. */
export function computeAirflow(model: ModelState): Map<ElementId, number> {
  return computeTreeTotals(model, AIRFLOW_TOTAL);
}
