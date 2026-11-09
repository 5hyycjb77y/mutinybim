import type { ElementId, PartInstance, Vec2 } from "../types";

/**
 * Planned elements (KERNEL-REQUIREMENTS-MODEL §3.1, ROADMAP F1): a panel,
 * rooftop unit or sink can exist with its id, type, values, circuits and
 * served-from links before anyone draws it. Placing it later keeps the id, so
 * everything that points at it keeps working.
 *
 * Storage keeps the flat placed fields on `PartInstance` so every existing
 * record reads as placed with no migration. A planned part carries `planned`;
 * while it does, its `levelId` / `position` / `offsetMm` / `rotationDeg` are
 * placeholders that no geometry consumer may read. Read placement only through
 * `placementOf` / `isPlaced`.
 */
export interface PlannedPlacement {
  /** The level it will probably go on (the one-line's "Level 1"). Not a location. */
  readonly levelHint?: ElementId;
  /** The space it serves or will sit in (spaces/types.ts). Drives "which room is this load in" before placement. */
  readonly spaceHint?: ElementId;
  readonly note?: string;
}

export type Placement =
  | {
      readonly state: "placed";
      readonly levelId: ElementId;
      readonly position: Vec2;
      readonly offsetMm: number;
      readonly rotationDeg: number;
    }
  | ({ readonly state: "planned" } & PlannedPlacement);

export type PlacementState = Placement["state"];

export function isPlaced(part: Pick<PartInstance, "planned">): boolean {
  return part.planned === undefined;
}

export function placementOf(part: PartInstance): Placement {
  if (part.planned !== undefined) return { state: "planned", ...part.planned };
  return { state: "placed", levelId: part.levelId, position: part.position, offsetMm: part.offsetMm, rotationDeg: part.rotationDeg };
}

/**
 * What a geometry consumer reports instead of silently skipping planned parts
 * ("3 planned elements not checked for clashes").
 */
export interface PlannedSkipReport {
  readonly consumer: string;
  readonly plannedIds: readonly ElementId[];
}
