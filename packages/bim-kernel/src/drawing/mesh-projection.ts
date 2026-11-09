import { p3 } from "../routing/geometry";
import type { RunPoint } from "../routing/types";

/**
 * Triangle meshes (modeled parts) in drawings. Faces are the triangles that
 * face the viewer; lines are the mesh's sharp edges plus its silhouette; a
 * section cut is the mesh crossed with the cut plane, chained into closed
 * outlines and split into convex strips for poche and occlusion.
 */

export interface WorldMesh {
  /** World millimetres, x, y, z per vertex. */
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  /** Edges with their two triangles (t1 = -1 on an open boundary) and whether the faces meet at a crease. */
  readonly edges: readonly MeshEdge[];
}

export interface MeshEdge {
  readonly a: number;
  readonly b: number;
  readonly t0: number;
  readonly t1: number;
  readonly sharp: boolean;
}

/** Faces meeting at more than this are a drawn edge; flatter seams (sampled curves) are not. */
const CREASE_COS = Math.cos((25 * Math.PI) / 180);

const edgeTables = new WeakMap<Uint32Array, MeshEdge[]>();

function triNormal(positions: ArrayLike<number>, indices: Uint32Array, t: number): RunPoint {
  const i0 = (indices[3 * t] ?? 0) * 3;
  const i1 = (indices[3 * t + 1] ?? 0) * 3;
  const i2 = (indices[3 * t + 2] ?? 0) * 3;
  const ux = (positions[i1] ?? 0) - (positions[i0] ?? 0);
  const uy = (positions[i1 + 1] ?? 0) - (positions[i0 + 1] ?? 0);
  const uz = (positions[i1 + 2] ?? 0) - (positions[i0 + 2] ?? 0);
  const vx = (positions[i2] ?? 0) - (positions[i0] ?? 0);
  const vy = (positions[i2 + 1] ?? 0) - (positions[i0 + 1] ?? 0);
  const vz = (positions[i2 + 2] ?? 0) - (positions[i0 + 2] ?? 0);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return p3(nx / len, ny / len, nz / len);
}

/**
 * Edges of a mesh with adjacency, computed once per index buffer. Rotation and
 * translation don't change which edges are creases, so every placed copy of a
 * part shares the table.
 */
export function meshEdges(localPositions: ArrayLike<number>, indices: Uint32Array): MeshEdge[] {
  const hit = edgeTables.get(indices);
  if (hit) return hit;
  const byKey = new Map<number, { a: number; b: number; t0: number; t1: number }>();
  const vertexCount = Math.floor(localPositions.length / 3) + 1;
  const tris = indices.length / 3;
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[3 * t + k] ?? 0;
      const b = indices[3 * t + ((k + 1) % 3)] ?? 0;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * vertexCount + hi;
      const e = byKey.get(key);
      if (e) e.t1 = t;
      else byKey.set(key, { a: lo, b: hi, t0: t, t1: -1 });
    }
  }
  const out: MeshEdge[] = [];
  for (const e of byKey.values()) {
    if (e.t1 < 0) {
      out.push({ ...e, sharp: true });
      continue;
    }
    const n0 = triNormal(localPositions, indices, e.t0);
    const n1 = triNormal(localPositions, indices, e.t1);
    out.push({ ...e, sharp: n0.x * n1.x + n0.y * n1.y + n0.z * n1.z < CREASE_COS });
  }
  edgeTables.set(indices, out);
  return out;
}

export function worldTriNormal(mesh: WorldMesh, t: number): RunPoint {
  return triNormal(mesh.positions, mesh.indices, t);
}

export function vertex(mesh: WorldMesh, i: number): RunPoint {
  return p3(mesh.positions[3 * i] ?? 0, mesh.positions[3 * i + 1] ?? 0, mesh.positions[3 * i + 2] ?? 0);
}

interface P2 {
  readonly u: number;
  readonly v: number;
}

/** Chain unordered segments into closed loops (endpoints matched within `tol`). Open chains are dropped. */
export function chainLoops<T extends P2>(segments: ReadonlyArray<readonly [T, T]>, tol: number): T[][] {
  const key = (p: P2) => `${Math.round(p.u / tol)},${Math.round(p.v / tol)}`;
  const byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      const list = byEnd.get(k) ?? [];
      list.push(i);
      byEnd.set(k, list);
    }
  });
  const used = new Set<number>();
  const loops: T[][] = [];
  for (let s = 0; s < segments.length; s++) {
    if (used.has(s)) continue;
    const first = segments[s];
    if (!first) continue;
    used.add(s);
    const loop: T[] = [first[0]];
    let tail = first[1];
    const startKey = key(first[0]);
    let closed = false;
    for (let guard = 0; guard < segments.length; guard++) {
      if (key(tail) === startKey) {
        closed = true;
        break;
      }
      loop.push(tail);
      const next = (byEnd.get(key(tail)) ?? []).find((i) => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const seg = segments[next];
      if (!seg) break;
      tail = key(seg[0]) === key(tail) ? seg[1] : seg[0];
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Even-odd region of closed loops as convex strips (trapezoids between
 * consecutive vertex heights). Holes and nesting come out right without
 * triangulating.
 */
export function evenOddStrips<T extends P2>(loops: readonly (readonly T[])[], make: (u: number, v: number) => T): T[][] {
  const edges: Array<[T, T]> = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const a = l[i];
    const b = l[(i + 1) % l.length];
    if (a && b && Math.abs(a.v - b.v) > 1e-9) edges.push([a, b]);
  }
  const vs = [...new Set(loops.flatMap((l) => l.map((p) => p.v)))].sort((x, y) => x - y);
  const out: T[][] = [];
  const at = (e: [T, T], v: number) => e[0].u + ((e[1].u - e[0].u) * (v - e[0].v)) / (e[1].v - e[0].v);
  for (let i = 0; i + 1 < vs.length; i++) {
    const v0 = vs[i] ?? 0;
    const v1 = vs[i + 1] ?? 0;
    if (v1 - v0 < 1e-6) continue;
    const mid = (v0 + v1) / 2;
    const crossing = edges.filter((e) => (e[0].v - mid) * (e[1].v - mid) < 0).sort((a, b) => at(a, mid) - at(b, mid));
    for (let k = 0; k + 1 < crossing.length; k += 2) {
      const left = crossing[k];
      const right = crossing[k + 1];
      if (!left || !right) continue;
      out.push([make(at(left, v0), v0), make(at(right, v0), v0), make(at(right, v1), v1), make(at(left, v1), v1)]);
    }
  }
  return out;
}
