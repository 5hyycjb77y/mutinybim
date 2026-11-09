import type { BimElement, ElementId, Vec2 } from "../../types";
import { outlineAreaMm2, outlineProblem, MM2_PER_M2 } from "../space-geometry";
import type { BoundaryRef } from "../types";
import { roomAt, type RoomAt } from "./room-at";
import { boundingElementRow } from "./rows";

/**
 * What "Room from walls" would make at a point, before anything is written:
 * the outline and area for the hover preview, or why not in words with the
 * gap to highlight. `place_space_in_walls` refuses with the same words.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type RoomFromWallsPreview =
  | { readonly ok: true; readonly outline: readonly Vec2[]; readonly boundary: readonly BoundaryRef[]; readonly areaM2: number }
  | { readonly ok: false; readonly message: string; readonly gap?: { readonly at: Vec2; readonly elementId: ElementId } };

/** "wall W-12": the element's row label and its mark, name or id. */
export function boundingElementWords(elements: Elements, elementId: ElementId): string {
  const el = elements[elementId];
  if (!el) return elementId;
  const named = "mark" in el && typeof el.mark === "string" && el.mark.trim() !== "" ? el.mark : "name" in el && typeof el.name === "string" && el.name.trim() !== "" ? el.name : null;
  const noun = (boundingElementRow(el.kind)?.label ?? el.kind.replace(/_/g, " ")).toLowerCase();
  return `${noun} ${named ?? el.id}`;
}

/** Why there is no closed room at a point, in words. */
export function noRoomWords(elements: Elements, found: Exclude<RoomAt, { ok: true }>): string {
  if (found.gap) return `No closed room here: the walls leave a gap near the end of ${boundingElementWords(elements, found.gap.elementId)}. Close the gap, or draw the room's outline instead`;
  if (found.segmentsRead === 0) return "No closed room here: nothing on this level bounds rooms yet. Draw walls around the room, or draw its outline instead";
  return "No closed room here: the walls on this level don't enclose that point. Click inside a room, or draw its outline instead";
}

export function previewRoomFromWalls(elements: Elements, levelId: ElementId, seed: Vec2): RoomFromWallsPreview {
  const found = roomAt(elements, levelId, seed);
  if (!found.ok) return { ok: false, message: noRoomWords(elements, found), ...(found.gap ? { gap: found.gap } : {}) };
  const problem = outlineProblem(found.outline);
  if (problem) return { ok: false, message: `The walls around that point enclose a region that can't be a room: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` };
  return { ok: true, outline: found.outline, boundary: found.boundary, areaM2: outlineAreaMm2(found.outline) / MM2_PER_M2 };
}
