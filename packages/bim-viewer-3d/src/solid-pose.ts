import type { Solid } from "./native-geometry";

/**
 * Euler rotation (x, y, z, order "YXZ") that lays a unit primitive along its solid.
 *
 * Meshes turn about the scene up axis only. Boxes lie along local X; cylinders
 * are built along scene Y and, unless vertical, are laid along local X. Both
 * then tilt by `pitch`, so a sloped pipe or duct follows its fall instead of
 * drawing level at its average height.
 */
export function solidRotation(s: Pick<Solid, "shape" | "yaw" | "vertical" | "pitch">): readonly [number, number, number] {
  if (s.shape === "mesh") return [0, s.yaw, 0];
  if (s.shape === "box") return [0, s.yaw, s.pitch ?? 0];
  if (s.vertical) return [0, 0, 0];
  return [0, s.yaw, Math.PI / 2 + (s.pitch ?? 0)];
}
