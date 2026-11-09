import type { Frame, LoftSection, Loop, Mat4Tuple, SolidStep, Vec3Tuple } from "@permitzip/bim-geometry";
import type { Dim } from "../part-dim";
import { importedBody } from "./bodies";
import { allPlanes, boundsOf, DEFAULT_CIRCULAR_SEGMENTS, inFrame, resolveSketchSet, safeNum, type ModelIssue, type ResolvedPartModel, type ResolvedSketch, type ResolveOptions } from "./resolve-common";
import type { DetailLevel, PlaneAxis } from "./schema";
import type { PartFeature2, PartModel2, PartProfile } from "./schema-2";
import { expandedEntities, sketchProfile, type Uv } from "./sketch";

/**
 * Part model schema 2 → the numeric solid program (the one body every reader
 * draws). Profiles are loops of named sketch edges with holes. A sweep along
 * lines and arcs becomes a chain of extrusions and partial revolutions with
 * the profile carried along the path, so a bend is an exact torus piece.
 * Pattern and mirror copy earlier features' steps with a transform. Pure
 * TypeScript; the kernel never loads the engine.
 */

/** Most steps one model may resolve to (patterns multiply); past it the model is refused rather than slowed. */
export const MAX_RESOLVED_STEPS = 2000;
const MAX_PATTERN_COUNT = 200;
/** Schema 2 samples circles and arcs to this chord error (mm), so a small hole isn't drawn with a large circle's 48 sides. */
export const CHORD_TOLERANCE_MM = 0.5;
const TOL = 0.5;

type Bounds = { readonly id: string; readonly min: Vec3Tuple; readonly max: Vec3Tuple };

const add = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3Tuple, k: number): Vec3Tuple => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3Tuple): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3Tuple): Vec3Tuple => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

/** Rodrigues: v turned by `rad` about unit axis k. */
function rotate(v: Vec3Tuple, k: Vec3Tuple, rad: number): Vec3Tuple {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

function mul(a: Mat4Tuple, b: Mat4Tuple): Mat4Tuple {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] = (out[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
  return out as unknown as Mat4Tuple;
}

function apply(m: Mat4Tuple, p: Vec3Tuple): Vec3Tuple {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

const translation = (t: Vec3Tuple): Mat4Tuple => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];

/** Turn by `deg` about an axis through `center`. */
function rotation(axis: Vec3Tuple, deg: number, center: Vec3Tuple = [0, 0, 0]): Mat4Tuple {
  const k = unit(axis);
  const rad = (deg * Math.PI) / 180;
  const x = rotate([1, 0, 0], k, rad);
  const y = rotate([0, 1, 0], k, rad);
  const z = rotate([0, 0, 1], k, rad);
  const r: Mat4Tuple = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
  return mul(translation(center), mul(r, translation(scale(center, -1))));
}

const AXIS: Readonly<Record<PlaneAxis, Vec3Tuple>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function mirrorAcross(axis: PlaneAxis, offset: number): Mat4Tuple {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const k = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  m[k * 5] = -1;
  m[12 + k] = 2 * offset;
  return m as unknown as Mat4Tuple;
}

function boxCorners(b: { min: Vec3Tuple; max: Vec3Tuple }): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

function shows(f: { readonly visibility?: readonly DetailLevel[] }, detail: DetailLevel): boolean {
  return !f.visibility || f.visibility.includes(detail);
}

/** The loops of a profile: one outer loop and its holes, each from exactly the edges named. */
function profileLoops(rs: ResolvedSketch, profile: PartProfile, radii: ReadonlyMap<string, number>, segments: number): { outer: Loop | null; holes: Loop[]; problems: string[] } {
  const problems: string[] = [];
  const { lines } = expandedEntities(rs.sketch);
  const known = new Set<string>([...rs.sketch.entities.map((e) => e.id), ...lines.keys()]);
  const loopOf = (edges: readonly string[], which: string): Loop | null => {
    for (const e of edges) if (!known.has(e)) problems.push(`Profile "${profile.name}" ${which} names ${e}, which isn't in sketch "${rs.sketch.name}"`);
    const include = new Set(edges);
    const exclude = new Set<string>();
    for (const e of rs.sketch.entities) if (!include.has(e.id)) exclude.add(e.id);
    for (const id of lines.keys()) {
      const dot = id.lastIndexOf(".");
      const owner = dot > 0 ? id.slice(0, dot) : null;
      if (!include.has(id) && !(owner !== null && include.has(owner))) exclude.add(id);
    }
    const got = sketchProfile(rs.sketch, rs.solution, radii, segments, exclude, CHORD_TOLERANCE_MM);
    for (const p of got.problems) problems.push(`Profile "${profile.name}" ${which}: ${p}`);
    if (got.problems.length > 0) return null;
    if (got.loops.length !== 1) {
      problems.push(`Profile "${profile.name}" ${which} makes ${got.loops.length} closed loops from its edges; it needs exactly one`);
      return null;
    }
    return (got.loops[0] ?? []).map((p) => [p.u, p.v] as const);
  };
  const outer = loopOf(profile.outer.edges, "outline");
  const holes: Loop[] = [];
  (profile.holes ?? []).forEach((h, i) => {
    const l = loopOf(h.edges, `hole ${i + 1}`);
    if (l) holes.push(l);
  });
  return { outer, holes, problems };
}

interface PathSegment {
  readonly kind: "line" | "arc";
  readonly a: Vec3Tuple;
  readonly b: Vec3Tuple;
  /** Arcs: centre, and the axis it turns about (right-handed) going from a to b. */
  readonly center?: Vec3Tuple;
  readonly axis?: Vec3Tuple;
  readonly angleDeg?: number;
}

/** A sweep path's edges as one chain from its open end (or its first edge when closed), in 3D. */
function pathChain(rs: ResolvedSketch, edges: readonly string[], label: string, problems: string[], profileFrame: Frame): PathSegment[] {
  const at = (id: string): Uv | null => rs.solution.points.get(id) ?? null;
  const { lines } = expandedEntities(rs.sketch);
  type Raw = { kind: "line" | "arc"; s: Uv; e: Uv; c?: Uv };
  const raw: Raw[] = [];
  for (const id of edges) {
    const line = lines.get(id);
    if (line) {
      const s = at(line.a);
      const e = at(line.b);
      if (s && e) raw.push({ kind: "line", s, e });
      continue;
    }
    const ent = rs.sketch.entities.find((x) => x.id === id);
    if (ent?.kind === "arc") {
      const s = at(ent.start);
      const e = at(ent.end);
      const c = at(ent.center);
      if (s && e && c) raw.push({ kind: "arc", s, e, c });
      continue;
    }
    problems.push(`${label}'s path names ${id}; a path is lines and arcs of sketch "${rs.sketch.name}"`);
  }
  if (raw.length === 0) return [];
  const same = (p: Uv, q: Uv) => Math.hypot(p.u - q.u, p.v - q.v) < TOL;
  // Start at the free end that lies on the profile's plane (a path may be drawn either way round).
  const offPlane = (p: Uv) => Math.abs(dot(sub(inFrame(rs.frame, p.u, p.v, 0), profileFrame.origin), profileFrame.normal));
  let startIdx = 0;
  let startFromS = true;
  let best = Infinity;
  for (const [i, r] of raw.entries()) {
    for (const fromS of [true, false]) {
      const end = fromS ? r.s : r.e;
      const free = !raw.some((o, j) => j !== i && (same(o.s, end) || same(o.e, end)));
      if (!free) continue;
      const d = offPlane(end);
      if (d < best - 1e-9) {
        best = d;
        startIdx = i;
        startFromS = fromS;
      }
    }
  }
  const used = new Set<number>([startIdx]);
  const ordered: Array<{ r: Raw; forward: boolean }> = [{ r: raw[startIdx] as Raw, forward: startFromS }];
  for (;;) {
    const last = ordered[ordered.length - 1] as { r: Raw; forward: boolean };
    const end = last.forward ? last.r.e : last.r.s;
    const next = raw.findIndex((o, j) => !used.has(j) && (same(o.s, end) || same(o.e, end)));
    if (next < 0) break;
    used.add(next);
    const o = raw[next] as Raw;
    ordered.push({ r: o, forward: same(o.s, end) });
  }
  if (used.size !== raw.length) problems.push(`${label}'s path isn't one chain: its edges must join end to end`);
  const w = (p: Uv) => inFrame(rs.frame, p.u, p.v, 0);
  const n = rs.frame.normal;
  return ordered.map(({ r, forward }) => {
    const a = w(forward ? r.s : r.e);
    const b = w(forward ? r.e : r.s);
    if (r.kind === "line" || !r.c) return { kind: "line" as const, a, b };
    const c = w(r.c);
    // Arcs run counter-clockwise about the sketch normal from start to end.
    const a0 = Math.atan2(r.s.v - r.c.v, r.s.u - r.c.u);
    let a1 = Math.atan2(r.e.v - r.c.v, r.e.u - r.c.u);
    while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI;
    return { kind: "arc" as const, a, b, center: c, axis: forward ? n : scale(n, -1), angleDeg: ((a1 - a0) * 180) / Math.PI };
  });
}

function tangentAtStart(s: PathSegment): Vec3Tuple {
  return s.kind === "line" || !s.center || !s.axis ? unit(sub(s.b, s.a)) : unit(cross(s.axis, sub(s.a, s.center)));
}

function tangentAtEnd(s: PathSegment): Vec3Tuple {
  return s.kind === "line" || !s.center || !s.axis ? unit(sub(s.b, s.a)) : unit(cross(s.axis, sub(s.b, s.center)));
}

function moved(f: Frame, by: (v: Vec3Tuple) => Vec3Tuple, origin: Vec3Tuple): Frame {
  return { origin, uAxis: by(f.uAxis), vAxis: by(f.vAxis), normal: by(f.normal) };
}

export function resolvePartModel2(model: PartModel2, num: (d: Dim, field: string) => number, options: ResolveOptions = {}): ResolvedPartModel {
  const detail = options.detail ?? "fine";
  const segments = options.circularSegments ?? DEFAULT_CIRCULAR_SEGMENTS;
  const issues: ModelIssue[] = [];
  const notes: string[] = [];
  const unloaded: ModelIssue[] = [];
  const safe = safeNum(num, issues);
  const sketches = resolveSketchSet(model, safe, issues, notes);
  const planes = new Map(allPlanes(model).map((p) => [p.id, p]));

  const radiiOf = (rs: ResolvedSketch): Map<string, number> => {
    const radii = new Map<string, number>();
    for (const e of rs.sketch.entities) if (e.kind === "circle") radii.set(e.id, safe(e.radius, `sketch "${rs.sketch.name}" circle ${e.id}`) ?? 0);
    return radii;
  };

  const profiles = new Map<string, { rs: ResolvedSketch; outer: Loop; holes: Loop[] }>();
  for (const p of model.profiles) {
    if (profiles.has(p.id)) {
      issues.push({ field: p.id, message: `Profile ${p.id} is defined twice` });
      continue;
    }
    const rs = sketches.get(p.sketch);
    if (!rs) {
      issues.push({ field: p.id, message: `Profile "${p.name}" is on sketch ${p.sketch}, which doesn't exist or has a problem` });
      continue;
    }
    const got = profileLoops(rs, p, radiiOf(rs), segments);
    for (const m of got.problems) issues.push({ field: p.id, message: m });
    if (got.outer) profiles.set(p.id, { rs, outer: got.outer, holes: got.holes });
  }

  const stepsBy = new Map<string, SolidStep[]>();
  const boundsBy = new Map<string, Bounds[]>();
  const order: string[] = [];
  let total = 0;

  const profileFor = (f: PartFeature2, id: string) => {
    const p = profiles.get(id);
    if (!p) issues.push({ field: f.id, message: `"${f.name}" uses profile ${id}, which doesn't exist or has a problem` });
    return p ?? null;
  };
  const loopsBounds = (id: string, frame: Frame, loops: readonly Loop[], ws: readonly number[]): Bounds => {
    const pts: Vec3Tuple[] = [];
    for (const l of loops) for (const [u, v] of l) for (const w of ws) pts.push(inFrame(frame, u, v, w));
    return { id, ...boundsOf(pts) };
  };

  for (const f of model.features) {
    if (stepsBy.has(f.id)) {
      issues.push({ field: f.id, message: `Feature ${f.id} is defined twice` });
      continue;
    }
    const steps: SolidStep[] = [];
    const bounds: Bounds[] = [];
    const visible = f.kind === "pattern" || f.kind === "mirror" ? true : shows(f, detail);
    switch (f.kind) {
      case "extrude": {
        const p = profileFor(f, f.profile);
        const start = safe(f.start, `"${f.name}" start`);
        const end = safe(f.end, `"${f.name}" end`);
        if (!p || start === null || end === null) break;
        if (!(end > start)) {
          issues.push({ field: f.id, message: `"${f.name}" has no depth: its end (${round(end)} mm) must be beyond its start (${round(start)} mm)` });
          break;
        }
        const loops = [p.outer, ...p.holes];
        if (visible) steps.push({ id: f.id, operation: f.operation, op: { kind: "extrude", frame: p.rs.frame, loops, start, end } });
        if (f.operation === "join") bounds.push(loopsBounds(f.id, p.rs.frame, [p.outer], [start, end]));
        break;
      }
      case "revolve": {
        const p = profileFor(f, f.profile);
        if (!p) break;
        const axis = p.rs.sketch.entities.find((e) => e.id === f.axis);
        const a = axis?.kind === "line" ? p.rs.solution.points.get(axis.a) : undefined;
        const b = axis?.kind === "line" ? p.rs.solution.points.get(axis.b) : undefined;
        if (!a || !b || Math.hypot(b.u - a.u, b.v - a.v) < 1e-6) {
          issues.push({ field: f.id, message: `"${f.name}" revolves about ${f.axis}, which must be a line with length in its profile's sketch` });
          break;
        }
        const startDeg = safe(f.startAngle, `"${f.name}" start angle`);
        const endDeg = safe(f.endAngle, `"${f.name}" end angle`);
        if (startDeg === null || endDeg === null) break;
        if (!(endDeg > startDeg) || endDeg - startDeg > 360) {
          issues.push({ field: f.id, message: `"${f.name}" must turn more than 0° and at most 360°` });
          break;
        }
        const l = Math.hypot(b.u - a.u, b.v - a.v);
        const d = { u: (b.u - a.u) / l, v: (b.v - a.v) / l };
        const loops = [p.outer, ...p.holes];
        if (visible) steps.push({ id: f.id, operation: f.operation, op: { kind: "revolve", frame: p.rs.frame, loops, axisPoint: [a.u, a.v], axisDirection: [d.u, d.v], startDeg, endDeg } });
        if (f.operation === "join") {
          // The full turn's box: every profile point at every quarter of its circle.
          const c0 = inFrame(p.rs.frame, a.u, a.v, 0);
          const k = unit(sub(inFrame(p.rs.frame, b.u, b.v, 0), c0));
          const pts: Vec3Tuple[] = [];
          for (const [u, v] of p.outer) {
            const q = inFrame(p.rs.frame, u, v, 0);
            for (let i = 0; i < 8; i++) pts.push(add(c0, rotate(sub(q, c0), k, (i * Math.PI) / 4)));
          }
          bounds.push({ id: f.id, ...boundsOf(pts) });
        }
        break;
      }
      case "sweep": {
        const p = profileFor(f, f.profile);
        const prs = sketches.get(f.path.sketch);
        if (!prs) issues.push({ field: f.id, message: `"${f.name}"'s path is on sketch ${f.path.sketch}, which doesn't exist or has a problem` });
        if (!p || !prs) break;
        const problems: string[] = [];
        const chain = pathChain(prs, f.path.edges, `"${f.name}"`, problems, p.rs.frame);
        for (const m of problems) issues.push({ field: f.id, message: m });
        const first = chain[0];
        if (problems.length > 0 || !first) break;
        let frame = p.rs.frame;
        const t0 = tangentAtStart(first);
        if (Math.abs(dot(frame.normal, t0)) < 0.999) {
          issues.push({ field: f.id, message: `"${f.name}": the profile must be square to the path where the path starts` });
          break;
        }
        if (Math.abs(dot(sub(first.a, frame.origin), frame.normal)) > TOL) {
          issues.push({ field: f.id, message: `"${f.name}": the path must start on the profile's plane` });
          break;
        }
        const loops = [p.outer, ...p.holes];
        const pts: Vec3Tuple[] = [];
        const sample = (fr: Frame) => {
          for (const [u, v] of p.outer) pts.push(inFrame(fr, u, v, 0));
        };
        sample(frame);
        let ok = true;
        for (const [i, seg] of chain.entries()) {
          if (i > 0) {
            const prev = chain[i - 1] as PathSegment;
            if (dot(tangentAtEnd(prev), tangentAtStart(seg)) < 0.999) {
              issues.push({ field: f.id, message: `"${f.name}": the path turns sharply at corner ${i}; put an arc (a bend) there` });
              ok = false;
              break;
            }
          }
          const id = `${f.id}.${i + 1}`;
          if (seg.kind === "line") {
            const L = len(sub(seg.b, seg.a));
            if (L < 1e-6) continue;
            const t = unit(sub(seg.b, seg.a));
            const along = dot(frame.normal, t) > 0;
            if (visible) steps.push({ id, operation: f.operation, op: { kind: "extrude", frame, loops, start: along ? 0 : -L, end: along ? L : 0 } });
            frame = moved(frame, (v) => v, add(frame.origin, scale(t, L)));
          } else {
            const c = seg.center as Vec3Tuple;
            const k = seg.axis as Vec3Tuple;
            const deg = seg.angleDeg ?? 0;
            const rel = sub(c, frame.origin);
            if (visible) steps.push({ id, operation: f.operation, op: { kind: "revolve", frame, loops, axisPoint: [dot(rel, frame.uAxis), dot(rel, frame.vAxis)], axisDirection: [dot(k, frame.uAxis), dot(k, frame.vAxis)], startDeg: 0, endDeg: deg } });
            for (let s = 1; s <= 8; s++) {
              const rad = (((deg * s) / 8) * Math.PI) / 180;
              sample(moved(frame, (v) => rotate(v, k, rad), add(c, rotate(sub(frame.origin, c), k, rad))));
            }
            const rad = (deg * Math.PI) / 180;
            frame = moved(frame, (v) => rotate(v, k, rad), add(c, rotate(sub(frame.origin, c), k, rad)));
          }
          sample(frame);
        }
        if (ok && f.operation === "join") bounds.push({ id: f.id, ...boundsOf(pts) });
        if (!ok) steps.length = 0;
        break;
      }
      case "loft": {
        const sections: LoftSection[] = [];
        for (const id of f.profiles) {
          const p = profileFor(f, id);
          if (!p) continue;
          if (p.holes.length > 0) issues.push({ field: f.id, message: `"${f.name}": profile ${id} has holes; a loft section is one outline (cut the hole after)` });
          sections.push({ frame: p.rs.frame, loop: p.outer });
        }
        if (sections.length !== f.profiles.length) break;
        if (visible) steps.push({ id: f.id, operation: f.operation, op: { kind: "loft", sections } });
        if (f.operation === "join") {
          const pts: Vec3Tuple[] = [];
          for (const s of sections) for (const [u, v] of s.loop) pts.push(inFrame(s.frame, u, v, 0));
          bounds.push({ id: f.id, ...boundsOf(pts) });
        }
        break;
      }
      case "imported": {
        const x = safe(f.at.x, `"${f.name}" x`);
        const y = safe(f.at.y, `"${f.name}" y`);
        const z = safe(f.at.z, `"${f.name}" z`);
        const turn = f.rotationDeg === undefined ? 0 : safe(f.rotationDeg, `"${f.name}" turn`);
        if (x === null || y === null || z === null || turn === null) break;
        const body = importedBody(f.body, detail) ?? importedBody(f.body, "fine");
        if (!body) {
          unloaded.push({ field: f.id, message: `"${f.name}": its body file (${f.body.format}, ${f.body.contentHash.slice(0, 12)}) isn't loaded here, so the part can't be drawn yet` });
          break;
        }
        const transform = mul(translation([x, y, z]), rotation([0, 0, 1], turn));
        if (visible) steps.push({ id: f.id, operation: f.operation, op: { kind: "mesh", positions: body.positions, indices: body.indices }, transform });
        if (f.operation === "join") bounds.push({ id: f.id, ...boundsOf(boxCorners(body.bounds).map((q) => apply(transform, q))) });
        break;
      }
      case "pattern":
      case "mirror": {
        const transforms: Mat4Tuple[] = [];
        if (f.kind === "mirror") {
          const plane = planes.get(f.plane);
          if (!plane) {
            issues.push({ field: f.id, message: `"${f.name}" mirrors about plane ${f.plane}, which doesn't exist` });
            break;
          }
          transforms.push(mirrorAcross(plane.axis, safe(plane.offset, `plane ${plane.name}`) ?? 0));
        } else {
          const arr = f.arrangement;
          const countRaw = safe(arr.count, `"${f.name}" count`);
          if (countRaw === null) break;
          const count = Math.round(countRaw);
          if (count < 1 || count > MAX_PATTERN_COUNT) {
            issues.push({ field: f.id, message: `"${f.name}" makes ${count} copies; between 1 and ${MAX_PATTERN_COUNT}` });
            break;
          }
          if (arr.kind === "linear") {
            const spacing = safe(arr.spacing, `"${f.name}" spacing`);
            if (spacing === null) break;
            for (let i = 1; i < count; i++) transforms.push(translation(scale(AXIS[arr.axis], spacing * i)));
          } else {
            const angle = safe(arr.angle, `"${f.name}" angle`);
            const cx = safe(arr.center.x, `"${f.name}" centre`);
            const cy = safe(arr.center.y, `"${f.name}" centre`);
            const cz = safe(arr.center.z, `"${f.name}" centre`);
            if (angle === null || cx === null || cy === null || cz === null) break;
            const full = Math.abs(Math.abs(angle) - 360) < 1e-6;
            const stepDeg = full ? angle / count : count > 1 ? angle / (count - 1) : 0;
            for (let i = 1; i < count; i++) transforms.push(rotation(AXIS[arr.axis], stepDeg * i, [cx, cy, cz]));
          }
        }
        for (const ref of f.features) {
          const src = stepsBy.get(ref);
          if (!src) {
            issues.push({ field: f.id, message: `"${f.name}" repeats ${ref}, which isn't an earlier feature` });
            continue;
          }
          transforms.forEach((t, i) => {
            for (const s of src) steps.push({ ...s, id: `${s.id}~${f.id}${i + 1}`, transform: s.transform ? mul(t, s.transform) : t });
            for (const b of boundsBy.get(ref) ?? []) bounds.push({ id: `${b.id}~${f.id}${i + 1}`, ...boundsOf(boxCorners(b).map((q) => apply(t, q))) });
          });
        }
        break;
      }
    }
    total += steps.length;
    if (total > MAX_RESOLVED_STEPS) {
      issues.push({ field: f.id, message: `The model makes more than ${MAX_RESOLVED_STEPS} solids by "${f.name}"; use fewer copies` });
      break;
    }
    stepsBy.set(f.id, steps);
    boundsBy.set(f.id, bounds);
    order.push(f.id);
  }

  // A repeated feature's own steps stay; its copies follow it in the program, in feature order.
  const steps = order.flatMap((id) => stepsBy.get(id) ?? []);
  const featureBounds = order.flatMap((id) => boundsBy.get(id) ?? []);
  const firstShown = steps[0];
  if (firstShown && firstShown.operation !== "join" && unloaded.length === 0) issues.push({ field: firstShown.id, message: "The first solid feature must add material (join); there is nothing yet to cut or intersect" });
  if (model.features.length > 0 && !model.features.some((f) => f.kind !== "pattern" && f.kind !== "mirror" && f.operation === "join")) issues.push({ field: "features", message: "The model has no solid feature; add one that joins" });
  for (const s of model.symbols) if (!sketches.has(s.sketch)) issues.push({ field: s.id, message: `Symbol "${s.name}" draws sketch ${s.sketch}, which doesn't exist or has a problem` });
  const rowNames = new Set<string>();
  for (const row of model.types) {
    if (rowNames.has(row.name)) issues.push({ field: row.name, message: `The types table lists ${row.name} twice` });
    rowNames.add(row.name);
  }
  return { sketches, program: { steps, circularSegments: segments }, featureBounds, issues, notes, unloaded };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Every dimension in a schema 2 model (for finding the parameters it reads). */
export function modelDims2(model: PartModel2): Dim[] {
  const out: Dim[] = [];
  for (const p of model.referencePlanes) out.push(p.offset);
  for (const s of model.sketches) {
    for (const e of s.entities) if (e.kind === "circle") out.push(e.radius);
    for (const c of s.constraints) {
      if (c.kind === "distance" || c.kind === "length" || c.kind === "radius" || c.kind === "angle") out.push(c.value);
      if (c.kind === "fix") {
        if (c.u !== undefined) out.push(c.u);
        if (c.v !== undefined) out.push(c.v);
      }
    }
  }
  for (const f of model.features) {
    if (f.kind === "extrude") out.push(f.start, f.end);
    else if (f.kind === "revolve") out.push(f.startAngle, f.endAngle);
    else if (f.kind === "imported") out.push(f.at.x, f.at.y, f.at.z, ...(f.rotationDeg !== undefined ? [f.rotationDeg] : []));
    else if (f.kind === "pattern") {
      out.push(f.arrangement.count);
      if (f.arrangement.kind === "linear") out.push(f.arrangement.spacing);
      else out.push(f.arrangement.angle, f.arrangement.center.x, f.arrangement.center.y, f.arrangement.center.z);
    }
  }
  return out;
}
