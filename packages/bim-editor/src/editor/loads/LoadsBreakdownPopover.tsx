'use client'

import { useMemo, useState } from 'react'
import { ListTree, MousePointerClick } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '../../ui/popover'
import { ScrollArea } from '../../ui/scroll-area'
import { Separator } from '../../ui/separator'
import type { ElementId } from '@permitzip/bim-kernel'
import type { LoadsBreakdown } from './loads-breakdown'

/** Rows shown per list; the rest are in the Loads list. */
const ROWS_SHOWN = 40

interface Props {
  /** The chip's words ("Water and drainage: 0 of 35 piped · Gas: 0 of 5 piped"). */
  readonly chip: string
  /** Read only while the popover is open (the engine is incremental; this is a read, not a recount). */
  readonly breakdown: () => LoadsBreakdown
  /** Select these in the model; the refusal in words, or null. */
  readonly onSelect: (ids: readonly ElementId[], label: string) => void
  readonly onOpenList: () => void
  /** Why the Loads list can't be opened (it has to be made and editing is off), or null. */
  readonly openListBlocked: string | null
}

/**
 * The header's Loads chip and the breakdown it opens: per trade how far its
 * loads have got, the estimate beside the devices placed so far per space and
 * zone, what the project counts, and the loads that need someone. Each row
 * selects in the model; the footer opens the Loads list. Esc closes.
 */
export function LoadsBreakdownPopover({ chip, breakdown, onSelect, onOpenList, openListBlocked }: Props) {
  const [open, setOpen] = useState(false)
  // `breakdown` changes identity with each model render; reading it only while open keeps the header cheap.
  const data = useMemo(() => (open ? breakdown() : null), [open, breakdown])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className="hidden h-6 rounded-full px-2.5 text-xs lg:inline-flex" title="Loads by trade and status, estimates beside the devices so far, and loads that need attention" data-testid="building-model-loads-progress">
          {chip}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-0" data-testid="loads-breakdown">
        <PopoverHeader className="px-3 pt-3">
          <PopoverTitle>Loads</PopoverTitle>
          <PopoverDescription>{data ? `${data.total} load${data.total === 1 ? '' : 's'} in this model${data.counted ? `. ${data.counted}` : ''}` : 'Reading the loads…'}</PopoverDescription>
        </PopoverHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-3 p-3">
            {data && data.total === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No loads yet</EmptyTitle>
                  <EmptyDescription>Add loads from the Loads list, a space’s loads, or by placing fixtures and devices.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {data && data.trades.length > 0 ? (
              <section className="flex flex-col gap-1.5" aria-label="By trade" data-testid="loads-breakdown-trades">
                <h3 className="text-xs font-medium text-muted-foreground">By trade</h3>
                <ItemGroup>
                  {data.trades.map((t) => (
                    <Item key={t.trade} size="sm" variant="outline" data-testid="loads-breakdown-trade" data-trade={t.trade}>
                      <ItemContent>
                        <ItemTitle className="text-xs">
                          {t.label}: {t.done}
                        </ItemTitle>
                        {t.stages ? <ItemDescription className="text-xs">{t.stages}</ItemDescription> : null}
                        <div className="flex flex-wrap gap-1 pt-1">
                          {t.statuses.map((s) => (
                            <Badge key={s.status} variant={s.status === 'mismatch' ? 'destructive' : 'secondary'} className="text-[10px]">
                              {s.label}: {s.count}
                            </Badge>
                          ))}
                        </div>
                      </ItemContent>
                    </Item>
                  ))}
                </ItemGroup>
              </section>
            ) : null}
            {data && data.attention.length > 0 ? (
              <section className="flex flex-col gap-1.5" aria-label="Needs attention" data-testid="loads-breakdown-attention">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Needs attention ({data.attention.length})
                </h3>
                <ItemGroup>
                  {data.attention.slice(0, ROWS_SHOWN).map((r) => (
                    <Item key={r.id} size="sm" variant="outline" data-testid="loads-breakdown-attention-row" data-reason={r.reason} data-load={r.id}>
                      <ItemContent>
                        <ItemTitle className="text-xs">
                          {r.label}
                          <Badge variant={r.reason === 'mismatch' ? 'destructive' : 'outline'} className="text-[10px]">
                            {r.reason === 'mismatch' ? 'Disagrees with its source' : 'No source yet'}
                          </Badge>
                        </ItemTitle>
                        <ItemDescription className="text-xs">{r.why}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button size="xs" variant="ghost" onClick={() => onSelect(r.selectIds, r.label)} aria-label={`Select ${r.label}`}>
                          <MousePointerClick data-icon="inline-start" />
                          Select
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
                {data.attention.length > ROWS_SHOWN ? <p className="text-xs text-muted-foreground">{data.attention.length - ROWS_SHOWN} more in the Loads list.</p> : null}
              </section>
            ) : null}
            {data && data.estimates.length > 0 ? (
              <section className="flex flex-col gap-1.5" aria-label="Estimate vs devices so far" data-testid="loads-breakdown-estimates">
                <h3 className="text-xs font-medium text-muted-foreground">Estimate vs devices so far</h3>
                <ItemGroup>
                  {data.estimates.slice(0, ROWS_SHOWN).map((r) => (
                    <Item key={r.id} size="sm" variant="outline" data-testid="loads-breakdown-estimate-row" data-scope={r.id}>
                      <ItemContent>
                        <ItemTitle className="text-xs">
                          {r.kind === 'zone' ? 'Zone' : 'Space'} {r.name}
                        </ItemTitle>
                        <ItemDescription className="text-xs">{r.text}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Button size="xs" variant="ghost" onClick={() => onSelect([r.id], `${r.kind === 'zone' ? 'zone' : 'space'} ${r.name}`)} aria-label={`Select ${r.kind} ${r.name}`}>
                          <MousePointerClick data-icon="inline-start" />
                          Select
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
                {data.estimates.length > ROWS_SHOWN ? <p className="text-xs text-muted-foreground">{data.estimates.length - ROWS_SHOWN} more: see Spaces, or a Space loads schedule.</p> : null}
              </section>
            ) : null}
          </div>
        </ScrollArea>
        <Separator />
        <div className="flex items-center justify-between gap-2 p-2">
          <span className="text-xs text-muted-foreground">{openListBlocked ? `Loads list: ${openListBlocked}` : 'Every load row, with its values and status'}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={openListBlocked !== null}
            title={openListBlocked ?? undefined}
            data-testid="loads-breakdown-open-list"
            onClick={() => {
              setOpen(false)
              onOpenList()
            }}
          >
            <ListTree data-icon="inline-start" />
            Open the Loads list
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
