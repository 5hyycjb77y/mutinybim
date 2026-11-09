'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatMoney, money } from '@permitzip/bim-units'
import { priceQuantityDeltas, type PricedDelta, type QuantityDelta } from '@permitzip/bim-kernel'
import { PackSet } from '@permitzip/bim-kernel/packs'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { priceBooksApiFrom } from '../../contracts/bim/cost-source/client'
import { priceBookCostSource } from '../../contracts/bim/cost-source/cost-source'
import type { PriceBookSummary } from '../../contracts/bim/cost-source/types'

type Books = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly books: readonly PriceBookSummary[] }
type Priced = { readonly kind: 'none' } | { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly priced: PricedDelta; readonly owner: string }

const NOTHING = '__none__'
const NO_SET = PackSet.create([])

/**
 * Price this change with a price book you can read, here in your browser
 * only. Optional: the change order itself never carries a price, and nothing
 * here is saved or sent. Every amount names its book and owner; a code the
 * book has no rate for says "No price", never $0.
 */
export function PriceDeltaWith({ projectId, deltas }: { readonly projectId: string; readonly deltas: readonly QuantityDelta[] }) {
  const costSource = useEditorHost().data.costSource
  const priceBooksApi = useMemo(() => priceBooksApiFrom(costSource), [costSource])
  const [attempt, setAttempt] = useState(0)
  const [books, setBooks] = useState<Books>({ kind: 'loading' })
  const [picked, setPicked] = useState<string>(NOTHING)
  const [priced, setPriced] = useState<Priced>({ kind: 'none' })

  useEffect(() => {
    let live = true
    priceBooksApi.list(projectId).then(
      (r) => live && setBooks({ kind: 'ready', books: r.books }),
      (err: unknown) => {
        console.error('[PriceDeltaWith] listing price books failed', err)
        if (live) setBooks({ kind: 'error', message: err instanceof Error ? err.message : "Your price books didn't load." })
      },
    )
    return () => {
      live = false
    }
  }, [priceBooksApi, projectId, attempt])

  async function pick(id: string) {
    setPicked(id)
    if (id === NOTHING) return setPriced({ kind: 'none' })
    setPriced({ kind: 'loading' })
    try {
      const readable = await priceBooksApi.read(id, projectId)
      const source = priceBookCostSource(readable)
      setPriced({ kind: 'ready', priced: priceQuantityDeltas(deltas, NO_SET, source.id, readable.readerCompany.organizationId, [source]), owner: readable.book.owner.name ?? 'another company' })
    } catch (err) {
      console.error('[PriceDeltaWith] pricing the change failed', err)
      setPriced({ kind: 'error', message: err instanceof Error ? err.message : "Couldn't price this change with that book." })
    }
  }

  if (books.kind === 'loading') return <p className="text-xs text-muted-foreground">Loading your price books…</p>
  if (books.kind === 'error') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        {books.message}
        <Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </p>
    )
  }
  if (books.books.length === 0) return <p className="text-xs text-muted-foreground">To price this change privately, add a price book in Settings › Price books.</p>
  const show = (m: { minor: number; currency: string }) => formatMoney(money(m.minor, m.currency))
  return (
    <div className="flex flex-col gap-2">
      <Select value={picked} onValueChange={(v) => void pick(v)}>
        <SelectTrigger aria-label="Price with" className="w-full">
          <SelectValue placeholder="Price with your own book (optional)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOTHING}>Don’t price it</SelectItem>
          {books.books.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name} ({b.mine ? 'your company' : (b.owner.name ?? 'another company')})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {priced.kind === 'loading' ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner aria-hidden /> Pricing in your browser…
        </p>
      ) : priced.kind === 'error' ? (
        <p className="text-xs text-destructive">{priced.message}</p>
      ) : priced.kind === 'ready' ? (
        <div className="text-xs">
          <p className="font-medium">
            {show(priced.priced.total)} with {priced.priced.source.party.label}’s book ({priced.owner}). Only you see this; it isn’t saved.
          </p>
          <ul className="text-muted-foreground">
            {priced.priced.lines.map((l) => (
              <li key={`${l.group}|${l.measure}`}>
                {l.label}: {show(l.amount)}
              </li>
            ))}
            {priced.priced.noRate.map((l) => (
              <li key={`no:${l.group}|${l.label}`}>{l.label}: No price in this book</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
