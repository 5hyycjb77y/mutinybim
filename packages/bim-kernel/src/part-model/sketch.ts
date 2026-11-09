import type { Sketch, SketchConstraint, SketchEntity } from "./schema";

/**
 * Sketch solving and profiles.
 *
 * The solver is damped Gauss-Newton (Levenberg-Marquardt) over the sketch's
 * point coordinates, starting from where the points were drawn: textbook
 * least-squares constraint solving. It runs wherever the definition is
 * evaluated (browser, worker, server) with the same fixed iteration order, so
 * the same sketch solves the same way everywhere. Directions no constraint
 * pins stay where they were drawn.
 */

export interface Uv {
  readonly u: number;
  readonly v: number;
}

/** A plane offset as seen in the sketch: which sketch coordinate it fixes, and to what. */
export interface PlaneLine {
  readonly coordinate: "u" | "v";
  readonly value: number;
}

export interface SketchInputs {
  /** Resolved numeric values of the sketch's dimensions, by constraint index (distance, length, radius, angle, fix). */
  readonly dims: ReadonlyMap<number, { readonly value?: number; readonly u?: number; readonly v?: number }>;
  /** Reference planes square to this sketch, as sketch lines. Planes parallel to the sketch are absent. */
  readonly planes: ReadonlyMap<string, PlaneLine>;
  /** Resolved circle radii by entity id. */
  readonly radii: ReadonlyMap<string, number>;
}

export type SolveStatus = "solved" | "underdefined" | "failed";

export interface SketchSolution {
  readonly status: SolveStatus;
  readonly points: ReadonlyMap<string, Uv>;
  /** Directions left free (0 when fully defined). */
  readonly freeDirections: number;
  readonly iterations: number;
  /** Plain-language problems, each naming the constraint or entity. */
  readonly problems: readonly string[];
}

/**
 * One residual: the coordinates it reads (`vars`, indices into x, repeats
 * allowed) and a function returning its value while writing its exact partial
 * derivatives for those coordinates, in the same order, at `g[o..]`.
 */
interface Row {
  readonly vars: readonly number[];
  readonly f: (x: Float64Array, g: Float64Array, o: number) => number;
}

interface Built {
  readonly index: ReadonlyMap<string, number>;
  readonly x0: Float64Array;
  readonly rows: Row[];
  readonly labels: string[];
  readonly problems: string[];
}

function constraintLabel(c: SketchConstraint, i: number): string {
  const what = c.kind.replace(/_/g, " ");
  return `constraint ${i + 1} (${what})`;
}

/** Entities and constraints a rectangle stands for. */
export function expandedEntities(sketch: Sketch): { lines: Map<string, { a: string; b: string; construction: boolean }>; extra: SketchConstraint[] } {
  const lines = new Map<string, { a: string; b: string; construction: boolean }>();
  const extra: SketchConstraint[] = [];
  for (const e of sketch.entities) {
    if (e.kind === "line") lines.set(e.id, { a: e.a, b: e.b, construction: e.construction ?? false });
    if (e.kind === "rectangle") {
      const [p0, p1, p2, p3] = e.corners;
      const ids = [`${e.id}.s0`, `${e.id}.s1`, `${e.id}.s2`, `${e.id}.s3`] as const;
      lines.set(ids[0], { a: p0, b: p1, construction: false });
      lines.set(ids[1], { a: p1, b: p2, construction: false });
      lines.set(ids[2], { a: p2, b: p3, construction: false });
      lines.set(ids[3], { a: p3, b: p0, construction: false });
      // Side 0 horizontal or vertical as drawn; the rest follow.
      extra.push({ kind: "horizontal", line: ids[0] }, { kind: "vertical", line: ids[1] }, { kind: "horizontal", line: ids[2] }, { kind: "vertical", line: ids[3] });
    }
  }
  return { lines, extra };
}

const X = (x: Float64Array, k: number): number => x[k] ?? 0;

/** The four coordinates of the vector from point p to point q: p.u, p.v, q.u, q.v. */
const spanVars = (p: number, q: number): number[] => [2 * p, 2 * p + 1, 2 * q, 2 * q + 1];

/** |q - p|, writing s × its gradient over spanVars(p, q) at g[o..o+3]. Zero gradient where p and q coincide. */
function span(x: Float64Array, p: number, q: number, g: Float64Array, o: number, s: number): number {
  const du = X(x, 2 * q) - X(x, 2 * p);
  const dv = X(x, 2 * q + 1) - X(x, 2 * p + 1);
  const len = Math.sqrt(du * du + dv * dv);
  const k = len > 0 ? s / len : 0;
  g[o] = -du * k;
  g[o + 1] = -dv * k;
  g[o + 2] = du * k;
  g[o + 3] = dv * k;
  return len;
}

/** Spread the gradient over a line's direction (d0, d1) onto its end points: start gets minus, end gets plus. */
function spread(g: Float64Array, o: number, d0: number, d1: number): void {
  g[o] = -d0;
  g[o + 1] = -d1;
  g[o + 2] = d0;
  g[o + 3] = d1;
}

function build(sketch: Sketch, inputs: SketchInputs): Built {
  const index = new Map<string, number>();
  const problems: string[] = [];
  sketch.points.forEach((p, i) => {
    if (index.has(p.id)) problems.push(`Point ${p.id} is defined twice`);
    index.set(p.id, i);
  });
  const x0 = new Float64Array(sketch.points.length * 2);
  sketch.points.forEach((p, i) => {
    x0[2 * i] = p.u;
    x0[2 * i + 1] = p.v;
  });
  const { lines, extra } = expandedEntities(sketch);
  // Rectangles drawn rotated keep their first side's orientation: horizontal or vertical swap.
  const rectExtra = extra.map((c): SketchConstraint => {
    if (c.kind !== "horizontal" && c.kind !== "vertical") return c;
    const line = lines.get(c.line);
    const ia = line ? index.get(line.a) : undefined;
    const ib = line ? index.get(line.b) : undefined;
    if (ia === undefined || ib === undefined) return c;
    const du = Math.abs((x0[2 * ib] ?? 0) - (x0[2 * ia] ?? 0));
    const dv = Math.abs((x0[2 * ib + 1] ?? 0) - (x0[2 * ia + 1] ?? 0));
    const side = Number(c.line.slice(-1));
    const firstHorizontal = side % 2 === 0 ? du >= dv : dv >= du;
    return { kind: (side % 2 === 0) === firstHorizontal ? "horizontal" : "vertical", line: c.line };
  });
  const arcs = new Map<string, Extract<SketchEntity, { kind: "arc" }>>();
  for (const e of sketch.entities) if (e.kind === "arc") arcs.set(e.id, e);

  const rows: Row[] = [];
  const labels: string[] = [];
  const pt = (id: string, where: string): number | null => {
    const i = index.get(id);
    if (i === undefined) {
      problems.push(`${where} uses point ${id}, which is not in the sketch`);
      return null;
    }
    return i;
  };
  const lineOf = (id: string, where: string): [number, number] | null => {
    const l = lines.get(id);
    if (!l) {
      problems.push(`${where} uses line ${id}, which is not a line in the sketch`);
      return null;
    }
    const a = pt(l.a, where);
    const b = pt(l.b, where);
    return a === null || b === null ? null : [a, b];
  };
  const push = (label: string, row: Row) => {
    rows.push(row);
    labels.push(label);
  };
  /** x[k] - value: a coordinate pinned to a number. */
  const pin = (label: string, k: number, value: number) =>
    push(label, {
      vars: [k],
      f: (x, g, o) => {
        g[o] = 1;
        return X(x, k) - value;
      },
    });
  /** s × (x[j] - x[i]) - value. */
  const difference = (label: string, i: number, j: number, s: number, value: number) =>
    push(label, {
      vars: [i, j],
      f: (x, g, o) => {
        g[o] = -s;
        g[o + 1] = s;
        return s * (X(x, j) - X(x, i)) - value;
      },
    });

  // Arcs keep both ends on one circle.
  for (const arc of arcs.values()) {
    const c = pt(arc.center, `Arc ${arc.id}`);
    const s = pt(arc.start, `Arc ${arc.id}`);
    const e = pt(arc.end, `Arc ${arc.id}`);
    if (c === null || s === null || e === null) continue;
    push(`arc ${arc.id}`, { vars: [...spanVars(c, e), ...spanVars(c, s)], f: (x, g, o) => span(x, c, e, g, o, 1) - span(x, c, s, g, o + 4, -1) });
  }
  /** An arc's radius as a span from its centre to its start, or a circle's fixed radius (no coordinates). */
  const radiusTerm = (id: string): { vars: number[]; f: (x: Float64Array, g: Float64Array, o: number, s: number) => number } => {
    const arc = arcs.get(id);
    if (!arc) {
      const fixed = inputs.radii.get(id) ?? 0;
      return { vars: [], f: () => fixed };
    }
    const c = index.get(arc.center) ?? 0;
    const s = index.get(arc.start) ?? 0;
    return { vars: spanVars(c, s), f: (x, g, o, k) => span(x, c, s, g, o, k) };
  };

  const all: Array<{ c: SketchConstraint; i: number }> = [...sketch.constraints.map((c, i) => ({ c, i })), ...rectExtra.map((c) => ({ c, i: -1 }))];
  for (const { c, i } of all) {
    const label = i >= 0 ? constraintLabel(c, i) : `rectangle side (${c.kind})`;
    const dims = inputs.dims.get(i);
    switch (c.kind) {
      case "coincident": {
        const a = pt(c.a, label);
        const b = pt(c.b, label);
        if (a === null || b === null) break;
        difference(label, 2 * b, 2 * a, 1, 0);
        difference(label, 2 * b + 1, 2 * a + 1, 1, 0);
        break;
      }
      case "horizontal":
      case "vertical": {
        const l = lineOf(c.line, label);
        if (!l) break;
        const k = c.kind === "horizontal" ? 1 : 0;
        difference(label, 2 * l[0] + k, 2 * l[1] + k, 1, 0);
        break;
      }
      case "parallel":
      case "perpendicular": {
        const l1 = lineOf(c.line1, label);
        const l2 = lineOf(c.line2, label);
        if (!l1 || !l2) break;
        const parallel = c.kind === "parallel";
        push(label, {
          vars: [...spanVars(l1[0], l1[1]), ...spanVars(l2[0], l2[1])],
          f: (x, g, o) => {
            const a0 = X(x, 2 * l1[1]) - X(x, 2 * l1[0]);
            const a1 = X(x, 2 * l1[1] + 1) - X(x, 2 * l1[0] + 1);
            const b0 = X(x, 2 * l2[1]) - X(x, 2 * l2[0]);
            const b1 = X(x, 2 * l2[1] + 1) - X(x, 2 * l2[0] + 1);
            const la = Math.sqrt(a0 * a0 + a1 * a1);
            const lb = Math.sqrt(b0 * b0 + b1 * b1);
            const num = parallel ? a0 * b1 - a1 * b0 : a0 * b0 + a1 * b1;
            // ∂num/∂a and ∂num/∂b
            const na0 = parallel ? b1 : b0;
            const na1 = parallel ? -b0 : b1;
            const nb0 = parallel ? -a1 : a0;
            const nb1 = parallel ? a0 : a1;
            if (la === 0 || lb === 0) {
              // A zero-length line: the quotient falls back to num / 1.
              spread(g, o, na0, na1);
              spread(g, o + 4, nb0, nb1);
              return num;
            }
            const den = la * lb;
            const q = num / den;
            // ∂(num/den) = ∂num/den - q·∂den/den, with ∂den/∂a = lb·a/la and ∂den/∂b = la·b/lb.
            spread(g, o, na0 / den - (q * a0) / (la * la), na1 / den - (q * a1) / (la * la));
            spread(g, o + 4, nb0 / den - (q * b0) / (lb * lb), nb1 / den - (q * b1) / (lb * lb));
            return q;
          },
        });
        break;
      }
      case "equal_length": {
        const l1 = lineOf(c.line1, label);
        const l2 = lineOf(c.line2, label);
        if (!l1 || !l2) break;
        push(label, { vars: [...spanVars(l1[0], l1[1]), ...spanVars(l2[0], l2[1])], f: (x, g, o) => span(x, l1[0], l1[1], g, o, 1) - span(x, l2[0], l2[1], g, o + 4, -1) });
        break;
      }
      case "equal_radius": {
        if (!arcs.has(c.arc1) && !inputs.radii.has(c.arc1)) problems.push(`${label} uses ${c.arc1}, which is not an arc or circle`);
        if (!arcs.has(c.arc2) && !inputs.radii.has(c.arc2)) problems.push(`${label} uses ${c.arc2}, which is not an arc or circle`);
        const r1 = radiusTerm(c.arc1);
        const r2 = radiusTerm(c.arc2);
        const at = r1.vars.length;
        push(label, { vars: [...r1.vars, ...r2.vars], f: (x, g, o) => r1.f(x, g, o, 1) - r2.f(x, g, o + at, -1) });
        break;
      }
      case "distance": {
        const a = pt(c.a, label);
        const b = pt(c.b, label);
        const value = dims?.value;
        if (a === null || b === null || value === undefined) break;
        const direction = c.direction ?? "aligned";
        if (direction === "aligned") push(label, { vars: spanVars(a, b), f: (x, g, o) => span(x, a, b, g, o, 1) - value });
        else {
          // Signed the way it was drawn, so the solver never flips a point across its partner.
          const k = direction === "horizontal" ? 0 : 1;
          const drawn = (x0[2 * b + k] ?? 0) - (x0[2 * a + k] ?? 0);
          difference(label, 2 * a + k, 2 * b + k, drawn < 0 ? -1 : 1, value);
        }
        break;
      }
      case "length": {
        const l = lineOf(c.line, label);
        const value = dims?.value;
        if (!l || value === undefined) break;
        push(label, { vars: spanVars(l[0], l[1]), f: (x, g, o) => span(x, l[0], l[1], g, o, 1) - value });
        break;
      }
      case "radius": {
        const value = dims?.value;
        if (!arcs.has(c.arc)) {
          problems.push(`${label} uses ${c.arc}, which is not an arc (a circle's radius is its own dimension)`);
          break;
        }
        if (value === undefined) break;
        const r = radiusTerm(c.arc);
        push(label, { vars: r.vars, f: (x, g, o) => r.f(x, g, o, 1) - value });
        break;
      }
      case "angle": {
        const l1 = lineOf(c.line1, label);
        const l2 = lineOf(c.line2, label);
        const value = dims?.value;
        if (!l1 || !l2 || value === undefined) break;
        const target = (value * Math.PI) / 180;
        // Radians × 1000, so an angle weighs like a length in millimetres.
        const w = 1000;
        push(label, {
          vars: [...spanVars(l1[0], l1[1]), ...spanVars(l2[0], l2[1])],
          f: (x, g, o) => {
            const a0 = X(x, 2 * l1[1]) - X(x, 2 * l1[0]);
            const a1 = X(x, 2 * l1[1] + 1) - X(x, 2 * l1[0] + 1);
            const b0 = X(x, 2 * l2[1]) - X(x, 2 * l2[0]);
            const b1 = X(x, 2 * l2[1] + 1) - X(x, 2 * l2[0] + 1);
            let d = Math.atan2(a0 * b1 - a1 * b0, a0 * b0 + a1 * b1) - target;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            // ∂θ/∂a = (a1, -a0)/|a|², ∂θ/∂b = (-b1, b0)/|b|² for θ = angle from a to b.
            const qa = a0 * a0 + a1 * a1;
            const qb = b0 * b0 + b1 * b1;
            const ka = qa > 0 ? w / qa : 0;
            const kb = qb > 0 ? w / qb : 0;
            spread(g, o, a1 * ka, -a0 * ka);
            spread(g, o + 4, -b1 * kb, b0 * kb);
            return d * w;
          },
        });
        break;
      }
      case "on_plane": {
        const p = pt(c.point, label);
        const plane = inputs.planes.get(c.plane);
        if (!plane) {
          problems.push(`${label}: plane ${c.plane} is not a reference plane square to this sketch`);
          break;
        }
        if (p === null) break;
        pin(label, 2 * p + (plane.coordinate === "u" ? 0 : 1), plane.value);
        break;
      }
      case "fix": {
        const p = pt(c.point, label);
        if (p === null) break;
        const fu = dims?.u;
        const fv = dims?.v;
        if (fu === undefined && fv === undefined) {
          pin(label, 2 * p, x0[2 * p] ?? 0);
          pin(label, 2 * p + 1, x0[2 * p + 1] ?? 0);
          break;
        }
        if (fu !== undefined) pin(label, 2 * p, fu);
        if (fv !== undefined) pin(label, 2 * p + 1, fv);
        break;
      }
    }
  }
  return { index, x0, rows, labels, problems };
}

/**
 * Solve M·out = r by Gaussian elimination with partial pivoting, destroying M
 * and r (callers pass scratch copies). Columns whose pivot falls under the
 * tolerance are free and get 0. Returns the rank.
 */
function solveInPlace(m: Float64Array, r: Float64Array, n: number, out: Float64Array, pivotCols: Int32Array): number {
  const pivotTol = 1e-12;
  let row = 0;
  for (let col = 0; col < n && row < n; col++) {
    let best = row;
    let bestAbs = Math.abs(m[row * n + col] ?? 0);
    for (let k = row + 1; k < n; k++) {
      const v = Math.abs(m[k * n + col] ?? 0);
      if (v > bestAbs) {
        best = k;
        bestAbs = v;
      }
    }
    if (bestAbs < pivotTol) continue;
    if (best !== row) {
      for (let j = col; j < n; j++) {
        const t = m[row * n + j] ?? 0;
        m[row * n + j] = m[best * n + j] ?? 0;
        m[best * n + j] = t;
      }
      const t = r[row] ?? 0;
      r[row] = r[best] ?? 0;
      r[best] = t;
    }
    const p = m[row * n + col] ?? 1;
    const rr = r[row] ?? 0;
    for (let k = row + 1; k < n; k++) {
      const f = (m[k * n + col] ?? 0) / p;
      if (f === 0) continue;
      for (let j = col; j < n; j++) m[k * n + j] = (m[k * n + j] ?? 0) - f * (m[row * n + j] ?? 0);
      r[k] = (r[k] ?? 0) - f * rr;
    }
    pivotCols[row] = col;
    row++;
  }
  out.fill(0);
  for (let i = row - 1; i >= 0; i--) {
    const col = pivotCols[i] ?? 0;
    let s = r[i] ?? 0;
    for (let j = col + 1; j < n; j++) s -= (m[i * n + j] ?? 0) * (out[j] ?? 0);
    out[col] = s / (m[i * n + col] ?? 1);
  }
  return row;
}

const MAX_ITERATIONS = 100;

/**
 * Solve a sketch's constraints. Pure and deterministic: the same sketch and
 * inputs give bit-identical points (fixed row order, exact derivatives, no
 * randomness, no reuse of state between calls).
 */
export function solveSketch(sketch: Sketch, inputs: SketchInputs): SketchSolution {
  const built = build(sketch, inputs);
  const { rows, labels, x0, index } = built;
  const n = x0.length;
  const m = rows.length;
  const x = x0.slice();
  const points = () => new Map(sketch.points.map((p) => [p.id, { u: x[2 * (index.get(p.id) ?? 0)] ?? 0, v: x[2 * (index.get(p.id) ?? 0) + 1] ?? 0 }]));
  if (built.problems.length > 0) return { status: "failed", points: points(), freeDirections: 0, iterations: 0, problems: built.problems };
  if (m === 0 || n === 0) return { status: n === 0 ? "solved" : "underdefined", points: points(), freeDirections: n, iterations: 0, problems: [] };

  let scale = 1;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(x0[i] ?? 0));
  const tol = 1e-9 * scale;

  // Sparse Jacobian: row k's entries live at [start[k], start[k + 1]) of vars / jac.
  const start = new Int32Array(m + 1);
  for (let k = 0; k < m; k++) start[k + 1] = (start[k] ?? 0) + (rows[k]?.vars.length ?? 0);
  const nnz = start[m] ?? 0;
  const vars = new Int32Array(nnz);
  for (let k = 0; k < m; k++) (rows[k]?.vars ?? []).forEach((v, j) => (vars[(start[k] ?? 0) + j] = v));

  /** Residuals into r and their gradients into jac, at `at`. Returns ‖r‖. */
  const evaluate = (at: Float64Array, r: Float64Array, jac: Float64Array): number => {
    let s = 0;
    for (let k = 0; k < m; k++) {
      const v = rows[k]?.f(at, jac, start[k] ?? 0) ?? 0;
      r[k] = v;
      s += v * v;
    }
    return Math.sqrt(s);
  };
  /** Normal equations A = JᵀJ (dense, symmetric) and g = -Jᵀr from the sparse rows. */
  const A = new Float64Array(n * n);
  const g = new Float64Array(n);
  const normal = (r: Float64Array, jac: Float64Array) => {
    A.fill(0);
    g.fill(0);
    for (let k = 0; k < m; k++) {
      const rk = r[k] ?? 0;
      const s = start[k] ?? 0;
      const e = start[k + 1] ?? 0;
      for (let p = s; p < e; p++) {
        const jp = jac[p] ?? 0;
        if (jp === 0) continue;
        const vi = (vars[p] ?? 0) * n;
        g[vars[p] ?? 0] = (g[vars[p] ?? 0] ?? 0) - jp * rk;
        for (let q = s; q < e; q++) A[vi + (vars[q] ?? 0)] = (A[vi + (vars[q] ?? 0)] ?? 0) + jp * (jac[q] ?? 0);
      }
    }
  };

  let r = new Float64Array(m);
  let jac = new Float64Array(nnz);
  let rTrial = new Float64Array(m);
  let jacTrial = new Float64Array(nnz);
  const D = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const dx = new Float64Array(n);
  const trial = new Float64Array(n);
  const pivotCols = new Int32Array(n);

  let err = evaluate(x, r, jac);
  let lambda = 1e-3;
  let iterations = 0;
  while (err > tol && iterations < MAX_ITERATIONS) {
    iterations++;
    normal(r, jac);
    let improved = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      D.set(A);
      for (let i = 0; i < n; i++) D[i * n + i] = (D[i * n + i] ?? 0) + lambda * Math.max(1e-9, A[i * n + i] ?? 0) + lambda * 1e-6;
      rhs.set(g);
      solveInPlace(D, rhs, n, dx, pivotCols);
      for (let i = 0; i < n; i++) trial[i] = (x[i] ?? 0) + (dx[i] ?? 0);
      const e2 = evaluate(trial, rTrial, jacTrial);
      if (e2 < err) {
        x.set(trial);
        [r, rTrial] = [rTrial, r];
        [jac, jacTrial] = [jacTrial, jac];
        err = e2;
        lambda = Math.max(1e-12, lambda / 10);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  if (err > Math.max(tol, 1e-6 * scale)) {
    // Name the constraints that disagree most.
    const worst = labels
      .map((label, k) => ({ label, v: Math.abs(r[k] ?? 0) }))
      .filter((w) => w.v > 1e-6 * scale)
      .sort((a, b) => b.v - a.v);
    const named = [...new Set(worst.map((w) => w.label))].slice(0, 3);
    return {
      status: "failed",
      points: points(),
      freeDirections: 0,
      iterations,
      problems: [`The sketch "${sketch.name}" can't satisfy all its constraints; these disagree: ${named.join(", ") || "two or more constraints"}. Remove one or change a dimension.`],
    };
  }
  // Free directions: n minus the rank of JᵀJ at the solution (jac is current for x).
  normal(r, jac);
  rhs.fill(0);
  const rank = solveInPlace(A, rhs, n, dx, pivotCols);
  const free = n - rank;
  return { status: free === 0 ? "solved" : "underdefined", points: points(), freeDirections: free, iterations, problems: [] };
}

// ------------------------------------------------------------------ profiles

export interface ProfileResult {
  readonly loops: ReadonlyArray<readonly Uv[]>;
  readonly problems: readonly string[];
}

/** Closed loops of a solved sketch, arcs sampled. Construction lines and the named axis are left out. */
/**
 * Segments for a full circle of radius `r`: `circularSegments`, or with a
 * chord tolerance as few as keep every chord within it (at least 8). Small
 * holes and fillets then cost a few triangles, not a full circle's worth.
 */
function segmentsFor(r: number, circularSegments: number, chordToleranceMm: number | undefined): number {
  if (chordToleranceMm === undefined || !(r > chordToleranceMm)) return circularSegments;
  return Math.max(8, Math.min(circularSegments, Math.ceil((2 * Math.PI) / (2 * Math.acos(1 - chordToleranceMm / r)))));
}

export function sketchProfile(sketch: Sketch, solution: SketchSolution, radii: ReadonlyMap<string, number>, circularSegments: number, exclude: ReadonlySet<string> = new Set(), chordToleranceMm?: number): ProfileResult {
  const problems: string[] = [];
  const at = (id: string): Uv => solution.points.get(id) ?? { u: 0, v: 0 };
  // Coincident points are one vertex.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let p = parent.get(id) ?? id;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    return p;
  };
  for (const c of sketch.constraints) if (c.kind === "coincident") parent.set(find(c.a), find(c.b));

  interface Edge {
    readonly from: string;
    readonly to: string;
    /** Points strictly between from and to. */
    readonly inner: readonly Uv[];
  }
  const edges: Edge[] = [];
  const loops: Uv[][] = [];
  const { lines } = expandedEntities(sketch);
  for (const [id, l] of lines) if (!l.construction && !exclude.has(id)) edges.push({ from: l.a, to: l.b, inner: [] });
  for (const e of sketch.entities) {
    if (exclude.has(e.id)) continue;
    if (e.kind === "polyline") {
      const ids = e.closed ? [...e.points, e.points[0] ?? ""] : e.points;
      for (let i = 0; i + 1 < ids.length; i++) edges.push({ from: ids[i] ?? "", to: ids[i + 1] ?? "", inner: [] });
    } else if (e.kind === "arc") {
      const c = at(e.center);
      const s = at(e.start);
      const t = at(e.end);
      const r = Math.hypot(s.u - c.u, s.v - c.v);
      const a0 = Math.atan2(s.v - c.v, s.u - c.u);
      let a1 = Math.atan2(t.v - c.v, t.u - c.u);
      while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(((a1 - a0) / (2 * Math.PI)) * segmentsFor(r, circularSegments, chordToleranceMm)));
      const inner: Uv[] = [];
      for (let i = 1; i < n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        inner.push({ u: c.u + r * Math.cos(a), v: c.v + r * Math.sin(a) });
      }
      edges.push({ from: e.start, to: e.end, inner });
    } else if (e.kind === "circle") {
      const c = at(e.center);
      const r = radii.get(e.id) ?? 0;
      if (!(r > 0)) {
        problems.push(`Circle ${e.id} has no radius`);
        continue;
      }
      const n = segmentsFor(r, circularSegments, chordToleranceMm);
      loops.push(Array.from({ length: n }, (_, i) => ({ u: c.u + r * Math.cos((2 * Math.PI * i) / n), v: c.v + r * Math.sin((2 * Math.PI * i) / n) })));
    }
  }
  const byVertex = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const v of [find(e.from), find(e.to)]) {
      const list = byVertex.get(v) ?? [];
      list.push(i);
      byVertex.set(v, list);
    }
  });
  for (const [v, list] of byVertex) {
    if (list.length !== 2) {
      problems.push(list.length < 2 ? `The sketch "${sketch.name}" is open at point ${v}: join it to another line` : `Point ${v} in "${sketch.name}" joins ${list.length} lines; a profile needs exactly two at each corner`);
    }
  }
  if (problems.length > 0) return { loops, problems };
  const used = new Set<number>();
  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    const loop: Uv[] = [];
    let edgeIndex = start;
    let vertex = find(edges[start]?.from ?? "");
    for (let guard = 0; guard <= edges.length; guard++) {
      used.add(edgeIndex);
      const e = edges[edgeIndex];
      if (!e) break;
      const forward = find(e.from) === vertex;
      loop.push(at(forward ? e.from : e.to));
      loop.push(...(forward ? e.inner : [...e.inner].reverse()));
      vertex = find(forward ? e.to : e.from);
      const next = (byVertex.get(vertex) ?? []).find((i) => !used.has(i));
      if (next === undefined) break;
      edgeIndex = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return { loops, problems };
}
