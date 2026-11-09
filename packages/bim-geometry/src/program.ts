/**
 * A solid program: everything needed to build one solid, with every value
 * already resolved to a number. Programs are plain data, so they can be
 * hashed, cached, sent to a worker and evaluated identically anywhere.
 *
 * Units are whatever the caller uses (MutinyBIM uses millimetres). Frames are
 * right-handed and orthonormal; a profile point (u, v) lies at
 * origin + u * uAxis + v * vAxis, and `normal` = uAxis × vAxis.
 */

export type Vec2Tuple = readonly [number, number];
export type Vec3Tuple = readonly [number, number, number];

export interface Frame {
  readonly origin: Vec3Tuple;
  readonly uAxis: Vec3Tuple;
  readonly vAxis: Vec3Tuple;
  readonly normal: Vec3Tuple;
}

/** One closed boundary. Loops of a profile combine even-odd, so a loop inside another is a hole. */
export type Loop = readonly Vec2Tuple[];

export interface ExtrudeOp {
  readonly kind: "extrude";
  readonly frame: Frame;
  readonly loops: readonly Loop[];
  /** Distances along the frame normal; `end` > `start`. */
  readonly start: number;
  readonly end: number;
}

export interface RevolveOp {
  readonly kind: "revolve";
  readonly frame: Frame;
  readonly loops: readonly Loop[];
  /** The axis in profile coordinates: a point on it and its direction. */
  readonly axisPoint: Vec2Tuple;
  readonly axisDirection: Vec2Tuple;
  /** Degrees about the axis (right-handed); `end` > `start`, at most 360 apart. */
  readonly startDeg: number;
  readonly endDeg: number;
}

/** One cross-section of a loft: a single closed loop (no holes) in its frame. */
export interface LoftSection {
  readonly frame: Frame;
  readonly loop: Loop;
}

/**
 * A solid through two or more cross-sections in order (a rectangle-to-round
 * transition, a taper, a wye leg). Each section's loop is matched to the next
 * by perimeter length from the point square to the first section's u axis, so
 * any loop shapes join without twisting; faces between sections are ruled.
 */
export interface LoftOp {
  readonly kind: "loft";
  readonly sections: readonly LoftSection[];
}

/**
 * Triangles made elsewhere (an imported vendor body), already in the part's
 * frame. A closed body takes part in booleans like any solid; an open one
 * (most vendor files aren't watertight) can only add, and is drawn as is.
 */
export interface MeshOp {
  readonly kind: "mesh";
  /** x, y, z per vertex. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
}

export type SolidOp = ExtrudeOp | RevolveOp | LoftOp | MeshOp;

export type BooleanOperation = "join" | "cut" | "intersect";

/** A 4×4 affine matrix, column-major (the last row is 0 0 0 1). A negative determinant mirrors. */
export type Mat4Tuple = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

export const IDENTITY_MAT4: Mat4Tuple = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export interface SolidStep {
  /** Caller's id, echoed in errors. */
  readonly id: string;
  readonly op: SolidOp;
  readonly operation: BooleanOperation;
  /** Where the built solid is moved to (a pattern copy, a mirror); absent: where it was built. */
  readonly transform?: Mat4Tuple;
}

/** The product a · b of two column-major affine matrices (apply b, then a). */
export function mulMat4(a: Mat4Tuple, b: Mat4Tuple): Mat4Tuple {
  const out: number[] = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] = (out[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
  return out as unknown as Mat4Tuple;
}

/** A point moved by a column-major affine matrix. */
export function applyMat4(m: Mat4Tuple, p: Vec3Tuple): Vec3Tuple {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/**
 * Convex pieces that together cover a solid: what clash tests read. Each
 * piece is the hull of the solid's material inside one cell of a grid laid
 * over it (about 450 mm, at most five cells along an axis), so a hollow
 * body stays hollow to within one cell, and anything passing through the
 * hollow is clear.
 */
export interface ConvexPieces {
  /** Each piece as its hull's triangles (x, y, z per corner; three corners per triangle, counter-clockwise from outside). */
  readonly pieces: ReadonlyArray<{ readonly positions: Float32Array; readonly indices: Uint32Array }>;
  /** The grid cell size used, per axis. */
  readonly cellMm: number;
}

export interface ConvexPieceOptions {
  /** Target cell edge; the grid never has more than `maxCellsPerAxis` cells along an axis. */
  readonly cellMm?: number;
  readonly maxCellsPerAxis?: number;
}

export interface SolidProgram {
  readonly steps: readonly SolidStep[];
  /** Segments for a full circle (arcs in profiles are already sampled by the caller). */
  readonly circularSegments: number;
}

export interface TriangleMesh {
  /** x, y, z per vertex. */
  readonly positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
  readonly triangleCount: number;
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
}

export interface SolidEngine {
  /** Build the solid. Throws `SolidProgramError` naming the step when a step can't be built. */
  evaluate(program: SolidProgram): TriangleMesh;
  /** The solid as convex pieces (clash). Throws like `evaluate`. */
  convexPieces(program: SolidProgram, options?: ConvexPieceOptions): ConvexPieces;
}

export class SolidProgramError extends Error {
  constructor(
    message: string,
    readonly stepId: string | null,
  ) {
    super(message);
    this.name = "SolidProgramError";
  }
}

export const EMPTY_MESH: TriangleMesh = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
};

/** Bounds of a position array. */
export function meshBounds(positions: Float32Array): TriangleMesh["bounds"] {
  if (positions.length === 0) return EMPTY_MESH.bounds;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}
