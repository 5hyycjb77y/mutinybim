import type { Profile, Vec2 } from "./types";

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

export function unit(a: Vec2): Vec2 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

/** Left-hand perpendicular of a direction. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

const ANGLE_EPS = 1e-6;

export function isParallel(direction: Vec2, axis: Vec2): boolean {
  if (length(direction) === 0) return true;
  return Math.abs(cross(unit(direction), unit(axis))) < ANGLE_EPS;
}

export function isPerpendicular(direction: Vec2, axis: Vec2): boolean {
  if (length(direction) === 0) return true;
  return Math.abs(dot(unit(direction), unit(axis))) < ANGLE_EPS;
}

/** Plan width of a duct profile (the dimension drawn in plan). */
export function planWidth(profile: Profile): number {
  return profile.shape === "rect" ? profile.width : profile.diameter;
}

export function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function roundVec(a: Vec2): Vec2 {
  return { x: round(a.x), y: round(a.y) };
}

export function inchesLabel(mm: number): string {
  return `${Math.round(mm / 25.4)}"`;
}

export function profileLabel(profile: Profile): string {
  return profile.shape === "rect"
    ? `${inchesLabel(profile.width)}x${inchesLabel(profile.height)}`
    : `${inchesLabel(profile.diameter)}Ø`;
}

/** A sloped face: it passes through its block's height at `at` and rises `rise.x` mm per mm east and `rise.y` per mm north (a wall's top under a sloped roof). */
export interface Tilt {
  readonly at: Vec2;
  readonly rise: Vec2;
}

/** A face's height at a plan point: `z` at the tilt's origin, carried along its rise. No tilt: `z` everywhere. */
export function tiltedZ(z: number, tilt: Tilt | undefined, p: Vec2): number {
  return tilt ? z + tilt.rise.x * (p.x - tilt.at.x) + tilt.rise.y * (p.y - tilt.at.y) : z;
}
