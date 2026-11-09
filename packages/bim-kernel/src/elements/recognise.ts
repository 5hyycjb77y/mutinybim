import { BUILDING_FALLBACK_CLASS_ID, builtinRegistry, PART_CATEGORY_CLASSES } from "../registry/builtin";
import { recognizes } from "../registry/recognition";
import type { ClassId, ObjectClass, Registry } from "../registry/types";
import { isKnownPartCategory } from "../parts";
import type { BimElement } from "../types";
import type { CoreElement, ElementCoreKind } from "./feature";

/**
 * The class a stored element is recognised as by the kernel's built-in
 * registry. Built-in only on purpose: the upgrade on edit must write the same
 * `classId` on every peer, whatever packs a host has loaded; a pack's own
 * classes refine it by recognition at read time, or by an explicit set.
 */

let byKind: { readonly registry: Registry; readonly map: ReadonlyMap<string, readonly ObjectClass[]> } | null = null;

function candidates(kind: ElementCoreKind): readonly ObjectClass[] {
  const registry = builtinRegistry();
  if (byKind?.registry !== registry) {
    const m = new Map<string, ObjectClass[]>();
    for (const cls of registry.listClasses()) {
      // The fallback is read-time only: a stored class is always the add-on's (or none), so turning the add-on on never rewrites it.
      if (cls.abstract || cls.id === BUILDING_FALLBACK_CLASS_ID) continue;
      for (const k of cls.recognize?.elementKinds ?? []) {
        const list = m.get(k);
        if (list) list.push(cls);
        else m.set(k, [cls]);
      }
    }
    byKind = { registry, map: m };
  }
  return byKind.map.get(kind) ?? [];
}

const NO_ELEMENTS: Readonly<Record<string, BimElement>> = {};

/** The built-in class this element is, or null when none recognises it (an opening type this release doesn't know). Classes with conditions win over a kind-only class. */
export function builtinClassOf(el: CoreElement): ClassId | null {
  let kindOnly: ClassId | null = null;
  for (const cls of candidates(el.kind)) {
    if (!recognizes(cls, el, NO_ELEMENTS)) continue;
    if ((cls.recognize?.where?.length ?? 0) > 0) return cls.id;
    kindOnly ??= cls.id;
  }
  return kindOnly;
}

/** The class a part category's parts are, a category this release doesn't know reading as a generic model (kept as stored, never rewritten). */
export function partCategoryClass(category: string): ClassId {
  return isKnownPartCategory(category) ? PART_CATEGORY_CLASSES[category] : PART_CATEGORY_CLASSES.generic;
}
