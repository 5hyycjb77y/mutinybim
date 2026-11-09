import type { ElementId, Vec2 } from "../types";

/**
 * Where a typed element sits, beyond a point (FOUNDATION-COVERAGE §2, the
 * 5c-2 placement row). Four shapes cover every discipline:
 *
 * - point: equipment, fixtures, columns, footings, inlets (today's parts);
 * - line: walls, beams, braces, joists, curbs, pipe sleeves; start and end
 *   with a justification, each end offset from its level;
 * - path: alignments, roads, swales, long walls, utility runs; a stationed
 *   polyline with arcs and an optional elevation profile;
 * - area: slabs, decks, roofs, ceilings, paving, catchments, lots; an outline
 *   with holes and an optional span direction.
 *
 * Plain data, millimetres and degrees in the model frame, so a pack reads it
 * with no kernel code of its own. Readers accept an unknown `kind` and keep
 * it (tolerant readers, strict writers); `geometricPlacementKind` says what a
 * reader can use.
 */

export const KNOWN_GEOMETRIC_PLACEMENT_KINDS = ["point", "line", "path", "area"] as const;
export type GeometricPlacementKind = (typeof KNOWN_GEOMETRIC_PLACEMENT_KINDS)[number];

/** Across the line, looking from start to end. */
export type LateralJustification = "left" | "center" | "right";
/** Which face of the element the placement line or outline describes. */
export type VerticalJustification = "top" | "center" | "bottom";

export interface PointPlacement {
  readonly kind: "point";
  readonly levelId: ElementId;
  readonly position: Vec2;
  /** Height of the insertion point above the level. */
  readonly offsetMm: number;
  /** Counter-clockwise from east. */
  readonly rotationDeg: number;
}

export interface LinePlacement {
  readonly kind: "line";
  readonly levelId: ElementId;
  readonly start: Vec2;
  readonly end: Vec2;
  /** Height of each end above the level (a sloped beam or brace differs). */
  readonly startOffsetMm: number;
  readonly endOffsetMm: number;
  readonly lateral: LateralJustification;
  readonly vertical: VerticalJustification;
  /** Rotation about the element's own axis (a rolled beam, a sloped joist web). Absent: 0. */
  readonly rollDeg?: number;
  /** The level the top end is tied to (a column or a wall to the floor above). Absent: `startOffsetMm` / `endOffsetMm` only. */
  readonly topLevelId?: ElementId;
  /** With `topLevelId`: how far above (negative: below) the top level the top sits. Absent: 0. */
  readonly topOffsetMm?: number;
  /** The top runs to a surface over the line instead (the structure above, a ceiling, a roof). Never beside `topLevelId`. */
  readonly topSurface?: SurfaceBinding;
  /** The base stands on a surface under the line (the top of the slab below). Its offsets above the level are then derived. */
  readonly baseSurface?: SurfaceBinding;
}

/**
 * What a bound face is: `structure` is the underside of the lowest slab, deck
 * or roof over the line; `ceiling` a ceiling's underside; `roof` a roof's
 * underside; `floor` the top of the surface the line stands on.
 */
export const SURFACE_BIND_TARGETS = ["structure", "ceiling", "roof", "floor"] as const;
export type SurfaceBindTarget = (typeof SURFACE_BIND_TARGETS)[number];

/** A top or base bound to a surface (`placement/surface-bind.ts` resolves it; `kernel.surface_face` rows say what each kind offers). */
export interface SurfaceBinding {
  readonly to: SurfaceBindTarget;
  /** One element's face (that slab, that roof). Absent: whatever surface of that kind is found over (or under) the line. */
  readonly elementId?: ElementId;
  /** With `elementId`: which of its faces. Absent: its top for `floor`, else its underside. */
  readonly face?: "top" | "underside";
  /** How far above (negative: below) the face. Absent: 0. */
  readonly offsetMm?: number;
}

/** One piece of a path, from the previous point. `bulge` is tan(θ/4) of the arc's sweep, positive counter-clockwise (DXF convention). */
export type PathSegment = { readonly kind: "line"; readonly to: Vec2 } | { readonly kind: "arc"; readonly to: Vec2; readonly bulge: number };

/** A station along a path and the elevation there (a road profile, a pipe invert line). */
export interface ProfilePoint {
  readonly stationMm: number;
  readonly elevationMm: number;
}

export interface PathPlacement {
  readonly kind: "path";
  readonly levelId: ElementId;
  readonly start: Vec2;
  readonly segments: readonly PathSegment[];
  /** Station of `start` (civil starts at 10+00, i.e. 1000 ft). Absent: 0. */
  readonly startStationMm?: number;
  /** Elevations along the path, ascending stations. Absent: `offsetMm` everywhere. */
  readonly profile?: readonly ProfilePoint[];
  /** Height above the level where there is no profile. */
  readonly offsetMm: number;
  readonly lateral: LateralJustification;
}

export interface AreaPlacement {
  readonly kind: "area";
  readonly levelId: ElementId;
  /** Counter-clockwise outline, closed implicitly. */
  readonly outline: readonly Vec2[];
  /** Clockwise holes (shafts, openings). */
  readonly holes?: readonly (readonly Vec2[])[];
  /** Height of the described face above the level. */
  readonly offsetMm: number;
  readonly vertical: VerticalJustification;
  /** One-way span direction (a deck, joists), counter-clockwise from east. Absent: two-way or none. */
  readonly spanDirectionDeg?: number;
  /** A sloped area (a roof, a ramp): rise per unit run along `slopeDirectionDeg`. Absent: flat. */
  readonly slope?: { readonly directionDeg: number; readonly rise: number };
}

export type GeometricPlacement = PointPlacement | LinePlacement | PathPlacement | AreaPlacement;

/** The kind a reader can use, or null for a shape this release doesn't know (kept, not drawn). */
export function geometricPlacementKind(value: { readonly kind?: unknown } | null | undefined): GeometricPlacementKind | null {
  const kind = value?.kind;
  return typeof kind === "string" && (KNOWN_GEOMETRIC_PLACEMENT_KINDS as readonly string[]).includes(kind) ? (kind as GeometricPlacementKind) : null;
}
