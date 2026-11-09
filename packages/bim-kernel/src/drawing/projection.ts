import { p3 } from "../routing/geometry";
import type { RunPoint } from "../routing/types";
import type { Vec2 } from "../types";
import { chainLoops, evenOddStrips, vertex, worldTriNormal, type WorldMesh } from "./mesh-projection";
import type { ElementSolid, Piece } from "./solids";

/**
 * Orthographic projection of solids into a view's drawing frame, with exact
 * hidden-line removal against planar faces. A view's projector maps a world
 * point to (u, v) on the drawing and `near` (larger is closer to the viewer),
 * and keeps what lies between `nearMin` and `nearMax` (a section keeps from
 * its cut plane to its far clip; plans and 3D keep everything).
 *
 * Each piece contributes its front-facing faces (occluders) and its edges.
 * An edge is hidden where a face projects over it and is nearer at that
 * point: the face's depth is a plane over (u, v), the edge's depth is linear
 * along it, so each test is a clip of the edge to the face polygon followed by
 * one linear inequality. A piece's own front faces hide its back edges, so
 * boxes and ducts draw correctly from any angle.
 */

export interface ProjPoint {
  readonly u: number;
  readonly v: number;
  readonly near: number;
}

export interface Projector {
  /** Unit vector from the model toward the viewer. */
  readonly toViewer: RunPoint;
  readonly nearMin: number;
  readonly nearMax: number;
  project(p: RunPoint): ProjPoint;
}

export function planProjector(ceiling: boolean): Projector {
  const k = ceiling ? -1 : 1;
  return { toViewer: p3(0, 0, k), nearMin: -Infinity, nearMax: Infinity, project: (p) => ({ u: p.x, v: p.y, near: k * p.z }) };
}

/** Section frame: u along the cut from its start, v elevation, near = minus the distance beyond the cut plane. */
export function sectionProjector(start: Vec2, end: Vec2, direction: 1 | -1, depthMm: number): Projector {
  const len = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const ax = { x: (end.x - start.x) / len, y: (end.y - start.y) / len };
  // perp(axis) = (-y, x); the section looks along direction * perp.
  const look = { x: -ax.y * direction, y: ax.x * direction };
  return {
    toViewer: p3(-look.x, -look.y, 0),
    nearMin: -depthMm,
    nearMax: 0,
    project: (p) => ({ u: (p.x - start.x) * ax.x + (p.y - start.y) * ax.y, v: p.z, near: -((p.x - start.x) * look.x + (p.y - start.y) * look.y) }),
  };
}

const COS30 = Math.cos(Math.PI / 6);
const ISO_NEAR = 1 / Math.sqrt(3);

/** The 3D view's isometric (same mapping as `isoProject`): looking from the south-west, above. */
export function isoProjector(): Projector {
  return {
    toViewer: p3(-ISO_NEAR, -ISO_NEAR, ISO_NEAR),
    nearMin: -Infinity,
    nearMax: Infinity,
    project: (p) => ({ u: (p.x - p.y) * COS30, v: (p.x + p.y) * 0.5 + p.z, near: (-p.x - p.y + p.z) * ISO_NEAR }),
  };
}

export interface Face {
  readonly owner: string;
  readonly piece: number;
  /** Counter-clockwise in (u, v). */
  readonly poly: readonly ProjPoint[];
  /** near = a·u + b·v + c over the face. */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
  /** Lambert term toward the viewer-side light, 0..1 (shaded styles). */
  readonly light: number;
  readonly meanNear: number;
}

export interface ProjEdge {
  readonly a: ProjPoint;
  readonly b: ProjPoint;
  readonly owner: string;
  readonly piece: number;
  /**
   * Set by projectors that know each edge's faces (3D views). "back": both
   * faces turn away, so its own closed convex piece hides it entirely.
   * "front": at least one faces the viewer, so its own piece never hides it.
   */
  readonly facing?: "front" | "back";
}

export interface ProjectedSolid {
  readonly solid: ElementSolid;
  readonly faces: Face[];
  readonly edges: ProjEdge[];
  /** Where the solid crosses the near plane (the section cut), one convex polygon per cut piece. */
  readonly cuts: ProjPoint[][];
  /** A mesh's cut: convex strips to fill and occlude (no outline of their own)… */
  readonly cutFills: ProjPoint[][];
  /** …and the closed outlines around them, drawn with the cut pen. */
  readonly cutOutlines: ProjPoint[][];
  /** Centreline pieces inside the kept range, and where a centreline crosses the cut. */
  readonly centerline: ProjEdge[];
  readonly centerCuts: ProjPoint[];
  /** Nearest and farthest kept point. */
  readonly nearest: number;
  readonly farthest: number;
}

const sub = (a: RunPoint, b: RunPoint) => p3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: RunPoint, b: RunPoint) => a.x * b.x + a.y * b.y + a.z * b.z;
export const lerp = (a: ProjPoint, b: ProjPoint, t: number): ProjPoint => ({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, near: a.near + (b.near - a.near) * t });

export function centroid(points: readonly RunPoint[]): RunPoint {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const q of points) {
    x += q.x;
    y += q.y;
    z += q.z;
  }
  const n = points.length || 1;
  return p3(x / n, y / n, z / n);
}

/** Outward normal of a planar face of a convex piece (Newell's method, flipped away from the piece centre). */
export function outwardNormal(face: readonly RunPoint[], pieceCenter: RunPoint): RunPoint {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i] as RunPoint;
    const b = face[(i + 1) % face.length] as RunPoint;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return p3(0, 0, 0);
  let n = p3(nx / len, ny / len, nz / len);
  if (dot(n, sub(centroid(face), pieceCenter)) < 0) n = p3(-n.x, -n.y, -n.z);
  return n;
}

/** Clip a projected polygon to nearMin <= near <= nearMax. */
function clipPoly(poly: readonly ProjPoint[], lo: number, hi: number): ProjPoint[] {
  let out = [...poly];
  for (const [bound, keepAbove] of [[lo, true], [hi, false]] as const) {
    if (!Number.isFinite(bound) || out.length === 0) continue;
    const inside = (p: ProjPoint) => (keepAbove ? p.near >= bound - 1e-9 : p.near <= bound + 1e-9);
    const next: ProjPoint[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i] as ProjPoint;
      const b = out[(i + 1) % out.length] as ProjPoint;
      const ia = inside(a);
      const ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(lerp(a, b, (bound - a.near) / (b.near - a.near)));
    }
    out = next;
  }
  return out;
}

/** Clip a projected segment to the kept depth range; null when nothing is left. */
export function clipEdge(a: ProjPoint, b: ProjPoint, lo: number, hi: number): [ProjPoint, ProjPoint] | null {
  let t0 = 0;
  let t1 = 1;
  const d = b.near - a.near;
  for (const [bound, keepAbove] of [[lo, true], [hi, false]] as const) {
    if (!Number.isFinite(bound)) continue;
    if (Math.abs(d) < 1e-12) {
      if (keepAbove ? a.near < bound - 1e-9 : a.near > bound + 1e-9) return null;
      continue;
    }
    const t = (bound - a.near) / d;
    if (keepAbove === d > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  if (t1 - t0 < 1e-9) return null;
  return [lerp(a, b, t0), lerp(a, b, t1)];
}

export function signedArea(poly: readonly ProjPoint[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as ProjPoint;
    const b = poly[(i + 1) % poly.length] as ProjPoint;
    s += a.u * b.v - b.u * a.v;
  }
  return s / 2;
}

/** Plane near = a·u + b·v + c through a projected polygon (least-squares over its first three well-spread points). */
export function planeOf(poly: readonly ProjPoint[]): { a: number; b: number; c: number } | null {
  const p0 = poly[0];
  if (!p0) return null;
  let best: { a: number; b: number; c: number } | null = null;
  let bestDet = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const p1 = poly[i] as ProjPoint;
    const p2 = poly[i + 1] as ProjPoint;
    const du1 = p1.u - p0.u;
    const dv1 = p1.v - p0.v;
    const du2 = p2.u - p0.u;
    const dv2 = p2.v - p0.v;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) <= Math.abs(bestDet)) continue;
    const dn1 = p1.near - p0.near;
    const dn2 = p2.near - p0.near;
    const a = (dn1 * dv2 - dn2 * dv1) / det;
    const b = (du1 * dn2 - du2 * dn1) / det;
    best = { a, b, c: p0.near - a * p0.u - b * p0.v };
    bestDet = det;
  }
  return best;
}

/** Convex hull of projected points in (u, v), counter-clockwise, keeping each point's depth. */
export function hullProj(points: readonly ProjPoint[]): ProjPoint[] {
  const pts = [...points].sort((a, b) => a.u - b.u || a.v - b.v);
  if (pts.length < 3) return pts;
  const cr = (o: ProjPoint, a: ProjPoint, b: ProjPoint) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
  const lower: ProjPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2] as ProjPoint, lower[lower.length - 1] as ProjPoint, p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: ProjPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as ProjPoint;
    while (upper.length >= 2 && cr(upper[upper.length - 2] as ProjPoint, upper[upper.length - 1] as ProjPoint, p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function pieceFaces(piece: Piece): RunPoint[][] {
  const n = piece.r0.length;
  const faces: RunPoint[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([piece.r0[i] as RunPoint, piece.r0[j] as RunPoint, piece.r1[j] as RunPoint, piece.r1[i] as RunPoint]);
  }
  faces.push([...piece.r0]);
  faces.push([...piece.r1]);
  return faces;
}

/** Projected edges shorter than this (drawing frame mm) are dropped. */
const MIN_EDGE_MM = 3;

export function projectSolid(solid: ElementSolid, proj: Projector): ProjectedSolid {
  const faces: Face[] = [];
  const edges: ProjEdge[] = [];
  const cuts: ProjPoint[][] = [];
  let nearest = -Infinity;
  let farthest = Infinity;
  const lo = proj.nearMin;
  const hi = proj.nearMax;
  solid.pieces.forEach((piece, pi) => {
    const n = piece.r0.length;
    if (n < 2 || piece.r1.length !== n) return;
    const center = centroid([...piece.r0, ...piece.r1]);
    const p0 = piece.r0.map((q) => proj.project(q));
    const p1 = piece.r1.map((q) => proj.project(q));
    const world = pieceFaces(piece);
    const facing: boolean[] = [];
    world.forEach((wf, fi) => {
      const normal = outwardNormal(wf, center);
      const toward = dot(normal, proj.toViewer);
      facing.push(toward > 1e-6);
      if (toward <= 1e-6) return;
      const projected = fi < n ? [p0[fi] as ProjPoint, p0[(fi + 1) % n] as ProjPoint, p1[(fi + 1) % n] as ProjPoint, p1[fi] as ProjPoint] : fi === n ? p0 : p1;
      let poly = clipPoly(projected, lo, hi);
      if (poly.length < 3) return;
      const area = signedArea(poly);
      if (Math.abs(area) < 1e-6) return;
      if (area < 0) poly = [...poly].reverse();
      const plane = planeOf(poly);
      if (!plane) return;
      let minU = Infinity;
      let minV = Infinity;
      let maxU = -Infinity;
      let maxV = -Infinity;
      let sumNear = 0;
      for (const q of poly) {
        minU = Math.min(minU, q.u);
        maxU = Math.max(maxU, q.u);
        minV = Math.min(minV, q.v);
        maxV = Math.max(maxV, q.v);
        sumNear += q.near;
      }
      faces.push({ owner: solid.owner, piece: pi, poly, ...plane, minU, minV, maxU, maxV, light: toward, meanNear: sumNear / poly.length });
    });
    const keep = (a: ProjPoint, b: ProjPoint) => {
      const c = clipEdge(a, b, lo, hi);
      // A lengthwise edge seen end-on projects to a point: nothing to draw.
      if (!c || Math.hypot(c[1].u - c[0].u, c[1].v - c[0].v) < MIN_EDGE_MM) return;
      edges.push({ a: c[0], b: c[1], owner: solid.owner, piece: pi });
      nearest = Math.max(nearest, c[0].near, c[1].near);
      farthest = Math.min(farthest, c[0].near, c[1].near);
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (piece.edge0) keep(p0[i] as ProjPoint, p0[j] as ProjPoint);
      if (piece.edge1) keep(p1[i] as ProjPoint, p1[j] as ProjPoint);
      // A lengthwise edge of a sampled curve is only a line where the surface turns away (a silhouette).
      const silhouette = facing[i] !== facing[(i - 1 + n) % n];
      if (!piece.smooth || silhouette) keep(p0[i] as ProjPoint, p1[i] as ProjPoint);
    }
    if (Number.isFinite(hi)) {
      const crossings: ProjPoint[] = [];
      const meet = (a: ProjPoint, b: ProjPoint) => {
        if ((a.near - hi) * (b.near - hi) > 0 || a.near === b.near) return;
        crossings.push(lerp(a, b, (hi - a.near) / (b.near - a.near)));
      };
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        meet(p0[i] as ProjPoint, p0[j] as ProjPoint);
        meet(p1[i] as ProjPoint, p1[j] as ProjPoint);
        meet(p0[i] as ProjPoint, p1[i] as ProjPoint);
      }
      const poly = hullProj(crossings);
      if (poly.length >= 3 && Math.abs(signedArea(poly)) > 1) cuts.push(poly);
    }
  });
  const cutFills: ProjPoint[][] = [];
  const cutOutlines: ProjPoint[][] = [];
  if (solid.mesh) {
    const m = projectMesh(solid.owner, solid.mesh, proj, faces, edges, cutFills, cutOutlines);
    nearest = Math.max(nearest, m.nearest);
    farthest = Math.min(farthest, m.farthest);
  }
  const centerline: ProjEdge[] = [];
  const centerCuts: ProjPoint[] = [];
  for (const [a, b] of solid.centerline ?? []) {
    const pa = proj.project(a);
    const pb = proj.project(b);
    const c = clipEdge(pa, pb, lo, hi);
    if (c) centerline.push({ a: c[0], b: c[1], owner: solid.owner, piece: -1 });
    if (Number.isFinite(hi) && (pa.near - hi) * (pb.near - hi) <= 0 && pa.near !== pb.near) centerCuts.push(lerp(pa, pb, (hi - pa.near) / (pb.near - pa.near)));
  }
  return { solid, faces, edges, cuts, cutFills, cutOutlines, centerline, centerCuts, nearest, farthest };
}

/** A triangle mesh's front faces, sharp and silhouette edges, and section cut. */
function projectMesh(owner: string, mesh: WorldMesh, proj: Projector, faces: Face[], edges: ProjEdge[], cutFills: ProjPoint[][], cutOutlines: ProjPoint[][]): { nearest: number; farthest: number } {
  const lo = proj.nearMin;
  const hi = proj.nearMax;
  const count = mesh.positions.length / 3;
  const projected: ProjPoint[] = [];
  for (let i = 0; i < count; i++) projected.push(proj.project(vertex(mesh, i)));
  const tris = mesh.indices.length / 3;
  const facing: boolean[] = [];
  let nearest = -Infinity;
  let farthest = Infinity;
  for (let t = 0; t < tris; t++) {
    const toward = dot(worldTriNormal(mesh, t), proj.toViewer);
    facing.push(toward > 1e-6);
    if (toward <= 1e-6) continue;
    const corner = (k: number) => projected[mesh.indices[3 * t + k] ?? 0] as ProjPoint;
    let poly = clipPoly([corner(0), corner(1), corner(2)], lo, hi);
    if (poly.length < 3) continue;
    const area = signedArea(poly);
    if (Math.abs(area) < 1e-6) continue;
    if (area < 0) poly = [...poly].reverse();
    const plane = planeOf(poly);
    if (!plane) continue;
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    let sumNear = 0;
    for (const q of poly) {
      minU = Math.min(minU, q.u);
      maxU = Math.max(maxU, q.u);
      minV = Math.min(minV, q.v);
      maxV = Math.max(maxV, q.v);
      sumNear += q.near;
    }
    faces.push({ owner, piece: -2, poly, ...plane, minU, minV, maxU, maxV, light: toward, meanNear: sumNear / poly.length });
  }
  for (const e of mesh.edges) {
    const silhouette = e.t1 >= 0 && facing[e.t0] !== facing[e.t1];
    if (!e.sharp && !silhouette) continue;
    // A crease between two faces both turned away is hidden by the mesh itself; leave it to hidden-line removal.
    const c = clipEdge(projected[e.a] as ProjPoint, projected[e.b] as ProjPoint, lo, hi);
    if (!c || Math.hypot(c[1].u - c[0].u, c[1].v - c[0].v) < MIN_EDGE_MM) continue;
    edges.push({ a: c[0], b: c[1], owner, piece: -2 });
    nearest = Math.max(nearest, c[0].near, c[1].near);
    farthest = Math.min(farthest, c[0].near, c[1].near);
  }
  if (Number.isFinite(hi)) {
    const segments: Array<[ProjPoint, ProjPoint]> = [];
    for (let t = 0; t < tris; t++) {
      const ps = [0, 1, 2].map((k) => projected[mesh.indices[3 * t + k] ?? 0] as ProjPoint);
      const crossing: ProjPoint[] = [];
      for (let k = 0; k < 3; k++) {
        const a = ps[k] as ProjPoint;
        const b = ps[(k + 1) % 3] as ProjPoint;
        if ((a.near - hi) * (b.near - hi) < 0) crossing.push(lerp(a, b, (hi - a.near) / (b.near - a.near)));
      }
      if (crossing.length === 2) segments.push([crossing[0] as ProjPoint, crossing[1] as ProjPoint]);
    }
    const loops = chainLoops(segments, 0.01);
    for (const l of loops) if (Math.abs(signedArea(l)) > 1) cutOutlines.push(l);
    cutFills.push(...evenOddStrips(cutOutlines, (u, v) => ({ u, v, near: hi })));
  }
  return { nearest, farthest };
}

/** Faces bucketed on a uniform grid over (u, v), for the per-edge occluder lookup. */
export class FaceIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly faces: Face[] = [];
  /** Per face, the last query that returned it (so a face in several cells comes back once, without a Set per query). */
  private seen = new Uint32Array(64);
  private stamp = 0;
  constructor(private readonly cell: number) {}

  private key(ix: number, iy: number): number {
    return ix * 1_000_003 + iy;
  }

  add(face: Face): void {
    const id = this.faces.length;
    this.faces.push(face);
    if (id >= this.seen.length) {
      const grown = new Uint32Array(this.seen.length * 2);
      grown.set(this.seen);
      this.seen = grown;
    }
    const x0 = Math.floor(face.minU / this.cell);
    const x1 = Math.floor(face.maxU / this.cell);
    const y0 = Math.floor(face.minV / this.cell);
    const y1 = Math.floor(face.maxV / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const k = this.key(ix, iy);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
    }
  }

  query(minU: number, minV: number, maxU: number, maxV: number): Face[] {
    const out: Face[] = [];
    this.stamp += 1;
    const stamp = this.stamp;
    const x0 = Math.floor(minU / this.cell);
    const x1 = Math.floor(maxU / this.cell);
    const y0 = Math.floor(minV / this.cell);
    const y1 = Math.floor(maxV / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (!list) continue;
        for (const id of list) {
          if (this.seen[id] === stamp) continue;
          this.seen[id] = stamp;
          const f = this.faces[id] as Face;
          if (f.maxU < minU || f.minU > maxU || f.maxV < minV || f.minV > maxV) continue;
          out.push(f);
        }
      }
    }
    return out;
  }
}

/** Edges strictly inside a face by this much (drawing frame mm) count as covered; edges on its outline do not. */
const INSET_MM = 0.5;
/** A face must be this much nearer than the edge to hide it. */
const DEPTH_EPS_MM = 1;

/**
 * Split an edge into the stretches that show and the stretches nearer faces
 * hide. `edgeNear` overrides the edge's own depth (plans draw 2D linework at
 * the top of its element); it must be linear along the edge. `ignore` skips
 * faces that cannot hide this edge (its own convex piece, for a front edge).
 */
export function splitHidden(a: ProjPoint, b: ProjPoint, index: FaceIndex, edgeNear?: (t: number) => number, ignore?: (f: Face) => boolean): { visible: Array<[ProjPoint, ProjPoint]>; hidden: Array<[ProjPoint, ProjPoint]> } {
  const minU = Math.min(a.u, b.u);
  const maxU = Math.max(a.u, b.u);
  const minV = Math.min(a.v, b.v);
  const maxV = Math.max(a.v, b.v);
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const nearAt = edgeNear ?? ((t: number) => a.near + (b.near - a.near) * t);
  const near0 = nearAt(0);
  const near1 = nearAt(1);
  const intervals: Array<[number, number]> = [];
  for (const f of index.query(minU, minV, maxU, maxV)) {
    if (ignore?.(f)) continue;
    // A face hides a stretch only where its plane is nearer than the edge by DEPTH_EPS. That margin is linear along the edge: not nearer at either end, never nearer.
    const e0 = f.a * a.u + f.b * a.v + f.c - near0 - DEPTH_EPS_MM;
    const e1 = f.a * b.u + f.b * b.v + f.c - near1 - DEPTH_EPS_MM;
    if (e0 <= 0 && e1 <= 0) continue;
    let t0 = 0;
    let t1 = 1;
    let empty = false;
    const poly = f.poly;
    for (let i = 0; i < poly.length && !empty; i++) {
      const p = poly[i] as ProjPoint;
      const q = poly[(i + 1) % poly.length] as ProjPoint;
      const eu = q.u - p.u;
      const ev = q.v - p.v;
      const elen = Math.hypot(eu, ev);
      if (elen < 1e-9) continue;
      // Inside (left of p→q, counter-clockwise) by INSET: g(t) = g0 + t·gd >= INSET.
      const g0 = (eu * (a.v - p.v) - ev * (a.u - p.u)) / elen - INSET_MM;
      const gd = (eu * dv - ev * du) / elen;
      if (Math.abs(gd) < 1e-12) {
        if (g0 < 0) empty = true;
        continue;
      }
      const t = -g0 / gd;
      if (gd > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t1 - t0 < 1e-9) empty = true;
    }
    if (empty) continue;
    // Within [t0, t1], hidden where face depth exceeds edge depth: h(t) = faceNear - edgeNear - EPS > 0.
    const h0 = f.a * (a.u + du * t0) + f.b * (a.v + dv * t0) + f.c - nearAt(t0) - DEPTH_EPS_MM;
    const h1 = f.a * (a.u + du * t1) + f.b * (a.v + dv * t1) + f.c - nearAt(t1) - DEPTH_EPS_MM;
    if (h0 <= 0 && h1 <= 0) continue;
    if (h0 > 0 && h1 > 0) {
      intervals.push([t0, t1]);
      // One face hides all of it: nothing else can change the answer.
      if (t0 <= 1e-9 && t1 >= 1 - 1e-9) break;
      continue;
    }
    const tz = t0 + ((t1 - t0) * h0) / (h0 - h1);
    intervals.push(h0 > 0 ? [t0, tz] : [tz, t1]);
  }
  const visible: Array<[ProjPoint, ProjPoint]> = [];
  const hidden: Array<[ProjPoint, ProjPoint]> = [];
  const at = (t: number): ProjPoint => ({ u: a.u + du * t, v: a.v + dv * t, near: a.near + (b.near - a.near) * t });
  if (intervals.length === 0) {
    visible.push([a, b]);
    return { visible, hidden };
  }
  intervals.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // Slivers left between two covering faces are not lines anyone draws.
  const minT = MIN_EDGE_MM / (Math.hypot(du, dv) || 1);
  let cursor = 0;
  for (const [s, e] of merged) {
    if (s - cursor > minT) visible.push([at(cursor), at(s)]);
    if (e - s > minT) hidden.push([at(s), at(e)]);
    cursor = Math.max(cursor, e);
  }
  if (1 - cursor > minT) visible.push([at(cursor), at(1)]);
  return { visible, hidden };
}

/** Grid cell for a face index over a window: about 64 cells across the larger side. */
export function cellFor(minU: number, minV: number, maxU: number, maxV: number): number {
  return Math.max(50, Math.max(maxU - minU, maxV - minV) / 64);
}

