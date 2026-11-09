import { levelContentExtent, normalizeLevelName, type ModelState, type ViewElement } from "@permitzip/bim-kernel";
import { isSiteSlabName, type LinkedKind, type LinkedModelIndex } from "@permitzip/bim-lint";

/**
 * "Fit crop to content" for a plan, counting the linked models the plan
 * draws (bug log #6: a level with only the architect's model fit to nothing
 * and printed blank). The kernel's fit sees only our elements; this widens
 * it by the linked elements on the plan's level, found the way the drawing
 * finds them (the storey of that name, ignoring case, else the one at that
 * height), so the crop covers what prints.
 */

type Rect = { readonly min: { x: number; y: number }; readonly max: { x: number; y: number } };

const FT = 304.8;
const MARGIN_MM = 10 * FT;
const SAME_FLOOR_MM = 5;
/** Rooms, holes and loose generic content don't decide where a plan's edges are. */
const NOT_CONTENT: ReadonlySet<LinkedKind> = new Set(["space", "opening", "other"]);

export function isPlanView(view: Pick<ViewElement, "viewType">): boolean {
  return view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
}

/** Plan extent (host mm, with the fit's margin) of the linked elements on a level; null when none are. */
export function linkedLevelExtent(linked: readonly LinkedModelIndex[], level: string | undefined, levelElevationMm: number | undefined): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const wanted = level ? normalizeLevelName(level) : null;
  for (const m of linked) {
    const storey =
      (wanted ? m.storeys.find((s) => normalizeLevelName(s.name) === wanted) : undefined) ??
      (levelElevationMm !== undefined ? m.storeys.find((s) => Math.abs(s.elevationMm - levelElevationMm) < SAME_FLOOR_MM) : undefined);
    if (!storey) continue;
    for (const e of m.elements) {
      if (e.storey !== storey.name || NOT_CONTENT.has(e.kind) || (e.kind === "slab" && isSiteSlabName(e.name))) continue;
      minX = Math.min(minX, e.box[0]);
      minY = Math.min(minY, e.box[1]);
      maxX = Math.max(maxX, e.box[3]);
      maxY = Math.max(maxY, e.box[4]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: Math.round(minX - MARGIN_MM), y: Math.round(minY - MARGIN_MM) }, max: { x: Math.round(maxX + MARGIN_MM), y: Math.round(maxY + MARGIN_MM) } };
}

/**
 * The crop a plan's fit should set: our content and the linked content on
 * its level together. A string when there is nothing on the level at all, so
 * the caller says so instead of saving an empty drawing.
 */
export function planFitCrop(model: Pick<ModelState, "elements" | "connections">, view: Pick<ViewElement, "props" | "name">, linked: readonly LinkedModelIndex[]): Rect | string {
  const level = view.props?.level;
  const elevation = view.props?.levelElevationMm;
  const ours = levelContentExtent(model, level, MARGIN_MM, elevation);
  const theirs = linkedLevelExtent(linked, level, elevation);
  if (!ours && !theirs) {
    return `Nothing to fit ${view.name} to: ${level ?? "its level"} has none of our elements${linked.length > 0 ? " and no linked-model elements" : " and the project has no linked models"}. Set the crop with crop_min_ft / crop_max_ft instead.`;
  }
  if (!ours) return theirs as Rect;
  if (!theirs) return ours;
  return { min: { x: Math.min(ours.min.x, theirs.min.x), y: Math.min(ours.min.y, theirs.min.y) }, max: { x: Math.max(ours.max.x, theirs.max.x), y: Math.max(ours.max.y, theirs.max.y) } };
}
