import type { Solid } from "./native-geometry";

/**
 * Window and crossing selection, the CAD convention: drag left to right and
 * only what lies fully inside the box is picked; drag right to left and
 * anything the box touches is. Pure screen geometry: the viewer projects
 * solids with its camera, the perf suite with a plan camera.
 */

export interface ScreenRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type BoxSelectMode = "window" | "crossing";

/** Screen point of a scene point (metres), or null when it is behind the camera. */
export type Project = (x: number, y: number, z: number) => { readonly x: number; readonly y: number } | null;

export function boxModeOf(start: { readonly x: number }, end: { readonly x: number }): BoxSelectMode {
  return end.x >= start.x ? "window" : "crossing";
}

export function dragRect(start: { readonly x: number; readonly y: number }, end: { readonly x: number; readonly y: number }): ScreenRect {
  return { minX: Math.min(start.x, end.x), minY: Math.min(start.y, end.y), maxX: Math.max(start.x, end.x), maxY: Math.max(start.y, end.y) };
}

/** The eight corners of a solid's oriented bounding box, scene metres. */
function corners(s: Solid): Array<[number, number, number]> {
  if (s.shape === "mesh" && s.mesh) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const p = s.mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i] ?? 0;
      const y = p[i + 1] ?? 0;
      const z = p[i + 2] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const [cx, cy, cz] = s.center;
    // Mesh solids turn by `yaw` about the scene up axis, as three.js rotation.y does.
    const c = Math.cos(s.yaw);
    const n = Math.sin(s.yaw);
    const out: Array<[number, number, number]> = [];
    for (const x of [minX, maxX]) for (const y of [minY, maxY]) for (const z of [minZ, maxZ]) out.push([cx + x * c + z * n, cy + y, cz - x * n + z * c]);
    return out;
  }
  // Half extents along local X, scene up and local Z. Cylinders: length along X (or up when vertical), diameter across.
  const [lx, ly, lz] =
    s.shape === "box" ? [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2] : s.vertical ? [s.size[1] / 2, s.size[0] / 2, s.size[1] / 2] : [s.size[0] / 2, s.size[1] / 2, s.size[1] / 2];
  const c = Math.cos(s.yaw);
  const n = Math.sin(s.yaw);
  const [cx, cy, cz] = s.center;
  const out: Array<[number, number, number]> = [];
  for (const sx of [-lx, lx]) {
    for (const sy of [-ly, ly]) {
      for (const sz of [-lz, lz]) {
        // Rotation about scene Y by yaw (three.js convention: x' = x cos + z sin, z' = -x sin + z cos).
        out.push([cx + sx * c + sz * n, cy + sy, cz - sx * n + sz * c]);
      }
    }
  }
  return out;
}

/** Each element's screen box: the union of its solids' projected corners. Elements wholly behind the camera are left out. */
export function screenBoxes(solids: readonly Solid[], project: Project): Map<string, ScreenRect> {
  const out = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const s of solids) {
    let box = out.get(s.elementId);
    for (const [x, y, z] of corners(s)) {
      const q = project(x, y, z);
      if (!q) continue;
      if (!box) {
        box = { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y };
        out.set(s.elementId, box);
        continue;
      }
      if (q.x < box.minX) box.minX = q.x;
      if (q.y < box.minY) box.minY = q.y;
      if (q.x > box.maxX) box.maxX = q.x;
      if (q.y > box.maxY) box.maxY = q.y;
    }
  }
  return out;
}

export function rectInside(inner: ScreenRect, outer: ScreenRect): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function rectsTouch(a: ScreenRect, b: ScreenRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Element ids the box picks, in the boxes' order. `accept` narrows to the categories asked for. */
export function boxSelect(boxes: ReadonlyMap<string, ScreenRect>, rect: ScreenRect, mode: BoxSelectMode, accept?: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const [id, box] of boxes) {
    if (accept && !accept(id)) continue;
    if (mode === "window" ? rectInside(box, rect) : rectsTouch(box, rect)) out.push(id);
  }
  return out;
}
