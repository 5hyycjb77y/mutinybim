import { storedField } from "../kinds";
import { TAG_STYLE_CATEGORIES, type TagStyleCategory } from "../organization/model";
import { elementKindTable } from "../registry/element-kind-point";
import type { BimElement, ModelState, Vec2 } from "../types";

/**
 * What tags and auto-tag read about a record of an add-on's kind, from its
 * kind row (contract 1.10.0 / 1.11.0 faces) instead of a kind case: which
 * tag category it is, where it sits, how wide a run is and the size text a
 * size tag prints.
 */

type Elements = ModelState["elements"];

const isTagCategory = (category: string): category is TagStyleCategory => (TAG_STYLE_CATEGORIES as readonly string[]).includes(category);

/** The tag category of an add-on record: the view category its row draws it under, when a tag style can be the default for it; null for a kernel kind, a kind no add-on here registers, or one that isn't tagged. */
export function addOnTagCategory(el: BimElement): TagStyleCategory | null {
  const category = elementKindTable().row(el.kind)?.viewCategory;
  return category !== undefined && isTagCategory(category) ? category : null;
}

/** An add-on record that runs from one point to another (its row's shape has two plan points and its ends pass straight through), with the width its body is drawn at. */
export function addOnRun(el: BimElement): { readonly start: Vec2; readonly end: Vec2; readonly widthMm: number } | null {
  const row = elementKindTable().row(el.kind);
  const ends = row?.connectorEnds;
  if (!row || !ends || ends.hostedBy !== undefined || ends.root === true) return null;
  const points = row.shape?.points?.(el) ?? [];
  const [start, end] = points;
  if (points.length !== 2 || !start || !end) return null;
  const solid = row.solid?.(el, { elements: {}, floorMm: 0 });
  return { start, end, widthMm: solid?.form === "run" ? solid.sizeMm : 0 };
}

/** An add-on record placed at one point that carries a mark (a unit, a device), so a tag can point at it. */
export function addOnMarkedPoint(el: BimElement): Vec2 | null {
  const row = elementKindTable().row(el.kind);
  const points = row?.shape?.points?.(el) ?? [];
  const [at] = points;
  return points.length === 1 && at && typeof storedField(el, "mark") === "string" ? at : null;
}

/** The text an add-on record's tag prints by default (its size, for a run), or null. */
export function addOnTagText(el: BimElement, elements: Elements): string | null {
  return elementKindTable().row(el.kind)?.tagText?.(el, elements) ?? null;
}

/** True when an add-on in force registers the record's kind. */
export function isAddOnRecord(el: BimElement): boolean {
  return elementKindTable().row(el.kind) !== undefined;
}
