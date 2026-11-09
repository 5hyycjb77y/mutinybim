import { z } from "zod"
import { DISPOSITION_REASON_MAX, DISPOSITION_REASON_MIN } from "@permitzip/bim-kernel"

const modelId = z.string().trim().min(1).max(200).refine((v) => !v.includes("~"), "Use the model, not a branch.")
const discipline = z.string().trim().regex(/^[a-z][a-z0-9_.]{0,63}$/, "Say which discipline's code changed.")
const words = (max: number) => z.string().trim().min(1).max(max)

const jurisdiction = z
  .object({ country: z.string().length(2), subdivision: z.string().max(8).optional(), locality: words(120).optional(), authority: words(120).optional() })
  .strict()

/** A discipline's code of record as the kernel writes it (`CodeOfRecord`). */
export const codeOfRecordSchema = z
  .object({
    discipline,
    instrument: words(80),
    edition: words(40),
    adoptedAs: words(200).optional(),
    amendment: z.object({ id: words(80), version: words(40) }).strict().optional(),
    jurisdiction: jurisdiction.optional(),
  })
  .strict()

/**
 * "The project's code changed": what moved, the sign-off records the kernel's
 * carry found relying on it (`codeChangeCarry`, which applies "carried forward
 * unchanged"), and the change key (`codeChangeKey`). The database derives the
 * recipients from those records itself.
 */
export const codeChangeSchema = z
  .object({
    modelId,
    discipline,
    instrument: words(80),
    from: codeOfRecordSchema.nullable(),
    to: codeOfRecordSchema.nullable(),
    changeKey: words(600),
    recordIds: z.array(z.string().uuid()).max(10_000),
  })
  .strict()

export type CodeChangeBody = z.infer<typeof codeChangeSchema>

/** "Override with a reason": only the record's own signer; the database checks. */
export const overrideSchema = z
  .object({
    recordId: z.string().uuid(),
    sourceVersion: z.string().regex(/^sha256:[0-9a-f]{64}$/, "Reload the sheet and try again."),
    reason: z.string().trim().min(DISPOSITION_REASON_MIN, "Say why in a sentence; reviewers will read it.").max(DISPOSITION_REASON_MAX),
  })
  .strict()

export type OverrideBody = z.infer<typeof overrideSchema>

export const markReadSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict()
