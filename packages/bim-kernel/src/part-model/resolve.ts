import type { Loop, SolidStep, Vec3Tuple } from "@permitzip/bim-geometry";
import type { Dim } from "../part-dim";
import type { DetailLevel, PartFeature, PartModel } from "./schema";
import { isPartModel2, type AnyPartModel } from "./schema-2";
import { modelDims2, resolvePartModel2 } from "./resolve-2";
import { boundsOf, DEFAULT_CIRCULAR_SEGMENTS, inFrame, resolveSketchSet, safeNum, type ModelIssue, type ResolvedPartModel, type ResolvedSketch, type ResolveOptions } from "./resolve-common";
import { sketchProfile } from "./sketch";

export { allPlanes, boundsOf, DEFAULT_CIRCULAR_SEGMENTS, inFrame, planeFrame, planeLineIn, resolveSketchSet, safeNum, type ModelIssue, type ResolvedPartModel, type ResolvedSketch, type ResolveOptions } from "./resolve-common";

/**
 * Part model → solved sketches, a numeric solid program and bounds. Pure
 * TypeScript: commands validate with it without loading the geometry engine.
 */

export function featureShows(feature: PartFeature, detail: DetailLevel): boolean {
  return !feature.visibility || feature.visibility.includes(detail);
}

/**
 * Resolve a part model with `num` turning dimensions into numbers (the
 * definition's parameters and the instance's values already bound).
 */
export function resolvePartModel(model: AnyPartModel, num: (d: Dim, field: string) => number, options: ResolveOptions = {}): ResolvedPartModel {
  if (isPartModel2(model)) return resolvePartModel2(model, num, options);
  const detail = options.detail ?? "fine";
  const segments = options.circularSegments ?? DEFAULT_CIRCULAR_SEGMENTS;
  const issues: ModelIssue[] = [];
  const notes: string[] = [];
  const safe = safeNum(num, issues);
  const sketches = resolveSketchSet(model, safe, issues, notes);
  return resolveFeatures1(model, sketches, safe, detail, segments, issues, notes);
}

function resolveFeatures1(model: PartModel, sketches: ReadonlyMap<string, ResolvedSketch>, safe: (d: Dim, field: string) => number | null, detail: DetailLevel, segments: number, issues: ModelIssue[], notes: string[]): ResolvedPartModel {
  const steps: SolidStep[] = [];
  const featureBounds: Array<{ id: string; min: Vec3Tuple; max: Vec3Tuple }> = [];
  const featureIds = new Set<string>();
  for (const feature of model.features) {
    if (featureIds.has(feature.id)) issues.push({ field: feature.id, message: `Feature ${feature.id} is defined twice` });
    featureIds.add(feature.id);
    const rs = sketches.get(feature.sketch);
    if (!rs) {
      issues.push({ field: feature.id, message: `"${feature.name}" uses sketch ${feature.sketch}, which doesn't exist or has a problem` });
      continue;
    }
    const radii = new Map<string, number>();
    for (const e of rs.sketch.entities) if (e.kind === "circle") radii.set(e.id, safe(e.radius, feature.name) ?? 0);
    const exclude = new Set<string>(feature.kind === "revolve" ? [feature.axis] : []);
    const profile = sketchProfile(rs.sketch, rs.solution, radii, segments, exclude);
    for (const p of profile.problems) issues.push({ field: feature.id, message: `"${feature.name}": ${p}` });
    if (profile.loops.length === 0 && profile.problems.length === 0) issues.push({ field: feature.id, message: `"${feature.name}": its sketch has no closed shape to make a solid from` });
    const loops: Loop[] = profile.loops.map((l) => l.map((p) => [p.u, p.v] as const));
    if (feature.kind === "extrude") {
      const start = safe(feature.start, `"${feature.name}" start`);
      const end = safe(feature.end, `"${feature.name}" end`);
      if (start === null || end === null) continue;
      if (!(end > start)) {
        issues.push({ field: feature.id, message: `"${feature.name}" has no depth: its end (${round(end)} mm) must be beyond its start (${round(start)} mm)` });
        continue;
      }
      if (featureShows(feature, detail) && loops.length > 0) steps.push({ id: feature.id, operation: feature.operation, op: { kind: "extrude", frame: rs.frame, loops, start, end } });
      if (feature.operation === "join" && loops.length > 0) {
        const corners: Vec3Tuple[] = [];
        for (const l of loops) for (const [u, v] of l) corners.push(inFrame(rs.frame, u, v, start), inFrame(rs.frame, u, v, end));
        featureBounds.push({ id: feature.id, ...boundsOf(corners) });
      }
    } else {
      const axis = rs.sketch.entities.find((e) => e.id === feature.axis);
      const a = axis?.kind === "line" ? rs.solution.points.get(axis.a) : undefined;
      const b = axis?.kind === "line" ? rs.solution.points.get(axis.b) : undefined;
      if (!a || !b || Math.hypot(b.u - a.u, b.v - a.v) < 1e-6) {
        issues.push({ field: feature.id, message: `"${feature.name}" revolves about ${feature.axis}, which must be a line with length in its sketch` });
        continue;
      }
      const startDeg = safe(feature.startAngle, `"${feature.name}" start angle`);
      const endDeg = safe(feature.endAngle, `"${feature.name}" end angle`);
      if (startDeg === null || endDeg === null) continue;
      if (!(endDeg > startDeg) || endDeg - startDeg > 360) {
        issues.push({ field: feature.id, message: `"${feature.name}" must turn more than 0° and at most 360°` });
        continue;
      }
      const d = { u: (b.u - a.u) / Math.hypot(b.u - a.u, b.v - a.v), v: (b.v - a.v) / Math.hypot(b.u - a.u, b.v - a.v) };
      const s = { u: -d.v, v: d.u };
      let rMin = Infinity;
      let rMax = -Infinity;
      let hMin = Infinity;
      let hMax = -Infinity;
      for (const l of loops) {
        for (const [u, v] of l) {
          const r = (u - a.u) * s.u + (v - a.v) * s.v;
          const h = (u - a.u) * d.u + (v - a.v) * d.v;
          rMin = Math.min(rMin, r);
          rMax = Math.max(rMax, r);
          hMin = Math.min(hMin, h);
          hMax = Math.max(hMax, h);
        }
      }
      if (rMin < -1e-6 && rMax > 1e-6) {
        issues.push({ field: feature.id, message: `"${feature.name}": the profile crosses its axis; keep it on one side` });
        continue;
      }
      if (featureShows(feature, detail) && loops.length > 0) steps.push({ id: feature.id, operation: feature.operation, op: { kind: "revolve", frame: rs.frame, loops, axisPoint: [a.u, a.v], axisDirection: [d.u, d.v], startDeg, endDeg } });
      if (feature.operation === "join" && loops.length > 0) {
        const R = Math.max(Math.abs(rMin), Math.abs(rMax));
        const p0 = inFrame(rs.frame, a.u + d.u * hMin, a.v + d.v * hMin, 0);
        const p1 = inFrame(rs.frame, a.u + d.u * hMax, a.v + d.v * hMax, 0);
        const dw = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const len = Math.hypot(dw[0] ?? 0, dw[1] ?? 0, dw[2] ?? 0) || 1;
        const ext = dw.map((c) => R * Math.sqrt(Math.max(0, 1 - (c / len) ** 2)));
        const lo: Vec3Tuple = [Math.min(p0[0], p1[0]) - (ext[0] ?? 0), Math.min(p0[1], p1[1]) - (ext[1] ?? 0), Math.min(p0[2], p1[2]) - (ext[2] ?? 0)];
        const hi: Vec3Tuple = [Math.max(p0[0], p1[0]) + (ext[0] ?? 0), Math.max(p0[1], p1[1]) + (ext[1] ?? 0), Math.max(p0[2], p1[2]) + (ext[2] ?? 0)];
        featureBounds.push({ id: feature.id, min: lo, max: hi });
      }
    }
  }
  const firstShown = steps[0];
  if (firstShown && firstShown.operation !== "join") issues.push({ field: firstShown.id, message: "The first solid feature must add material (join); there is nothing yet to cut or intersect" });
  if (model.features.length > 0 && !model.features.some((f) => f.operation === "join")) issues.push({ field: "features", message: "The model has no solid feature; add an extrude or revolve that joins" });

  const rowNames = new Set<string>();
  for (const row of model.types) {
    if (rowNames.has(row.name)) issues.push({ field: row.name, message: `The types table lists ${row.name} twice` });
    rowNames.add(row.name);
  }
  return { sketches, program: { steps, circularSegments: segments }, featureBounds, issues, notes };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Every dimension in a model (for finding the parameters it reads). */
export function modelDims(model: AnyPartModel): Dim[] {
  if (isPartModel2(model)) return modelDims2(model);
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
    else out.push(f.startAngle, f.endAngle);
  }
  return out;
}
