'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { HostLink as Link } from '@permitzip/bim-editor/host'
import { Calculator } from 'lucide-react'
import { formatMoney, money } from '@permitzip/bim-units'
import type { ModelState, PricedTakeoff, ScheduleDefinitionV2 } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../../ui/table'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { priceBooksApiFrom } from '../../contracts/bim/cost-source/client'
import { priceWithBook } from '../../contracts/bim/cost-source/cost-source'
import { PRICE_BOOK_BASIS_LABELS, type PriceBookSummary, type ReadablePriceBook } from '../../contracts/bim/cost-source/types'

/** True for a schedule laid out as the takeoff (grouped by cost code), the one Price with applies to. */
export function isTakeoffSchedule(definition: ScheduleDefinitionV2 | null): boolean {
  return definition?.groups?.[0]?.path === 'qto.code' && definition.columns.some((c) => c.kind === 'field' && c.path === 'qto.code')
}

type Books =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly books: readonly PriceBookSummary[]; readonly hasCompany: boolean }

type Picked = { readonly kind: 'none' } | { readonly kind: 'loading'; readonly id: string } | { readonly kind: 'error'; readonly id: string; readonly message: string } | { readonly kind: 'ready'; readonly readable: ReadablePriceBook }

const NOT_PRICED = '__not_priced__'

function stageName(model: ModelState, stageId: string | null): string {
  if (stageId === null) return 'No stage'
  const el = model.elements[stageId]
  return el && el.kind === 'construction_stage' ? el.stage.name : stageId
}

function bookLabel(b: PriceBookSummary): string {
  return `${b.name} (${b.mine ? 'your company' : (b.owner.name ?? 'another company')})`
}

/**
 * Takeoff › Price with: multiply this model's quantities by a price book you
 * can read on this project, here in the browser. Nothing is saved to the
 * model. Every amount says whose book it is; a code the book has no rate for
 * says "No price", never $0.
 */
export function PriceWith({ projectId, model }: { readonly projectId: string; readonly model: ModelState | null }) {
  const costSource = useEditorHost().data.costSource
  const priceBooksApi = useMemo(() => priceBooksApiFrom(costSource), [costSource])
  const [books, setBooks] = useState<Books>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [picked, setPicked] = useState<Picked>({ kind: 'none' })
  const retryBooks = useCallback(() => setAttempt((a) => a + 1), [])

  useEffect(() => {
    let live = true
    setBooks({ kind: 'loading' })
    priceBooksApi
      .list(projectId)
      .then((r) => live && setBooks({ kind: 'ready', books: r.books, hasCompany: r.companies.length > 0 }))
      .catch((err: unknown) => {
        console.error('[PriceWith] loading price books failed', err)
        if (live) setBooks({ kind: 'error', message: err instanceof Error ? err.message : 'The connection dropped.' })
      })
    return () => {
      live = false
    }
  }, [priceBooksApi, projectId, attempt])

  const pick = useCallback(
    (id: string) => {
      if (id === NOT_PRICED) return setPicked({ kind: 'none' })
      setPicked({ kind: 'loading', id })
      priceBooksApi
        .read(id, projectId)
        .then((readable) => setPicked((p) => (p.kind === 'loading' && p.id === id ? { kind: 'ready', readable } : p)))
        .catch((err: unknown) => {
          console.error('[PriceWith] loading the price book failed', err)
          setPicked((p) => (p.kind === 'loading' && p.id === id ? { kind: 'error', id, message: err instanceof Error ? err.message : 'The book did not load.' } : p))
        })
    },
    [priceBooksApi, projectId],
  )

  const priced = useMemo((): { ok: true; value: PricedTakeoff } | { ok: false; message: string } | null => {
    if (picked.kind !== 'ready' || !model) return null
    try {
      return { ok: true, value: priceWithBook(model, picked.readable) }
    } catch (err) {
      console.error('[PriceWith] pricing the takeoff failed', err)
      return { ok: false, message: err instanceof Error ? err.message : 'The takeoff could not be priced.' }
    }
  }, [picked, model])

  const pickedId = picked.kind === 'none' ? NOT_PRICED : picked.kind === 'ready' ? picked.readable.book.id : picked.id

  return (
    <section className="mb-3 flex flex-col gap-2 rounded-md border p-3" aria-label="Price with" data-testid="price-with">
      <div className="flex flex-wrap items-center gap-2">
        <Calculator className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Price with</span>
        {books.kind === 'loading' && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading the price books you can use here…
          </span>
        )}
        {books.kind === 'error' && (
          <>
            <span className="text-sm text-danger-700">Price books didn&apos;t load: {books.message}</span>
            <Button size="sm" variant="outline" onClick={retryBooks}>
              Retry
            </Button>
          </>
        )}
        {books.kind === 'ready' && books.books.length === 0 && (
          <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="price-with-empty">
            {books.hasCompany ? 'Your company has no price books yet, and none are shared with it on this project.' : "You aren't part of a company with price books yet."}
            <Button asChild size="sm" variant="link" className="h-auto p-0">
              <Link href="/settings/price-books">Add one in Settings › Price books</Link>
            </Button>
          </span>
        )}
        {books.kind === 'ready' && books.books.length > 0 && (
          <Select value={pickedId} onValueChange={pick}>
            <SelectTrigger className="w-80" aria-label="Price book" data-testid="price-with-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NOT_PRICED}>Not priced (quantities only)</SelectItem>
                {books.books.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {bookLabel(b)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {picked.kind === 'loading' && <Spinner aria-label="Loading the book" />}
      </div>
      <p className="text-xs text-muted-foreground">Prices are worked out here in your browser from your company&apos;s book. They are never saved to the model or seen by anyone else.</p>

      {picked.kind === 'error' && (
        <Alert variant="destructive">
          <AlertTitle>That book didn&apos;t load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {picked.message}
            <Button size="sm" variant="outline" onClick={() => pick(picked.id)}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {priced && !priced.ok && (
        <Alert variant="destructive">
          <AlertTitle>Not priced</AlertTitle>
          <AlertDescription>{priced.message}</AlertDescription>
        </Alert>
      )}
      {picked.kind === 'ready' && priced?.ok && model && <PricedTable model={model} readable={picked.readable} priced={priced.value} />}
    </section>
  )
}

function PricedTable({ model, readable, priced }: { readonly model: ModelState; readonly readable: ReadablePriceBook; readonly priced: PricedTakeoff }) {
  const { book } = readable
  const owner = book.owner.name ?? 'another company'
  const whose = `${book.name}, ${owner}'s ${PRICE_BOOK_BASIS_LABELS[book.basis].toLowerCase()} as of ${book.effectiveDate}`
  const fmt = (minor: number) => formatMoney(money(minor, book.currency))
  if (priced.lines.length === 0 && priced.noRate.length === 0 && priced.unpriced.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing in this model has a cost code from {book.name}&apos;s code lists yet. Set cost codes on types or elements, then price again.</p>
  }
  return (
    <Table data-testid="price-with-table">
      <TableCaption>Prices from {whose}.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Cost code</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Unit price</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {priced.lines.map((l) => (
          <TableRow key={l.takeoffKey} data-testid="price-with-line">
            <TableCell className="font-medium">{l.code}</TableCell>
            <TableCell>{stageName(model, l.stageId)}</TableCell>
            <TableCell className="text-right tabular-nums" title={`${l.quantityFrom.from}, ${l.quantityFrom.elementCount} element${l.quantityFrom.elementCount === 1 ? '' : 's'}`}>
              {l.quantity.toLocaleString('en-US', { maximumFractionDigits: 2 })} {l.per}
            </TableCell>
            <TableCell className="text-right tabular-nums">{fmt(l.unitRate.minor)}</TableCell>
            <TableCell className="text-right tabular-nums" title={`From ${whose}`}>
              {fmt(l.amount.minor)}
            </TableCell>
          </TableRow>
        ))}
        {priced.noRate.map((l) => (
          <TableRow key={`no-rate-${l.system}-${l.code}-${l.stageId ?? ''}`} data-testid="price-with-no-price">
            <TableCell className="font-medium">{l.code}</TableCell>
            <TableCell>{stageName(model, l.stageId)}</TableCell>
            <TableCell className="text-right text-muted-foreground">
              {l.elementCount} element{l.elementCount === 1 ? '' : 's'}
            </TableCell>
            <TableCell colSpan={2} className="text-right text-muted-foreground">
              No price: {book.name} has no rate for {l.code}
            </TableCell>
          </TableRow>
        ))}
        {priced.unpriced.map((u) => (
          <TableRow key={`unpriced-${u.takeoffKey}`} data-testid="price-with-no-price">
            <TableCell className="font-medium">{u.groupLabel}</TableCell>
            <TableCell />
            <TableCell className="text-right text-muted-foreground">{u.measure.replace(/^qto\./, '').replace(/_/g, ' ')}</TableCell>
            <TableCell colSpan={2} className="text-right text-muted-foreground">
              No price: {u.reason}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={4}>Total of priced lines ({owner}&apos;s prices{priced.noRate.length + priced.unpriced.length > 0 ? '; lines with no price are not included' : ''})</TableCell>
          <TableCell className="text-right font-semibold tabular-nums" data-testid="price-with-total">
            {fmt(priced.total.minor)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}
