import { fromCanonical, to, type Quantity } from "@permitzip/bim-units";
import { z } from "zod";

/**
 * A simply supported beam under one uniform load and any number of point
 * loads: end reactions, the largest bending moment and where it is, and a
 * utilisation against a given allowable moment. Statics by superposition of
 * AISC Manual Table 3-23 cases 1 (uniform load) and 8 (concentrated load at
 * any point). One service-level load case: no load factors or combinations
 * (those are scenarios, round 6).
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
}

export interface SimpleBeamResult {
  readonly startReaction: Quantity<"force">;
  readonly endReaction: Quantity<"force">;
  readonly maxMoment: Quantity<"moment">;
  /** Where the largest moment is, from the start. */
  readonly maxMomentAt: Quantity<"length">;
  /** Largest moment ÷ allowable; null without an allowable. */
  readonly utilisation: number | null;
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
  return {
    startReaction: fromCanonical("force", rStart),
    endReaction: fromCanonical("force", rEnd),
    maxMoment: fromCanonical("moment", best.m),
    maxMomentAt: fromCanonical("length", best.x),
    utilisation: input.allowableMoment !== undefined && input.allowableMoment > 0 ? Math.abs(best.m) / input.allowableMoment : null,
  };
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
  })
  .strict();
export type SimpleBeamCalcInput = z.input<typeof simpleBeamCalcInputSchema>;
