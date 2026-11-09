import {
  apply,
  arcThrough,
  cutTriangle,
  fromRowMajor,
  invertAffine,
  maxAbsDiff,
  mergeCollinear,
  multiply,
  scaleMat,
  splitSharedBoundaries,
  uniformScale,
  upFacingOutline,
  IDENTITY4,
  type Vec3,
} from "../src/plan-geometry";

/** Segments as sorted, rounded tuples so order and direction do not matter. */
function norm(flat: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const a = [flat[i] ?? 0, flat[i + 1] ?? 0].map((v) => Math.round(v * 1000) / 1000);
    const b = [flat[i + 2] ?? 0, flat[i + 3] ?? 0].map((v) => Math.round(v * 1000) / 1000);
    out.push(JSON.stringify(a.join() < b.join() ? [a, b] : [b, a]));
  }
  return out.sort();
}

describe("plan geometry", () => {
  it("reads the manifest's row-major link placement (180 degrees about Z)", () => {
    const m = fromRowMajor([
      [-1, 0, 0, 0],
      [0, -1, 0, 0],
      [0, 0, 1, 0.5],
      [0, 0, 0, 1],
    ]);
    expect(apply(m, 2, 3, 4)).toEqual([-2, -3, 4.5]);
    expect(maxAbsDiff(multiply(m, invertAffine(m)), IDENTITY4)).toBeLessThan(1e-12);
  });

  it("measures a uniform scale and rejects a skewed one", () => {
    expect(uniformScale(multiply(scaleMat(0.3048), fromRowMajor([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]])))).toBeCloseTo(0.3048, 12);
    expect(uniformScale([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
  });

  it("cuts a triangle at a plane and ignores triangles that do not cross it", () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [10, 0, 10];
    const c: Vec3 = [0, 10, 10];
    expect(cutTriangle(a, b, c, 5)).toEqual([5, 0, 0, 5]);
    expect(cutTriangle(a, b, c, 20)).toBeNull();
  });

  it("merges collinear pieces into one line and keeps parallel offsets apart", () => {
    const merged = mergeCollinear([0, 0, 40, 0, 40, 0, 100, 0, 120, 0, 60, 0, 0, 10, 50, 10], 1);
    expect(norm(merged)).toEqual(norm([0, 0, 120, 0, 0, 10, 50, 10]));
  });

  it("separates an element's outline from the joint between two of its layers", () => {
    // Two 100 x 10 layers stacked: y 0..10 and y 10..25. The y = 10 line is the joint.
    const layer = (y0: number, y1: number) => [0, y0, 100, y0, 100, y0, 100, y1, 100, y1, 0, y1, 0, y1, 0, y0];
    const { outline, shared } = splitSharedBoundaries([layer(0, 10), layer(10, 25)], 1);
    expect(norm(shared)).toEqual(norm([0, 10, 100, 10]));
    expect(norm(outline)).toEqual(norm([0, 0, 100, 0, 0, 25, 100, 25, 0, 0, 0, 25, 100, 0, 100, 25]));
  });

  it("tessellates an arc through three points within the chord error", () => {
    const r = 914.4;
    const pts = arcThrough([r, 0], [r * Math.SQRT1_2, r * Math.SQRT1_2], [0, r], 1);
    expect(pts[0]).toEqual([r, 0]);
    const last = pts[pts.length - 1] ?? [0, 0];
    expect(last[0]).toBeCloseTo(0, 6);
    expect(last[1]).toBeCloseTo(r, 6);
    for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(r, 6);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] ?? [0, 0];
      const b = pts[i] ?? [0, 0];
      const sagitta = r - Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      expect(sagitta).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("outlines the top face of a box seen from above", () => {
    const top: [Vec3, Vec3, Vec3][] = [
      [[0, 0, 5], [10, 0, 5], [10, 4, 5]],
      [[0, 0, 5], [10, 4, 5], [0, 4, 5]],
    ];
    const side: [Vec3, Vec3, Vec3][] = [[[0, 0, 0], [10, 0, 0], [10, 0, 5]]];
    expect(norm(upFacingOutline([...top, ...side], 0.01))).toEqual(norm([0, 0, 10, 0, 10, 0, 10, 4, 10, 4, 0, 4, 0, 4, 0, 0]));
  });
});
