import { localBounds, resolveConnectors, resolveGeometry, type PartTypeDefinition } from "../parts";
import { definitionTypes } from "./types-table";

/**
 * Where a connector can't take a run, as warnings (a part that breaks them
 * still saves): below the part's base, off its body, inside one of its solid
 * pieces, or on its outline facing into it (a run would go through the body).
 *
 * Solid pieces are each piece's bounding box (a modeled part's join features,
 * or a plain part's primitives); cuts are not subtracted. So an opening at the
 * bottom of a hollow curb, or at the cabinet's bottom face looking down into
 * the curb, passes; a connector strictly inside a piece's box (even inside a
 * hollow piece's open middle) is flagged.
 */

const MM_PER_IN = 25.4;
const SLACK_MM = 1;
const inch = (mm: number) => Math.round((mm / MM_PER_IN) * 100) / 100;

export interface PlacementBox {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface PlacedConnectorFrame {
  readonly label: string;
  readonly position: readonly number[];
  readonly direction: readonly number[];
}

/** How deep a point lies inside a box (distance to its nearest face), or null when it isn't strictly inside. */
function depthInside(p: readonly number[], b: PlacementBox): number | null {
  let depth = Infinity;
  for (let i = 0; i < 3; i++) {
    const v = p[i] ?? 0;
    const d = Math.min(v - (b.min[i] ?? 0), (b.max[i] ?? 0) - v);
    if (d <= SLACK_MM) return null;
    depth = Math.min(depth, d);
  }
  return depth;
}

/**
 * Warnings for one size. `box` is the part's overall box; `pieces` its solid
 * pieces (leave out to check against the overall box only).
 */
export function connectorPlacementWarnings(size: string, box: PlacementBox, connectors: readonly PlacedConnectorFrame[], pieces: readonly PlacementBox[] = []): string[] {
  const out: string[] = [];
  if (![...box.min, ...box.max].every(Number.isFinite)) return out;
  for (const c of connectors) {
    const [x = 0, y = 0, z = 0] = c.position;
    const baseZ = box.min[2] ?? 0;
    if (z < baseZ - SLACK_MM) {
      out.push(`${size}: ${c.label} is ${inch(baseZ - z)} in below the part's base; connectors sit on the part.`);
      continue;
    }
    const within = [x, y, z].every((v, i) => v >= (box.min[i] ?? 0) - SLACK_MM && v <= (box.max[i] ?? 0) + SLACK_MM);
    if (!within) {
      const off = Math.hypot(...[x, y, z].map((v, i) => Math.max((box.min[i] ?? 0) - v, 0, v - (box.max[i] ?? 0))));
      out.push(`${size}: ${c.label} is ${inch(off)} in off the part's body; connectors sit on a face of the part.`);
      continue;
    }
    const buried = pieces.map((piece) => depthInside(c.position, piece)).filter((d): d is number => d !== null);
    if (buried.length > 0) {
      out.push(`${size}: ${c.label} is inside the part's body (${inch(Math.max(...buried))} in from the nearest face), so a run would start inside it; put it on a face, pointing out.`);
      continue;
    }
    // How far the connector looks into the part along its own direction, against the part's depth that way.
    let reach = Infinity;
    let depth = 0;
    [x, y, z].forEach((v, i) => {
      const d = c.direction[i] ?? 0;
      const lo = box.min[i] ?? 0;
      const hi = box.max[i] ?? 0;
      if (Math.abs(d) < 1e-6) return;
      reach = Math.min(reach, d > 0 ? (hi - v) / d : (lo - v) / d);
      depth += Math.abs(d) * (hi - lo);
    });
    if (reach > depth / 2) out.push(`${size}: ${c.label} faces into the part (${inch(reach)} in of body ahead of it), so a run would go through it; put it on a face, pointing out.`);
  }
  return out;
}

/** Connector placement warnings for every size of a part definition, checked against each size's solid pieces. */
export function partConnectorWarnings(def: PartTypeDefinition): string[] {
  return definitionTypes(def).flatMap(({ definition }) => {
    const prims = resolveGeometry(definition);
    return connectorPlacementWarnings(definition.typeName, localBounds(prims), resolveConnectors(definition), prims.map((p) => localBounds([p])));
  });
}
