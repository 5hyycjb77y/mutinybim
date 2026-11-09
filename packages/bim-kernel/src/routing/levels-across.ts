import { GLOBAL_LEVEL, partitionOf } from "../partition";
import { recordsOfKinds } from "../store";
import type { BimElement, ElementId, Level, ModelState, Partition } from "../types";
import { portInfo, type PortInfo } from "./geometry";
import type { PortRef, RunPoint } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Runs that cross levels: a rooftop unit's downflow supply, dropping through
 * the roof to ceiling diffusers on the floor below. Heights in the model are
 * millimetres above an element's own level, so a run belongs to the level it
 * starts on and every height along it (and every connector it meets on
 * another level) is measured from that floor. Each piece is filed under the
 * floor it runs through, so a plan of that floor draws it and area loading
 * finds it there.
 */

export function levelElevationOf(elements: Elements, levelId: string): number {
  const level = elements[levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** The level an element's heights are measured from (parts and runs). */
export function heightFrameOf(el: BimElement | undefined): ElementId | null {
  return el && (el.kind === "part" || el.kind === "run_segment" || el.kind === "run_fitting") ? el.levelId : null;
}

/** Add this to a height measured from `fromLevelId`'s floor to measure it from `toLevelId`'s. */
export function frameShiftMm(elements: Elements, fromLevelId: string, toLevelId: string): number {
  if (fromLevelId === toLevelId) return 0;
  return Math.round((levelElevationOf(elements, fromLevelId) - levelElevationOf(elements, toLevelId)) * 1000) / 1000;
}

/** A port's position and direction with its height measured from `frameLevelId`'s floor. */
export function portInfoIn(elements: Elements, ref: PortRef, frameLevelId: string | null): PortInfo | null {
  const info = portInfo(elements, ref);
  if (!info || frameLevelId === null) return info;
  const own = heightFrameOf(elements[ref.elementId]);
  const shift = own === null ? 0 : frameShiftMm(elements, own, frameLevelId);
  return shift === 0 ? info : { ...info, position: { ...info.position, z: info.position.z + shift } };
}

/**
 * Levels low to high, read through the store's per-kind list (it follows each
 * edit with the few records the edit wrote, so routing after an edit doesn't
 * rebuild a model-wide index). Levels live in the global partition, the same
 * set `modelLevels` reads.
 */
export function levelsByHeight(model: Pick<ModelState, "elements" | "connections">): Level[] {
  const levels = recordsOfKinds(model.elements, ["level"]).filter((el): el is Level => el.kind === "level" && partitionOf(el).level === GLOBAL_LEVEL);
  return levels.sort((a, b) => a.elevationMm - b.elevationMm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const FLOOR_TOL_MM = 1;

/**
 * The floor a run piece is filed under: its own level while it stays between
 * that floor and the next one up, else the floor it is actually on (a drop
 * through the roof to the floor below, a rise to the floor above).
 */
export function floorForPiece(levels: readonly Level[], own: Level, absoluteMm: number): Level {
  if (absoluteMm < own.elevationMm - FLOOR_TOL_MM) return floorAt(levels, absoluteMm) ?? own;
  const next = levels.find((l) => l.elevationMm > own.elevationMm + FLOOR_TOL_MM);
  if (next && absoluteMm >= next.elevationMm - FLOOR_TOL_MM) return floorAt(levels, absoluteMm) ?? own;
  return own;
}

/** Does a height (from `own`'s floor) leave `own`'s storey? */
export function leavesStorey(levels: readonly Level[], own: Level, zMm: number): boolean {
  return floorForPiece(levels, own, own.elevationMm + zMm).id !== own.id;
}

/** The floor an absolute height is on: the highest level at or below it (the lowest level below every floor). */
export function floorAt(levels: readonly Level[], absoluteMm: number): Level | null {
  let best: Level | null = levels[0] ?? null;
  for (const l of levels) if (l.elevationMm <= absoluteMm + FLOOR_TOL_MM) best = l;
  return best;
}

/** Floors a vertical stretch from `loMm` to `hiMm` (absolute) passes into, above the lowest: where a riser is split. */
export function floorsBetween(levels: readonly Level[], loMm: number, hiMm: number): Level[] {
  return levels.filter((l) => l.elevationMm > loMm + FLOOR_TOL_MM && l.elevationMm < hiMm - FLOOR_TOL_MM);
}

/** The partition of a run piece that runs through `floor` (its zone and discipline kept). */
export function partitionOnFloor(partition: Partition, floor: Level | null): Partition {
  return floor && floor.name !== partition.level ? { ...partition, level: floor.name } : partition;
}

/** Midpoint height of a piece, absolute. */
export function absoluteMid(a: RunPoint, b: RunPoint, floorMm: number): number {
  return floorMm + (a.z + b.z) / 2;
}
