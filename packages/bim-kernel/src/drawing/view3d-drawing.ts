import type { RunPoint } from "../routing/types";
import { cameraFrame, type KeepPlane, type View3dCamera } from "../view3d";
import { centroid, hullProj, outwardNormal, pieceFaces, planeOf, signedArea, type Face, type ProjEdge, type ProjPoint, type ProjectedSolid, type Projector } from "./projection";
import { vertex, worldTriNormal, type WorldMesh } from "./mesh-projection";
import type { ElementSolid } from "./solids";

/**
 * Printing a saved 3D view: an orthographic projection along its camera's
 * direction, with every solid clipped to the view's 3D crop box in 3D before
 * it is projected. Where the box cuts through a solid, the cut is a cap: an
 * occluding face drawn as a cut shape (heavy outline and poche), so what was
 * inside the solid never shows through. Hidden lines are then removed exactly
 * as for sections (`drawProjected`).
 */

/** Projected edges shorter than this (model mm in the picture plane) are dropped, as in `projectSolid`. */
const MIN_EDGE_MM = 3;
const EPS = 1e-6;

/** The 3D view's projector: parallel, from its camera, nothing kept or dropped by depth. */
export function cameraProjector(camera: View3dCamera): Projector {
  const frame = cameraFrame(camera);
  return { toViewer: frame.toViewer, nearMin: -Infinity, nearMax: Infinity, project: (q) => frame.project(q) };
}

const side = (pl: KeepPlane, q: RunPoint) => pl.normal.x * q.x + pl.normal.y * q.y + pl.normal.z * q.z + pl.constant;
const mix = (a: RunPoint, b: RunPoint, t: number): RunPoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** A planar polygon clipped to the kept side of every plane (Sutherland–Hodgman in 3D). */
export function clipPolygon3(poly: readonly RunPoint[], planes: readonly KeepPlane[]): RunPoint[] {
  let out = [...poly];
  for (const pl of planes) {
    if (out.length === 0) break;
    const next: RunPoint[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i] as RunPoint;
      const b = out[(i + 1) % out.length] as RunPoint;
      const da = side(pl, a);
      const db = side(pl, b);
      if (da >= -EPS) next.push(a);
      if ((da >= -EPS) !== (db >= -EPS)) next.push(mix(a, b, da / (da - db)));
    }
    out = next;
  }
  return out;
}

/** A segment clipped to the kept side of every plane; null when nothing is left. */
export function clipSegment3(a: RunPoint, b: RunPoint, planes: readonly KeepPlane[]): [RunPoint, RunPoint] | null {
  let t0 = 0;
  let t1 = 1;
  for (const pl of planes) {
    const da = side(pl, a);
    const db = side(pl, b);
    if (da < -EPS && db < -EPS) return null;
    if (da >= -EPS && db >= -EPS) continue;
    const t = da / (da - db);
    if (da < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t1 - t0 < 1e-9) return null;
  }
  return [mix(a, b, t0), mix(a, b, t1)];
}

/** Where a convex piece crosses a plane, clipped to the other planes, in order round the cut; empty when it doesn't. */
function capOf(corners: readonly RunPoint[], edges: ReadonlyArray<readonly [number, number]>, plane: KeepPlane, others: readonly KeepPlane[]): RunPoint[] {
  const crossings: RunPoint[] = [];
  for (const [i, j] of edges) {
    const a = corners[i] as RunPoint;
    const b = corners[j] as RunPoint;
    const da = side(plane, a);
    const db = side(plane, b);
    if (Math.abs(da) < EPS) crossings.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) crossings.push(mix(a, b, da / (da - db)));
  }
  if (crossings.length < 3) return [];
  // Order them round their centre within the plane, then clip to the box's other faces.
  const n = plane.normal;
  const ref = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const e1 = norm({ x: n.y * ref.z - n.z * ref.y, y: n.z * ref.x - n.x * ref.z, z: n.x * ref.y - n.y * ref.x });
  const e2 = { x: n.y * e1.z - n.z * e1.y, y: n.z * e1.x - n.x * e1.z, z: n.x * e1.y - n.y * e1.x };
  const c = centroid(crossings);
  const flat = hullProj(crossings.map((q) => ({ u: (q.x - c.x) * e1.x + (q.y - c.y) * e1.y + (q.z - c.z) * e1.z, v: (q.x - c.x) * e2.x + (q.y - c.y) * e2.y + (q.z - c.z) * e2.z, near: 0 })));
  const ring = flat.map((f) => ({ x: c.x + e1.x * f.u + e2.x * f.v, y: c.y + e1.y * f.u + e2.y * f.v, z: c.z + e1.z * f.u + e2.z * f.v }));
  return ring.length >= 3 ? clipPolygon3(ring, others) : [];
}

function norm(a: RunPoint): RunPoint {
  const len = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

function faceFrom(owner: string, piece: number, worldPoly: readonly RunPoint[], proj: Projector, light: number): Face | null {
  let poly: ProjPoint[] = worldPoly.map((q) => proj.project(q));
  if (poly.length < 3) return null;
  const area = signedArea(poly);
  if (Math.abs(area) < 1e-6) return null;
  if (area < 0) poly = [...poly].reverse();
  const plane = planeOf(poly);
  if (!plane) return null;
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
  return { owner, piece, poly, ...plane, minU, minV, maxU, maxV, light, meanNear: sum / poly.length };
}

/**
 * A modeled part's triangle mesh in a 3D view: front triangles clipped to the
 * box as occluding faces, and its sharp and silhouette edges clipped as lines.
 * Where the box cuts through the mesh no cap is drawn; the cut stays open.
 */
function projectMeshInBox(
  owner: string,
  mesh: WorldMesh,
  proj: Projector,
  planes: readonly KeepPlane[],
  faces: Face[],
  keep: (a: RunPoint, b: RunPoint, piece: number, facing: "front" | "back") => void,
): void {
  const count = mesh.positions.length / 3;
  const corners: RunPoint[] = [];
  for (let i = 0; i < count; i++) corners.push(vertex(mesh, i));
  if (planes.some((pl) => corners.every((q) => side(pl, q) < -EPS))) return;
  const active = planes.filter((pl) => corners.some((q) => side(pl, q) < -EPS));
  const tv = proj.toViewer;
  const tris = mesh.indices.length / 3;
  const facing: boolean[] = [];
  for (let t = 0; t < tris; t++) {
    const n = worldTriNormal(mesh, t);
    const toward = n.x * tv.x + n.y * tv.y + n.z * tv.z;
    facing.push(toward > 1e-6);
    if (toward <= 1e-6) continue;
    const tri = [0, 1, 2].map((k) => corners[mesh.indices[3 * t + k] ?? 0] as RunPoint);
    const clipped = active.length > 0 ? clipPolygon3(tri, active) : tri;
    const face = faceFrom(owner, MESH_PIECE, clipped, proj, toward);
    if (face) faces.push(face);
  }
  for (const e of mesh.edges) {
    const silhouette = e.t1 >= 0 && facing[e.t0] !== facing[e.t1];
    if (!e.sharp && !silhouette) continue;
    keep(corners[e.a] as RunPoint, corners[e.b] as RunPoint, MESH_PIECE, facing[e.t0] || (e.t1 >= 0 && facing[e.t1]) ? "front" : "back");
  }
}

/** The piece index a mesh's faces and edges carry (as `projectSolid` marks them). */
const MESH_PIECE = -2;

/**
 * Project a solid from a 3D view's camera, keeping only what lies inside the
 * planes (its crop box; none: everything). Front faces are clipped as
 * polygons, edges as segments, and each plane that slices a piece and faces
 * the viewer adds a cap: an occluding face, and a cut shape to draw.
 */
export function projectSolidInBox(solid: ElementSolid, proj: Projector, planes: readonly KeepPlane[]): ProjectedSolid {
  const faces: Face[] = [];
  const edges: ProjEdge[] = [];
  const cuts: ProjPoint[][] = [];
  let nearest = -Infinity;
  let farthest = Infinity;
  const tv = proj.toViewer;
  const keep = (a: RunPoint, b: RunPoint, piece: number, facing: "front" | "back") => {
    const c = planes.length > 0 ? clipSegment3(a, b, planes) : ([a, b] as [RunPoint, RunPoint]);
    if (!c) return;
    const pa = proj.project(c[0]);
    const pb = proj.project(c[1]);
    if (Math.hypot(pb.u - pa.u, pb.v - pa.v) < MIN_EDGE_MM) return;
    edges.push({ a: pa, b: pb, owner: solid.owner, piece, facing });
    nearest = Math.max(nearest, pa.near, pb.near);
    farthest = Math.min(farthest, pa.near, pb.near);
  };
  solid.pieces.forEach((piece, pi) => {
    const n = piece.r0.length;
    if (n < 2 || piece.r1.length !== n) return;
    const corners = [...piece.r0, ...piece.r1];
    // Quick reject and accept: a piece wholly outside one plane is gone; wholly inside every plane needs no clipping.
    if (planes.some((pl) => corners.every((q) => side(pl, q) < -EPS))) return;
    const active = planes.filter((pl) => corners.some((q) => side(pl, q) < -EPS));
    const center = centroid(corners);
    const world = pieceFaces(piece);
    const facing: boolean[] = [];
    world.forEach((wf) => {
      const normal = outwardNormal(wf, center);
      const toward = normal.x * tv.x + normal.y * tv.y + normal.z * tv.z;
      facing.push(toward > 1e-6);
      if (toward <= 1e-6) return;
      const clipped = active.length > 0 ? clipPolygon3(wf, active) : wf;
      const face = faceFrom(solid.owner, pi, clipped, proj, toward);
      if (face) faces.push(face);
    });
    // Each edge's two faces: lateral face i with end cap n (ring 0) or n + 1 (ring 1); lengthwise edge i between laterals i - 1 and i.
    const side2 = (f: number, g: number): "front" | "back" => (facing[f] || facing[g] ? "front" : "back");
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (piece.edge0) keep(piece.r0[i] as RunPoint, piece.r0[j] as RunPoint, pi, side2(i, n));
      if (piece.edge1) keep(piece.r1[i] as RunPoint, piece.r1[j] as RunPoint, pi, side2(i, n + 1));
      const prev = (i - 1 + n) % n;
      const silhouette = facing[i] !== facing[prev];
      if (!piece.smooth || silhouette) keep(piece.r0[i] as RunPoint, piece.r1[i] as RunPoint, pi, side2(i, prev));
    }
    if (active.length === 0) return;
    // Edges of the convex piece: both rings and the lengthwise ones, as corner indices.
    const pieceEdges: Array<readonly [number, number]> = [];
    for (let i = 0; i < n; i++) pieceEdges.push([i, (i + 1) % n], [n + i, n + ((i + 1) % n)], [i, n + i]);
    for (const pl of active) {
      // The cap's outside faces away from what is kept: it shows when that side faces the viewer.
      const toward = -(pl.normal.x * tv.x + pl.normal.y * tv.y + pl.normal.z * tv.z);
      if (toward <= 1e-6) continue;
      const cap = capOf(corners, pieceEdges, pl, planes.filter((o) => o !== pl));
      if (cap.length < 3) continue;
      const face = faceFrom(solid.owner, pi, cap, proj, toward);
      if (!face) continue;
      faces.push(face);
      cuts.push([...face.poly]);
    }
  });
  if (solid.mesh) projectMeshInBox(solid.owner, solid.mesh, proj, planes, faces, keep);
  const centerline: ProjEdge[] = [];
  for (const [a, b] of solid.centerline ?? []) {
    const c = planes.length > 0 ? clipSegment3(a, b, planes) : ([a, b] as [RunPoint, RunPoint]);
    if (c) centerline.push({ a: proj.project(c[0]), b: proj.project(c[1]), owner: solid.owner, piece: -1 });
  }
  return { solid, faces, edges, cuts, cutFills: [], cutOutlines: [], centerline, centerCuts: [], nearest, farthest };
}
