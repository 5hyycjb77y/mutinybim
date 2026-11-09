import type { AdditiveKind, Quantity } from "@permitzip/bim-units";
import { balance, type BalanceVerdict } from "./core";

/**
 * A typed balance over named contributors (KERNEL-REQUIREMENTS-MODEL §3.10):
 * every term says what it is, which side it is on and its typed value. One
 * shape for building pressurization (exhaust out, makeup air and outdoor air
 * in), zone air, a panel's phases, load vs a source's rating and pump inflow vs
 * the pump. Trades build the contributor list; this file only adds them up.
 *
 * Never a partial total: when any contributor has no value the result is
 * `incomplete` and names each one and why, with no sums at all.
 */

export type BalanceSide = "in" | "out";

export interface BalanceContributor<K extends AdditiveKind> {
  /** The element (or a stable key for a computed term). */
  readonly id: string;
  /** As a person reads it on a schedule: "KEF-1". */
  readonly label: string;
  readonly side: BalanceSide;
  /** What the term is, trade's own word: "exhaust", "makeup_air", "outdoor_air". */
  readonly role: string;
  /** Always non-negative; the side gives the sign. Null when it can't be read. */
  readonly value: Quantity<K> | null;
  /** Why `value` is null, in words. */
  readonly missing?: string;
}

export interface QuantityBalanceTolerance<K extends AdditiveKind> {
  /** Differences up to this always count as balanced. */
  readonly absolute?: Quantity<K>;
  /** Differences up to this percent of the larger side count as balanced. */
  readonly percent?: number;
}

export interface BalanceMissing {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface CompleteBalance<K extends AdditiveKind> {
  readonly status: "complete";
  readonly kind: K;
  readonly contributors: readonly BalanceContributor<K>[];
  readonly inflow: Quantity<K>;
  readonly outflow: Quantity<K>;
  /** in − out. */
  readonly net: Quantity<K>;
  /** The band that applied (larger of the absolute floor and the percentage). */
  readonly tolerance: Quantity<K>;
  /** |net| as a percent of the larger side; null when both are zero. */
  readonly percent: number | null;
  readonly verdict: BalanceVerdict;
}

export interface IncompleteBalance<K extends AdditiveKind> {
  readonly status: "incomplete";
  readonly kind: K;
  readonly contributors: readonly BalanceContributor<K>[];
  readonly missing: readonly BalanceMissing[];
}

export type QuantityBalance<K extends AdditiveKind> = CompleteBalance<K> | IncompleteBalance<K>;

/** Sum the contributors of one kind; incomplete (naming each gap) when any value is missing. */
export function balanceOf<K extends AdditiveKind>(kind: K, contributors: readonly BalanceContributor<K>[], tolerance: QuantityBalanceTolerance<K> = {}): QuantityBalance<K> {
  const missing: BalanceMissing[] = [];
  let inflow = 0;
  let outflow = 0;
  for (const c of contributors) {
    if (c.value === null || !Number.isFinite(c.value)) {
      missing.push({ id: c.id, label: c.label, reason: c.missing ?? `${c.label} has no value.` });
      continue;
    }
    if (c.value < 0) throw new RangeError(`${c.label}: a balance term is never negative; put it on the other side (got ${c.value}).`);
    if (c.side === "in") inflow += c.value;
    else outflow += c.value;
  }
  if (missing.length > 0) return { status: "incomplete", kind, contributors, missing };
  const b = balance(inflow, outflow, { ...(tolerance.absolute !== undefined ? { absolute: tolerance.absolute } : {}), ...(tolerance.percent !== undefined ? { percent: tolerance.percent } : {}) });
  return {
    status: "complete",
    kind,
    contributors,
    inflow: inflow as Quantity<K>,
    outflow: outflow as Quantity<K>,
    net: b.difference as Quantity<K>,
    tolerance: b.tolerance as Quantity<K>,
    percent: b.percent,
    verdict: b.verdict,
  };
}

/** "KEF-1 has no exhaust airflow; MUA-1 has no …": the gaps of an incomplete balance as one sentence. */
export function balanceMissingText(missing: readonly BalanceMissing[]): string {
  return missing.map((m) => m.reason).join(" ");
}
