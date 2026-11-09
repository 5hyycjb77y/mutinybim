import { z } from "zod"

/**
 * What the Propose changes dialog and its routes say to each other (round 9
 * I9). Browser-safe: no Node imports. People only: there is no agent tool
 * for this (the round's tool-token plan).
 */

export const agreementViewSchema = z.object({
  version: z.string(),
  title: z.string(),
  body: z.string(),
  sha256: z.string(),
  acceptedAt: z.string().nullable(),
})
export type AgreementView = z.infer<typeof agreementViewSchema>

export const proposeStateSchema = z.object({
  agreement: agreementViewSchema,
  reference: z.object({ id: z.string(), label: z.string(), disciplines: z.array(z.string()), contributor: z.string().nullable() }),
  /** Why the button can't run here, in words; null when it can. */
  blocked: z.string().nullable(),
  defaultName: z.string(),
})
export type ProposeState = z.infer<typeof proposeStateSchema>

export const proposeStartBodySchema = z.object({
  agreementVersion: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(70),
})
export type ProposeStartBody = z.infer<typeof proposeStartBodySchema>

export const proposeStartedSchema = z.object({ jobId: z.string(), runId: z.string(), modelId: z.string() })
export type ProposeStarted = z.infer<typeof proposeStartedSchema>

const classLineSchema = z.object({
  classId: z.string().nullable(),
  label: z.string(),
  converted: z.number(),
  linked: z.array(z.object({ reason: z.string(), count: z.number() })),
})

export const importReportSchema = z.object({
  source: z.object({ id: z.string(), label: z.string(), disciplines: z.array(z.string()) }),
  converted: z.number(),
  stayLinked: z.number(),
  levelsAdded: z.array(z.string()),
  classes: z.array(classLineSchema),
  notes: z.array(z.string()),
  summary: z.string(),
})
export type ImportReportView = z.infer<typeof importReportSchema>

export const proposeProgressSchema = z.object({
  status: z.enum(["converting", "landing", "done", "failed", "cancelled"]),
  total: z.number(),
  landed: z.number(),
  branchId: z.string().nullable(),
  report: importReportSchema.nullable(),
  error: z.string().nullable(),
})
export type ProposeProgress = z.infer<typeof proposeProgressSchema>

export const PROPOSE_WORDS = {
  button: "Propose changes to this model",
  title: (label: string) => `Propose changes to ${label}`,
  intro: "This opens a copy of this linked model as your own branch. Walls, doors, rooms, slabs, columns, beams, and the runs and parts an add-on can bring in become editable there; everything else keeps showing from the linked model. Main doesn't change.",
  agree: "I accept these terms",
  start: "Open as my branch",
  converting: "Converting the linked model…",
  landing: (landed: number, total: number) => `Adding to your branch: ${landed.toLocaleString()} of ${total.toLocaleString()}`,
  stop: "Stop",
  openBranch: "Open the branch",
  done: "Your branch is ready.",
  stopped: "Stopped.",
  notConfigured: "Live editing isn't set up for this project yet, so a linked model can't open as a branch here.",
  notReady: "This linked model's current version isn't ready yet. Wait for it to finish converting.",
  fixture: "The project's test model can't be opened as a branch.",
} as const

/** A short default name for the branch: "Proposal: <model>". */
export function defaultProposalName(label: string): string {
  return `Proposal: ${label}`.slice(0, 70)
}
