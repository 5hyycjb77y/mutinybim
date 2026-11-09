import { z } from "zod"
import { PRICE_BOOK_BASES } from "./types"

/** Wire shapes of `/api/price-books/**`: requests checked by the routes, responses checked by the screens. */

const companyRef = z.object({ organizationId: z.string(), name: z.string().nullable() })

export const readerCompanySchema = z.object({ organizationId: z.string(), name: z.string(), via: z.enum(["membership", "house"]) })

export const priceBookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  basis: z.enum(PRICE_BOOK_BASES),
  currency: z.string(),
  effectiveDate: z.string(),
  notes: z.string().nullable(),
  owner: companyRef,
  mine: z.boolean(),
  sharedOnProjects: z.array(z.string()),
  updatedAt: z.string(),
})

export const priceBookRateSchema = z.object({
  system: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(80),
  stageId: z.string().trim().min(1).max(120).nullable(),
  typeKey: z.string().trim().min(1).max(200).nullable(),
  measure: z.string().regex(/^qto\.[a-z][a-z0-9_]{0,40}$/),
  unit: z.string().trim().min(1).max(20),
  unitRateMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  description: z.string().max(300).nullable(),
})

export const priceBookShareSchema = z.object({ id: z.string(), sharedWith: companyRef, projectId: z.string(), createdAt: z.string() })

export const priceBookListResponse = z.object({
  companies: z.array(readerCompanySchema),
  canWrite: z.boolean(),
  books: z.array(priceBookSummarySchema),
})

export const readablePriceBookResponse = z.object({
  book: priceBookSummarySchema,
  rates: z.array(priceBookRateSchema),
  readerCompany: companyRef,
})

export const priceBookSharesResponse = z.object({ shares: z.array(priceBookShareSchema) })
export const shareTargetsResponse = z.object({ companies: z.array(companyRef) })

export const priceBookInputSchema = z.object({
  name: z.string().trim().min(1, "Give the book a name.").max(120),
  basis: z.enum(PRICE_BOOK_BASES),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, like USD."),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-01."),
  notes: z.string().max(2000).nullable(),
})

export const createPriceBookBody = priceBookInputSchema.extend({ organizationId: z.string().uuid() })
export const replaceRatesBody = z.object({ rates: z.array(priceBookRateSchema).max(20_000) })
export const shareBody = z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() })
