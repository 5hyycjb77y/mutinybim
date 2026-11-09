import type { BimElement, ElementId, Vec2 } from "../../types";
import { boxOf, type Box } from "../space-geometry";
import { boundaryExtent, boundarySegmentsNear, BOUNDARY_GRID_MM } from "./boundary-index";
import { faceAround, SAME_POINT_MM, type FaceFound, type NoFace } from "./face-walk";

/**
 * The closed room around a plan point on a level, from the boundary index.
 * Starts with the cells around the point and widens ring by ring only while
 * the region found could still be cut by a segment outside what was read: a
 * face that sits inside the cells read is exact, because a segment that
 * could cut it would have to be in those cells.
 */

type Elements = Readonly<Record<string, BimElement>>;

const NONE: ReadonlySet<string> = new Set();

export type RoomAt = FaceFound | (NoFace & { readonly segmentsRead: number });

const within = (inner: Box, outer: Box): boolean => inner.minX > outer.minX + SAME_POINT_MM && inner.minY > outer.minY + SAME_POINT_MM && inner.maxX < outer.maxX - SAME_POINT_MM && inner.maxY < outer.maxY - SAME_POINT_MM;
const covers = (outer: Box, inner: Box): boolean => outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;

/** `ignore`: bounding elements that don't bound this trace (the separation lines inside the room being traced). */
/** How many traces ran (perf proofs and tests read the delta). */
export const roomAtStats = { traces: 0 };

export function roomAt(elements: Elements, levelId: ElementId, seed: Vec2, ignore: ReadonlySet<string> = NONE): RoomAt {
  roomAtStats.traces += 1;
  const extent = boundaryExtent(elements, levelId);
  if (!extent) return { ok: false, segmentsRead: 0 };
  const cx = Math.floor(seed.x / BOUNDARY_GRID_MM);
  const cy = Math.floor(seed.y / BOUNDARY_GRID_MM);
  for (let ring = 1; ; ring *= 2) {
    const box: Box = { minX: (cx - ring) * BOUNDARY_GRID_MM, minY: (cy - ring) * BOUNDARY_GRID_MM, maxX: (cx + ring + 1) * BOUNDARY_GRID_MM, maxY: (cy + ring + 1) * BOUNDARY_GRID_MM };
    const near = boundarySegmentsNear(elements, levelId, box);
    const segments = ignore.size === 0 ? near : near.filter((s) => !ignore.has(s.elementId));
    const found = faceAround(segments, seed);
    const all = covers(box, extent);
    if (found.ok && (all || within(boxOf(found.outline), box))) return found;
    if (all) return found.ok ? found : { ...found, segmentsRead: segments.length };
  }
}
