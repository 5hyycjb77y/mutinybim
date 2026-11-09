import { networkOf } from "./network";
import type { ElementId, ModelState } from "./types";

export { downstreamEndsOf, upstreamEndOf } from "./network";

export function downstreamOf(model: ModelState, id: ElementId): ElementId[] {
  if (!model.elements[id]) return [];
  return [...networkOf(model).children(id)];
}

/** Network elements not reachable from any tree root (a kind row says which kinds start a tree). */
export function findDisconnected(model: ModelState): ElementId[] {
  return [...networkOf(model).disconnected()];
}
