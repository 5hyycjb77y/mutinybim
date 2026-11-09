import { referenceMayWinPick, type ReferenceTone } from "./reference-tone";

/** Distances closer than this (scene metres) are the same surface: a pipe flush on a wall stays ours. */
const SAME_SURFACE_M = 0.002;

/**
 * Is an authored element hidden behind a linked model's surface? Hover and
 * grabs must follow what the person sees: pointing at the architect's pipe
 * must not name, highlight or drag the supply duct behind it (review video V1
 * 2:03: "the little tool tips says duct but it's not a duct"). A receded
 * (halftone or see-through) linked model never hides our own work, the same
 * rule a click uses.
 */
export function nativeHiddenByLinked(front: { readonly distance: number; readonly linked: { readonly referenceId: string } | null } | null, nativeDistance: number, toneOf: (referenceId: string) => ReferenceTone): boolean {
  if (!front?.linked) return false;
  if (!referenceMayWinPick(toneOf(front.linked.referenceId), true)) return false;
  return front.distance < nativeDistance - SAME_SURFACE_M;
}
