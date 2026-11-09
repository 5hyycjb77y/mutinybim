import type { ScriptApproval, ScriptApprovalStore } from "../host";

/**
 * The rules every host applies to agent-written scripts (product decision, Nov 4):
 *
 * - Scripts run on a separate sealed machine, never in the process serving
 *   the tools: that process only sends the script and reads its answer.
 * - The agent may run a script it just wrote to show a preview; nothing in
 *   the model changes until a person approves that result.
 * - Reusing a saved script needs a person's approval of that version.
 * - "Approve for this session" is allowed only for low-risk results;
 *   deletes, large batches, cross-system writes and anything touching
 *   approvals or sign-offs ask every time.
 */

/** The tool pack the script tools ship in: the core (`@permitzip/bim-plugin` skill `mutinybim`). */
export const SCRIPT_TOOL_PACK_ID = "mutinybim";

/** The tool that lands a checked script result in the model. */
export const SCRIPT_APPLY_TOOL = "bim_apply_output";
/** The tool that saves a part script's part types (and the script version) to the library. */
export const SCRIPT_SAVE_PART_TYPE_TOOL = "bim_save_part_type";

/** What one checked script result would change, read before it is offered for approval. */
export interface ScriptChangeSummary {
  readonly creates: number;
  readonly edits: number;
  readonly deletes: number;
  /** The result writes outside the model (the library, another system). */
  readonly crossSystem: boolean;
  /** The result touches approvals or sign-offs. */
  readonly touchesSignoffs: boolean;
  /** Every changed record sits inside the scope the person saw in the preview. */
  readonly insidePreviewedScope: boolean;
}

/** Whether a result may ride an "Approve for this session" grant, with the reasons it may not. */
export type ScriptApprovalTier = { readonly tier: "session_allowed" } | { readonly tier: "ask_every_time"; readonly reasons: readonly string[] };

/** More changes than this in one result is a large batch: it asks every time. */
export const SESSION_APPROVAL_MAX_CHANGES = 50;

/**
 * The risk rule for session approvals: only a low-risk result may ride an
 * "Approve for this session" grant. Deletes, large batches, writes outside
 * the model, anything touching approvals or sign-offs, and changes outside
 * what the person saw in the preview ask every time.
 */
export function scriptApprovalTier(summary: ScriptChangeSummary): ScriptApprovalTier {
  const reasons: string[] = [];
  const changes = summary.creates + summary.edits + summary.deletes;
  if (summary.deletes > 0) reasons.push(`It deletes ${summary.deletes} element${summary.deletes === 1 ? "" : "s"}.`);
  if (changes > SESSION_APPROVAL_MAX_CHANGES) reasons.push(`It changes ${changes} things at once (more than ${SESSION_APPROVAL_MAX_CHANGES}).`);
  if (summary.crossSystem) reasons.push("It writes outside the model (the firm library or another system).");
  if (summary.touchesSignoffs) reasons.push("It touches approvals, locks or sign-offs.");
  if (!summary.insidePreviewedScope) reasons.push("It changes things outside what the preview showed you.");
  return reasons.length === 0 ? { tier: "session_allowed" } : { tier: "ask_every_time", reasons };
}

/**
 * Whether this call's approval may offer, and an existing grant may cover,
 * "Approve for the rest of this session". `bim_apply_output` carries the
 * tier its preview computed (`approval`); the tool recomputes it when it
 * runs and refuses a call that claimed a lower tier, so a wrong claim changes
 * nothing. Saving to the library always asks. Every other tool: true (this
 * rule doesn't decide it).
 */
export function scriptCallAllowsSessionApproval(toolName: string, input: unknown): boolean {
  if (toolName === SCRIPT_SAVE_PART_TYPE_TOOL) return false;
  if (toolName !== SCRIPT_APPLY_TOOL) return true;
  return typeof input === "object" && input !== null && (input as { approval?: unknown }).approval === "session_allowed";
}

/**
 * Whether a saved script version may run for this caller: its own author may
 * always preview it; anyone else needs a person's approval of that version
 * and source in force.
 */
export async function scriptRunAllowed(store: Pick<ScriptApprovalStore, "approvalOf">, script: { readonly key: string; readonly version: string; readonly hash: string; readonly authoredByCaller: boolean }): Promise<{ readonly ok: true; readonly approval: ScriptApproval | null } | { readonly ok: false; readonly message: string }> {
  if (script.authoredByCaller) return { ok: true, approval: null };
  const approval = await store.approvalOf(script.key, script.hash);
  if (approval) return { ok: true, approval };
  return { ok: false, message: `${script.key} ${script.version} isn't approved for agents, and you didn't write it, so it can't run here. Ask a person who approves firm library parts to approve this version; until then, write a script of your own and preview that.` };
}
