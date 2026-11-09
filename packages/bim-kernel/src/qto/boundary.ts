import type { BimElement } from "../types";
import { boundaryFactReads, boundaryFactsIn, BOUNDARY_QUANTITY_KEYS } from "../spaces/boundary-facts";
import type { Space } from "../spaces/types";
import type { MeasureDef } from "./types";

/**
 * A bounded space's boundary quantities on its quantity bag (`qto.boundary.*`):
 * what facets, requirement inputs and tabular space types read like any other
 * measure. From `spaceBoundaryFacts`; a separation line carries no wall.
 * Exterior: an edge with no room beyond it.
 */

type Elements = Readonly<Record<string, BimElement>>;

const K = BOUNDARY_QUANTITY_KEYS;

export const BOUNDARY_MEASURES: readonly MeasureDef[] = [
  { key: K.exteriorLength, kind: "length", unit: "m", from: "edges with no room beyond them", label: "Exterior length" },
  { key: K.exteriorWallArea, kind: "area", unit: "m2", from: "exterior edges × height, less their doors and windows", label: "Exterior wall area" },
  { key: K.interiorWallArea, kind: "area", unit: "m2", from: "edges to another room × height, less their doors and windows", label: "Interior wall area" },
  { key: K.windowArea, kind: "area", unit: "m2", from: "windows in the walls around it", label: "Window area" },
  { key: K.doorCount, kind: "count", unit: "ea", from: "doors in the walls around it", label: "Doors" },
  { key: K.ratedLength, kind: "length", unit: "m", from: "edges whose element carries a rating", label: "Rated length" },
];

/** The boundary quantities of one space (SI); empty for a space not bounded by walls. */
export function boundaryQuantities(elements: Elements, space: Space): Record<string, number> {
  if (space.bounds.kind !== "bounded") return {};
  const out: Record<string, number> = { [K.exteriorLength]: 0, [K.exteriorWallArea]: 0, [K.interiorWallArea]: 0, [K.windowArea]: 0, [K.doorCount]: 0, [K.ratedLength]: 0 };
  const add = (key: string, v: number): void => {
    out[key] = (out[key] ?? 0) + v;
  };
  for (const f of boundaryFactsIn(elements, space)) {
    if (f.virtual) continue;
    const lengthM = f.lengthMm / 1000;
    const openings = f.openings.reduce((s, o) => s + o.areaM2, 0);
    const net = Math.max(0, lengthM * (f.heightMm / 1000) - openings);
    if (f.otherSide.kind === "outside") {
      add(K.exteriorLength, lengthM);
      add(K.exteriorWallArea, net);
    } else add(K.interiorWallArea, net);
    for (const o of f.openings) {
      if (o.label === "Window") add(K.windowArea, o.areaM2);
      if (o.label === "Door") add(K.doorCount, 1);
    }
    if (Object.values(f.ratings).some((r) => r > 0)) add(K.ratedLength, lengthM);
  }
  return out;
}

/** The records the boundary quantities read, so a measure re-runs when a wall or an opening in it changes. */
export function boundaryQuantityReads(elements: Elements, space: Space): string[] {
  return boundaryFactReads(elements, space);
}
