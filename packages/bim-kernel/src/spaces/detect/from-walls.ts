import { lineJoinsOf } from "../../joins/solve";
import type { BimElement, ElementId, Vec2 } from "../../types";
import { boundarySegmentsOfLevel } from "../boundaries/boundary-index";
import { faceAround, regionsOf, type WalkSegment } from "../boundaries/face-walk";
import { roomAt } from "../boundaries/room-at";
import { boxOf, containsPoint, outlineAreaMm2, outlineProblem, MM2_PER_M2 } from "../space-geometry";
import { spaceAt } from "../space-index";
import type { BoundaryRef } from "../types";
import type { DetectedRoomOutline } from "./rooms";
import { linkedBoundarySegments, linkedBoundingOutlines, parseLinkedElementKey, type LinkedReferenceIndex } from "../../reference-geometry/index-geometry";

/**
 * Find rooms from walls: every closed region the room-bounding elements make
 * on a level that no space covers yet, as proposals in the shape the
 * Proposed rooms review already shows (`DetectedRoomOutline`), each with the
 * seed that `place_space_in_walls` makes it from. Nothing is stored. Off the
 * edit path: one read of the level's boundary index.
 *
 * With `linked`, the room-bounding elements of linked models at that height
 * bound rooms too. A room any linked element bounds can't be kept in step
 * with our own walls, so it is proposed with its outline (made as a drawn
 * space), and `linkedBoundary` says so.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const WALL_ROOM_DETECTOR_ID = "walls-rooms@1";
/** The detector a space found from a linked model's walls records. */
export const LINKED_WALL_ROOM_DETECTOR_ID = "linked-walls-rooms@1";

export interface WallRoomProposal extends DetectedRoomOutline {
  /** Where `place_space_in_walls` is sent to make it. */
  readonly seed: Vec2;
  readonly boundary: readonly BoundaryRef[];
  /** A linked model's element bounds it somewhere: made from its outline, not kept in step with walls. */
  readonly linkedBoundary?: boolean;
}

export interface LinkedRoomBounds {
  readonly index: LinkedReferenceIndex;
  /** The height (model mm) the level reads linked elements at. */
  readonly zMm: number;
}

/** Two regions this close in area are the same room. */
const SAME_AREA = 0.005;
/** How far past a region's box a segment can be and still matter to the face round it. */
const NEAR_MM = 10;

function keyOf(p: Vec2): string {
  return `${Math.round(p.x / 10) * 10},${Math.round(p.y / 10) * 10}`;
}

/** Inside the body of a line-placed element around it (between a wall's two faces): wall, not floor. */
function inElementBody(elements: Elements, at: Vec2, ids: Iterable<ElementId>): boolean {
  for (const id of ids) {
    const outline = lineJoinsOf(elements, id)?.outline;
    if (outline && outline.length >= 3 && containsPoint(outline, at)) return true;
  }
  return false;
}

/** The rooms the walls on a level close that no space covers yet, west to east then south to north. */
export function detectRoomsFromWalls(elements: Elements, levelId: ElementId, linked?: LinkedRoomBounds): WallRoomProposal[] {
  const extra = linked ? linkedBoundarySegments(linked.index, linked.zMm) : [];
  if (extra.length > 0 && linked) return detectWithLinked(elements, levelId, extra, linkedBoundingOutlines(linked.index, linked.zMm));
  const regions = regionsOf(boundarySegmentsOfLevel(elements, levelId));
  const out = new Map<string, WallRoomProposal>();
  for (const r of regions) {
    if (outlineProblem(r.outline) !== null) continue;
    if (inElementBody(elements, r.inside, new Set(r.boundary.map((b) => b.elementId)))) continue;
    const area = outlineAreaMm2(r.outline);
    // A loop around other rooms (a building's outer ring) is not itself a room: the room at its inside point is smaller.
    const traced = roomAt(elements, levelId, r.inside);
    if (!traced.ok || Math.abs(outlineAreaMm2(traced.outline) - area) > SAME_AREA * area) continue;
    if (spaceAt(elements, levelId, r.inside)) continue;
    const key = keyOf(r.inside);
    if (out.has(key)) continue;
    out.set(key, { key, outline: traced.outline, areaM2: area / MM2_PER_M2, centre: r.inside, openings: [], confidence: 1, seed: r.inside, boundary: traced.boundary });
  }
  return [...out.values()].sort((a, b) => a.centre.x - b.centre.x || a.centre.y - b.centre.y);
}

/** Our walls and the linked ones together: one arrangement, each region checked against the segments near it. */
function detectWithLinked(elements: Elements, levelId: ElementId, extra: readonly WalkSegment[], linkedBodies: readonly (readonly Vec2[])[]): WallRoomProposal[] {
  const all: WalkSegment[] = [...boundarySegmentsOfLevel(elements, levelId), ...extra];
  const boxes = all.map((s) => boxOf([s.start, s.end]));
  const near = (b: { minX: number; minY: number; maxX: number; maxY: number }): WalkSegment[] =>
    all.filter((_, i) => {
      const s = boxes[i];
      return s !== undefined && s.maxX >= b.minX - NEAR_MM && s.minX <= b.maxX + NEAR_MM && s.maxY >= b.minY - NEAR_MM && s.minY <= b.maxY + NEAR_MM;
    });
  const out = new Map<string, WallRoomProposal>();
  for (const r of regionsOf(all)) {
    if (outlineProblem(r.outline) !== null) continue;
    const native = r.boundary.filter((b) => parseLinkedElementKey(b.elementId) === null).map((b) => b.elementId);
    if (inElementBody(elements, r.inside, new Set(native))) continue;
    if (linkedBodies.some((o) => o.length >= 3 && containsPoint(o, r.inside))) continue;
    const area = outlineAreaMm2(r.outline);
    const traced = faceAround(near(boxOf(r.outline)), r.inside);
    if (!traced.ok || Math.abs(outlineAreaMm2(traced.outline) - area) > SAME_AREA * area) continue;
    if (spaceAt(elements, levelId, r.inside)) continue;
    const key = keyOf(r.inside);
    if (out.has(key)) continue;
    const linkedBoundary = traced.boundary.some((b) => parseLinkedElementKey(b.elementId) !== null);
    out.set(key, { key, outline: traced.outline, areaM2: area / MM2_PER_M2, centre: r.inside, openings: [], confidence: 1, seed: r.inside, boundary: traced.boundary, ...(linkedBoundary ? { linkedBoundary } : {}) });
  }
  return [...out.values()].sort((a, b) => a.centre.x - b.centre.x || a.centre.y - b.centre.y);
}
