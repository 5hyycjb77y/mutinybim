import { priceTakeoff, type CostRate, type CostSourceDef, type ModelState, type PricedTakeoff } from "@permitzip/bim-kernel"
import type { ReadablePriceBook } from "./types"

/**
 * A the host app price book as a kernel cost source (`kernel.cost_source` v1),
 * contributed to the reader's process only. The book and its rates were
 * read under the host's access rules (RLS) for this reader; the kernel's
 * `canReadCostSource` still decides with the reader's company, so a book is
 * visible to its owning company, and to the company it was shared with when
 * that is who is reading.
 */

/** Source ids are per book and never reused, so two books never collide. */
export function priceBookSourceId(bookId: string): string {
  // oss-clean: legacy-host-id: source ids already stored on models; a host-supplied prefix replaces this in a later change.
  return `polygnotos.price_book.${bookId}`
}

export function priceBookCostSource(readable: ReadablePriceBook): CostSourceDef {
  const { book, rates, readerCompany } = readable
  const ownerId = book.owner.organizationId
  const ownerLabel = book.owner.name ?? "Another company"
  const snapshot: readonly CostRate[] = Object.freeze(
    rates.map((r) => ({
      classification: { system: r.system, code: r.code },
      ...(r.stageId !== null ? { stageId: r.stageId } : {}),
      ...(r.typeKey !== null ? { typeId: r.typeKey } : {}),
      unitRate: { minor: r.unitRateMinor, currency: book.currency },
      measure: r.measure,
      per: r.unit,
      provenance: { ownedBy: { party: ownerId }, source: book.name, date: book.effectiveDate },
    })),
  )
  const sharedReader = readerCompany.organizationId !== ownerId
  return {
    id: priceBookSourceId(book.id),
    party: { kind: "company", id: ownerId, label: ownerLabel },
    basis: book.basis,
    currency: book.currency,
    effectiveDate: book.effectiveDate,
    visibility: sharedReader ? { kind: "shared_with", parties: [readerCompany.organizationId] } : { kind: "party_only" },
    rates: () => snapshot,
  }
}

/** Price the model's takeoff with one readable book, as the company the reader reads it as. Nothing is written anywhere. */
export function priceWithBook(model: ModelState, readable: ReadablePriceBook): PricedTakeoff {
  const source = priceBookCostSource(readable)
  return priceTakeoff(model, source.id, readable.readerCompany.organizationId, { sources: [source] })
}
