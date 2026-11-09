import { elementsOfKind } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { childrenOf } from "./nesting";
import type { SpaceSeparator } from "./types";

/**
 * Space separation lines (contract 1.11.0, feature `spaces:separators`).
 * The stored shape is `SpaceSeparator` (`spaces/types.ts`). Drawing, split
 * and merge are lane A13b's; a peer that doesn't advertise the feature is
 * never sent one.
 */

export const SPACES_SEPARATORS_FEATURE = "spaces:separators";

export function isSpaceSeparator(el: BimElement | undefined): el is SpaceSeparator {
  return el !== undefined && el.kind === "space_separator";
}

/** The separation lines on one level, in id order. */
export function separatorsOnLevel(model: ModelState, levelId: string): SpaceSeparator[] {
  return elementsOfKind(model.elements, "space_separator")
    .filter((s) => s.levelId === levelId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The separation lines inside a space: the ones that split it or any space
 * nested in it. A trace of the space itself ignores them, so a parent keeps
 * its whole outline while its sub-rooms are bounded by the lines.
 */
export function separatorsInside(elements: Readonly<Record<string, BimElement>>, spaceId: ElementId): Set<ElementId> {
  const splitting = elementsOfKind(elements, "space_separator").filter((s) => s.splits !== undefined);
  if (splitting.length === 0) return new Set();
  const within = new Set<string>([spaceId]);
  const stack: ElementId[] = [spaceId];
  while (stack.length > 0) {
    const id = stack.pop() as ElementId;
    for (const c of childrenOf(elements, id)) {
      if (within.has(c.id)) continue;
      within.add(c.id);
      stack.push(c.id);
    }
  }
  return new Set(splitting.filter((s) => s.splits !== undefined && within.has(s.splits)).map((s) => s.id));
}
