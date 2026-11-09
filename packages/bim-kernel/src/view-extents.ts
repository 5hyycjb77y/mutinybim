import { roundVec } from "./geometry";
import { viewLevelNames } from "./levels";
import { elementValues } from "./store";
import { DEFAULT_PARTITION, type ModelState, type Vec2 } from "./types";

/**
 * View extents: the rectangle type and a level's content extent, which both
 * the crop boxes (`crop.ts`) and the 3D views (`view3d.ts`) read. A leaf of
 * both, so neither imports the other for it.
 */

export interface Rect {
  readonly min: Vec2;
  readonly max: Vec2;
}

const FT = 304.8;

/** Plan extent of everything on a level (all levels when none; same-floor model levels count), with a margin; null when there is nothing. */
export function levelContentExtent(model: Pick<ModelState, "elements"> & Partial<Pick<ModelState, "connections">>, level: string | undefined, marginMm = 10 * FT, levelElevationMm?: number): Rect | null {
  const names = viewLevelNames(model, level, levelElevationMm);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (p: Vec2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const el of elementValues(model.elements)) {
    if (el.kind === "view" || el.kind === "sheet" || el.kind === "viewport" || el.kind === "drawing_item" || el.kind === "level") continue;
    if (names && !names.has(el.partition?.level ?? DEFAULT_PARTITION.level)) continue;
    if ("start" in el && "end" in el) {
      take(el.start);
      take(el.end);
    } else if ("position" in el && el.kind !== "tag") take(el.position);
    else if ("outline" in el) for (const p of el.outline) take(p);
  }
  if (!Number.isFinite(minX)) return null;
  return { min: roundVec({ x: minX - marginMm, y: minY - marginMm }), max: roundVec({ x: maxX + marginMm, y: maxY + marginMm }) };
}
