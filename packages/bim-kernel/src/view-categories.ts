import type { ViewCategory } from "./documents";
import { elementLook, partCategoryViewCategory } from "./categories/element";
import { categoryLook } from "./categories/resolve";
import type { BimElement, ModelState, ViewElement } from "./types";

/**
 * Which view category a placed part draws under, from its part type: the
 * electrical trades get their own (devices, lighting fixtures, panels and
 * electrical equipment) so a view can switch them off and set their pens.
 * Other parts keep their earlier categories. The answer is the category
 * registry's (`categories/registry.ts`, `CLASS_VIEW_CATEGORY`); visibility
 * reads the one resolver (`categories/resolve.ts`).
 */

/** The view category of a part (by its type), or null for anything that is not a placed part. */
export function partViewCategory(model: Pick<ModelState, "elements">, el: BimElement): ViewCategory | null {
  return partCategoryViewCategory(model.elements, el);
}

/** The view switched this part's category off (Categories shown, or Visibility/Graphics). */
export function partHiddenInView(model: Pick<ModelState, "elements">, view: Pick<ViewElement, "props">, el: BimElement): boolean {
  if (el.kind !== "part" || partViewCategory(model, el) === null) return false;
  return !elementLook(model, view, el).visible;
}

/** The view switched duct and pipe insulation off. */
export function insulationHiddenInView(view: Pick<ViewElement, "props">): boolean {
  return !categoryLook(view, "insulation").visible;
}
