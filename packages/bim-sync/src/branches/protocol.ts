import { z } from "zod";
import type { BimElement, BranchRef, SavedVersion } from "@permitzip/bim-kernel";
import { coverageCheckSchema, type CoverageResult } from "./coverage";
import { STATE_AT_MAX_IDS } from "./limits";

/**
 * Branch and history messages (round 8b). A client sends them only when the
 * server's welcome advertised the feature; every request carries a
 * `requestId` and gets exactly one answer with the same id.
 */

/** The server lists, creates and closes branches and serves `<base>~<branch>` model ids. */
export const BRANCHES_SESSIONS_FEATURE = "branches:sessions";
/** The server answers `state_at` and `changed_between` (elements at a revision; ids changed between two). */
export const HISTORY_REVISION_READS_FEATURE = "history:revision_reads";

/**
 * Round 9: the server sends `branch_state` to every connection on a branch
 * whose state changed (closed or merged, here or on another machine). Sent
 * only to a peer that advertises it; an older page learns on its next edit.
 */
export const BRANCHES_STATE_BROADCAST_FEATURE = "branches:state_broadcast";

/** The branch this session is on changed state; the page updates in place (no reconnect). */
export interface BranchStateMessage {
  readonly type: "branch_state";
  readonly branch: BranchRef;
}

/** Most ids one `state_at` may ask for (a schedule page, a merge part); defined in `./limits` so a page can read it alone. */
export { STATE_AT_MAX_IDS };

const requestId = z.string().min(1).max(100);
const revision = z.number().int().min(0);
/** A revision, or that model's head now (a copy's session learns its parent's head this way). */
const revisionOrHead = z.union([revision, z.literal("head")]);

export const branchClientMessageSchemas = [
  z.object({ type: z.literal("branch_list"), requestId }),
  /** From the head, or from a saved or issued version. On a copy's session: a copy of that copy. */
  z.object({ type: z.literal("branch_create"), requestId, name: z.string().trim().min(1).max(80), fromRevision: revision.optional() }),
  z.object({ type: z.literal("branch_close"), requestId, branchId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("version_list"), requestId }),
  z.object({ type: z.literal("version_save"), requestId, name: z.string().trim().min(1).max(80), revision: revision.optional() }),
  z.object({ type: z.literal("version_delete"), requestId, versionId: z.string().min(1).max(100) }),
  /**
   * On a copy's session, `model: "main"` reads the copy it came from (its parent, at any depth) at that
   * revision ("head": the parent now). The wire value stays "main" for older peers; it means "the parent".
   * The answer names the revision read.
   */
  z.object({ type: z.literal("state_at"), requestId, revision: revisionOrHead, ids: z.array(z.string().min(1).max(200)).max(STATE_AT_MAX_IDS), model: z.literal("main").optional() }),
  z.object({
    type: z.literal("changed_between"),
    requestId,
    from: z.union([revision, z.object({ model: z.literal("main"), revision: revisionOrHead })]),
    to: z.union([revision, z.literal("head")]),
  }),
  /** Round 9: who covers a change, read by the server from its own history (`history:coverage_read`). */
  coverageCheckSchema,
] as const;

export type BranchClientMessage = z.infer<(typeof branchClientMessageSchemas)[number]>;

export const BRANCH_CLIENT_TYPES: ReadonlySet<string> = new Set(branchClientMessageSchemas.map((s) => s.shape.type.value));

export type BranchServerMessage =
  | { readonly type: "branches"; readonly requestId: string; readonly branches: readonly BranchRef[] }
  | { readonly type: "branch_saved"; readonly requestId: string; readonly branch: BranchRef }
  | { readonly type: "versions"; readonly requestId: string; readonly head: number; readonly versions: readonly SavedVersion[] }
  | { readonly type: "version_saved"; readonly requestId: string; readonly version: SavedVersion }
  | { readonly type: "version_deleted"; readonly requestId: string; readonly versionId: string }
  | { readonly type: "state_at_result"; readonly requestId: string; readonly revision: number; readonly elements: Readonly<Record<string, BimElement | null>> }
  | { readonly type: "changed_between_result"; readonly requestId: string; readonly ids: readonly string[]; readonly truncated: false }
  | CoverageResult
  /** Not done, in words a person can act on. */
  | { readonly type: "request_refused"; readonly requestId: string; readonly reason: string };

export const BRANCH_SERVER_TYPES: readonly BranchServerMessage["type"][] = [
  "branches",
  "branch_saved",
  "versions",
  "version_saved",
  "version_deleted",
  "state_at_result",
  "changed_between_result",
  "coverage_result",
  "request_refused",
];

export function isBranchClientMessage(msg: { readonly type: string }): msg is BranchClientMessage {
  return BRANCH_CLIENT_TYPES.has(msg.type);
}

/** Said when asked for a branch on a server (or a release) that does not serve it. */
export const BRANCHES_UNAVAILABLE = "Branches aren't available on this model server yet.";
export const BRANCH_EDIT_REQUIRED = "You can view this model but not start or close branches. Ask a project admin for model editing access.";
