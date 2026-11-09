import type { BimElement, ElementId, GridLine, Vec2 } from "../types";
import type { DatumRow, DatumSnapLine } from "./point";
import { referencePlaneLabel } from "./reference-plane";

/**
 * The kernel's own datum rows (`kernel.datum` built-ins): levels, grid lines
 * and reference planes. Add-ons add theirs (a site reference line) to the
 * same point.
 */

/** A grid line's IFC axis family: lines running mostly along the model's y axis are one family (U), the rest the other (V). */
export function gridAxisFamily(start: Vec2, end: Vec2): "U" | "V" {
  return Math.abs(end.y - start.y) >= Math.abs(end.x - start.x) ? "U" : "V";
}

function gridLabel(el: GridLine): string {
  const label = el.label.trim();
  return label.length > 0 ? label : el.id;
}

export const LEVEL_DATUM_ROW: DatumRow = {
  kind: "level",
  label: "Level",
  labelOf: (el) => (el.kind === "level" ? el.name : el.id),
  snapLines: () => [],
  elevationMm: (el) => (el.kind === "level" ? el.elevationMm : null),
};

/** Grid lines run through every level. */
export const GRID_DATUM_ROW: DatumRow = {
  kind: "grid",
  label: "Grid line",
  labelOf: (el) => (el.kind === "grid" ? `Grid ${gridLabel(el)}` : el.id),
  snapLines: (el: BimElement): readonly DatumSnapLine[] => (el.kind === "grid" ? [{ datumId: el.id, label: gridLabel(el), start: el.start, end: el.end, axisFamily: gridAxisFamily(el.start, el.end) }] : []),
};

/** A reference plane snaps on the level it is drawn on. */
export const REFERENCE_PLANE_DATUM_ROW: DatumRow = {
  kind: "reference_plane",
  label: "Reference plane",
  labelOf: (el) => (el.kind === "reference_plane" ? referencePlaneLabel(el) : el.id),
  snapLines: (el: BimElement, _elements, levelId: ElementId): readonly DatumSnapLine[] =>
    el.kind === "reference_plane" && el.levelId === levelId ? [{ datumId: el.id, label: referencePlaneLabel(el), start: el.start, end: el.end }] : [],
};

export const KERNEL_DATUM_ROWS: readonly DatumRow[] = [LEVEL_DATUM_ROW, GRID_DATUM_ROW, REFERENCE_PLANE_DATUM_ROW];
