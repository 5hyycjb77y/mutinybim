import { z } from "zod"
import { responsibilityScopeSchema } from "./model"

/** Request bodies for lane M's routes (shared with the screens' tests). */

const DISCIPLINE_ID = /^[a-z][a-z0-9_]*(?:[.:][a-z0-9][a-z0-9_]*)*$/

const disciplineSchema = z.string().trim().min(1).max(96).regex(DISCIPLINE_ID, "Pick a discipline from the list.")

/** Name a person, a firm entry (a company, its rule), or a person from a firm entry. */
export const nameResponsibilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      personId: z.string().uuid("Pick a person."),
      discipline: disciplineSchema,
      scope: responsibilityScopeSchema.optional(),
      scopeWords: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("firm"),
      organizationId: z.string().uuid("Pick a company."),
      discipline: disciplineSchema,
      approvalRule: z.enum(["each", "any_one"]),
      scope: responsibilityScopeSchema.optional(),
      scopeWords: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("firm_person"),
      firmEntryId: z.string().uuid(),
      personId: z.string().uuid("Pick a person."),
    })
    .strict(),
])

/** "Take responsibility for this": the discipline and the part it covers. */
export const takeResponsibilitySchema = z
  .object({
    discipline: disciplineSchema,
    scope: responsibilityScopeSchema.optional(),
    scopeWords: z.string().trim().min(1).max(300).optional(),
  })
  .strict()

export const requestDecisionSchema = z
  .object({ grant: z.boolean(), note: z.string().trim().max(2000).optional() })
  .strict()
  .refine((v) => v.grant || (v.note !== undefined && v.note.length > 0), { message: "Say why you decline, so they know." })

export const changeResponsibilitySchema = z
  .object({
    discipline: disciplineSchema.optional(),
    scope: responsibilityScopeSchema.optional(),
    scopeWords: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((v) => v.discipline !== undefined || v.scope !== undefined || v.scopeWords !== undefined, { message: "Say what changed: the discipline or the part." })

export const decideSchema = z
  .object({
    responsibilityId: z.string().uuid().nullable(),
    decision: z.enum(["approved", "declined"]),
    note: z.string().trim().max(2000).optional(),
    branchHead: z.number().int().min(0),
    deltaDigest: z.string().regex(/^[0-9a-f]{64}$/, "That part's fingerprint isn't one the model makes. Reload the merge."),
  })
  .strict()
  .refine((v) => v.decision === "approved" || (v.note !== undefined && v.note.length > 0), { message: "Say why you decline, so the proposer knows what to change." })

const partSchema = z.object({
  discipline: disciplineSchema,
  responsibilityIds: z.array(z.string().uuid()).max(200),
  elementIds: z.array(z.string().min(1).max(200)).max(250_000),
  deltaDigest: z.string().regex(/^[0-9a-f]{64}$/),
  lastChangedRevision: z.number().int().min(0).optional(),
  /** Round 9: no one covers it; the levels and systems its changes sit on, for "Take responsibility for this". */
  suggestedScope: responsibilityScopeSchema.optional(),
  suggestedScopeWords: z.string().trim().min(1).max(300).optional(),
})

/** A previewed part's suggested scope as the proposal stores it (the kernel suggests levels and systems only). */
export function suggestedScopeFields(p: { readonly suggestedScope?: { readonly levels?: readonly string[]; readonly systems?: readonly string[] }; readonly suggestedScopeWords?: string }): { suggestedScope?: { levels?: string[]; systems?: string[] }; suggestedScopeWords?: string } {
  const s = p.suggestedScope
  if (!s || !p.suggestedScopeWords) return {}
  return { suggestedScope: { ...(s.levels ? { levels: [...s.levels] } : {}), ...(s.systems ? { systems: [...s.systems] } : {}) }, suggestedScopeWords: p.suggestedScopeWords }
}

/** A merge preview from the model server, saved as a proposal (or refreshing the open one). */
export const proposeSchema = z
  .object({
    branchId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "That branch id isn't one the model server makes."),
    branchName: z.string().trim().min(1).max(200),
    baseRevision: z.number().int().min(0),
    branchHead: z.number().int().min(0),
    mainHead: z.number().int().min(0),
    parts: z.array(partSchema).max(2000),
    conflicts: z.array(z.object({ elementId: z.string().min(1).max(200), words: z.string().min(1).max(1000) })).max(5000),
  })
  .strict()
  .refine((v) => v.branchHead >= v.baseRevision && v.mainHead >= v.baseRevision, { message: "The branch and Main must be at or after the version the branch started from." })

export const landedSchema = z
  .object({
    landed: z
      .array(
        z.object({
          discipline: disciplineSchema,
          elementIds: z.array(z.string().min(1).max(200)).max(250_000),
          revision: z.number().int().min(1),
          deltaDigest: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1)
      .max(2000),
    allLanded: z.boolean(),
  })
  .strict()
