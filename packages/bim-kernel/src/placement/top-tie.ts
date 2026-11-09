import { lineLevelId } from "../joins/rows";
import type { BimElement, ElementId, Level } from "../types";
import type { LinePlacement } from "./geometric";

/**
 * A line-placed element whose top is tied to a level: its body runs from its
 * base level (plus the placement's start offset) up to the top level (plus
 * `topOffsetMm`), and follows either level when it moves. Kernel rows say
 * where each kind keeps its height; a kind with no row derives its top on
 * read (stairs, columns).
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Where a kind keeps the height a top tie writes. */
export interface TopTieRow {
  readonly kind: string;
  readonly height: (el: BimElement) => number | null;
  readonly withHeight: (el: BimElement, heightMm: number) => BimElement;
}

const ROWS = new Map<string, TopTieRow>();

ROWS.set("wall", {
  kind: "wall",
  height: (el) => (el.kind === "wall" ? el.height : null),
  withHeight: (el, heightMm) => (el.kind === "wall" ? { ...el, height: heightMm } : el),
});

export function topTieRow(kind: string): TopTieRow | undefined {
  return ROWS.get(kind);
}

/** Lowest body a tie may give: below this the top level is at or under the base. */
export const MIN_TIED_HEIGHT_MM = 1;

/** The element's line placement when its top is tied to a level, else null. */
export function topTieOf(el: BimElement): LinePlacement | null {
  const p = "placement" in el ? el.placement : undefined;
  return p && typeof p === "object" && p.kind === "line" && typeof p.topLevelId === "string" ? p : null;
}

/**
 * The body height a tied placement gives, or null when it isn't tied, a level
 * is missing, or the top level isn't above the base. `elevation` reads a
 * level's elevation (a level change in progress passes its new ones).
 */
export function tiedHeightMm(p: LinePlacement, elevation: (levelId: ElementId) => number | null): number | null {
  if (p.topLevelId === undefined) return null;
  const base = elevation(p.levelId);
  const top = elevation(p.topLevelId);
  if (base === null || top === null) return null;
  const height = Math.round(top + (p.topOffsetMm ?? 0) - (base + p.startOffsetMm));
  return height >= MIN_TIED_HEIGHT_MM ? height : null;
}

/** A level's elevation in `elements`, or null when it isn't a level. */
export function levelElevationIn(elements: Elements): (levelId: ElementId) => number | null {
  return (id) => {
    const l = elements[id];
    return l?.kind === "level" ? l.elevationMm : null;
  };
}

/** The element with its tied height written, or null when nothing changes (not tied, no row, same height, or no valid height). */
export function withTiedHeight(el: BimElement, elevation: (levelId: ElementId) => number | null): BimElement | null {
  const p = topTieOf(el);
  const row = p ? ROWS.get(el.kind) : undefined;
  if (!p || !row) return null;
  const h = tiedHeightMm(p, elevation);
  if (h === null || row.height(el) === h) return null;
  return row.withHeight(el, h);
}

/** True when `el`'s body depends on one of `levelIds` (its base or its tied top). */
export function tiedToAny(el: BimElement, levelIds: ReadonlySet<ElementId>): boolean {
  const p = topTieOf(el);
  return p !== null && ROWS.has(el.kind) && ((p.topLevelId !== undefined && levelIds.has(p.topLevelId)) || levelIds.has(p.levelId));
}

/**
 * The element's line placement to edit its top on: its own, or for an older
 * wall stored without one, its centreline on its base level. Null for other
 * kinds, or a wall whose level can't be found.
 */
export function editableLinePlacement(el: BimElement, elements: Elements): LinePlacement | null {
  const p = "placement" in el ? el.placement : undefined;
  if (p && typeof p === "object" && p.kind === "line") return p;
  if (el.kind !== "wall" || p) return null;
  const levelId = lineLevelId(el, elements);
  return levelId === "" ? null : { kind: "line", levelId, start: el.start, end: el.end, startOffsetMm: 0, endOffsetMm: 0, lateral: "center", vertical: "bottom" };
}

/** The level a tied element's top follows, or null when it isn't tied or the level is gone. */
export function topLevelOf(el: BimElement, elements: Elements): Level | null {
  const p = topTieOf(el);
  const l = p?.topLevelId ? elements[p.topLevelId] : undefined;
  return l?.kind === "level" ? l : null;
}
