import { cleanOutline, containsPoint, outlineFault, type OutlineFault } from "../spaces/space-geometry";
import type { Vec2 } from "../types";

/**
 * The checks a ceiling's outline has to pass, in one place: the ceiling
 * commands refuse an outline that fails them, and the import leaves a product
 * whose outline fails them on the linked model. Each caller puts its own
 * words to the fault.
 */

export interface CheckedOutline<Fault extends string = OutlineFault> {
  /** The outline as a ceiling keeps it: repeated corners and a closing point dropped. */
  readonly outline: Vec2[];
  readonly fault: Fault | null;
}

/** A ceiling's outline as it is kept, and what stops it being one (crosses itself, covers almost nothing). */
export function checkCeilingOutline(points: readonly Vec2[]): CheckedOutline {
  const outline = cleanOutline(points);
  return { outline, fault: outlineFault(outline) };
}

/** What is wrong with a hole: what is wrong with any outline, or that it reaches outside the ceiling. */
export type HoleFault = OutlineFault | "outside";

/** A hole as it is kept, and what stops it being one: not an outline, or not wholly inside the ceiling's own. */
export function checkCeilingHole(points: readonly Vec2[], around: readonly Vec2[]): CheckedOutline<HoleFault> {
  const { outline, fault } = checkCeilingOutline(points);
  return { outline, fault: fault ?? (outline.every((p) => containsPoint(around, p)) ? null : "outside") };
}
