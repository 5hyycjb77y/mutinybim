import type { ResolvedConnector, ResolvedPrimitive, ResolvedSymbol, Vec3 } from "./parts";
import type { Vec2 } from "./types";

/**
 * How a placed part sits relative to the way its type is drawn. A part type
 * is drawn one way up (a ceiling diffuser face down, neck up); a placed part
 * can be turned over (a floor register: face up, neck down) or stood on its
 * side (a sidewall register: face out along the part's plan rotation, neck
 * back). Both are rotations about the insertion point, so solids stay solid
 * and connectors keep facing out of them. Plan rotation is applied after.
 *
 * - `turned_over`: half a turn about the part's own east-west axis: (x, y, z) → (x, −y, −z).
 * - `on_side`: a quarter turn about the part's own north-south axis that brings
 *   the drawn underside to face east: (x, y, z) → (−z, y, x).
 */
export const PART_MOUNTS = ["turned_over", "on_side"] as const;
export type PartMount = (typeof PART_MOUNTS)[number];

/** What people call each mount for an air terminal drawn face down. */
export const PART_MOUNT_LABELS: Readonly<Record<PartMount | "as_drawn", string>> = {
  as_drawn: "As drawn",
  turned_over: "Turned over",
  on_side: "On its side",
};

export function mountPoint(mount: PartMount | undefined, p: Vec3): Vec3 {
  switch (mount) {
    case "turned_over":
      return [p[0], -p[1], -p[2]];
    case "on_side":
      return [-p[2], p[1], p[0]];
    default:
      return p;
  }
}

/** A box's size (or any axis-aligned extent) under the mount: axes swap, lengths don't change sign. */
function mountExtent(mount: PartMount | undefined, s: Vec3): Vec3 {
  return mount === "on_side" ? [s[2], s[1], s[0]] : s;
}

function mountAxis(mount: PartMount | undefined, axis: "x" | "y" | "z"): "x" | "y" | "z" {
  if (mount !== "on_side") return axis;
  return axis === "x" ? "z" : axis === "z" ? "x" : "y";
}

/** The type's primitives as the placed part has them (still in its own plan frame, before rotation). */
export function mountedGeometry(prims: readonly ResolvedPrimitive[], mount: PartMount | undefined): ResolvedPrimitive[] {
  if (!mount) return [...prims];
  return prims.map((p): ResolvedPrimitive => {
    switch (p.kind) {
      case "box":
        return { kind: "box", center: mountPoint(mount, p.center), size: mountExtent(mount, p.size) };
      case "cylinder":
        return { kind: "cylinder", center: mountPoint(mount, p.center), radius: p.radius, height: p.height, axis: mountAxis(mount, p.axis) };
      case "extrusion": {
        if (mount === "turned_over") return { kind: "extrusion", profile: p.profile.map((q) => ({ x: q.x, y: -q.y })), z: -(p.z + p.height), height: p.height };
        // An extrusion stood on its side is no longer upright: its bounding box stands in for it.
        const xs = p.profile.map((q) => q.x);
        const ys = p.profile.map((q) => q.y);
        const min: Vec3 = [Math.min(...xs), Math.min(...ys), p.z];
        const max: Vec3 = [Math.max(...xs), Math.max(...ys), p.z + p.height];
        const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        return { kind: "box", center: mountPoint(mount, center), size: mountExtent(mount, [max[0] - min[0], max[1] - min[1], max[2] - min[2]]) };
      }
    }
  });
}

export function mountedConnectors(connectors: readonly ResolvedConnector[], mount: PartMount | undefined): ResolvedConnector[] {
  if (!mount) return [...connectors];
  return connectors.map((c) => ({ ...c, position: mountPoint(mount, c.position), direction: mountPoint(mount, c.direction) }));
}

/**
 * The plan symbol under the mount. Turned over, the symbol mirrors north-south.
 * On its side, the drawn symbol no longer shows what is seen from above, so the
 * plan draws the outline of the stood-up solid instead (`bounds` from the
 * mounted geometry).
 */
export function mountedSymbol(symbols: readonly ResolvedSymbol[], mount: PartMount | undefined, bounds: { min: Vec3; max: Vec3 } | null): ResolvedSymbol[] {
  if (!mount) return [...symbols];
  if (mount === "on_side") {
    if (!bounds) return [];
    const center: Vec2 = { x: (bounds.min[0] + bounds.max[0]) / 2, y: (bounds.min[1] + bounds.max[1]) / 2 };
    const size: Vec2 = { x: bounds.max[0] - bounds.min[0], y: bounds.max[1] - bounds.min[1] };
    return size.x > 0 && size.y > 0 ? [{ kind: "rect", center, size }] : [];
  }
  const m = (q: Vec2): Vec2 => ({ x: q.x, y: -q.y });
  return symbols.map((s): ResolvedSymbol => {
    switch (s.kind) {
      case "rect":
        return { ...s, center: m(s.center) };
      case "circle":
        return { ...s, center: m(s.center) };
      case "line":
        return { ...s, from: m(s.from), to: m(s.to) };
      case "polyline":
        return { ...s, points: s.points.map(m) };
      case "text":
        return { ...s, at: m(s.at) };
    }
  });
}

/** Mesh vertices (x, y, z triples in the part's own frame) under the mount; proper rotations keep the triangles' winding. */
export function mountedPositions(positions: ArrayLike<number>, mount: PartMount | undefined): Float64Array {
  const out = new Float64Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const [x, y, z] = mountPoint(mount, [positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0]);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}
