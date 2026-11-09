import { z } from "zod";
import { round } from "../geometry";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements } from "../store";
import {
  DEFAULT_SITE,
  SITE_ID,
  bearingDeg,
  modelToShared,
  normalizeAngleDeg,
  sharedToModel,
  siteOf,
  type SharedCoordinates,
  type SiteElement,
  type SiteFrame,
  type SitePoint,
} from "../site";
import { asElementId, type ModelState } from "../types";
import { normalizeWorkingAngleDeg, workingAngleFromEdge } from "../work-frame";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";

/**
 * Coordinates commands: move the project base point or the survey point, and
 * set true north. Two different things a person can mean by "move the origin":
 *
 * - move_point: the point moves on the model; the site does not. Every
 *   element keeps its shared coordinates; the point's own coordinates follow
 *   from where it now sits.
 * - relocate_project: the building moves on the site. Model coordinates (and
 *   so geometry, views and linked models) stay put; every element's shared
 *   coordinates change by the same move. The survey point stays on the site.
 *
 * Setting true north turns the building on the site about the project base
 * point (the base point keeps its coordinates; everything else's change).
 * Setting the working angle (`work-frame.ts`) changes only the direction
 * people draw in; no point's shared coordinates change.
 * All of them are ordinary commands: attributed, conflicting on the site's
 * fields, and undoable.
 */

/** Shared coordinates can be state-plane sized: hundreds of kilometres. */
const MAX_COORD_MM = 1e11;
const coord = z.number().finite().min(-MAX_COORD_MM).max(MAX_COORD_MM);
const point3 = z.object({ x: coord, y: coord, z: coord });
const shared = z.object({ eastWest: coord, northSouth: coord, elevation: coord });
const vec2 = z.object({ x: coord, y: coord });
const mode = z.enum(["move_point", "relocate_project"]);

export const siteCommandSchemas = [
  z.object({
    type: z.literal("set_project_origin"),
    mode,
    /** New model position of the project base point (mm). move_point needs it. */
    position: point3.optional(),
    /** The base point's new shared coordinates (relocate_project only). */
    shared: shared.optional(),
  }),
  z.object({
    type: z.literal("set_true_north"),
    /** Degrees clockwise from plan north to true north. */
    angleDeg: z.number().finite().min(-3600).max(3600).optional(),
    /** Or pick two plan points: true north runs from `from` toward `to`. */
    from: vec2.optional(),
    to: vec2.optional(),
  }),
  z.object({
    type: z.literal("set_working_angle"),
    /** Degrees counter-clockwise from model east to the direction people draw in. Kept in (−45, 45]; 0 puts it back square to the model. */
    angleDeg: z.number().finite().min(-3600).max(3600).optional(),
    /** Or two plan points along a building edge (a wall, a slab edge): the working axes turn square to that edge. */
    from: vec2.optional(),
    to: vec2.optional(),
  }),
  z.object({
    type: z.literal("set_survey_point"),
    mode,
    /** New model position of the survey point (mm). move_point needs it. */
    position: point3.optional(),
    /** The survey point's new shared coordinates (relocate_project only). */
    shared: shared.optional(),
  }),
] as const;

export type SiteCommand = z.infer<(typeof siteCommandSchemas)[number]>;

const SITE_COMMAND_TYPES: ReadonlySet<string> = new Set(siteCommandSchemas.map((s) => s.shape.type.value));

export function isSiteCommand(command: { readonly type: string }): command is SiteCommand {
  return SITE_COMMAND_TYPES.has(command.type);
}

const roundPoint = (p: SitePoint): SitePoint => ({ x: round(p.x), y: round(p.y), z: round(p.z) });
const roundShared = (s: SharedCoordinates): SharedCoordinates => ({ eastWest: round(s.eastWest), northSouth: round(s.northSouth), elevation: round(s.elevation) });
const samePoint = (a: SitePoint, b: SitePoint) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
const sameShared = (a: SharedCoordinates, b: SharedCoordinates) =>
  Math.abs(a.eastWest - b.eastWest) < 1e-6 && Math.abs(a.northSouth - b.northSouth) < 1e-6 && Math.abs(a.elevation - b.elevation) < 1e-6;

/** The survey point keeps its place on the site when the site moves under the building. */
function surveyFollowsSite(before: SiteFrame, after: Omit<SiteFrame, "surveyPoint">): SitePoint {
  return roundPoint(sharedToModel({ ...after, surveyPoint: before.surveyPoint }, modelToShared(before, before.surveyPoint)));
}

export function executeSiteCommand(model: ModelState, command: SiteCommand): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    const id = asElementId(SITE_ID);
    const existing = reader.find(id);
    if (existing && existing.kind !== "site") refuse("wrong_kind", `${SITE_ID} is a ${existing.kind}, not the site`, [id]);
    const before = siteOf(model);
    let next: SiteFrame;
    switch (command.type) {
      case "set_project_origin": {
        if (command.mode === "move_point") {
          if (!command.position) refuse("invalid_value", "Say where the project base point goes (a model position)");
          if (command.shared) refuse("invalid_value", "Moving the point only keeps the site where it is, so the point's coordinates follow from where you put it. To type new coordinates, relocate the project instead");
          const position = roundPoint(command.position);
          next = { ...before, basePoint: position, basePointShared: roundShared(modelToShared(before, position)) };
        } else {
          if (!command.position && !command.shared) refuse("invalid_value", "Give the project base point's new coordinates or its new position");
          const moved = { basePoint: roundPoint(command.position ?? before.basePoint), basePointShared: roundShared(command.shared ?? before.basePointShared), trueNorthDeg: before.trueNorthDeg };
          next = { ...moved, surveyPoint: surveyFollowsSite(before, moved) };
        }
        break;
      }
      case "set_true_north": {
        const picked = command.from || command.to;
        if (picked && command.angleDeg !== undefined) refuse("invalid_value", "Give an angle or two points, not both");
        let deg: number;
        if (picked) {
          if (!command.from || !command.to) refuse("invalid_value", "Pick two points: where true north starts and the direction it points");
          const b = bearingDeg(command.from, command.to);
          if (b === null) refuse("invalid_value", "The two points are the same; pick a second point in the direction of true north");
          deg = b;
        } else {
          if (command.angleDeg === undefined) refuse("invalid_value", "Give the angle from plan north to true north, or pick two points");
          deg = command.angleDeg;
        }
        const turned = { basePoint: before.basePoint, basePointShared: before.basePointShared, trueNorthDeg: normalizeAngleDeg(deg) };
        next = { ...turned, surveyPoint: surveyFollowsSite(before, turned) };
        break;
      }
      case "set_working_angle": {
        const picked = command.from || command.to;
        if (picked && command.angleDeg !== undefined) refuse("invalid_value", "Give an angle or two points along an edge, not both");
        let deg: number;
        if (picked) {
          if (!command.from || !command.to) refuse("invalid_value", "Pick two points along the building edge to line up with");
          const fromEdge = workingAngleFromEdge(command.from, command.to);
          if (fromEdge === null) refuse("invalid_value", "The two points are the same; pick a second point further along the edge");
          deg = fromEdge;
        } else {
          if (command.angleDeg === undefined) refuse("invalid_value", "Give the working angle in degrees, or pick two points along a building edge");
          deg = command.angleDeg;
        }
        next = { ...before, workingAngleDeg: normalizeWorkingAngleDeg(deg) };
        break;
      }
      case "set_survey_point": {
        if (command.mode === "move_point") {
          if (!command.position) refuse("invalid_value", "Say where the survey point goes (a model position)");
          if (command.shared) refuse("invalid_value", "Moving the point only keeps the site where it is, so the point's coordinates follow from where you put it. To type new coordinates, relocate the project instead");
          next = { ...before, surveyPoint: roundPoint(command.position) };
        } else {
          if (!command.position && !command.shared) refuse("invalid_value", "Give the survey point's new coordinates or its new position");
          const surveyPoint = roundPoint(command.position ?? before.surveyPoint);
          const wanted = command.shared ?? modelToShared(before, before.surveyPoint);
          // Keep θ and the base point's model position; shift the site so the survey point reads `wanted`.
          const atSurveyNow = modelToShared(before, surveyPoint);
          const basePointShared = roundShared({
            eastWest: before.basePointShared.eastWest + (wanted.eastWest - atSurveyNow.eastWest),
            northSouth: before.basePointShared.northSouth + (wanted.northSouth - atSurveyNow.northSouth),
            elevation: before.basePointShared.elevation + (wanted.elevation - atSurveyNow.elevation),
          });
          next = { ...before, basePointShared, surveyPoint };
        }
        break;
      }
    }
    const authored: AuthoredWrite[] = [];
    if (!samePoint(next.basePoint, before.basePoint)) authored.push({ elementId: id, field: "basePoint", value: next.basePoint });
    if (!sameShared(next.basePointShared, before.basePointShared)) authored.push({ elementId: id, field: "basePointShared", value: next.basePointShared });
    if (next.trueNorthDeg !== before.trueNorthDeg) authored.push({ elementId: id, field: "trueNorthDeg", value: next.trueNorthDeg });
    if (!samePoint(next.surveyPoint, before.surveyPoint)) authored.push({ elementId: id, field: "surveyPoint", value: next.surveyPoint });
    if ((next.workingAngleDeg ?? 0) !== (before.workingAngleDeg ?? 0)) authored.push({ elementId: id, field: "workingAngleDeg", value: next.workingAngleDeg ?? 0 });
    if (authored.length === 0) refuse("invalid_value", command.type === "set_working_angle" ? "Nothing would change: the working angle is already that" : "Nothing would change: the coordinates are already that");
    const working = draftElements(model.elements);
    const site: SiteElement = existing?.kind === "site"
      ? { ...existing, ...next }
      : { ...DEFAULT_SITE, ...next, id, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION };
    working[id] = site;
    return finish(reader, working, [id], authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })));
  });
}
