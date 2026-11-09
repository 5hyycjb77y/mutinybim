/**
 * Pure plan-cut geometry: affine 4x4 matrices, plane cuts, segment merging and
 * curve tessellation. No IFC parser here, so it runs (and is tested) anywhere.
 *
 * Matrices are column-major Float64 arrays of 16, the layout web-ifc returns.
 */

export type Mat4 = readonly number[];
export type Vec3 = readonly [number, number, number];

export const IDENTITY4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mat4(values: ArrayLike<number>): Mat4 {
  if (values.length !== 16) throw new Error(`Expected 16 matrix values, got ${values.length}`);
  return Array.from(values);
}

/** Row-major 4x4 (fixture manifests) to column-major. */
export function fromRowMajor(rows: readonly (readonly number[])[]): Mat4 {
  if (rows.length !== 4 || rows.some((r) => r.length !== 4)) throw new Error("Expected a 4x4 row-major matrix");
  const out: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(rows[r]?.[c] ?? 0);
  return out;
}

const at = (m: Mat4, i: number) => m[i] ?? 0;

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += at(a, k * 4 + r) * at(b, c * 4 + k);
      out[c * 4 + r] = s;
    }
  return out;
}

export function scaleMat(s: number): Mat4 {
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
}

/** Inverse of an affine matrix (last row 0,0,0,1). */
export function invertAffine(m: Mat4): Mat4 {
  const a = at(m, 0), b = at(m, 4), c = at(m, 8);
  const d = at(m, 1), e = at(m, 5), f = at(m, 9);
  const g = at(m, 2), h = at(m, 6), i = at(m, 10);
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-15) throw new Error("Matrix is singular");
  const inv = [
    (e * i - f * h) / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    -(d * i - f * g) / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    (d * h - e * g) / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const [r00 = 0, r01 = 0, r02 = 0, r10 = 0, r11 = 0, r12 = 0, r20 = 0, r21 = 0, r22 = 0] = inv;
  const tx = at(m, 12), ty = at(m, 13), tz = at(m, 14);
  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    -(r00 * tx + r01 * ty + r02 * tz), -(r10 * tx + r11 * ty + r12 * tz), -(r20 * tx + r21 * ty + r22 * tz), 1,
  ];
}

export function apply(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    at(m, 0) * x + at(m, 4) * y + at(m, 8) * z + at(m, 12),
    at(m, 1) * x + at(m, 5) * y + at(m, 9) * z + at(m, 13),
    at(m, 2) * x + at(m, 6) * y + at(m, 10) * z + at(m, 14),
  ];
}

export function maxAbsDiff(a: Mat4, b: Mat4): number {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(at(a, i) - at(b, i)));
  return d;
}

/** Uniform scale of the linear part, or null when the axes are not orthogonal with equal length. */
export function uniformScale(m: Mat4, tol = 1e-9): number | null {
  const cols = [0, 1, 2].map((c) => [at(m, c * 4), at(m, c * 4 + 1), at(m, c * 4 + 2)] as const);
  const len = cols.map((v) => Math.hypot(v[0], v[1], v[2]));
  const [l0 = 0, l1 = 0, l2 = 0] = len;
  if (Math.abs(l0 - l1) > tol * l0 || Math.abs(l0 - l2) > tol * l0) return null;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) {
      const p = cols[i];
      const q = cols[j];
      if (!p || !q) return null;
      if (Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) > tol * l0 * l0) return null;
    }
  return l0;
}

/** Segment [x1, y1, x2, y2] where a triangle crosses the plane z = h, or null. */
export function cutTriangle(a: Vec3, b: Vec3, c: Vec3, h: number, minLength = 0): [number, number, number, number] | null {
  const pts: [number, number][] = [];
  const edge = (p: Vec3, q: Vec3) => {
    const dp = p[2] - h;
    const dq = q[2] - h;
    if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0) || dp === dq) return;
    const t = dp / (dp - dq);
    pts.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
  };
  edge(a, b);
  edge(b, c);
  edge(c, a);
  if (pts.length < 2) return null;
  const [p, q] = pts;
  if (!p || !q) return null;
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= minLength) return null;
  return [p[0], p[1], q[0], q[1]];
}

/**
 * Merge collinear, touching or overlapping segments (flat [x1, y1, x2, y2, ...]).
 * Tessellated faces cut into many short collinear pieces; this restores one
 * line per wall face. Tolerances are in the input units.
 */
export function mergeCollinear(flat: readonly number[], tol = 1, angleTol = 1e-3): number[] {
  const groups = new Map<string, { ux: number; uy: number; off: number; spans: [number, number][] }>();
  for (let i = 0; i + 3 < flat.length; i += 4) {
    let x1 = flat[i] ?? 0, y1 = flat[i + 1] ?? 0, x2 = flat[i + 2] ?? 0, y2 = flat[i + 3] ?? 0;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len <= tol / 10) continue;
    let ux = (x2 - x1) / len;
    let uy = (y2 - y1) / len;
    if (ux < -1e-12 || (Math.abs(ux) <= 1e-12 && uy < 0)) {
      ux = -ux;
      uy = -uy;
      [x1, y1, x2, y2] = [x2, y2, x1, y1];
    }
    const off = -uy * x1 + ux * y1;
    const key = `${Math.round(Math.atan2(uy, ux) / angleTol)}:${Math.round(off / tol)}`;
    let g = groups.get(key);
    if (!g) {
      g = { ux, uy, off, spans: [] };
      groups.set(key, g);
    }
    const s1 = ux * x1 + uy * y1;
    const s2 = ux * x2 + uy * y2;
    g.spans.push(s1 <= s2 ? [s1, s2] : [s2, s1]);
  }
  const out: number[] = [];
  for (const g of groups.values()) {
    g.spans.sort((p, q) => p[0] - q[0]);
    let cur: [number, number] | null = null;
    const emit = (s: [number, number]) => {
      const nx = -g.uy * g.off;
      const ny = g.ux * g.off;
      out.push(nx + g.ux * s[0], ny + g.uy * s[0], nx + g.ux * s[1], ny + g.uy * s[1]);
    };
    for (const s of g.spans) {
      if (cur && s[0] <= cur[1] + tol) cur[1] = Math.max(cur[1], s[1]);
      else {
        if (cur) emit(cur);
        cur = [s[0], s[1]];
      }
    }
    if (cur) emit(cur);
  }
  return out;
}

/**
 * Split one element's cut linework into its outline and the boundaries shared
 * by two of its parts (compound-wall layer joints). Input: flat segments per
 * part. A span covered by two or more parts is shared.
 */
export function splitSharedBoundaries(parts: readonly (readonly number[])[], tol = 1, angleTol = 1e-3): { outline: number[]; shared: number[] } {
  const groups = new Map<string, { ux: number; uy: number; off: number; spans: { s: [number, number]; part: number }[] }>();
  parts.forEach((flat, part) => {
    const merged = mergeCollinear(flat, tol, angleTol);
    for (let i = 0; i + 3 < merged.length; i += 4) {
      const x1 = merged[i] ?? 0, y1 = merged[i + 1] ?? 0, x2 = merged[i + 2] ?? 0, y2 = merged[i + 3] ?? 0;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const off = -uy * x1 + ux * y1;
      const key = `${Math.round(Math.atan2(uy, ux) / angleTol)}:${Math.round(off / tol)}`;
      const g = groups.get(key) ?? { ux, uy, off, spans: [] };
      groups.set(key, g);
      const s1 = g.ux * x1 + g.uy * y1;
      const s2 = g.ux * x2 + g.uy * y2;
      g.spans.push({ s: s1 <= s2 ? [s1, s2] : [s2, s1], part });
    }
  });
  const outline: number[] = [];
  const shared: number[] = [];
  for (const g of groups.values()) {
    const cuts = [...new Set(g.spans.flatMap((x) => x.s))].sort((a, b) => a - b);
    const emit = (out: number[], a: number, b: number) => {
      const nx = -g.uy * g.off;
      const ny = g.ux * g.off;
      out.push(nx + g.ux * a, ny + g.uy * a, nx + g.ux * b, ny + g.uy * b);
    };
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k] ?? 0;
      const b = cuts[k + 1] ?? 0;
      if (b - a <= tol / 10) continue;
      const mid = (a + b) / 2;
      const covering = new Set(g.spans.filter((x) => x.s[0] - tol / 10 <= mid && mid <= x.s[1] + tol / 10).map((x) => x.part));
      if (covering.size >= 2) emit(shared, a, b);
      else if (covering.size === 1) emit(outline, a, b);
    }
  }
  return { outline: mergeCollinear(outline, tol, angleTol), shared: mergeCollinear(shared, tol, angleTol) };
}

/** Points along the circular arc through p1, p2, p3 (p2 on the arc), chord error below maxError. */
export function arcThrough(p1: readonly [number, number], p2: readonly [number, number], p3: readonly [number, number], maxError: number): [number, number][] {
  const [ax, ay] = p1;
  const [bx, by] = p2;
  const [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [[ax, ay], [cx, cy]];
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ox, ay - oy);
  const t1 = Math.atan2(ay - oy, ax - ox);
  const tm = Math.atan2(by - oy, bx - ox);
  const t3 = Math.atan2(cy - oy, cx - ox);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Sweep from t1 to t3 in whichever direction passes through tm.
  const ccw = norm(tm - t1) <= norm(t3 - t1);
  const sweep = ccw ? norm(t3 - t1) : -norm(t1 - t3);
  const step = r > maxError ? 2 * Math.acos(Math.max(-1, 1 - maxError / r)) : Math.PI / 4;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
  const pts: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const t = t1 + (sweep * k) / n;
    pts.push([ox + r * Math.cos(t), oy + r * Math.sin(t)]);
  }
  return pts;
}

/**
 * Plan outline of the upward-facing surface of a mesh: edges that belong to
 * exactly one up-facing triangle. Used for elements wholly below the cut.
 */
export function upFacingOutline(tris: readonly (readonly [Vec3, Vec3, Vec3])[], quantum: number, minNormalZ = 0.5): number[] {
  const count = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  const key = (p: Vec3) => `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)},${Math.round(p[2] / quantum)}`;
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0 || nz / len < minNormalZ) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const kp = key(p);
      const kq = key(q);
      if (kp === kq) continue;
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const e = count.get(k);
      if (e) e.n += 1;
      else count.set(k, { a: p, b: q, n: 1 });
    }
  }
  const out: number[] = [];
  for (const e of count.values()) if (e.n === 1) out.push(e.a[0], e.a[1], e.b[0], e.b[1]);
  return out;
}
