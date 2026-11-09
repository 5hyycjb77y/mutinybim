import { documentIndex } from "../commands/views";
import type { DrawingItem } from "../documents";
import type { ModelState, Vec2, ViewElement } from "../types";
import { tagHasLeader, tagItemBox, tagTarget, type TagSpec } from "./annotations";
import { annotationBoxes, paperMapping } from "./auto-tag";
import { elbowLeaderPath, placeTagsClear, type ElbowLeader, type PlaceTagsOptions, type ElbowTagRequest } from "./elbow-leader";

/**
 * Spread tags (U9): move the chosen tags of a view so none overlaps another
 * tag, note or dimension and no leader crosses another, each with an elbow
 * leader. Everything not chosen stays exactly where it is, and a chosen tag
 * whose elbow was placed by hand is kept as it is: a hand placement always
 * wins. Pure: the caller sends the result as one batch of item updates.
 */


function tagView(model: ModelState, viewId: string): ViewElement {
  const view = model.elements[viewId];
  if (view?.kind !== "view" || view.deleted) throw new Error(`View ${viewId} does not exist`);
  if (view.viewType !== "floor_plan" && view.viewType !== "ceiling_plan" && view.viewType !== "section") throw new Error("Tags go in plans and sections, which show the model.");
  return view;
}

export interface TagSpreadUpdate {
  readonly itemId: string;
  /** New head, view frame mm (the item's first point). */
  readonly at: Vec2;
  readonly tag: TagSpec;
  /** False when no clear spot was found near the element: the tag needs a hand. */
  readonly clear: boolean;
}

export interface TagSpreadPlan {
  readonly updates: readonly TagSpreadUpdate[];
  /** Chosen tags left alone, and why. */
  readonly kept: ReadonlyArray<{ readonly itemId: string; readonly reason: string }>;
}

/** Plan new spots for `itemIds` (tags in the view). Unknown or non-tag ids are reported in `kept`, never silently dropped. */
export function planTagSpread(model: ModelState, viewId: string, itemIds: readonly string[], opts?: PlaceTagsOptions): TagSpreadPlan {
  const view = tagView(model, viewId);
  const { toPaper, toModel } = paperMapping(view);
  const items = documentIndex(model).itemsByOwner.get(view.id) ?? [];
  const byId = new Map<string, DrawingItem>(items.map((i) => [i.id, i]));
  const kept: Array<{ itemId: string; reason: string }> = [];
  const moving = new Map<string, DrawingItem & { readonly tag: TagSpec }>();
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item || item.deleted) kept.push({ itemId: id, reason: "not a drawing item in this view" });
    else if (!item.tag) kept.push({ itemId: id, reason: "not a tag" });
    else if (item.tag.elbow !== undefined && item.tag.elbow !== "auto") kept.push({ itemId: id, reason: "its elbow was placed by hand" });
    else moving.set(id, item as DrawingItem & { readonly tag: TagSpec });
  }
  const obstacles = annotationBoxes(model, view, items.filter((i) => !moving.has(i.id)), toPaper);
  const requests: ElbowTagRequest[] = [];
  for (const item of moving.values()) {
    const box = tagItemBox(model, view, item, toPaper);
    const target = tagTarget(model, view, item.tag);
    if (!box || !target) {
      kept.push({ itemId: item.id, reason: target ? "the tag has no head to place" : "the tagged element is not in this view" });
      moving.delete(item.id);
      continue;
    }
    requests.push({ id: item.id, target: toPaper(target), size: { w: box.max.x - box.min.x, h: box.max.y - box.min.y } });
  }
  const placed = placeTagsClear(requests, obstacles, opts);
  const updates = placed.map((p): TagSpreadUpdate => {
    const item = moving.get(p.id);
    if (!item) throw new Error(`planTagSpread: placed an unknown tag ${p.id}`);
    return { itemId: p.id, at: toModel(p.head), tag: { ...item.tag, leader: true, elbow: "auto" }, clear: p.clear };
  });
  return { updates, kept };
}

/**
 * A tag's leader as drawn, paper mm: for the canvas to draw and grab the
 * elbow grip. Null when the tag draws no leader, has no elbow setting (a
 * straight leader from before U9) or sits on its element.
 */
export function tagElbowLeader(model: ModelState, view: ViewElement, item: DrawingItem): ElbowLeader | null {
  const spec = item.tag;
  if (!spec || spec.elbow === undefined || !tagHasLeader(model, spec)) return null;
  const { toPaper } = paperMapping(view);
  const box = tagItemBox(model, view, item, toPaper);
  const target = tagTarget(model, view, spec);
  if (!box || !target) return null;
  return elbowLeaderPath(box, toPaper(target), spec.elbow === "auto" ? undefined : toPaper(spec.elbow));
}
