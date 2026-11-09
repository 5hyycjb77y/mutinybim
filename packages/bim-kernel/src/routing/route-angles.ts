import { DEFAULT_PIPE_TURN_ANGLES, planStepsFor, turnAnglesWords } from "./pipe/turn-angles";
import type { RunPoint } from "./types";

/**
 * The angles routed runs may take.
 *
 * Duct: a level or sloped leg may head any way in plan, and an elbow may turn
 * any angle up to `MAX_DUCT_TURN_DEG`. Sheet-metal elbows are made to the
 * angle (radius, gored and mitred elbows), and their loss coefficients
 * follow it (`bendAngleFactor`, `mitreCoefficient`). Families made only for
 * some turns (mitred with vanes: 45° and 90°) refuse other angles with the reason.
 *
 * Pipe turns only at the angles its elbows are made for, and heads in plan
 * on those angles' steps (`pipe/turn-angles.ts` reads them from the fitting
 * families in force: 45° / 90° and 45° steps unless a family makes others).
 *
 * The Route tool snaps to `ROUTE_SNAP_ANGLES_DEG` from the working angle;
 * holding Alt (Option) draws at any angle.
 */

/** Turns sharper than this fold the throat over the heel; make them as two elbows. */
export const MAX_DUCT_TURN_DEG = 135;

/** Plan headings the Route tool snaps to, in degrees from the working angle (and every multiple up to 360°). */
export const ROUTE_SNAP_ANGLES_DEG: readonly number[] = [15, 22.5];

/** The headings a snap may land on, 0 to 360° (multiples of 15° and of 22.5°). */
export function routeSnapHeadings(): number[] {
  const out = new Set<number>();
  for (const step of ROUTE_SNAP_ANGLES_DEG) for (let a = 0; a < 360 - 1e-9; a += step) out.add(Math.round(a * 1000) / 1000);
  return [...out].sort((a, b) => a - b);
}

/** Why leg `i` (vector `v`, not plumb) can't head that way in plan, or null. `angles`: the pipe's turns (45° and 90° when absent). */
export function ductLegPlanIssue(i: number, v: RunPoint, pipe: boolean, angles: readonly number[] = DEFAULT_PIPE_TURN_ANGLES): string | null {
  if (!pipe) return null;
  const deg = (((Math.atan2(v.y, v.x) * 180) / Math.PI) + 360) % 360;
  const steps = planStepsFor(angles);
  if (headingOnSteps(deg, steps)) return null;
  if (steps.length === 1 && steps[0] === 45) return `Leg ${i + 1} runs at ${deg.toFixed(0)}°; draw pipe east-west, north-south or at 45°`;
  return `Leg ${i + 1} runs at ${deg.toFixed(0)}°; this run's pipe elbows turn ${turnAnglesWords(angles)}, so draw it at a multiple of ${turnAnglesWords(steps)} from east-west`;
}

function headingOnSteps(deg: number, steps: readonly number[]): boolean {
  return steps.some((step) => {
    const off = ((deg % step) + step) % step;
    return off < 0.01 || off > step - 0.01;
  });
}

/** True when a routed segment's plan heading is one routing makes. `angles`: a pipe's turns (45° and 90° when absent). */
export function planHeadingOk(domain: "duct" | "pipe" | "conduit", d: RunPoint, angles: readonly number[] = DEFAULT_PIPE_TURN_ANGLES): boolean {
  if (domain === "duct") return true;
  return headingOnSteps((Math.atan2(d.y, d.x) * 180) / Math.PI + 360, planStepsFor(angles));
}

/** The elbow angle for a turn of `turn` degrees at point `at`, or the reason no elbow makes it. `angles`: a pipe's turns (45° and 90° when absent). */
export function elbowTurnFor(pipe: boolean, turn: number, tolDeg: number, at: number, angles: readonly number[] = DEFAULT_PIPE_TURN_ANGLES): number | string {
  if (pipe) {
    let best: number | null = null;
    for (const a of angles) if (Math.abs(turn - a) <= tolDeg && (best === null || Math.abs(turn - a) < Math.abs(turn - best))) best = a;
    if (best === null) return `The turn at point ${at} is ${turn.toFixed(0)}°; this run's pipe elbows turn ${turnAnglesWords(angles)}`;
    return best;
  }
  if (turn > MAX_DUCT_TURN_DEG + 0.5) return `The turn at point ${at} is ${turn.toFixed(0)}°; an elbow turns at most ${MAX_DUCT_TURN_DEG}°, so turn it in two elbows with a straight piece between`;
  return Math.round(turn * 100) / 100;
}
