import { z } from "zod";
import type { MergeConflict, MergePart, ResponsibilityScope } from "@permitzip/bim-kernel";

/**
 * Merge messages (round 8 step 8b, lane M), feature `branches:merge`. Sent on
 * a branch session: the branch is the session's model, so no client names
 * the branch or Main it merges into. A client asks only when the server
 * advertises the feature; an older server answers with its usual
 * unknown-message error, never a merge.
 *
 * - `merge_preview`: what would merge, by part, with conflicts and who
 *   approves each part.
 * - `merge_apply`: land the parts that every covering professional approved
 *   and that hang on no part still waiting. The server recomputes all of it
 *   from the model it holds and reads approvals from the host as the person;
 *   the proposal id only says which proposal's approvals to read.
 */
export const MERGE_FEATURE = "branches:merge";

const requestId = z.string().min(1).max(100);

export const mergeClientMessageSchemas = [
  z.object({ type: z.literal("merge_preview"), requestId }).strict(),
  z.object({ type: z.literal("merge_apply"), requestId, proposalId: z.string().uuid() }).strict(),
] as const;

export const mergeClientMessageSchema = z.discriminatedUnion("type", [...mergeClientMessageSchemas]);
export type MergeClientMessage = z.infer<typeof mergeClientMessageSchema>;

export function isMergeMessageType(type: string): type is MergeClientMessage["type"] {
  return type === "merge_preview" || type === "merge_apply";
}

/** A part as previewed: the fixed `MergePart` plus the newest branch revision that touched it. */
export interface PreviewPart extends MergePart {
  readonly lastChangedRevision: number;
  /** The part's delta digest (`partDeltaDigest`): what an approval names, and what lands. */
  readonly deltaDigest: string;
  /** Who approves it, in words ("J. Rao", "R. Doe (project lead)"); empty with no lead named. */
  readonly approvers: readonly string[];
  /** No one covers it (round 9): the levels and systems its changes sit on, for "Take responsibility for this". Absent from older servers. */
  readonly suggestedScope?: ResponsibilityScope;
  readonly suggestedScopeWords?: string;
}

export interface MergePreview {
  readonly branchId: string;
  readonly branchName: string;
  readonly baseRevision: number;
  readonly branchHead: number;
  readonly mainHead: number;
  readonly parts: readonly PreviewPart[];
  readonly conflicts: readonly MergeConflict[];
  /** Branch changes Main already has the same way (nothing to do). */
  readonly alreadyOnMain: number;
}

export interface LandedPart {
  readonly discipline: string;
  readonly elementIds: readonly string[];
  /** Main's revision this part landed as. */
  readonly revision: number;
  /** The digest of the part that landed (every approval named it). */
  readonly deltaDigest: string;
}

export interface WaitingPart {
  readonly discipline: string;
  readonly words: string;
}

export type MergeServerMessage =
  | { readonly type: "merge_preview_result"; readonly requestId: string; readonly preview: MergePreview }
  | { readonly type: "merge_apply_result"; readonly requestId: string; readonly landed: readonly LandedPart[]; readonly waiting: readonly WaitingPart[]; readonly allLanded: boolean }
  | { readonly type: "merge_refused"; readonly requestId: string; readonly message: string };

/** Refusals in words a person reads. */
export const MERGE_WORDS = {
  notABranch: "Open a branch to merge it. Main has nothing to merge into itself.",
  branchClosed: "This branch was merged or closed. Start a new branch to keep working.",
  noEdit: "Merging into Main needs edit access to this project's model.",
  wrongProposal: "That merge proposal is for a different branch. Reload and try again.",
  proposalClosed: "This merge is no longer open.",
  notProposer: "Only the person who proposed this merge can land it. Ask them to press Merge approved parts.",
  hostUnavailable: "Couldn't read the approvals right now. Try again in a moment.",
  nothingToLand: "Nothing can land yet. Each part says what it is waiting for.",
  mainMoved: "Main changed while merging. Preview the merge again, then merge.",
} as const;
