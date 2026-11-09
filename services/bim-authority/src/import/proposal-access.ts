import { parseBranchModelId } from "@permitzip/bim-kernel";
import type { ImportRunStore } from "./runs";

/**
 * Product decision, answer 7: anyone who can read a model may open a linked model as
 * their own proposal branch, and edit that branch. A branch is otherwise
 * edited by exactly the people who edit its base; this adds one case: the
 * person who opened it through a finished import, when they can read the
 * base. Nobody else gains anything, and Main is never written by a branch.
 */
export async function proposalOwnerCanWrite(runs: ImportRunStore, input: { readonly modelId: string; readonly userId: string; readonly canRead: boolean; readonly canWrite: boolean }): Promise<boolean> {
  if (input.canWrite) return true;
  if (!input.canRead || !parseBranchModelId(input.modelId)) return false;
  try {
    return await runs.ownsProposal(input.modelId, input.userId);
  } catch (err) {
    console.error("[bim-authority/import] checking who opened this proposal failed; read-only for now", { modelId: input.modelId, err });
    return false;
  }
}
