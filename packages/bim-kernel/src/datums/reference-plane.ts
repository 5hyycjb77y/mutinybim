import type { BimElement, ElementId, ModelElementBase, Vec2 } from "../types";

/**
 * A reference plane (contract 1.11.0): a named vertical plane drawn as a line
 * on a level, for placing, routing and drafting tools to snap to. Never
 * built, never scheduled, never exported as a building element. Made by
 * `create_element`, so it is written only to peers advertising
 * `elements:create`.
 */
export interface ReferencePlane extends ModelElementBase {
  readonly kind: "reference_plane";
  readonly levelId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
  /** What people call it ("Face of slab edge"). Absent: shown by its id. */
  readonly name?: string;
}

export const REFERENCE_PLANE_KIND = "reference_plane";

export function isReferencePlane(el: BimElement | undefined): el is ReferencePlane {
  return el !== undefined && el.kind === "reference_plane";
}

/** What a person calls one. */
export function referencePlaneLabel(plane: ReferencePlane): string {
  const name = plane.name?.trim();
  return name !== undefined && name.length > 0 ? name : `Reference plane ${plane.id}`;
}
