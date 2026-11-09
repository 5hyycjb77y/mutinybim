/**
 * Coordinate conventions.
 *
 * Kernel and IFC: millimetres / metres, X east, Y north, Z up.
 * Scene (three.js, as That Open Fragments renders IFC): metres, X east, Y up,
 * Z south (= -IFC Y). Everything authored in the kernel is mapped with the same
 * rule so it lands exactly on the linked IFC references.
 */

export type Vec3Tuple = readonly [number, number, number];
/** Row-major 4x4. */
export type Mat4Rows = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

export const MM = 0.001;

/** Kernel plan point (mm) at an elevation (mm) to scene metres. */
export function kernelToScene(x: number, y: number, elevationMm: number): Vec3Tuple {
  return [x * MM, elevationMm * MM, -y * MM];
}

/** Scene metres back to kernel plan millimetres (elevation dropped). */
export function sceneToKernel(point: { readonly x: number; readonly z: number }): { x: number; y: number } {
  return { x: point.x / MM, y: -point.z / MM };
}

/** Plan direction (kernel) to a rotation about the scene's up axis. */
export function planAngleToSceneYaw(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

const IFC_TO_SCENE: Mat4Rows = [
  [1, 0, 0, 0],
  [0, 0, 1, 0],
  [0, -1, 0, 0],
  [0, 0, 0, 1],
];
const SCENE_TO_IFC: Mat4Rows = [
  [1, 0, 0, 0],
  [0, 0, -1, 0],
  [0, 1, 0, 0],
  [0, 0, 0, 1],
];

export function multiply(a: Mat4Rows, b: Mat4Rows): Mat4Rows {
  const row = (r: number): [number, number, number, number] => {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r]![k]! * b[k]![c]!;
      out[c] = sum;
    }
    return out;
  };
  return [row(0), row(1), row(2), row(3)];
}

/**
 * A link placement recorded by the exporter (IFC axes, metres, row-major,
 * link file -> host file) expressed in scene axes, so it can be applied to the
 * link's Fragments object directly.
 */
export function ifcPlacementToScene(ifcRows: Mat4Rows): Mat4Rows {
  return multiply(IFC_TO_SCENE, multiply(ifcRows, SCENE_TO_IFC));
}

/** Column-major flat array, the layout THREE.Matrix4.fromArray expects. */
export function toColumnMajor(rows: Mat4Rows): number[] {
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(rows[r]![c]!);
  return out;
}

export function transformPoint(rows: Mat4Rows, p: Vec3Tuple): Vec3Tuple {
  const v = [p[0], p[1], p[2], 1] as const;
  const out = [0, 0, 0];
  for (let r = 0; r < 3; r++) out[r] = rows[r]![0]! * v[0] + rows[r]![1]! * v[1] + rows[r]![2]! * v[2] + rows[r]![3]! * v[3];
  return [out[0]!, out[1]!, out[2]!];
}

/** A point in a reference file's own frame (IFC axes, metres) to scene metres, through that reference's placement. */
export function ifcFilePointToScene(placement: Mat4Rows | null, p: Vec3Tuple): Vec3Tuple {
  const [x, y, z] = placement ? transformPoint(placement, p) : p;
  return [x, z, -y];
}

export function isMat4Rows(value: unknown): value is Mat4Rows {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((row) => Array.isArray(row) && row.length === 4 && row.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}
