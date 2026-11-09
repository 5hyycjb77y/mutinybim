/**
 * The shared balance shape (KERNEL-REQUIREMENTS-MODEL §3.10): what comes in
 * against what goes out (or what is needed against what is provided), with an
 * absolute floor beside the percentage so a tiny difference on a tiny number is
 * not called "135% off" (Electrical Demo 2, B10). Trade-neutral: pump inflow vs
 * pump, zone air in vs out, a panel's phases, load vs a source's rating.
 *
 * Numbers are in one unit, which the caller names and formats. The typed form
 * with named contributors is `balanceOf` (balance/quantity.ts).
 */

export interface BalanceTolerance {
  /** Differences up to this, in the caller's unit, always count as balanced. Default 0. */
  readonly absolute?: number;
  /** Differences up to this percent of the larger side count as balanced. Default 0. */
  readonly percent?: number;
}

export type BalanceVerdict = "balanced" | "more_in" | "more_out";

export interface BalanceResult {
  /** in − out. */
  readonly difference: number;
  /** The tolerance that applied: the larger of the absolute floor and the percentage of the larger side. */
  readonly tolerance: number;
  /** The difference as a percent of the larger side; null when both are zero. */
  readonly percent: number | null;
  readonly verdict: BalanceVerdict;
}

/** Two sides that should match. */
export function balance(inflow: number, outflow: number, tolerance: BalanceTolerance = {}): BalanceResult {
  if (!Number.isFinite(inflow) || !Number.isFinite(outflow)) throw new RangeError(`A balance needs two finite numbers, got ${inflow} and ${outflow}`);
  const larger = Math.max(Math.abs(inflow), Math.abs(outflow));
  const tol = Math.max(tolerance.absolute ?? 0, ((tolerance.percent ?? 0) / 100) * larger);
  const difference = inflow - outflow;
  const percent = larger === 0 ? null : (Math.abs(difference) / larger) * 100;
  const verdict = Math.abs(difference) <= tol + 1e-9 ? "balanced" : difference > 0 ? "more_in" : "more_out";
  return { difference, tolerance: tol, percent, verdict };
}

export interface DemandCoverage {
  /** capacity − demand: positive is spare, negative is short. */
  readonly spare: number;
  readonly tolerance: number;
  readonly ok: boolean;
}

/** A capacity that must cover a demand (pump flow vs inflow, pipe capacity vs load); the tolerance lets a hair over pass. */
export function coversDemand(demand: number, capacity: number, tolerance: BalanceTolerance = {}): DemandCoverage {
  const b = balance(demand, capacity, tolerance);
  return { spare: -b.difference, tolerance: b.tolerance, ok: b.verdict !== "more_in" };
}
