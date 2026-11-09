/**
 * Camera orientation helpers: the camera angles that look at the model from
 * one of its six sides (or any direction), which side the camera is square on,
 * and where each model axis points on screen.
 *
 * Model axes (kernel / IFC): X east, Y north (project north), Z up. The camera
 * is described the way camera-controls stores it: `azimuth` turns about the
 * up axis (0 = camera on the south side looking north, +π/2 = camera on the
 * east side), `polar` is measured from straight up (0 = looking down, π/2 =
 * level, π = looking up). Scene axes are X east, Y up, Z south (coords.ts).
 */

export interface Orientation {
  readonly azimuth: number;
  readonly polar: number;
}

/** The six sides of the model the camera can look from: each end of each model axis. */
export type Side = "east" | "west" | "north" | "south" | "top" | "bottom";
export type ElevationSide = "north" | "south" | "east" | "west";

export const SIDES: readonly Side[] = ["east", "west", "north", "south", "top", "bottom"];

/** A direction from the model toward the camera, in model axes. Any length but zero. */
export interface ViewVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const SIDE_VECTOR: Record<Side, ViewVector> = {
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  north: { x: 0, y: 1, z: 0 },
  south: { x: 0, y: -1, z: 0 },
  top: { x: 0, y: 0, z: 1 },
  bottom: { x: 0, y: 0, z: -1 },
};

export const SIDE_LABEL: Record<Side, string> = { east: "East", west: "West", north: "North", south: "South", top: "Top", bottom: "Bottom" };

export function sideVector(side: Side): ViewVector {
  return SIDE_VECTOR[side];
}

export function isElevationSide(side: Side | null): side is ElevationSide {
  return side === "north" || side === "south" || side === "east" || side === "west";
}

const TAU = Math.PI * 2;

/** The camera angles that look at the model from a side or a direction. Straight up or down keeps north at the top of the screen. */
export function orientationFor(view: Side | ViewVector): Orientation {
  const d = typeof view === "string" ? SIDE_VECTOR[view] : view;
  const len = Math.hypot(d.x, d.y, d.z);
  if (len === 0) throw new Error("A view direction needs at least one axis");
  const polar = Math.acos(d.z / len);
  const azimuth = d.x === 0 && d.y === 0 ? 0 : Math.atan2(d.x, -d.y);
  return { azimuth, polar };
}

/** `target` shifted by whole turns so the camera takes the short way round from `current`. */
export function nearestTurn(current: number, target: number): number {
  let delta = (target - current) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return current + delta;
}

/**
 * The side the camera looks square on from, read from its angles: Top or
 * Bottom when looking straight down or up, a compass side when level and
 * facing that side head-on, else null. It reports where the camera is; it
 * never moves it.
 */
export function squareOnSide(o: Orientation, tolerance = 0.02): Side | null {
  if (o.polar <= tolerance) return "top";
  if (o.polar >= Math.PI - tolerance) return "bottom";
  if (Math.abs(o.polar - Math.PI / 2) > tolerance) return null;
  for (const side of ["north", "south", "east", "west"] as const) {
    const t = orientationFor(side);
    if (Math.abs(nearestTurn(o.azimuth, t.azimuth) - o.azimuth) <= tolerance) return side;
  }
  return null;
}

export type ModelAxis = "x" | "y" | "z";

/**
 * Where a model axis points on screen for this camera: `x` right, `y` down
 * (CSS), `z` toward the viewer. Length 1 when the axis lies in the screen plane.
 */
export function projectAxis(o: Orientation, axis: ModelAxis): { x: number; y: number; z: number } {
  // The axis in CSS axes before turning: east → +x, north → -z (away), up → -y.
  const v = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 0, -1] : [0, -1, 0];
  const [vx = 0, vy = 0, vz = 0] = v;
  // Turn about up by -azimuth, then tip about screen-right by polar - π/2: the camera's own turns.
  const b = -o.azimuth;
  const x1 = vx * Math.cos(b) + vz * Math.sin(b);
  const z1 = -vx * Math.sin(b) + vz * Math.cos(b);
  const a = o.polar - Math.PI / 2;
  const y2 = vy * Math.cos(a) - z1 * Math.sin(a);
  const z2 = vy * Math.sin(a) + z1 * Math.cos(a);
  const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n);
  return { x: clean(x1), y: clean(y2), z: clean(z2) };
}

export interface PlanRectMm {
  readonly min: { readonly x: number; readonly y: number };
  readonly max: { readonly x: number; readonly y: number };
}

export interface ElevationCut {
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
  /** The section looks to the left of start→end; for these cuts that is always toward the model. */
  readonly direction: 1;
  readonly depthMm: number;
}

/**
 * A section line just outside the model on the camera's side, as long as the
 * model is wide, looking across all of it: the elevation the camera is looking
 * at, saved as a section view (the same command a drawn section cut sends).
 */
export function elevationCut(side: ElevationSide, rect: PlanRectMm, marginMm = 1000): ElevationCut {
  // Looking from the south means looking north, and so on.
  const look = side === "south" ? { x: 0, y: 1 } : side === "north" ? { x: 0, y: -1 } : side === "west" ? { x: 1, y: 0 } : { x: -1, y: 0 };
  // The section viewer looks to the left of start→end: along = look turned a quarter clockwise.
  const along = { x: look.y, y: -look.x };
  const corners = [rect.min, rect.max, { x: rect.min.x, y: rect.max.y }, { x: rect.max.x, y: rect.min.y }];
  const onLook = corners.map((c) => c.x * look.x + c.y * look.y);
  const onAlong = corners.map((c) => c.x * along.x + c.y * along.y);
  const nearL = Math.min(...onLook) - marginMm;
  const farL = Math.max(...onLook) + marginMm;
  const a0 = Math.min(...onAlong) - marginMm;
  const a1 = Math.max(...onAlong) + marginMm;
  const at = (a: number) => ({ x: Math.round(along.x * a + look.x * nearL) + 0, y: Math.round(along.y * a + look.y * nearL) + 0 });
  return { start: at(a0), end: at(a1), direction: 1, depthMm: Math.round(farL - nearL) };
}
