import { registerEditHook } from "../../command-core";
import type { BimElement, ElementId, ModelState, Vec2 } from "../../types";
import { boxOf, type Box } from "../space-geometry";
import { separatorsInside } from "../separators";
import { boundedSpacesMeeting, levelsWithBoundedSpaces } from "../space-index";
import type { BoundedOpen, Space } from "../types";
import { boundaryExtent, boundingInstancesOfType, withBoundaryIndexAt } from "./boundary-index";
import { roomAt } from "./room-at";
import { boundingElementRow, boundsRooms, type BoundarySegment } from "./rows";

/**
 * Bounded spaces follow their walls. After any edit that changes a bounding
 * element (or a type it reads its room-bounding switch from), each bounded
 * space whose outline box meets that element's old or new segments is
 * re-traced from its seed, inside the edit: the new outline and boundary are
 * derived values of the same revision, so one undo restores both. A seed
 * left in no closed region keeps its last outline and is marked open, which
 * the "rooms no longer closed" findings read.
 */

type Elements = Readonly<Record<string, BimElement>>;

function segmentsOf(elements: Elements, el: BimElement | undefined, levelId: ElementId): readonly BoundarySegment[] {
  if (!el) return [];
  const row = boundingElementRow(el.kind);
  if (!row || !boundsRooms(el, elements)) return [];
  return row.segments(el, elements, levelId);
}

function grow(box: Box | null, segs: readonly BoundarySegment[]): Box | null {
  if (segs.length === 0) return box;
  const b = boxOf(segs.flatMap((s) => [s.start, s.end]));
  return box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
}

/** A changed wall re-trims the faces of the walls it meets (joins), so rooms a wall's width away can change too. */
const REACH_MM = 1000;
const pad = (b: Box): Box => ({ minX: b.minX - REACH_MM, minY: b.minY - REACH_MM, maxX: b.maxX + REACH_MM, maxY: b.maxY + REACH_MM });

const samePoints = (a: readonly Vec2[], b: readonly Vec2[]): boolean => a.length === b.length && a.every((p, i) => p.x === b[i]?.x && p.y === b[i]?.y);

function midOf(segs: readonly BoundarySegment[]): Vec2 | null {
  const s = segs[0];
  return s ? { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 } : null;
}

/** The bounding elements an edit changed: touched ones with a row, before or after, and the instances of a touched type. */
function changedBounding(base: ModelState, working: Elements, touchedIds: readonly ElementId[], levels: readonly ElementId[]): ElementId[] {
  const out = new Set<ElementId>();
  let typesRead = false;
  for (const id of touchedIds) {
    const before = base.elements[id];
    const after = working[id];
    if ((before && boundingElementRow(before.kind)) || (after && boundingElementRow(after.kind))) {
      out.add(id);
      continue;
    }
    if ((before ?? after)?.kind !== "element_type") continue;
    if (!typesRead) {
      // The index learns which elements take values from which type as it reads each level.
      for (const levelId of levels) boundaryExtent(base.elements, levelId);
      typesRead = true;
    }
    for (const inst of boundingInstancesOfType(base.elements, id)) out.add(inst);
  }
  return [...out];
}

function retraced(space: Space & { readonly bounds: Extract<Space["bounds"], { kind: "bounded" }> }, working: Elements, changed: readonly ElementId[], segsAfter: ReadonlyMap<ElementId, readonly BoundarySegment[]>): Space | null {
  const b = space.bounds;
  const found = roomAt(working, b.levelId, b.seed, separatorsInside(working, space.id));
  if (found.ok) {
    const sameBoundary = found.boundary.length === b.boundary.length && found.boundary.every((r, i) => r.elementId === b.boundary[i]?.elementId);
    if (!b.open && sameBoundary && samePoints(found.outline, b.outline)) return null;
    const { open: _closed, ...kept } = b;
    return { ...space, bounds: { ...kept, outline: found.outline, boundary: found.boundary } };
  }
  if (b.open) return null;
  const culprit = changed.find((id) => b.boundary.some((r) => r.elementId === id)) ?? changed[0];
  const near = found.gap?.at ?? (culprit ? midOf(segsAfter.get(culprit) ?? []) : null) ?? b.seed;
  const open: BoundedOpen = { near: { x: Math.round(near.x * 1000) / 1000, y: Math.round(near.y * 1000) / 1000 }, ...(culprit ? { elementId: culprit } : found.gap ? { elementId: found.gap.elementId } : {}) };
  return { ...space, bounds: { ...b, open } };
}

/** The rooms the changed elements split, when every changed element is a separation line that splits one; else null. */
function splitRoomsOf(base: Elements, working: Elements, changed: readonly ElementId[]): ReadonlySet<ElementId> | null {
  const rooms = new Set<ElementId>();
  for (const id of changed) {
    const el = working[id] ?? base[id];
    const before = base[id];
    if (el?.kind !== "space_separator" || el.splits === undefined) return null;
    if (before !== undefined && (before.kind !== "space_separator" || before.splits !== el.splits)) return null;
    rooms.add(el.splits);
  }
  return rooms;
}

/** Whether a space sits (at any depth) inside one of these rooms; the rooms themselves don't count. */
function nestedUnder(elements: Elements, spaceId: ElementId, rooms: ReadonlySet<ElementId>): boolean {
  const seen = new Set<ElementId>();
  for (let at = elements[spaceId]; at?.kind === "space" && at.parentId !== undefined && !seen.has(at.id); at = elements[at.parentId]) {
    seen.add(at.id);
    if (rooms.has(at.parentId)) return true;
  }
  return false;
}

/** Re-trace the bounded spaces an edit's bounding changes reach; push each one rewritten onto `touchedIds`. */
export function followBoundingEdits(base: ModelState, working: Record<string, BimElement>, touchedIds: ElementId[]): void {
  const levels = levelsWithBoundedSpaces(base.elements);
  if (levels.length === 0) return;
  const changed = changedBounding(base, working, touchedIds, levels);
  if (changed.length === 0) return;
  const already = new Set(touchedIds);
  // A separation line lies inside the room it splits, and that room's own trace ignores it: when every
  // change is such a line, only the rooms nested under those rooms can move (the split wrote them already).
  const splitRooms = splitRoomsOf(base.elements, working, changed);
  const rewritten: ElementId[] = [];
  withBoundaryIndexAt(base.elements, working, changed, () => {
    for (const levelId of levels) {
      let box: Box | null = null;
      const segsAfter = new Map<ElementId, readonly BoundarySegment[]>();
      for (const id of changed) {
        const after = segmentsOf(working, working[id], levelId);
        segsAfter.set(id, after);
        box = grow(grow(box, segmentsOf(base.elements, base.elements[id], levelId)), after);
      }
      if (!box) continue;
      for (const space of boundedSpacesMeeting(base.elements, levelId, pad(box))) {
        if (already.has(space.id)) continue;
        if (splitRooms && !nestedUnder(working, space.id, splitRooms)) continue;
        const now = working[space.id];
        if (now?.kind !== "space" || now.bounds.kind !== "bounded") continue;
        const next = retraced({ ...now, bounds: now.bounds }, working, changed, segsAfter);
        if (!next) continue;
        working[space.id] = next;
        rewritten.push(space.id);
      }
    }
  });
  touchedIds.push(...rewritten);
}

registerEditHook("spaces.bounded-follow", followBoundingEdits);
