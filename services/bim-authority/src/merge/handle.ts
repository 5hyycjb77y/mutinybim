import { answerMerge, mergeClientMessageSchema, type MainLander, type MergeApprovalSource, type MergeServerMessage, type MergeSides, type MergeWho } from "@permitzip/bim-sync";

/**
 * One merge message on a session, answered and logged. `server.ts` hands the
 * hub `mergeSessionHandler` for each branch session; this is the same answer
 * for a caller holding a raw message (drills). `sides` is null on a Main
 * session; `lander` commits one part as one revision on Main, attributed to
 * the person.
 */
export interface MergeSessionDeps {
  readonly sides: MergeSides | null;
  readonly source: MergeApprovalSource;
  readonly lander: MainLander;
  readonly who: MergeWho;
}

export async function handleMergeMessage(raw: unknown, deps: MergeSessionDeps): Promise<MergeServerMessage | null> {
  const parsed = mergeClientMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const reply = await answerMerge(parsed.data, deps);
  logMergeReply(deps.sides, reply);
  return reply;
}

/** What landed, for the logs (`/morning-audit` reads them). */
export function logMergeReply(sides: Pick<MergeSides, "branch"> | null, reply: MergeServerMessage): void {
  if (reply.type !== "merge_apply_result" || !sides) return;
  console.log("[bim-authority] merge applied", {
    baseModelId: sides.branch.baseModelId,
    branchId: sides.branch.branchId,
    landed: reply.landed.map((l) => ({ discipline: l.discipline, revision: l.revision, count: l.elementIds.length })),
    waiting: reply.waiting.length,
  });
}
