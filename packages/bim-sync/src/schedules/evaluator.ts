import { canonicalJson, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import type { RowPatch, RowSet } from "./rows";
import type { ScheduleClosedReason, ScheduleTarget } from "./protocol";

/**
 * The seam between live sync and the schedule row engine (Stream E). The
 * sync layer never evaluates a schedule itself: it asks the evaluator to open
 * one over the whole model, keeps the instance while anyone has it open, and
 * hands it each batch of committed changesets. The instance answers with an
 * incremental patch (its read sets decide which rows to touch), not a rebuild.
 */
export type ScheduleApplyResult =
  /** Nothing this schedule reads changed. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "patch"; readonly patch: RowPatch }
  /** The definition itself changed (columns, source…): `rows()` is rebuilt; subscribers get fresh windows. */
  | { readonly kind: "reset" }
  /** The schedule view was deleted. */
  | { readonly kind: "closed"; readonly reason: ScheduleClosedReason; readonly message: string };

export interface ScheduleInstance {
  readonly viewId: string;
  /** The whole schedule at the revision it last applied. */
  rows(): RowSet;
  /** `changes` are consecutive and `model` is the model after the last of them. */
  apply(model: ModelState, changes: readonly Changeset[]): ScheduleApplyResult;
}

export type ScheduleOpenResult =
  | { readonly ok: true; readonly instance: ScheduleInstance }
  | { readonly ok: false; readonly reason: ScheduleClosedReason; readonly message: string };

export interface ScheduleEvaluator {
  open(model: ModelState, target: ScheduleTarget): ScheduleOpenResult;
}

/** Subscribers asking for the same view (or the same ad hoc definition) share one evaluation. */
export function scheduleTargetKey(target: ScheduleTarget): string {
  return "viewId" in target ? `view:${target.viewId}` : `def:${canonicalJson(target.definition)}`;
}
