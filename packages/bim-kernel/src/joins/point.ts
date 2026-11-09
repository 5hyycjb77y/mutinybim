import type { PackRefusal } from "../packs/points";
import type { ElementId, ModelState } from "../types";
import type { EndCleanup } from "./contract";
import { lineJoinsOf } from "./solve";

/**
 * Line-element joins (contract 1.11.0, `kernel.line_join` v1): the point,
 * its rows and the end-cleanup shape are in `contract.ts`; the kernel's own
 * rows in `rows.ts`; the endpoint index and solve in `solve.ts`.
 */

export * from "./contract";

/** One element's two end cleanups (start, then end). Refused, in words, for an element that isn't drawn on a line that joins. */
export function endCleanupsOf(model: ModelState, id: ElementId): readonly EndCleanup[] | PackRefusal {
  const joins = lineJoinsOf(model.elements, id);
  if (joins) return joins.cleanups;
  const el = model.elements[id];
  return { refused: el ? `${id} doesn't join others: no add-on in this model says how a ${el.kind.replace(/_/g, " ")}'s ends meet` : `There is no element ${id} in this model` };
}
