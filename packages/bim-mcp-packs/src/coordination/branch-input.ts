import { z } from "zod";

/** The `branch` argument on `bim_set_active_group_and_phase`. Strict: an unknown key (say `approve`) is refused, never ignored. */
export const agentBranchSchema = z
  .object({
    start: z.string().trim().min(1).max(80).optional().describe('Branch name; this thread then edits it.'),
    from_version: z.number().int().min(0).optional(),
    propose_merge: z.literal(true).optional(),
  })
  .strict()

export type AgentBranchInput = z.infer<typeof agentBranchSchema>

export type AgentBranchAction = { readonly kind: 'start'; readonly name: string; readonly fromVersion?: number } | { readonly kind: 'propose_merge' }

/** The one action asked for, or the words to send back. */
export function readAgentBranchAction(input: AgentBranchInput): AgentBranchAction | string {
  if (input.start !== undefined && input.propose_merge) return 'Give branch.start or branch.propose_merge, not both.'
  if (input.start !== undefined) return { kind: 'start', name: input.start, ...(input.from_version !== undefined ? { fromVersion: input.from_version } : {}) }
  if (input.from_version !== undefined) return 'branch.from_version goes with branch.start.'
  if (input.propose_merge) return { kind: 'propose_merge' }
  return 'Give branch.start (a name) or branch.propose_merge.'
}
