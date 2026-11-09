import { fromCanonical, type Quantity } from "@permitzip/bim-units";
import { CIVIL_RCP } from "./ids";

/**
 * Manning's equation for a circular pipe flowing full (`citations.ts`
 * MANNING_EQUATION): Q = (1/n)·A·R^(2/3)·S^(1/2) in SI, A = πD²/4, R = D/4.
 * The US form's 1.486 is (3.2808 ft/m)^(1/3) = 1.4859, the same equation in
 * feet, so an SI result read in cfs matches a hand check in feet to 0.01 %.
 */

/** Manning's n by pipe material id (the pack's RCP and the kernel's built-ins): design values within the published ranges. */
export const MANNING_N: Readonly<Record<string, number>> = {
  [CIVIL_RCP]: 0.013,
  pe: 0.012,
  pvc: 0.011,
  cast_iron: 0.013,
  steel: 0.024,
};

/** Concrete's n when a pipe's material has no row: the usual storm pipe, and the larger (safer) n of the common ones. */
export const DEFAULT_MANNING_N = 0.013;

export function manningNFor(material: string | null): number {
  return (material !== null ? MANNING_N[material] : undefined) ?? DEFAULT_MANNING_N;
}

export interface FullFlow {
  readonly capacity: Quantity<"flow_liquid">;
  readonly velocity: Quantity<"velocity">;
}

/** Capacity and velocity of a round pipe running full. Throws on a non-positive diameter or n, or a negative slope. */
export function manningFullFlow(diameter: Quantity<"length">, slope: Quantity<"slope">, n: number): FullFlow {
  if (!(diameter > 0)) throw new RangeError("[civil/manning] the pipe diameter must be more than zero");
  if (!(n > 0) || !Number.isFinite(n)) throw new RangeError(`[civil/manning] Manning's n must be a positive number, not ${n}`);
  if (slope < 0) throw new RangeError("[civil/manning] a pipe running uphill has no gravity capacity; its slope is negative");
  const area = (Math.PI * diameter * diameter) / 4;
  const r = diameter / 4;
  const v = (1 / n) * Math.pow(r, 2 / 3) * Math.sqrt(slope);
  return { capacity: fromCanonical("flow_liquid", v * area), velocity: fromCanonical("velocity", v) };
}
