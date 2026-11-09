import { withFlatLine } from "../placement/line-face";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, Wall } from "../types";
import type { LineJoinRow } from "./contract";

/**
 * The kernel's own join rows (`kernel.line_join` built-ins): its line-placed
 * building kind, so walls join with every add-on off. Add-ons add theirs.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** An instance value that sets an element's join priority (higher runs through). Absent: its width. */
export const JOIN_PRIORITY_KEY = "join.priority";

const levelsByName = new WeakMap<Elements, ReadonlyMap<string, ElementId>>();

/** The level a line element sits on: its placement's, else the level its partition names, else none (""). */
export function lineLevelId(el: Wall, elements: Elements): ElementId | "" {
  if (el.placement && "levelId" in el.placement) return el.placement.levelId;
  const name = el.partition?.level;
  if (name === undefined) return "";
  let byName = levelsByName.get(elements);
  if (!byName) {
    byName = new Map(elementsOfKind(elements, "level").map((l) => [l.name, l.id] as const));
    levelsByName.set(elements, byName);
  }
  return byName.get(name) ?? "";
}

function priorityValue(el: BimElement): number | null {
  if (!("values" in el) || typeof el.values !== "object" || el.values === null) return null;
  const v: unknown = (el.values as Readonly<Record<string, unknown>>)[JOIN_PRIORITY_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const WALL_JOIN_ROW: LineJoinRow = {
  kind: "wall",
  label: "Wall",
  styles: ["butt", "miter"],
  line: (el, elements) => (el.kind === "wall" ? { start: el.start, end: el.end, widthMm: el.thickness, levelId: lineLevelId(el, elements) as ElementId } : null),
  priority: (el) => priorityValue(el) ?? (el.kind === "wall" ? el.thickness : 0),
  withLine: (el, line) => (el.kind === "wall" ? withFlatLine(el, line.start, line.end, el.thickness) : el),
};

export const KERNEL_LINE_JOIN_ROWS: readonly LineJoinRow[] = [WALL_JOIN_ROW];
