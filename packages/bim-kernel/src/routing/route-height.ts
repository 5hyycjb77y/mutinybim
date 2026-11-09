import { refuse } from "../command-core";
import { asElementId, type ModelState, type Vec2 } from "../types";
import { isVertical } from "./geometry";
import { portInfoIn } from "./levels-across";
import type { RouteEndpoint } from "./commands";
import { runLabel } from "./validate";

const MM_PER_FT = 304.8;

function feet(mm: number): string {
  return `${(Math.round((mm / MM_PER_FT) * 100) / 100).toString()} ft`;
}

/** What `withRouteHeight` reads off a route: its height (maybe absent), its ends and its plan points. */
export interface RouteHeightInput {
  readonly elevationMm?: number | undefined;
  readonly from?: RouteEndpoint | undefined;
  readonly to?: RouteEndpoint | undefined;
  readonly points: readonly Vec2[];
  /** The route's level; heights are from its floor. */
  readonly levelId?: string | undefined;
}

/**
 * The height (mm above the level floor) a route without one starts at, taken
 * from what it starts on: the trunk a branch leaves (its centreline where the
 * branch's first point is), or the open end or connector it continues. With
 * no start, the same from what it finishes on. Refuses with the reason when
 * that thing has no single height to inherit (a stack, a connector facing up
 * or down, or a free route).
 */
export function inheritedRouteHeight(model: ModelState, cmd: RouteHeightInput): number {
  const end = cmd.from ? { ep: cmd.from, point: cmd.points[0] } : cmd.to ? { ep: cmd.to, point: cmd.points[cmd.points.length - 1] } : null;
  if (!end) refuse("invalid_value", "Give the run a height above the level: it doesn't start or finish on a duct, pipe or connector to take one from");
  const { ep, point } = end;
  if (ep.kind === "run_branch") {
    const host = model.elements[asElementId(ep.segmentId)];
    if (host?.kind !== "run_segment") refuse("element_not_found", `There is no straight run ${ep.segmentId} to branch off`, [asElementId(ep.segmentId)]);
    const ax = host.end.x - host.start.x;
    const ay = host.end.y - host.start.y;
    const plan2 = ax * ax + ay * ay;
    if (plan2 < 1e-6) refuse("invalid_value", `The ${runLabel(model.elements, host)} runs straight up and down, so a branch can leave it at any height; give the branch its height`, [host.id]);
    if (!point) refuse("invalid_value", "A branch needs a point on the trunk and at least one point beyond it");
    const t = Math.min(1, Math.max(0, ((point.x - host.start.x) * ax + (point.y - host.start.y) * ay) / plan2));
    return Math.round((host.start.z + (host.end.z - host.start.z) * t) * 1000) / 1000;
  }
  const ref = ep.kind === "part" ? { elementId: asElementId(ep.partId), port: ep.connectorId } : { elementId: asElementId(ep.elementId), port: ep.port };
  // A connector on another floor: its height from the route's floor.
  const info = portInfoIn(model.elements, ref, cmd.levelId ?? null);
  if (!info) refuse("element_not_found", `There is no connector ${ref.port} on ${ref.elementId} to route from`, [ref.elementId]);
  if (isVertical(info.direction)) {
    refuse("invalid_value", `That connector faces ${info.direction.z < 0 ? "down" : "up"} (it is at ${feet(info.position.z)}), so the run's height has to be chosen ${info.direction.z < 0 ? "below" : "above"} it; give the run a height`, [ref.elementId]);
  }
  return Math.round(info.position.z * 1000) / 1000;
}

/** The route with its height filled in: as given, or inherited (see `inheritedRouteHeight`). */
export function withRouteHeight<C extends RouteHeightInput>(model: ModelState, cmd: C): C & { readonly elevationMm: number } {
  if (cmd.elevationMm !== undefined) return { ...cmd, elevationMm: cmd.elevationMm };
  return { ...cmd, elevationMm: inheritedRouteHeight(model, cmd) };
}
