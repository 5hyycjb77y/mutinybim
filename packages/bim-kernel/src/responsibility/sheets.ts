/**
 * Which sheets an element appears on, for a responsibility scoped to sheets
 * (round 9 lane B9). An element appears on a sheet when a live view placed
 * on that sheet draws it: the view draws the element's level (same-floor
 * levels count; a view with no level draws every level) and, for a plan
 * with its crop on, the element's anchor is inside the crop. Schedules draw
 * no model location. The same rule a question pin follows on a plan.
 *
 * Built once per call from the sheets' own view lists (a handful of sheets
 * and views); each element's answer is then a walk over those views,
 * remembered per element. Nothing here scans the model's elements.
 */
import { cropIsOn, viewCrop } from "../crop";
import { levelOf } from "../fields/providers/spatial";
import { sameFloor } from "../levels";
import { anchorOf } from "../model";
import { elementsOfKind } from "../store";
import { DEFAULT_PARTITION, type BimElement, type ModelState, type Vec2, type ViewElement } from "../types";

interface DrawnView {
  /** Level names the view draws; null: every level. */
  readonly levels: ReadonlySet<string> | null;
  /** The crop an anchor must fall in (plans with the crop on); null: not tested. */
  readonly crop: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number } | null;
}

function isPlan(view: ViewElement): boolean {
  return (view.viewType === "floor_plan" || view.viewType === "ceiling_plan") && !view.props?.diagram;
}

function drawnView(model: Pick<ModelState, "elements">, view: ViewElement): DrawnView {
  const level = view.props?.level;
  let levels: Set<string> | null = null;
  if (level) {
    levels = new Set<string>([level]);
    for (const l of elementsOfKind(model.elements, "level")) if (sameFloor(l, level, view.props?.levelElevationMm)) levels.add(l.name);
  }
  if (!isPlan(view) || !cropIsOn(view)) return { levels, crop: null };
  const r = viewCrop(view);
  return { levels, crop: { minX: Math.min(r.min.x, r.max.x), maxX: Math.max(r.min.x, r.max.x), minY: Math.min(r.min.y, r.max.y), maxY: Math.max(r.min.y, r.max.y) } };
}

function draws(model: Pick<ModelState, "elements">, view: DrawnView, el: BimElement): boolean {
  if (view.levels) {
    const lvl = levelOf(model.elements, el);
    const name = lvl ? lvl.name : (el.partition ?? DEFAULT_PARTITION).level;
    if (!view.levels.has(name)) return false;
  }
  if (!view.crop) return true;
  const at: Vec2 | null = anchorOf(el);
  return at !== null && at.x >= view.crop.minX && at.x <= view.crop.maxX && at.y >= view.crop.minY && at.y <= view.crop.maxY;
}

/** `sheetsOf` for `modelCoverageContext`: the ids of the sheets an element appears on. */
export function sheetMembership(model: Pick<ModelState, "elements">): (el: BimElement) => readonly string[] {
  const sheets: Array<{ readonly id: string; readonly views: readonly DrawnView[] }> = [];
  for (const sheet of elementsOfKind(model.elements, "sheet")) {
    if (sheet.deleted) continue;
    const views: DrawnView[] = [];
    for (const id of sheet.viewIds) {
      const v = model.elements[id];
      if (v?.kind === "view" && !v.deleted && v.viewType !== "schedule") views.push(drawnView(model, v));
    }
    if (views.length > 0) sheets.push({ id: sheet.id, views });
  }
  const memo = new Map<string, readonly string[]>();
  return (el) => {
    const known = memo.get(el.id);
    if (known) return known;
    const out = sheets.filter((s) => s.views.some((v) => draws(model, v, el))).map((s) => s.id);
    memo.set(el.id, out);
    return out;
  };
}
