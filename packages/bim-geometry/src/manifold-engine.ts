import type { Box, CrossSection, Manifold, ManifoldToplevel, Mat4, Polygons, Vec3 } from "manifold-3d";
import { applyMat4, meshBounds, SolidProgramError, EMPTY_MESH, type ConvexPieceOptions, type ConvexPieces, type ExtrudeOp, type Frame, type LoftOp, type Loop, type MeshOp, type RevolveOp, type SolidEngine, type SolidProgram, type SolidStep, type TriangleMesh, type Vec2Tuple, type Vec3Tuple } from "./program";

/**
 * The solid engine on manifold-3d (Apache-2.0). Profiles go in as `{x, y}`
 * objects, never nested arrays: manifold tells points from lists with
 * `instanceof Array`, which fails for arrays made in another JavaScript realm
 * (a worker, a test sandbox).
 */

type Point = { x: number; y: number };
const EPS = 1e-6;

function loopsToContours(loops: readonly Loop[]): Point[][] {
  return loops.filter((l) => l.length >= 3).map((l) => l.map(([x, y]) => ({ x, y })));
}

/** manifold's binding converts `p instanceof Array ? {x: p[0], y: p[1]} : p`; its typings list only the array form. */
function asPolygons(contours: Point[][]): Polygons {
  return contours as unknown as Polygons;
}

function frameMatrix(x: Vec3Tuple, y: Vec3Tuple, z: Vec3Tuple, origin: Vec3Tuple): Mat4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
}

const add3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3Tuple, k: number): Vec3Tuple => [a[0] * k, a[1] * k, a[2] * k];
const cross3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function inFrame(frame: Frame, u: number, v: number): Vec3Tuple {
  return add3(frame.origin, add3(scale3(frame.uAxis, u), scale3(frame.vAxis, v)));
}

function frameVector(frame: Frame, u: number, v: number): Vec3Tuple {
  return add3(scale3(frame.uAxis, u), scale3(frame.vAxis, v));
}

class Scope {
  private readonly owned: Array<{ delete(): void }> = [];
  keep<T extends { delete(): void }>(value: T): T {
    this.owned.push(value);
    return value;
  }
  dispose(): void {
    for (const o of this.owned.reverse()) o.delete();
    this.owned.length = 0;
  }
}

function section(wasm: ManifoldToplevel, scope: Scope, loops: Point[][], stepId: string): CrossSection {
  if (loops.length === 0) throw new SolidProgramError("The profile has no closed loop", stepId);
  const cs = scope.keep(new wasm.CrossSection(asPolygons(loops), "EvenOdd"));
  if (cs.isEmpty()) throw new SolidProgramError("The profile encloses no area", stepId);
  return cs;
}

function extrude(wasm: ManifoldToplevel, scope: Scope, op: ExtrudeOp, stepId: string): Manifold {
  const height = op.end - op.start;
  if (!(height > EPS)) throw new SolidProgramError("The extrusion has no depth: its end must be beyond its start", stepId);
  const cs = section(wasm, scope, loopsToContours(op.loops), stepId);
  const solid = scope.keep(cs.extrude(height));
  const raised = scope.keep(solid.translate(0, 0, op.start));
  return scope.keep(raised.transform(frameMatrix(op.frame.uAxis, op.frame.vAxis, op.frame.normal, op.frame.origin)));
}

function normalize2(v: Vec2Tuple): Vec2Tuple | null {
  const len = Math.hypot(v[0], v[1]);
  return len < EPS ? null : [v[0] / len, v[1] / len];
}

function revolve(wasm: ManifoldToplevel, scope: Scope, op: RevolveOp, circularSegments: number, stepId: string): Manifold {
  const sweep = op.endDeg - op.startDeg;
  if (!(sweep > EPS) || sweep > 360 + EPS) throw new SolidProgramError("The revolve angle must be more than 0° and at most 360°", stepId);
  const d = normalize2(op.axisDirection);
  if (!d) throw new SolidProgramError("The revolve axis has no direction", stepId);
  let s: Vec2Tuple = [-d[1], d[0]];
  const [au, av] = op.axisPoint;
  const radial = (p: Vec2Tuple) => (p[0] - au) * s[0] + (p[1] - av) * s[1];
  const pts = op.loops.flat();
  const lo = Math.min(...pts.map(radial));
  const hi = Math.max(...pts.map(radial));
  if (lo < -EPS && hi > EPS) throw new SolidProgramError("The profile crosses the revolve axis; keep it on one side", stepId);
  if (hi <= EPS) s = [-s[0], -s[1]];
  const contours = op.loops
    .filter((l) => l.length >= 3)
    .map((l) => l.map((p) => ({ x: Math.max(0, (p[0] - au) * s[0] + (p[1] - av) * s[1]), y: (p[0] - au) * d[0] + (p[1] - av) * d[1] })));
  const cs = section(wasm, scope, contours, stepId);
  const segments = Math.max(3, Math.round((circularSegments * sweep) / 360));
  const solid = scope.keep(cs.revolve(segments, sweep));
  const turned = Math.abs(op.startDeg) > EPS ? scope.keep(solid.rotate(0, 0, op.startDeg)) : solid;
  const sw = frameVector(op.frame, s[0], s[1]);
  const dw = frameVector(op.frame, d[0], d[1]);
  return scope.keep(turned.transform(frameMatrix(sw, cross3(dw, sw), dw, inFrame(op.frame, au, av))));
}

const sub3 = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (a: Vec3Tuple): Vec3Tuple => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

/** Most points a loft ring may be resampled to; past it the loft is refused rather than slowed. */
const MAX_LOFT_RING = 1024;

interface Ring {
  readonly points: Vec3Tuple[];
  readonly normal: Vec3Tuple;
  readonly centroid: Vec3Tuple;
}

function newellNormal(points: readonly Vec3Tuple[]): Vec3Tuple {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec3Tuple;
    const b = points[(i + 1) % points.length] as Vec3Tuple;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return unit3([x, y, z]);
}

function ringOf(section: LoftOp["sections"][number], stepId: string, index: number): Ring {
  const pts: Vec3Tuple[] = [];
  for (const [u, v] of section.loop) {
    const p = inFrame(section.frame, u, v);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > EPS) pts.push(p);
  }
  const first = pts[0];
  const end = pts[pts.length - 1];
  if (first && end && pts.length > 1 && Math.hypot(first[0] - end[0], first[1] - end[1], first[2] - end[2]) <= EPS) pts.pop();
  if (pts.length < 3) throw new SolidProgramError(`Loft section ${index + 1} has fewer than three corners`, stepId);
  const c: [number, number, number] = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] = (c[k] ?? 0) + (p[k] ?? 0) / pts.length;
  const normal = newellNormal(pts);
  if (Math.hypot(normal[0], normal[1], normal[2]) < 0.5) throw new SolidProgramError(`Loft section ${index + 1} encloses no area`, stepId);
  return { points: pts, normal, centroid: c };
}

/** The ring started where the ray from its centroid along `ref` (in its plane) leaves it, so every ring starts on the same side. */
function startedRing(ring: Ring, ref: Vec3Tuple): Vec3Tuple[] {
  const n = ring.normal;
  const e1 = unit3(sub3(ref, scale3(n, dot3(ref, n))));
  if (Math.hypot(e1[0], e1[1], e1[2]) < 0.5) return ring.points;
  const e2 = cross3(n, e1);
  const pts = ring.points;
  let best: { t: number; edge: number; s: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = sub3(pts[i] as Vec3Tuple, ring.centroid);
    const b = sub3(pts[(i + 1) % pts.length] as Vec3Tuple, ring.centroid);
    const a2: Vec2Tuple = [dot3(a, e1), dot3(a, e2)];
    const b2: Vec2Tuple = [dot3(b, e1), dot3(b, e2)];
    const dy = b2[1] - a2[1];
    if (Math.abs(dy) < EPS) continue;
    const s = -a2[1] / dy;
    if (s < -EPS || s > 1 + EPS) continue;
    const t = a2[0] + s * (b2[0] - a2[0]);
    if (t > EPS && (best === null || t < best.t)) best = { t, edge: i, s: Math.min(1, Math.max(0, s)) };
  }
  if (!best) return pts;
  const a = pts[best.edge] as Vec3Tuple;
  const b = pts[(best.edge + 1) % pts.length] as Vec3Tuple;
  const start: Vec3Tuple = [a[0] + (b[0] - a[0]) * best.s, a[1] + (b[1] - a[1]) * best.s, a[2] + (b[2] - a[2]) * best.s];
  const out: Vec3Tuple[] = [start];
  for (let k = 1; k <= pts.length; k++) {
    const p = pts[(best.edge + k) % pts.length] as Vec3Tuple;
    const last = out[out.length - 1] as Vec3Tuple;
    if (Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > EPS && (k < pts.length || Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]) > EPS)) out.push(p);
  }
  return out;
}

/** Perimeter fractions of each corner, 0 at the start. */
function fractions(points: readonly Vec3Tuple[]): number[] {
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec3Tuple;
    const b = points[(i + 1) % points.length] as Vec3Tuple;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lens.push(l);
    total += l;
  }
  const out: number[] = [];
  let run = 0;
  for (const l of lens) {
    out.push(total > 0 ? run / total : 0);
    run += l;
  }
  return out;
}

function sampleAt(points: readonly Vec3Tuple[], fracs: readonly number[], f: number): Vec3Tuple {
  let i = 0;
  while (i + 1 < fracs.length && (fracs[i + 1] ?? 1) <= f) i++;
  const f0 = fracs[i] ?? 0;
  const f1 = i + 1 < fracs.length ? (fracs[i + 1] ?? 1) : 1;
  const a = points[i] as Vec3Tuple;
  const b = points[(i + 1) % points.length] as Vec3Tuple;
  const s = f1 - f0 < EPS ? 0 : (f - f0) / (f1 - f0);
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

function loft(wasm: ManifoldToplevel, scope: Scope, op: LoftOp, stepId: string): Manifold {
  if (op.sections.length < 2) throw new SolidProgramError("A loft needs two or more sections", stepId);
  const rings = op.sections.map((s, i) => ringOf(s, stepId, i));
  // Every ring wound the same way seen along the loft, so its faces point out.
  const oriented = rings.map((r, i) => {
    const next = rings[i + 1];
    const prev = rings[i - 1];
    const dir = next ? sub3(next.centroid, r.centroid) : prev ? sub3(r.centroid, prev.centroid) : r.normal;
    if (Math.hypot(dir[0], dir[1], dir[2]) < EPS) throw new SolidProgramError(`Loft sections ${i + 1} and ${i + 2} are in the same place`, stepId);
    return dot3(r.normal, dir) < 0 ? { points: [...r.points].reverse(), normal: scale3(r.normal, -1), centroid: r.centroid } : r;
  });
  const ref = (op.sections[0] as LoftOp["sections"][number]).frame.uAxis;
  const started = oriented.map((r) => startedRing(r, ref));
  const each = started.map(fractions);
  const all = [...new Set(each.flat().map((f) => Math.round(f * 1e6) / 1e6))].sort((a, b) => a - b);
  if (all.length > MAX_LOFT_RING) throw new SolidProgramError(`The loft's sections have ${all.length} corners between them; at most ${MAX_LOFT_RING}`, stepId);
  const m = all.length;
  const n = started.length;
  const verts = new Float32Array(n * m * 3);
  started.forEach((pts, i) => {
    all.forEach((f, k) => {
      const p = sampleAt(pts, each[i] as number[], f);
      verts.set(p, (i * m + k) * 3);
    });
  });
  const tris: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (let k = 0; k < m; k++) {
      const a = i * m + k;
      const b = i * m + ((k + 1) % m);
      const c = (i + 1) * m + ((k + 1) % m);
      const d = (i + 1) * m + k;
      tris.push(a, b, c, a, c, d);
    }
  }
  const cap = (i: number, flip: boolean) => {
    const r = oriented[i] as Ring;
    const e1 = unit3(sub3(started[i]?.[0] ?? r.centroid, r.centroid));
    const e2 = cross3(r.normal, e1);
    const flat: Point[] = [];
    for (let k = 0; k < m; k++) {
      const p = sub3([verts[(i * m + k) * 3] ?? 0, verts[(i * m + k) * 3 + 1] ?? 0, verts[(i * m + k) * 3 + 2] ?? 0], r.centroid);
      flat.push({ x: dot3(p, e1), y: dot3(p, e2) });
    }
    for (const t of wasm.triangulate(asPolygons([flat]))) {
      const [x, y, z] = [i * m + (t[0] ?? 0), i * m + (t[1] ?? 0), i * m + (t[2] ?? 0)];
      if (flip) tris.push(x, z, y);
      else tris.push(x, y, z);
    }
  };
  cap(0, true);
  cap(n - 1, false);
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: verts, triVerts: Uint32Array.from(tris) });
  const solid = scope.keep(new wasm.Manifold(mesh));
  const status = solid.status();
  if (status !== "NoError") throw new SolidProgramError(`The loft's sections don't make a closed solid (${status}); keep each section a simple loop and the sections apart`, stepId);
  return solid;
}

/** An imported body as a solid, or null when it isn't closed (then it can only add, drawn as is). */
function meshSolid(wasm: ManifoldToplevel, scope: Scope, op: MeshOp): Manifold | null {
  if (op.indices.length === 0) return null;
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: op.positions, triVerts: op.indices });
  mesh.merge();
  let solid: Manifold;
  try {
    solid = scope.keep(new wasm.Manifold(mesh));
  } catch {
    // manifold throws ManifoldError("Not manifold") for an open or self-touching surface (from its own realm, so
    // not an `instanceof Error` here). That is an answer, not a failure: the body is still drawn; cutting it is refused.
    return null;
  }
  return solid.status() === "NoError" && !solid.isEmpty() ? solid : null;
}

function build(wasm: ManifoldToplevel, scope: Scope, step: SolidStep, circularSegments: number): Manifold {
  switch (step.op.kind) {
    case "extrude":
      return extrude(wasm, scope, step.op, step.id);
    case "revolve":
      return revolve(wasm, scope, step.op, circularSegments, step.id);
    case "loft":
      return loft(wasm, scope, step.op, step.id);
    case "mesh": {
      const solid = meshSolid(wasm, scope, step.op);
      if (!solid) throw new SolidProgramError("The imported body isn't a closed solid", step.id);
      return solid;
    }
  }
}

function placed(scope: Scope, solid: Manifold, step: SolidStep): Manifold {
  return step.transform ? scope.keep(solid.transform(step.transform as unknown as Mat4)) : solid;
}

/** An open imported body moved to where its step places it (drawn beside the solid, never cut). */
function rawMesh(step: SolidStep & { readonly op: MeshOp }): TriangleMesh {
  const m = step.transform;
  const positions = new Float32Array(step.op.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p: Vec3Tuple = [step.op.positions[i] ?? 0, step.op.positions[i + 1] ?? 0, step.op.positions[i + 2] ?? 0];
    positions.set(m ? applyMat4(m, p) : p, i);
  }
  let indices = step.op.indices.slice();
  if (m) {
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2] ?? 0, indices[t + 1] ?? 0];
    indices = indices.slice();
  }
  return { positions, indices, triangleCount: indices.length / 3, bounds: meshBounds(positions) };
}

function joinMeshes(meshes: readonly TriangleMesh[]): TriangleMesh {
  const live = meshes.filter((m) => m.triangleCount > 0);
  if (live.length === 0) return EMPTY_MESH;
  if (live.length === 1) return live[0] as TriangleMesh;
  const positions = new Float32Array(live.reduce((s, m) => s + m.positions.length, 0));
  const indices = new Uint32Array(live.reduce((s, m) => s + m.indices.length, 0));
  let pOff = 0;
  let iOff = 0;
  for (const m of live) {
    positions.set(m.positions, pOff);
    for (let i = 0; i < m.indices.length; i++) indices[iOff + i] = (m.indices[i] ?? 0) + pOff / 3;
    pOff += m.positions.length;
    iOff += m.indices.length;
  }
  return { positions, indices, triangleCount: indices.length / 3, bounds: meshBounds(positions) };
}

function toMesh(solid: Manifold): TriangleMesh {
  const mesh = solid.getMesh();
  const stride = mesh.numProp;
  let positions: Float32Array;
  if (stride === 3) positions = mesh.vertProperties.slice();
  else {
    const count = mesh.vertProperties.length / stride;
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = mesh.vertProperties[i * stride] ?? 0;
      positions[i * 3 + 1] = mesh.vertProperties[i * stride + 1] ?? 0;
      positions[i * 3 + 2] = mesh.vertProperties[i * stride + 2] ?? 0;
    }
  }
  const indices = mesh.triVerts.slice();
  return { positions, indices, triangleCount: indices.length / 3, bounds: meshBounds(positions) };
}

/** Whether two solids' boxes touch or overlap (touching counts, so moving one boolean past the other is always exact). */
function boxesMeet(a: Box, b: Box): boolean {
  for (let k = 0; k < 3; k++) if ((a.min[k] ?? 0) > (b.max[k] ?? 0) + EPS || (b.min[k] ?? 0) > (a.max[k] ?? 0) + EPS) return false;
  return true;
}

/** The program's solid (or null) and the open imported bodies drawn beside it. Everything it makes is owned by `scope`. */
function buildProgram(wasm: ManifoldToplevel, scope: Scope, program: SolidProgram): { solid: Manifold | null; open: TriangleMesh[] } {
  let acc: Manifold | null = null;
  const open: TriangleMesh[] = [];
  const unionOf = (solids: readonly Manifold[]): Manifold => (solids.length === 1 && solids[0] ? solids[0] : scope.keep(wasm.Manifold.union([...solids])));
  // Steps are applied in order, batched into as few booleans as the order allows:
  // joins and cuts collect into one union and one difference, (acc ∪ joins) − cuts.
  // A join after pending cuts joins the batch too, because
  // (X − C) ∪ J = (X ∪ J) − (C − J): each pending cut it meets gives up J's
  // material (a small boolean between two features), instead of the whole body
  // being cut and joined again (a boss standing in a recess).
  // Consecutive intersects become one intersect with their union.
  const joins: Manifold[] = [];
  const cuts: Array<{ solid: Manifold; readonly box: Box }> = [];
  const intersects: Manifold[] = [];
  const flush = (into: Manifold | null): Manifold | null => {
    let out = into;
    if (joins.length > 0) {
      const body = unionOf(joins);
      out = out === null ? body : scope.keep(out.add(body));
      joins.length = 0;
    }
    if (cuts.length > 0 && out !== null) out = scope.keep(out.subtract(unionOf(cuts.map((c) => c.solid))));
    cuts.length = 0;
    if (intersects.length > 0 && out !== null) out = scope.keep(out.intersect(unionOf(intersects)));
    intersects.length = 0;
    return out;
  };
  // Pattern and mirror copies share their source step's op: build it once, move each copy.
  const builtOps = new Map<SolidStep["op"], Manifold | null>();
  for (const [i, step] of program.steps.entries()) {
    if (i === 0 && step.operation !== "join") throw new SolidProgramError("The first solid feature must add material; there is nothing yet to cut or intersect", step.id);
    let built: Manifold;
    if (step.op.kind === "mesh") {
      const closed = builtOps.has(step.op) ? (builtOps.get(step.op) ?? null) : meshSolid(wasm, scope, step.op);
      builtOps.set(step.op, closed);
      if (!closed) {
        if (step.operation !== "join") throw new SolidProgramError("The imported body isn't a closed solid, so it can only add material, not cut or intersect", step.id);
        open.push(rawMesh({ ...step, op: step.op }));
        continue;
      }
      built = closed;
    } else {
      const known = builtOps.get(step.op);
      built = known ?? build(wasm, scope, step, program.circularSegments);
      builtOps.set(step.op, built);
    }
    const solid = placed(scope, built, step);
    if (step.operation === "join") {
      if (intersects.length > 0) acc = flush(acc);
      else if (cuts.length > 0) {
        const box = solid.boundingBox();
        for (const c of cuts) if (boxesMeet(c.box, box)) c.solid = scope.keep(c.solid.subtract(solid));
      }
      joins.push(solid);
    } else if (step.operation === "cut") {
      if (intersects.length > 0) acc = flush(acc);
      cuts.push({ solid, box: solid.boundingBox() });
    } else {
      if (intersects.length === 0) acc = flush(acc);
      intersects.push(solid);
    }
  }
  acc = flush(acc);
  if (acc) {
    const status = acc.status();
    if (status !== "NoError") throw new SolidProgramError(`The solid could not be built (${status})`, null);
  }
  return { solid: acc, open };
}

/** A hollow body stays hollow to within this; measured (G15-notes) as the knee between pieces and build time. */
const DEFAULT_CELL_MM = 450;
const DEFAULT_MAX_CELLS_PER_AXIS = 5;

function hullPiece(solid: Manifold): { positions: Float32Array; indices: Uint32Array } {
  const m = toMesh(solid);
  return { positions: m.positions, indices: m.indices };
}

/** Slice a solid along one axis into `n` equal slabs between `lo` and `hi`. */
function slabs(scope: Scope, solid: Manifold, axis: 0 | 1 | 2, lo: number, hi: number, n: number): Manifold[] {
  if (n <= 1) return [solid];
  // An object, not an array: manifold's binding tells the two apart with `instanceof Array`, which fails across realms.
  const normal = { x: axis === 0 ? 1 : 0, y: axis === 1 ? 1 : 0, z: axis === 2 ? 1 : 0 } as unknown as Vec3;
  const out: Manifold[] = [];
  let rest = solid;
  for (let k = 1; k < n; k++) {
    const [above, below] = rest.splitByPlane(normal, lo + ((hi - lo) * k) / n);
    scope.keep(above);
    scope.keep(below);
    if (!below.isEmpty()) out.push(below);
    rest = above;
    if (rest.isEmpty()) return out;
  }
  out.push(rest);
  return out;
}

/** Wrap an initialised manifold module (`await Module()` then `setup()`). */
export function createManifoldEngine(wasm: ManifoldToplevel): SolidEngine {
  return {
    evaluate(program: SolidProgram): TriangleMesh {
      if (program.steps.length === 0) return EMPTY_MESH;
      const scope = new Scope();
      try {
        const { solid, open } = buildProgram(wasm, scope, program);
        return joinMeshes([...(solid ? [toMesh(solid)] : []), ...open]);
      } finally {
        scope.dispose();
      }
    },
    convexPieces(program: SolidProgram, options: ConvexPieceOptions = {}): ConvexPieces {
      const cellMm = options.cellMm ?? DEFAULT_CELL_MM;
      const maxCells = options.maxCellsPerAxis ?? DEFAULT_MAX_CELLS_PER_AXIS;
      if (program.steps.length === 0) return { pieces: [], cellMm };
      const scope = new Scope();
      try {
        const { solid, open } = buildProgram(wasm, scope, program);
        const pieces: Array<{ positions: Float32Array; indices: Uint32Array }> = [];
        if (solid && !solid.isEmpty()) {
          const box = solid.boundingBox();
          const count = (k: 0 | 1 | 2) => Math.max(1, Math.min(maxCells, Math.round(((box.max[k] ?? 0) - (box.min[k] ?? 0)) / cellMm)));
          let cells = [solid];
          for (const k of [0, 1, 2] as const) cells = cells.flatMap((c) => slabs(scope, c, k, box.min[k] ?? 0, box.max[k] ?? 0, count(k)));
          for (const cell of cells) {
            if (cell.isEmpty()) continue;
            for (const part of cell.decompose()) {
              scope.keep(part);
              if (part.isEmpty()) continue;
              pieces.push(hullPiece(scope.keep(part.hull())));
            }
          }
        }
        // An open body has no inside to slice; its hull stands in for it.
        for (const m of open) pieces.push(hullPiece(scope.keep(wasm.Manifold.hull(Array.from({ length: m.positions.length / 3 }, (_, i) => ({ x: m.positions[i * 3] ?? 0, y: m.positions[i * 3 + 1] ?? 0, z: m.positions[i * 3 + 2] ?? 0 }) as unknown as Vec3)))));
        return { pieces, cellMm };
      } finally {
        scope.dispose();
      }
    },
  };
}

let loading: Promise<SolidEngine> | null = null;

/**
 * Load manifold-3d (browser: fetches the 0.5 MB WASM next to the module; Node:
 * reads it from disk). One module per realm: every caller shares the first
 * load. A failed load is not kept, so the next call tries again.
 */
export function loadManifoldEngine(): Promise<SolidEngine> {
  loading ??= (async () => {
    const mod = await import("manifold-3d");
    const wasm = await mod.default();
    wasm.setup();
    return createManifoldEngine(wasm);
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
