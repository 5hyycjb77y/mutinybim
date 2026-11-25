import { fromCanonical, to, type Quantity } from "@permitzip/bim-units";
import { z } from "zod";

/**
 * A simply supported beam under one uniform load and any number of point
 * loads: end reactions, the largest bending moment and where it is, and a
 * utilisation against a given allowable moment. Statics by superposition of
 * AISC Manual Table 3-23 cases 1 (uniform load) and 8 (concentrated load at
 * any point). One service-level load case: no load factors or combinations
 * (those are scenarios, round 6).
 *
 * Given both E and I, also the largest elastic deflection and where it is:
 * Euler–Bernoulli bending, linear elastic, small deflections, constant EI
 * over the span, no shear deformation, the closed-form deflection curves of
 * the same two cases superposed. Deflection is positive in the direction a
 * positive load acts (down, for gravity loads). No allowable-deflection
 * limit is checked.
 */

export const SIMPLE_BEAM_CALC_ID = "struct.simple_beam";
export const SIMPLE_BEAM_CALC_VERSION = 1;

export interface PointLoad {
  readonly load: Quantity<"force">;
  /** Distance from the beam's start. */
  readonly at: Quantity<"length">;
  /** What put it there (an equipment mark), for the steps. */
  readonly label?: string;
}

export interface SimpleBeamInput {
  readonly span: Quantity<"length">;
  readonly uniform: Quantity<"line_load">;
  readonly pointLoads?: readonly PointLoad[];
  /** Absent: no utilisation is reported. */
  readonly allowableMoment?: Quantity<"moment">;
  /** Modulus of elasticity, E. Give it with `momentOfInertia`, or neither: absent, no deflection is reported. */
  readonly elasticModulus?: Quantity<"stress">;
  /** Moment of inertia about the bending axis, I, constant over the span. Give it with `elasticModulus`, or neither. */
  readonly momentOfInertia?: Quantity<"second_moment_of_area">;
}

export interface SimpleBeamResult {
  readonly startReaction: Quantity<"force">;
  readonly endReaction: Quantity<"force">;
  readonly maxMoment: Quantity<"moment">;
  /** Where the largest moment is, from the start. */
  readonly maxMomentAt: Quantity<"length">;
  /** Largest moment ÷ allowable; null without an allowable. */
  readonly utilisation: number | null;
  /**
   * The elastic deflection where its size is largest, positive in the
   * direction a positive load acts (down). Present only when E and I were given.
   */
  readonly maxDeflection?: Quantity<"length">;
  /** Where the largest deflection is, from the start. Present with `maxDeflection`. */
  readonly maxDeflectionAt?: Quantity<"length">;
}

export class SimpleBeamInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleBeamInputError";
  }
}

/** Reactions and the moment diagram's peak. Throws `SimpleBeamInputError` in plain words for an impossible beam. */
export function simpleBeam(input: SimpleBeamInput): SimpleBeamResult {
  const L = input.span;
  const w = input.uniform;
  const loads = [...(input.pointLoads ?? [])].sort((a, b) => a.at - b.at);
  if (!(L > 0)) throw new SimpleBeamInputError("A simple beam needs a span longer than zero");
  const E = input.elasticModulus;
  const I = input.momentOfInertia;
  if ((E === undefined) !== (I === undefined)) {
    throw new SimpleBeamInputError(E === undefined ? "Deflection needs the modulus of elasticity (E) as well as the moment of inertia (I). Give both, or neither to skip deflection" : "Deflection needs the moment of inertia (I) as well as the modulus of elasticity (E). Give both, or neither to skip deflection");
  }
  if (E !== undefined && !(Number.isFinite(E) && E > 0)) throw new SimpleBeamInputError("The modulus of elasticity (E) must be a finite number greater than zero");
  if (I !== undefined && !(Number.isFinite(I) && I > 0)) throw new SimpleBeamInputError("The moment of inertia (I) must be a finite number greater than zero");
  const EI = E !== undefined && I !== undefined ? E * I : undefined;
  if (EI !== undefined && !(Number.isFinite(EI) && EI > 0)) throw new SimpleBeamInputError("The flexural rigidity (E·I) must be finite and greater than zero");
  for (const p of loads) {
    if (p.at < 0 || p.at > L) throw new SimpleBeamInputError(`A point load${p.label ? ` (${p.label})` : ""} sits ${to(p.at, "ft").toFixed(2)} ft from the start, outside the ${to(L, "ft").toFixed(2)} ft span`);
  }
  let rEnd = (w * L) / 2;
  let rStart = (w * L) / 2;
  for (const p of loads) {
    rStart += (p.load * (L - p.at)) / L;
    rEnd += (p.load * p.at) / L;
  }
  const momentAt = (x: number): number => {
    let m = rStart * x - (w * x * x) / 2;
    for (const p of loads) if (p.at < x) m -= p.load * (x - p.at);
    return m;
  };
  const breaks = [0, ...loads.map((p) => p.at), L];
  let best = { m: 0, x: 0 };
  const consider = (x: number) => {
    const m = momentAt(x);
    if (Math.abs(m) > Math.abs(best.m)) best = { m, x };
  };
  for (let i = 0; i < breaks.length - 1; i++) {
    const x0 = breaks[i] ?? 0;
    const x1 = breaks[i + 1] ?? L;
    consider(x0);
    // Shear just right of x0; the moment peaks where it crosses zero.
    let applied = 0;
    for (const p of loads) if (p.at <= x0) applied += p.load;
    const v0 = rStart - w * x0 - applied;
    if (w !== 0) {
      const xs = x0 + v0 / w;
      if (xs > x0 && xs < x1) consider(xs);
    }
  }
  consider(L);
  const deflection = EI !== undefined ? peakDeflection(L, w, loads, EI, rStart) : null;
  return {
    startReaction: fromCanonical("force", rStart),
    endReaction: fromCanonical("force", rEnd),
    maxMoment: fromCanonical("moment", best.m),
    maxMomentAt: fromCanonical("length", best.x),
    utilisation: input.allowableMoment !== undefined && input.allowableMoment > 0 ? Math.abs(best.m) / input.allowableMoment : null,
    ...(deflection ? { maxDeflection: fromCanonical("length", deflection.v), maxDeflectionAt: fromCanonical("length", deflection.x) } : {}),
  };
}

/**
 * Elastic deflection v(x), positive with the load (down), and its slope, by
 * superposing the closed-form curves of AISC Table 3-23 cases 1 and 8 with
 * v(0) = v(L) = 0 (all values canonical SI: N, m, N·m²):
 *
 *   uniform w:      v = w·x·(L³ − 2L·x² + x³) / (24·EI)
 *   point P at a, b = L − a:
 *     x ≤ a:        v = P·b·x·(L² − b² − x²) / (6·L·EI)
 *     x ≥ a:        v = P·a·u·(L² − a² − u²) / (6·L·EI),  u = L − x
 *
 * The slope is continuous, v is zero at both supports, so the largest |v| is
 * where the slope is zero. Between load points the slope's own turning points
 * are where the moment is zero (EI·v″ = −M); each piece between them is
 * monotonic, so it holds at most one slope zero, found by bisection to
 * machine precision. No sampling.
 */
function peakDeflection(L: number, w: number, loads: readonly PointLoad[], EI: number, rStart: number): { v: number; x: number } {
  const deflectionAt = (x: number): number => {
    let v = (w * x * (L ** 3 - 2 * L * x * x + x ** 3)) / 24;
    for (const p of loads) {
      const a = p.at;
      const b = L - a;
      if (x <= a) v += (p.load * b * x * (L * L - b * b - x * x)) / (6 * L);
      else {
        const u = L - x;
        v += (p.load * a * u * (L * L - a * a - u * u)) / (6 * L);
      }
    }
    const result = v / EI;
    if (!Number.isFinite(result)) throw new SimpleBeamInputError("The calculated deflection is not representable as a finite number");
    return result;
  };
  const slopeAt = (x: number): number => {
    let t = (w * (L ** 3 - 6 * L * x * x + 4 * x ** 3)) / 24;
    for (const p of loads) {
      const a = p.at;
      const b = L - a;
      if (x <= a) t += (p.load * b * (L * L - b * b - 3 * x * x)) / (6 * L);
      else {
        const u = L - x;
        t -= (p.load * a * (L * L - a * a - 3 * u * u)) / (6 * L);
      }
    }
    return t;
  };
  let best = { v: 0, x: 0 };
  const consider = (x: number) => {
    const v = deflectionAt(x);
    if (Math.abs(v) > Math.abs(best.v)) best = { v, x };
  };
  const breaks = [0, ...loads.map((p) => p.at), L];
  for (let i = 0; i < breaks.length - 1; i++) {
    const x0 = breaks[i] ?? 0;
    const x1 = breaks[i + 1] ?? L;
    consider(x0);
    if (!(x1 > x0)) continue;
    // In (x0, x1) the moment is M(x) = −w/2·x² + (R1 − ΣP)·x + ΣP·a over the loads left of x0.
    let sumP = 0;
    let sumPa = 0;
    for (const p of loads) {
      if (p.at <= x0) {
        sumP += p.load;
        sumPa += p.load * p.at;
      }
    }
    const qa = -w / 2;
    const qb = rStart - sumP;
    const qc = sumPa;
    const zeros = quadraticRoots(qa, qb, qc);
    const knots = [x0, ...zeros.filter((z) => z > x0 && z < x1).sort((p, q) => p - q), x1];
    for (let k = 0; k < knots.length - 1; k++) {
      let lo = knots[k] ?? x0;
      let hi = knots[k + 1] ?? x1;
      let tLo = slopeAt(lo);
      const tHi = slopeAt(hi);
      if (tLo === 0) {
        consider(lo);
        continue;
      }
      if (tHi === 0) {
        consider(hi);
        continue;
      }
      if (tLo > 0 === tHi > 0) continue;
      // Bisection: the interval halves each pass until it can't shrink in floating point.
      for (let n = 0; n < 200; n++) {
        const mid = (lo + hi) / 2;
        if (!(mid > lo && mid < hi)) break;
        const tMid = slopeAt(mid);
        if (tMid === 0) {
          lo = hi = mid;
          break;
        }
        if (tMid > 0 === tLo > 0) {
          lo = mid;
          tLo = tMid;
        } else hi = mid;
      }
      consider((lo + hi) / 2);
    }
  }
  consider(L);
  return best;
}

/** Real roots of ax² + bx + c, with scaling and a cancellation-resistant q formula. */
function quadraticRoots(a: number, b: number, c: number): number[] {
  if (a === 0) return b === 0 ? [] : [-c / b];
  if (b === 0 && c === 0) return [0];
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (!(scale > 0) || !Number.isFinite(scale)) return [];
  const as = a / scale;
  const bs = b / scale;
  const cs = c / scale;
  const discriminant = bs * bs - 4 * as * cs;
  if (discriminant < 0) return [];
  const rootDiscriminant = Math.sqrt(discriminant);
  if (rootDiscriminant === 0) return [-bs / (2 * as)];
  const q = -0.5 * (bs + (bs >= 0 ? rootDiscriminant : -rootDiscriminant));
  if (q === 0) return [-bs / (2 * as)];
  return [q / as, cs / q];
}

// ---------------------------------------------------------------------------
// The calc-point form: inputs as plain numbers with the unit in the name, the
// convention every bim-calc plugin follows, so a schedule or an agent tool can
// run it with nothing from the model.

export const simpleBeamCalcInputSchema = z
  .object({
    span_ft: z.number().finite().positive().max(1000),
    uniform_plf: z.number().finite().min(0).max(1_000_000),
    point_loads: z
      .array(z.object({ p_lbf: z.number().finite().min(0).max(10_000_000), a_ft: z.number().finite().min(0).max(1000), label: z.string().max(80).optional() }).strict())
      .max(100)
      .default([]),
    allowable_moment_kip_ft: z.number().finite().positive().max(100_000).optional(),
    /** Modulus of elasticity, E. Give with `moment_inertia_in4`, or neither (no deflection). */
    elastic_modulus_ksi: z.number().finite().positive().max(100_000).optional(),
    /** Moment of inertia about the bending axis, I, constant over the span. Give with `elastic_modulus_ksi`, or neither. */
    moment_inertia_in4: z.number().finite().positive().max(10_000_000).optional(),
  })
  .strict();
export type SimpleBeamCalcInput = z.input<typeof simpleBeamCalcInputSchema>;
