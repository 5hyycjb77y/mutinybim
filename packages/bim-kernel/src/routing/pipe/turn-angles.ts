import type { SystemKind } from "../../parts";
import { activePackSet } from "../../packs/scope";
import { familyMismatch, fittingFamilies, type FittingFamily } from "../fittings/library";
import type { RunPoint, RunSize } from "../types";

/**
 * The turns a pipe run may take come from the elbow families in force: a run
 * turns, rises and heads in plan at the angles some elbow made for its
 * service, material and size turns. An add-on says what each family turns
 * (`FittingFamily.angles`); the kernel only reads that. With no family that
 * says otherwise (a bare kernel, or families that make 45° and 90° only), a
 * pipe turns 45° or 90°, the angles cast and wrought fittings are always made at.
 */

export const DEFAULT_PIPE_TURN_ANGLES: readonly number[] = [45, 90];

type PipeSize = Extract<RunSize, { shape: "pipe" }>;

/** The turns (degrees) one elbow family is made for; empty for a family made to any angle. */
export function familyTurnAngles(family: Pick<FittingFamily, "angles">): readonly number[] {
  const a = family.angles ?? "45_90";
  if (a === "45_90") return DEFAULT_PIPE_TURN_ANGLES;
  if (a === "any") return [];
  const n = Number(a);
  return Number.isFinite(n) && n > 0 && n <= 180 ? [n] : [];
}

/** True when the family is made for a turn of `deg` (within half a degree). */
export function familyMakesTurn(family: Pick<FittingFamily, "angles">, deg: number): boolean {
  if (family.angles === "any") return true;
  return familyTurnAngles(family).some((a) => Math.abs(a - deg) <= 0.5);
}

/** A pipe family that says what it turns (only turning fittings do), fit for this pipe and system. */
function turnFamilyFits(f: FittingFamily, kind: SystemKind | undefined, size: PipeSize | undefined, angleDeg?: number): boolean {
  const type = f.fittingTypes[0];
  if (f.domain !== "pipe" || !f.pipe || f.angles === undefined || type === undefined) return false;
  return familyMismatch(f, { fittingType: type, domain: "pipe", sizes: size ? [size] : [], ...(kind ? { systemKind: kind } : {}), ...(angleDeg !== undefined ? { angleDeg } : {}) }) === null;
}

/**
 * The turns (degrees, smallest first) a pipe of this size may take on a
 * system of this kind: every angle an elbow in force fit for it is made at.
 * 45° and 90° when no family here says.
 */
export function pipeTurnAngles(kind: SystemKind | undefined, size: PipeSize | undefined): readonly number[] {
  const key = `kernel.pipe_turn_angles#${kind ?? ""}|${size ? `${size.material}|${size.nominalMm}` : ""}`;
  return activePackSet().memo(key, () => {
    const out = new Set<number>();
    for (const f of fittingFamilies()) {
      if (!turnFamilyFits(f, kind, size)) continue;
      for (const a of familyTurnAngles(f)) out.add(a);
    }
    return out.size > 0 ? [...out].sort((a, b) => a - b) : DEFAULT_PIPE_TURN_ANGLES;
  });
}

/** The first elbow family in force made for a turn of `angleDeg` on this pipe, or null. */
export function pipeElbowForTurn(kind: SystemKind | undefined, size: PipeSize | undefined, angleDeg: number): FittingFamily | null {
  for (const f of fittingFamilies()) {
    if (f.angles === "45_90" || f.angles === "any" || f.angles === undefined) continue;
    if (familyMakesTurn(f, angleDeg) && turnFamilyFits(f, kind, size, angleDeg)) return f;
  }
  for (const f of fittingFamilies()) if (familyMakesTurn(f, angleDeg) && turnFamilyFits(f, kind, size, angleDeg)) return f;
  return null;
}

/** The slopes (degrees from level) a rise may take when an elbow family is made to any angle. */
export const RISE_SLOPE_ANGLES: readonly number[] = [22.5, 45, 60];

/** The slopes before any family says: 45°, the angle every elbow family is made at. */
const DEFAULT_RISE_SLOPES: readonly number[] = [45];

/**
 * The slopes (degrees from level, under 90°, smallest first) a run may rise
 * or drop on: pipe follows `pipeTurnAngles`; any other run kind follows the
 * elbow families in force for its domain. A family made to any angle rises on
 * each of `RISE_SLOPE_ANGLES`; one made only for some turns rises on those.
 * 45° when no family here says.
 */
export function runSlopeAngles(domain: string, kind: SystemKind | undefined, size: RunSize | undefined): readonly number[] {
  if (domain === "pipe") return pipeTurnAngles(kind, size?.shape === "pipe" ? size : undefined).filter((a) => a < 90);
  return activePackSet().memo(`kernel.run_slope_angles#${domain}`, () => {
    const out = new Set<number>();
    for (const f of fittingFamilies()) {
      // A family that says what it turns (only turning fittings do), as for pipe; one that doesn't makes 45° and 90°.
      if (f.domain !== domain || f.angles === undefined) continue;
      const made = f.angles === "any" ? RISE_SLOPE_ANGLES : familyTurnAngles(f);
      for (const a of made) if (a > 0 && a < 90) out.add(a);
    }
    return out.size > 0 ? [...out].sort((a, b) => a - b) : DEFAULT_RISE_SLOPES;
  });
}

/**
 * The plan steps (degrees) a run turning at `angles` heads on: each angle's
 * greatest common step with a right angle (45° for 45° and 90° turns, 22½°
 * for 22½° turns, 30° for 60° turns). A heading is fine on any of them.
 */
export function planStepsFor(angles: readonly number[]): readonly number[] {
  const gcd = (a: number, b: number): number => {
    let x = Math.round(a * 1000);
    let y = Math.round(b * 1000);
    while (y) [x, y] = [y, x % y];
    return x / 1000;
  };
  const steps = new Set<number>();
  for (const a of angles) if (a > 0) steps.add(gcd(a, 90));
  return [...steps].sort((a, b) => b - a);
}

/** A leg climbing at one of `angles` (degrees from level, under 90°) in a vertical plane. */
export function isSlopeAt(v: RunPoint, angles: readonly number[]): boolean {
  const plan = Math.hypot(v.x, v.y);
  if (plan <= 0.01) return false;
  return angles.some((a) => a > 0 && a < 90 && Math.abs(Math.abs(v.z) - plan * Math.tan((a * Math.PI) / 180)) < 0.01 * Math.max(1, plan / 1000));
}

/** "45° or 90°", "22½°, 45°, 60° or 90°". */
export function turnAnglesWords(angles: readonly number[]): string {
  const w = angles.map((a) => (a === 22.5 ? "22½°" : `${a}°`));
  return w.length <= 1 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} or ${w[w.length - 1]}`;
}
