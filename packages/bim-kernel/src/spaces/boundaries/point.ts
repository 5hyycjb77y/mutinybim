import type { PackRefusal } from "../../packs/points";
import type { ElementId, ModelState } from "../../types";
import { ratingKindRow } from "../../registry/rating-kind-point";
import { boundarySegmentsOfLevel, ratedSegmentsNearIn } from "./boundary-index";
import type { BoundarySegment } from "./rows";

/**
 * Bounding elements (contract 1.11.0, `kernel.bounding_element` v1): the
 * point and its row readers live in `rows.ts`; the per-level boundary index
 * that answers this reader in `boundary-index.ts`.
 */

export * from "./rows";

/**
 * Rated element segments near a box on a level (contract 1.12.0): every
 * segment of an element rated for `ratingKind`, whether or not it bounds
 * rooms, so route checks see a rated wall set not to bound rooms. Read from
 * a per-level grid carried by changed ids (`boundary-index.ts`), never a
 * model scan. Refuses a rating kind no add-on in force gives.
 */
export function ratedSegmentsNear(
  model: ModelState,
  levelId: ElementId,
  box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number },
  ratingKind: string,
): readonly BoundarySegment[] | PackRefusal {
  if (!ratingKindRow(ratingKind)) return { refused: `No add-on in force gives the rating kind ${ratingKind}` };
  return ratedSegmentsNearIn(model.elements, levelId, box, ratingKind);
}

/** Every room-bounding segment on a level, by element id, from the boundary index (empty when nothing bounds there). */
export function boundarySegmentsOnLevel(model: ModelState, levelId: ElementId): readonly BoundarySegment[] | PackRefusal {
  return boundarySegmentsOfLevel(model.elements, levelId);
}
