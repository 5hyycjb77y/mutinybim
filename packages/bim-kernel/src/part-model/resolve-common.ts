import type { Frame, SolidProgram, Vec3Tuple } from "@permitzip/bim-geometry";
import type { Dim } from "../part-dim";
import { BUILTIN_PLANES, type DetailLevel, type PartModel, type PlaneAxis, type ReferencePlane, type Sketch } from "./schema";
import { solveSketch, type PlaneLine, type SketchSolution } from "./sketch";

/**
 * What both part-model schemas resolve with: planes, sketches, bounds and the
 * resolved shape. `resolve.ts` dispatches to the schema 1 and schema 2
 * resolvers; both read these, so neither imports the other's module for them.
 */

export const DEFAULT_CIRCULAR_SEGMENTS = 48;

export interface ModelIssue {
  readonly field: string;
  readonly message: string;
}

export interface ResolvedSketch {
  readonly sketch: Sketch;
  readonly frame: Frame;
  readonly solution: SketchSolution;
}

export interface ResolvedPartModel {
  readonly sketches: ReadonlyMap<string, ResolvedSketch>;
  readonly program: SolidProgram;
  /** Bounds of each solid (join) feature, local frame. Voids are ignored, so it is conservative. */
  readonly featureBounds: ReadonlyArray<{ readonly id: string; readonly min: Vec3Tuple; readonly max: Vec3Tuple }>;
  readonly issues: readonly ModelIssue[];
  /** Information that is not an error (under-defined sketches). */
  readonly notes: readonly string[];
  /** Imported bodies the host hasn't loaded: the model is valid, but it can't be drawn here until they are (`partMesh` refuses). */
  readonly unloaded?: readonly ModelIssue[];
}

export interface ResolveOptions {
  readonly detail?: DetailLevel;
  readonly circularSegments?: number;
}

export function planeFrame(axis: PlaneAxis, offset: number): Frame {
  switch (axis) {
    case "z":
      return { origin: [0, 0, offset], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
    case "y":
      return { origin: [0, offset, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
    case "x":
      return { origin: [offset, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1], normal: [1, 0, 0] };
  }
}

/** Which sketch coordinate a plane square to the sketch fixes; null when the plane is parallel to it. */
export function planeLineIn(sketchAxis: PlaneAxis, planeAxis: PlaneAxis, value: number): PlaneLine | null {
  if (sketchAxis === planeAxis) return null;
  const u: PlaneAxis = sketchAxis === "x" ? "y" : "x";
  return { coordinate: planeAxis === u ? "u" : "v", value };
}

export function allPlanes(model: Pick<PartModel, "referencePlanes">): ReferencePlane[] {
  return [...BUILTIN_PLANES.map((p) => ({ id: p.id, name: p.name, axis: p.axis, offset: p.offset })), ...model.referencePlanes];
}

export function inFrame(f: Frame, u: number, v: number, w: number): Vec3Tuple {
  return [
    f.origin[0] + f.uAxis[0] * u + f.vAxis[0] * v + f.normal[0] * w,
    f.origin[1] + f.uAxis[1] * u + f.vAxis[1] * v + f.normal[1] * w,
    f.origin[2] + f.uAxis[2] * u + f.vAxis[2] * v + f.normal[2] * w,
  ];
}

export function boundsOf(points: readonly Vec3Tuple[]): { min: Vec3Tuple; max: Vec3Tuple } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? Infinity, p[k] ?? 0);
      max[k] = Math.max(max[k] ?? -Infinity, p[k] ?? 0);
    }
  }
  return { min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0], max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0] };
}

/** A number for a dimension, or null with the reason recorded as an issue. */
export function safeNum(num: (d: Dim, field: string) => number, issues: ModelIssue[]): (d: Dim, field: string) => number | null {
  return (d, field) => {
    try {
      return num(d, field);
    } catch (err) {
      issues.push({ field, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
}

/** Solve every sketch of a model on its reference plane (both schemas share planes and sketches). */
export function resolveSketchSet(model: Pick<PartModel, "referencePlanes" | "sketches">, safe: (d: Dim, field: string) => number | null, issues: ModelIssue[], notes: string[]): Map<string, ResolvedSketch> {
  const planes = new Map<string, { axis: PlaneAxis; offset: number; name: string }>();
  const builtinIds = new Set<string>(BUILTIN_PLANES.map((p) => p.id));
  for (const p of allPlanes(model)) {
    if (planes.has(p.id)) {
      issues.push({ field: p.id, message: builtinIds.has(p.id) ? `${p.id} is a built-in plane name; choose another id` : `Reference plane ${p.id} is defined twice` });
      continue;
    }
    planes.set(p.id, { axis: p.axis, offset: safe(p.offset, `plane ${p.name}`) ?? 0, name: p.name });
  }

  const sketches = new Map<string, ResolvedSketch>();
  for (const sketch of model.sketches) {
    if (sketches.has(sketch.id)) {
      issues.push({ field: sketch.id, message: `Sketch ${sketch.id} is defined twice` });
      continue;
    }
    const plane = planes.get(sketch.plane);
    if (!plane) {
      issues.push({ field: sketch.id, message: `Sketch "${sketch.name}" is on plane ${sketch.plane}, which doesn't exist` });
      continue;
    }
    const planeLines = new Map<string, PlaneLine>();
    for (const [id, p] of planes) {
      const line = planeLineIn(plane.axis, p.axis, p.offset);
      if (line) planeLines.set(id, line);
    }
    const dims = new Map<number, { value?: number; u?: number; v?: number }>();
    sketch.constraints.forEach((c, i) => {
      const where = `sketch "${sketch.name}" constraint ${i + 1}`;
      if (c.kind === "distance" || c.kind === "length" || c.kind === "radius" || c.kind === "angle") {
        const value = safe(c.value, where);
        if (value !== null) dims.set(i, { value });
      } else if (c.kind === "fix") {
        const u = c.u !== undefined ? safe(c.u, where) : undefined;
        const v = c.v !== undefined ? safe(c.v, where) : undefined;
        dims.set(i, { ...(u !== null && u !== undefined ? { u } : {}), ...(v !== null && v !== undefined ? { v } : {}) });
      }
    });
    const radii = new Map<string, number>();
    for (const e of sketch.entities) if (e.kind === "circle") radii.set(e.id, safe(e.radius, `sketch "${sketch.name}" circle ${e.id}`) ?? 0);
    const solution = solveSketch(sketch, { dims, planes: planeLines, radii });
    for (const problem of solution.problems) issues.push({ field: sketch.id, message: problem });
    if (solution.status === "underdefined") notes.push(`Sketch "${sketch.name}" has ${solution.freeDirections} free direction${solution.freeDirections === 1 ? "" : "s"}; it keeps the drawn position there`);
    sketches.set(sketch.id, { sketch, frame: planeFrame(plane.axis, plane.offset), solution });
  }

  return sketches;
}
