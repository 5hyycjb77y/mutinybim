import { kindRowOf } from "../kinds/rows";
import { ARCHITECTURE_MANIFEST } from "../packs/first-party/manifests";
import { activeClassRegistry } from "../registry";
import { BUILDING_FALLBACK_CLASS_ID, BUILDING_FALLBACK_KINDS } from "../registry/builtin";
import { recognizes } from "../registry/recognition";
import type { BimElement } from "../types";

/**
 * With the building add-on off, walls, doors and the rest keep the kernel's
 * fallback class: they still draw, join, cut and bound rooms, and say where
 * their types and rules would come from.
 */

type Elements = Readonly<Record<string, BimElement>>;

const FALLBACK_KINDS: ReadonlySet<string> = new Set(BUILDING_FALLBACK_KINDS);

/** What one element is called in the note ("wall", "door"). */
function noun(el: BimElement): string {
  if (el.kind === "opening") return el.openingType === "door" || el.openingType === "window" ? el.openingType : "opening";
  return (kindRowOf(el.kind)?.label ?? el.kind).toLowerCase();
}

/** True when only the fallback class recognises `el` in the set in force (no add-on gives it a class). */
export function onlyFallbackClass(el: BimElement, elements: Elements): boolean {
  if (!FALLBACK_KINDS.has(el.kind)) return false;
  for (const cls of activeClassRegistry().listClasses()) {
    if (cls.abstract || cls.id === BUILDING_FALLBACK_CLASS_ID) continue;
    if (recognizes(cls, el, elements)) return false;
  }
  return true;
}

/** The note an Inspector shows on such an element, or null when an add-on gives it a class. */
export function addonOffNote(el: BimElement, elements: Elements): string | null {
  return onlyFallbackClass(el, elements) ? `Types and rules for this ${noun(el)} come from the ${ARCHITECTURE_MANIFEST.name} add-on, which isn't on` : null;
}
