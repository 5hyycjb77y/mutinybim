import { createHash } from "node:crypto";
import { canonicalJson, executeCommand, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import type { ModelSlice, ScriptOutput } from "@permitzip/bim-script";
import { scriptApprovalTier, type ScriptApprovalTier, type ScriptChangeSummary } from "./tier";

/**
 * What one checked script result would change, read the same way at preview
 * and again when the approved call runs (so a card and its result can't
 * disagree): which records it creates, edits and deletes on the head, whether
 * it touches locks or sign-offs, and whether every record it changes was in
 * the slice the person previewed.
 */

/** Step kinds that change locks, approvals, issued state or accepted findings. */
const SIGNOFF_STEP = /lock|signoff|sign_off|approv|issue|accept|retract|disposition/;

export function outputHash(output: ScriptOutput): string {
  return `sha256:${createHash("sha256").update(canonicalJson(output)).digest("hex")}`;
}

export interface ScriptChangeReport {
  readonly summary: ScriptChangeSummary;
  readonly tier: ScriptApprovalTier;
  readonly changedIds: readonly string[];
}

export function partTypesChange(output: Extract<ScriptOutput, { kind: "part_types" }>): ScriptChangeReport {
  const summary: ScriptChangeSummary = { creates: output.types.length, edits: 0, deletes: 0, crossSystem: true, touchesSignoffs: false, insidePreviewedScope: true };
  return { summary, tier: scriptApprovalTier(summary), changedIds: [] };
}

/** Null with the kernel's words when a batch doesn't apply on `head` (the check says the same). */
export function editsChange(head: ModelState, output: Extract<ScriptOutput, { kind: "edits" }>, slice: ModelSlice): ScriptChangeReport | { readonly refused: string } {
  const features = new Set(slice.features);
  let model = head;
  const changed = new Set<string>();
  for (const batch of output.batches) {
    const applied = withUpgradePolicy((f) => features.has(f), () => executeCommand(model, batch));
    if (!applied.ok) return { refused: applied.error.message };
    for (const id of applied.changedIds) changed.add(id);
    for (const id of applied.removedIds) changed.add(id);
    model = applied.model;
  }
  let creates = 0;
  let edits = 0;
  let deletes = 0;
  let outside = false;
  for (const id of changed) {
    const before = head.elements[id];
    const after = model.elements[id];
    if (!before && after) creates++;
    else if (before && !after) deletes++;
    else if (before && after) edits++;
    if (before && !slice.elements[id]) outside = true;
  }
  const touchesSignoffs = output.batches.some((b) => b.commands.some((c) => SIGNOFF_STEP.test(c.type)));
  const summary: ScriptChangeSummary = { creates, edits, deletes, crossSystem: false, touchesSignoffs, insidePreviewedScope: !outside };
  return { summary, tier: scriptApprovalTier(summary), changedIds: [...changed] };
}
