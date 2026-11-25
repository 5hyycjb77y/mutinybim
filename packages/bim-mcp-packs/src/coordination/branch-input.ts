import { z } from "zod";

/** The `branch` argument on `bim_set_active_group_and_phase`. Strict: an unknown key (say `approve`) is refused, never ignored. */
export const agentBranchSchema = z
  .object({
    start: z.string().trim().min(1).max(80).optional().describe('New branch name to create from Main; this thread then edits it.'),
    from_version: z.number().int().min(0).optional(),
    checkout: z.string().trim().min(1).max(80).optional().describe('Existing open branch name or id to switch this thread onto (or "main" to return to Main).'),
    propose_merge: z.literal(true).optional(),
  })
  .strict()

export type AgentBranchInput = z.infer<typeof agentBranchSchema>

export type AgentBranchAction =
  | { readonly kind: 'start'; readonly name: string; readonly fromVersion?: number }
  | { readonly kind: 'checkout'; readonly target: string }
  | { readonly kind: 'propose_merge' }

/** The one action asked for, or the words to send back. */
export function readAgentBranchAction(input: AgentBranchInput): AgentBranchAction | string {
  const count = [input.start !== undefined, input.checkout !== undefined, input.propose_merge === true].filter(Boolean).length
  if (count > 1) return 'Give only one of branch.start, branch.checkout, or branch.propose_merge.'
  if (input.start !== undefined) return { kind: 'start', name: input.start, ...(input.from_version !== undefined ? { fromVersion: input.from_version } : {}) }
  if (input.from_version !== undefined) return 'branch.from_version goes with branch.start.'
  if (input.checkout !== undefined) return { kind: 'checkout', target: input.checkout }
  if (input.propose_merge) return { kind: 'propose_merge' }
  return 'Give branch.start (new branch name), branch.checkout (existing branch name/id or "main"), or branch.propose_merge.'
}
