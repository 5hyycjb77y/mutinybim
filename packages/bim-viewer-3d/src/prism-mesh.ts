/**
 * Upright prisms (a plan outline from one height to another) as one mesh
 * solid: a wall left in blocks round its doors and windows, a floor of any
 * outline, a ceiling, a stair's steps, an add-on's body. Outlines may be
 * concave (an L-shaped floor); caps are ear-clipped. Pure, no three.js.
 */
import { tiltedZ, type ElementId, type Tilt, type Vec2 } from "@permitzip/bim-kernel";
import { MM, type Vec3Tuple } from "./coords";
import type { RenderGroup, Solid } from "./native-geometry";

export interface PrismBlock {
  readonly outline: readonly Vec2[];
  /** World millimetres above project zero. */
  readonly z0: number;
  readonly z1: number;
  /** A sloped bottom or top through `z0` / `z1` (a wall's top under a pitched roof, a pitched roof). Absent: level. */
  readonly tilt0?: Tilt;
  readonly tilt1?: Tilt;
}

function signedArea(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function inTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

/** Drop repeated points and a closing point equal to the first. */
function cleanRing(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6) out.pop();
  return out;
}

/**
 * Triangles of a simple polygon, as index triples into `points` taken
 * counter-clockwise. Ear clipping: fine for the tens of corners a floor or
 * roof has. A polygon it cannot clip (self-crossing) falls back to a fan.
 */
export function triangulatePolygon(points: readonly Vec2[]): number[] {
  const n = points.length;
  if (n < 3) return [];
  const ccw = signedArea(points) >= 0;
  const ring = Array.from({ length: n }, (_, i) => (ccw ? i : n - 1 - i));
  const at = (i: number) => points[ring[i] as number] as Vec2;
  const out: number[] = [];
  let guard = n * n;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ia = (i + ring.length - 1) % ring.length;
      const ic = (i + 1) % ring.length;
      const a = at(ia);
      const b = at(i);
      const c = at(ic);
      if (cross(a, b, c) <= 0) continue;
      let blocked = false;
      for (let j = 0; j < ring.length && !blocked; j++) {
        if (j === ia || j === i || j === ic) continue;
        blocked = inTriangle(at(j), a, b, c);
      }
      if (blocked) continue;
      out.push(ring[ia] as number, ring[i] as number, ring[ic] as number);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (ring.length === 3) {
    out.push(ring[0] as number, ring[1] as number, ring[2] as number);
    return out;
  }
  for (let i = 1; i + 1 < ring.length; i++) out.push(ring[0] as number, ring[i] as number, ring[i + 1] as number);
  return out;
}

/** Blocks as one mesh solid in scene metres around the blocks' centre; null when no block has a face. */
export function prismsSolid(elementId: ElementId, version: number, group: RenderGroup, blocks: readonly PrismBlock[]): Solid | null {
  // Hot path (every wall with openings, every door and window body): size the buffers once, no per-vertex tuples.
  const faced: { readonly ring: Vec2[]; readonly caps: number[]; readonly z0: number; readonly z1: number; readonly tilt0: Tilt | undefined; readonly tilt1: Tilt | undefined }[] = [];
  let vertexCount = 0;
  let indexCount = 0;
  let loX = Infinity;
  let loY = Infinity;
  let loZ = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  let hiZ = -Infinity;
  for (const block of blocks) {
    const ring = cleanRing(block.outline);
    if (ring.length < 3 || !(block.z1 > block.z0)) continue;
    const caps = triangulatePolygon(ring);
    if (caps.length === 0) continue;
    faced.push({ ring, caps, z0: block.z0, z1: block.z1, tilt0: block.tilt0, tilt1: block.tilt1 });
    vertexCount += 6 * ring.length;
    indexCount += 2 * caps.length + 6 * ring.length;
    // Every corner of the block is a ring point at its bottom or top, so the ring and the two faces give its bounds.
    for (const p of ring) {
      loY = Math.min(loY, tiltedZ(block.z0, block.tilt0, p) * MM);
      hiY = Math.max(hiY, tiltedZ(block.z1, block.tilt1, p) * MM);
      const sx = p.x * MM;
      const sz = -p.y * MM;
      loX = Math.min(loX, sx);
      hiX = Math.max(hiX, sx);
      loZ = Math.min(loZ, sz);
      hiZ = Math.max(hiZ, sz);
    }
  }
  if (indexCount === 0) return null;
  const center: Vec3Tuple = [(loX + hiX) / 2, (loY + hiY) / 2, (loZ + hiZ) / 2];
  const [cx, cy, cz] = center;
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let w = 0;
  // Every face has its own corners, so the viewer's normals stay flat (a wall reads as a box, not a pillow).
  // Scene axes as `kernelToScene`: x east, y up, z south.
  const vertex = (p: Vec2, z: number): number => {
    positions[v * 3] = p.x * MM - cx;
    positions[v * 3 + 1] = z * MM - cy;
    positions[v * 3 + 2] = -p.y * MM - cz;
    return v++;
  };
  for (const { ring, caps, z0, z1, tilt0, tilt1 } of faced) {
    const n = ring.length;
    const lo = (p: Vec2) => tiltedZ(z0, tilt0, p);
    const hi = (p: Vec2) => tiltedZ(z1, tilt1, p);
    const bottom = v;
    for (const p of ring) vertex(p, lo(p));
    const top = v;
    for (const p of ring) vertex(p, hi(p));
    // Caps are counter-clockwise in plan; the bottom one faces down.
    for (let t = 0; t < caps.length; t += 3) {
      const a = caps[t] as number;
      const b = caps[t + 1] as number;
      const c = caps[t + 2] as number;
      indices[w++] = bottom + a;
      indices[w++] = bottom + c;
      indices[w++] = bottom + b;
      indices[w++] = top + a;
      indices[w++] = top + b;
      indices[w++] = top + c;
    }
    const ccw = signedArea(ring) >= 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p = (ccw ? ring[i] : ring[j]) as Vec2;
      const q = (ccw ? ring[j] : ring[i]) as Vec2;
      const p0 = vertex(p, lo(p));
      const q0 = vertex(q, lo(q));
      const q1 = vertex(q, hi(q));
      const p1 = vertex(p, hi(p));
      indices[w++] = p0;
      indices[w++] = q0;
      indices[w++] = q1;
      indices[w++] = p0;
      indices[w++] = q1;
      indices[w++] = p1;
    }
  }
  const size: Vec3Tuple = [hiX - loX, hiY - loY, hiZ - loZ];
  return { elementId, version, group, shape: "mesh", center, size, yaw: 0, mesh: { positions, indices } };
}
