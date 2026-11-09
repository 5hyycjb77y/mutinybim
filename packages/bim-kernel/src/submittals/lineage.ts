import type { LineageDifference, ReviewOutcomeId } from "../lineages/types";
import type { BimElement } from "../types";
import { submittalsIn } from "./records";
import type { SubmittalElement } from "./types";

/**
 * Submittals over a `submittal` lineage's delta (round 11, D1). The
 * submittal record stays the transmittal and the per-item review; the
 * products and drawings are the copy itself. Old submittals (no `lineageId`)
 * read exactly as before.
 */

/** What a person reads where round 9 said "Update design to match": the overlay's edit on the design that cites the difference. */
export const MATCHED_IN_DESIGN_WORDS = "Change the design to match";

/** The copy and delta a submittal transmits, or null for a submittal that isn't over a copy. */
export function submittalLineage(s: SubmittalElement): { readonly lineageId: string; readonly deltaDigest: string } | null {
  const { lineageId, deltaDigest } = s.submittal;
  return lineageId !== undefined && deltaDigest !== undefined ? { lineageId, deltaDigest } : null;
}

/** Submittals that transmit a given copy, by id. */
export function submittalsForLineage(elements: Readonly<Record<string, BimElement>>, lineageId: string): SubmittalElement[] {
  return submittalsIn(elements)
    .filter((s) => s.submittal.lineageId === lineageId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const APPROVING: ReadonlySet<string> = new Set<ReviewOutcomeId>(["approved", "approved_as_noted"]);

/**
 * A copy's divergences: differences a review approved (as is, or as noted)
 * that were neither accepted back nor matched in the design. The design is
 * not changed by any of them. A review that didn't approve has none.
 */
export function lineageDivergences(differences: readonly LineageDifference[], outcome: ReviewOutcomeId): readonly LineageDifference[] {
  if (!APPROVING.has(outcome)) return [];
  return differences.filter((d) => d.change !== "unchanged" && d.settled === undefined);
}
