import type { Vec2 } from "./types";

/**
 * A read-only linked reference (architecture, existing MEP) reduced to plan
 * linework. Never part of ModelState: references are drawn under native
 * elements and are not editable, snapped to, or validated.
 *
 * Coordinates are millimetres in the host model's plan frame (x east, y north),
 * after the link placement recorded in the fixture manifest has been applied.
 */
/** A linked model's discipline: the three it was written with, or any registered discipline id (`civil`, `fire_alarm`, `vt.elevators`); readers label it from the registry. */
export type ReferenceDiscipline = "architecture" | "structure" | "mep" | (string & {});

export interface ReferenceLayer {
  readonly id: string;
  readonly discipline: ReferenceDiscipline;
  /** cut: section through the plan cut plane; projection: outline seen from above. */
  readonly kind: "cut" | "projection";
  readonly category: string;
  /** Flat [x1, y1, x2, y2, ...] line segments, millimetres. */
  readonly segments: readonly number[];
}

export interface ReferenceLabel {
  readonly text: string;
  readonly at: Vec2;
}

export interface ReferencePlan {
  readonly id: string;
  readonly source: { readonly file: string; readonly sha256: string };
  readonly level: { readonly name: string; readonly elevationMm: number };
  readonly cutHeightMm: number;
  readonly bounds: { readonly min: Vec2; readonly max: Vec2 };
  readonly layers: readonly ReferenceLayer[];
  readonly labels: readonly ReferenceLabel[];
}

export function isReferencePlan(value: unknown): value is ReferencePlan {
  if (typeof value !== "object" || value === null) return false;
  if (!("layers" in value) || !Array.isArray(value.layers)) return false;
  if (!("bounds" in value) || typeof value.bounds !== "object" || value.bounds === null) return false;
  return value.layers.every(
    (l: unknown) => typeof l === "object" && l !== null && "segments" in l && Array.isArray(l.segments) && "id" in l,
  );
}

/** Clip a segment to an axis-aligned box (Liang-Barsky). Returns null when fully outside. */
export function clipSegment(a: Vec2, b: Vec2, min: Vec2, max: Vec2): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - min.x],
    [dx, max.x - a.x],
    [-dy, a.y - min.y],
    [dy, max.y - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}
