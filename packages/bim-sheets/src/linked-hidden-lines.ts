import { FaceIndex, cellFor, planeOf, signedArea, splitHidden, type Face, type ProjPoint } from "@permitzip/bim-kernel";
import type { Vec3 } from "./plan-geometry";

/**
 * Hidden lines for a linked model's drawing, with the kernel's own engine
 * (the one our ductwork and parts use): a seat outline under a table top is
 * removed where the top covers it. Points are in the drawing frame as
 * [u, v, near], near growing toward the viewer (a plan: height; a section:
 * minus the distance past the cut).
 *
 * Occluders are the faces turned toward the viewer. Triangles smaller than
 * MIN_OCCLUDER_AREA_MM2 are skipped: they hide nothing anyone could see at a
 * drawing scale and would only slow the per-edge lookup.
 */

const MIN_OCCLUDER_AREA_MM2 = 2500;

export interface PendingEdge {
  readonly owner: number;
  readonly a: Vec3;
  readonly b: Vec3;
  /** 2D symbol linework: the element's own faces never hide it (they are what it stands for). */
  readonly ignoreOwn: boolean;
}

export class LinkedHiddenLines {
  private readonly faces: Face[] = [];
  private readonly edges: PendingEdge[] = [];

  /** A face turned toward the viewer (counter-clockwise or not; it is ordered here). */
  addTriangle(owner: number, a: Vec3, b: Vec3, c: Vec3): void {
    let poly: ProjPoint[] = [a, b, c].map((p) => ({ u: p[0], v: p[1], near: p[2] }));
    const area = signedArea(poly);
    if (Math.abs(area) < MIN_OCCLUDER_AREA_MM2) return;
    if (area < 0) poly = poly.reverse();
    this.addFace(owner, poly);
  }

  /** A convex outline at one depth (a wall where a section cuts it): everything behind it is hidden. */
  addConvexLoop(owner: number, loop: readonly [number, number][], near: number): void {
    let poly: ProjPoint[] = loop.map(([u, v]) => ({ u, v, near }));
    if (poly.length < 3 || !isConvex(poly)) return;
    const area = signedArea(poly);
    if (Math.abs(area) < MIN_OCCLUDER_AREA_MM2) return;
    if (area < 0) poly = poly.reverse();
    this.addFace(owner, poly);
  }

  private addFace(owner: number, poly: ProjPoint[]): void {
    const plane = planeOf(poly);
    if (!plane) return;
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    let sum = 0;
    for (const q of poly) {
      minU = Math.min(minU, q.u);
      maxU = Math.max(maxU, q.u);
      minV = Math.min(minV, q.v);
      maxV = Math.max(maxV, q.v);
      sum += q.near;
    }
    this.faces.push({ owner: String(owner), piece: -2, poly, ...plane, minU, minV, maxU, maxV, light: 1, meanNear: sum / poly.length });
  }

  addEdge(edge: PendingEdge): void {
    this.edges.push(edge);
  }

  get occluderCount(): number {
    return this.faces.length;
  }

  /** The visible stretches of every pending edge, per owner, as flat [x1, y1, x2, y2…]; and how many stretches were hidden. */
  resolve(): { visible: Map<number, number[]>; hiddenStretches: number } {
    const visible = new Map<number, number[]>();
    const out = (owner: number) => {
      let list = visible.get(owner);
      if (!list) visible.set(owner, (list = []));
      return list;
    };
    if (this.faces.length === 0) {
      for (const e of this.edges) out(e.owner).push(e.a[0], e.a[1], e.b[0], e.b[1]);
      return { visible, hiddenStretches: 0 };
    }
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const f of this.faces) {
      minU = Math.min(minU, f.minU);
      minV = Math.min(minV, f.minV);
      maxU = Math.max(maxU, f.maxU);
      maxV = Math.max(maxV, f.maxV);
    }
    // A finer grid than the kernel's view default: linked furniture is small next to a whole floor.
    const index = new FaceIndex(Math.max(100, cellFor(minU, minV, maxU, maxV) / 4));
    for (const f of this.faces) index.add(f);
    let hiddenStretches = 0;
    for (const e of this.edges) {
      const own = String(e.owner);
      const split = splitHidden({ u: e.a[0], v: e.a[1], near: e.a[2] }, { u: e.b[0], v: e.b[1], near: e.b[2] }, index, undefined, e.ignoreOwn ? (f) => f.owner === own : undefined);
      hiddenStretches += split.hidden.length;
      const list = out(e.owner);
      for (const [p, q] of split.visible) list.push(p.u, p.v, q.u, q.v);
    }
    return { visible, hiddenStretches };
  }
}

function isConvex(poly: readonly ProjPoint[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as ProjPoint;
    const b = poly[(i + 1) % poly.length] as ProjPoint;
    const c = poly[(i + 2) % poly.length] as ProjPoint;
    const cross = (b.u - a.u) * (c.v - b.v) - (b.v - a.v) * (c.u - b.u);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Outline edges of the faces turned toward the viewer, each end keeping its depth. */
export function facingOutline3d(tris: readonly (readonly [Vec3, Vec3, Vec3])[], quantum: number, minNormalZ = 0.5): Array<[Vec3, Vec3]> {
  const count = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  const key = (p: Vec3) => `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)},${Math.round(p[2] / quantum)}`;
  for (const [a, b, c] of tris) {
    if (normalZ(a, b, c) < minNormalZ) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const kp = key(p);
      const kq = key(q);
      if (kp === kq) continue;
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const e = count.get(k);
      if (e) e.n += 1;
      else count.set(k, { a: p, b: q, n: 1 });
    }
  }
  const out: Array<[Vec3, Vec3]> = [];
  for (const e of count.values()) if (e.n === 1) out.push([e.a, e.b]);
  return out;
}

/** Closed loops chained from flat cut segments ([x1, y1, x2, y2…]) whose ends meet within `tol`; open chains are dropped. */
export function closedLoops(flat: readonly number[], tol: number): Array<[number, number][]> {
  const key = (x: number, y: number) => `${Math.round(x / tol)},${Math.round(y / tol)}`;
  const segs: Array<{ a: [number, number]; b: [number, number]; used: boolean }> = [];
  const byEnd = new Map<string, number[]>();
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const s = { a: [flat[i] ?? 0, flat[i + 1] ?? 0] as [number, number], b: [flat[i + 2] ?? 0, flat[i + 3] ?? 0] as [number, number], used: false };
    const n = segs.push(s) - 1;
    for (const p of [s.a, s.b]) {
      const k = key(p[0], p[1]);
      const list = byEnd.get(k);
      if (list) list.push(n);
      else byEnd.set(k, [n]);
    }
  }
  const loops: Array<[number, number][]> = [];
  for (const start of segs) {
    if (start.used) continue;
    start.used = true;
    const loop: [number, number][] = [start.a];
    let tip = start.b;
    const first = key(start.a[0], start.a[1]);
    let closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      if (key(tip[0], tip[1]) === first) {
        closed = true;
        break;
      }
      loop.push(tip);
      const next = (byEnd.get(key(tip[0], tip[1])) ?? []).map((n) => segs[n]).find((s) => s && !s.used);
      if (!next) break;
      next.used = true;
      tip = key(next.a[0], next.a[1]) === key(tip[0], tip[1]) ? next.b : next.a;
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Z of the unit normal: 1 faces the viewer squarely, 0 is edge-on, negative faces away. */
export function normalZ(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len === 0 ? 0 : nz / len;
}

/**
 * The height a plan symbol is drawn at: the median, by area, of the element's
 * faces turned toward the viewer (a chair's seat, a table's top, a door's
 * head). Null when it has none.
 */
export function symbolDepth(tris: readonly (readonly [Vec3, Vec3, Vec3])[]): number | null {
  const parts: Array<{ near: number; area: number }> = [];
  let total = 0;
  for (const [a, b, c] of tris) {
    if (normalZ(a, b, c) < 0.5) continue;
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    if (area <= 0) continue;
    parts.push({ near: (a[2] + b[2] + c[2]) / 3, area });
    total += area;
  }
  if (parts.length === 0) return null;
  parts.sort((x, y) => x.near - y.near);
  let acc = 0;
  for (const p of parts) {
    acc += p.area;
    if (acc >= total / 2) return p.near;
  }
  return parts[parts.length - 1]?.near ?? null;
}
