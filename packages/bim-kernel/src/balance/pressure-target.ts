import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { Space } from "../spaces/types";

/**
 * The pressure-target contract (`kernel.pressure_target`, contract 1.3.0): a
 * space's design pressure from its use, and the point a pack contributes the
 * source at. Kept in the kernel because the contract names it; the balance
 * that reads it lives in the Mechanical add-on.
 */

export type PressureState = "positive" | "negative" | "neutral";

export interface PressureTargetResolution {
  readonly target: PressureState;
  /** In words, with the source: "Kitchens are kept negative to the dining room (…)". */
  readonly why: string;
}

/** A space's pressure target from its use (a host registers one built from the space-use library). */
export type PressureTargetSource = (space: Space) => PressureTargetResolution | null;

/** One pack's design pressure targets (v1): built from a space-use library by the pack that reads it. */
export interface PressureTargetRow {
  readonly id: string;
  readonly target: PressureTargetSource;
}

/** Pressure-target sources (v1). The last row in set order is in force: a model's own pack overrides the first-party default. */
export const PRESSURE_TARGET_POINT = defineExtensionPoint<PressureTargetRow>({ id: "kernel.pressure_target", version: 1, label: "Pressure targets", idOf: (r) => r.id });

/** The design targets of the set in force, or null when no pack in it contributes any. */
export function registeredPressureTargets(): PressureTargetSource | null {
  return activePackSet().items(PRESSURE_TARGET_POINT).at(-1)?.target ?? null;
}
