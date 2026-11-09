import type { Actor } from "@permitzip/bim-kernel";
import type { ConnectionPrincipal } from "../hub";
import { applyMerge, previewMerge, type MainLander, type MergeApprovalSource, type MergeSides } from "./engine";
import { MERGE_WORDS, type MergeClientMessage, type MergeServerMessage } from "./messages";

export interface MergeWho {
  readonly userId: string;
  readonly token: string;
  readonly canEdit: boolean;
}

export const MERGE_NEEDS_PERSON = "Only a person lands a merge. Ask them to press Merge approved parts.";
export const MERGE_NO_SIGN_IN = "Sign in again: this connection has no person to merge as.";
export const MERGE_FAILED = "The merge didn't finish. Nothing more landed than it says; try again in a moment.";

/** One parsed merge message answered: preview, or apply through `lander`. Never throws. */
export async function answerMerge(msg: MergeClientMessage, deps: { readonly sides: MergeSides | null; readonly source: MergeApprovalSource; readonly lander: MainLander; readonly who: MergeWho }): Promise<MergeServerMessage> {
  if (!deps.sides) return { type: "merge_refused", requestId: msg.requestId, message: MERGE_WORDS.notABranch };
  try {
    if (msg.type === "merge_preview") {
      const out = await previewMerge(deps.sides, deps.source, deps.who);
      return out.ok ? { type: "merge_preview_result", requestId: msg.requestId, preview: out.preview } : { type: "merge_refused", requestId: msg.requestId, message: out.message };
    }
    const out = await applyMerge(deps.sides, deps.source, deps.lander, deps.who, msg.proposalId);
    if (!out.ok) return { type: "merge_refused", requestId: msg.requestId, message: out.message };
    return { type: "merge_apply_result", requestId: msg.requestId, landed: out.landed, waiting: out.waiting, allLanded: out.allLanded };
  } catch (err) {
    console.error("[bim-sync] merge failed", { type: msg.type, branchId: deps.sides.branch.branchId, err });
    return { type: "merge_refused", requestId: msg.requestId, message: MERGE_FAILED };
  }
}

/**
 * The hub's `merge` option for one branch session, the same for the model
 * server and the in-memory host. Only a person (a human actor) applies;
 * anyone admitted may preview. Each apply gets its own lander, so its parts
 * land as one session on Main. `onAnswered` sees every reply (the server
 * logs landings and marks the branch merged when everything landed).
 */
export function mergeSessionHandler(input: {
  readonly sides: () => Promise<MergeSides>;
  readonly source: MergeApprovalSource;
  readonly lander: (actor: Actor) => MainLander;
  readonly who: (connectionId: string, principal: ConnectionPrincipal) => MergeWho | null;
  readonly onAnswered?: (msg: MergeClientMessage, reply: MergeServerMessage) => Promise<void>;
}): (msg: MergeClientMessage, from: { readonly connectionId: string; readonly principal: ConnectionPrincipal; readonly actor: Actor | null }) => Promise<MergeServerMessage> {
  return async (msg, from) => {
    const who = input.who(from.connectionId, from.principal);
    if (!who || !from.actor) return { type: "merge_refused", requestId: msg.requestId, message: MERGE_NO_SIGN_IN };
    if (msg.type === "merge_apply" && from.actor.kind !== "human") return { type: "merge_refused", requestId: msg.requestId, message: MERGE_NEEDS_PERSON };
    const reply = await answerMerge(msg, { sides: await input.sides(), source: input.source, lander: input.lander(from.actor), who });
    await input.onAnswered?.(msg, reply);
    return reply;
  };
}
