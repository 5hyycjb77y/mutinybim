/**
 * Price books (round 8b lane C): a company's unit rates that price the
 * Building Model's quantities in the reader's process. These are the shapes
 * the routes and screens share. Rows come from public.price_books,
 * public.price_book_rates and public.price_book_shares under RLS
 * (20261102121100_mutinybim_r8b_price_books).
 */

export const PRICE_BOOK_BASES = ["estimate", "budget", "contract"] as const
export type PriceBookBasis = (typeof PRICE_BOOK_BASES)[number]

export const PRICE_BOOK_BASIS_LABELS: Readonly<Record<PriceBookBasis, string>> = {
  estimate: "Estimate",
  budget: "Budget",
  contract: "Contract",
}

/** A company the signed-in person belongs to for price books. */
export interface ReaderCompany {
  readonly organizationId: string
  readonly name: string
  /** `membership`: an active company portal membership. `house`: on the PermitZIP team (the house company). */
  readonly via: "membership" | "house"
}

export interface CompanyRef {
  readonly organizationId: string
  /** Null when the person may not read the company's name. */
  readonly name: string | null
}

export interface PriceBookShare {
  readonly id: string
  readonly sharedWith: CompanyRef
  readonly projectId: string
  readonly createdAt: string
}

export interface PriceBookSummary {
  readonly id: string
  readonly name: string
  readonly basis: PriceBookBasis
  readonly currency: string
  /** ISO date (YYYY-MM-DD). */
  readonly effectiveDate: string
  readonly notes: string | null
  readonly owner: CompanyRef
  /** True when the person belongs to the owning company (may write it with the write verb). */
  readonly mine: boolean
  /** For a book shared with the person's company: the projects it is shared on. Empty for their own books. */
  readonly sharedOnProjects: readonly string[]
  readonly updatedAt: string
}

/** One unit rate. `unitRateMinor` is in the book currency's minor unit (cents). */
export interface PriceBookRate {
  readonly system: string
  readonly code: string
  readonly stageId: string | null
  readonly typeKey: string | null
  /** The model quantity it prices (`qto.length`). */
  readonly measure: string
  /** One unit of that quantity (`ft`). */
  readonly unit: string
  readonly unitRateMinor: number
  readonly description: string | null
}

/** A book with its rates, as one reader may read it on one project. */
export interface ReadablePriceBook {
  readonly book: PriceBookSummary
  readonly rates: readonly PriceBookRate[]
  /** The company the reader reads it as: the owner when they belong to it, else the company it was shared with. */
  readonly readerCompany: CompanyRef
}

export interface PriceBookInput {
  readonly name: string
  readonly basis: PriceBookBasis
  readonly currency: string
  readonly effectiveDate: string
  readonly notes: string | null
}

export class PriceBookRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PriceBookRefusal"
  }
}
