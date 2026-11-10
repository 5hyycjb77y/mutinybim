'use client'

import { AlertTriangle, RotateCw } from 'lucide-react'
import type { SheetBlockReport } from '../../contracts/bim/block-reports'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '../../ui/popover'
import { Spinner } from '../../ui/spinner'
import type { BlockFreshnessState } from './use-block-freshness'

/** One answer for a sheet: any changed block wins, then any matching issue, else live. */
function worst(blocks: readonly SheetBlockReport[]): SheetBlockReport | null {
  return blocks.find((b) => b.freshness.state === 'changed_since') ?? blocks.find((b) => b.freshness.state === 'frozen_current') ?? blocks[0] ?? null
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

/**
 * Whether a live block (or every live block on a sheet) still says what it
 * said at the latest issue: "Live" (never issued), "Matches SD issue", or
 * "Changed since SD issue", which opens the issued text beside today's. The
 * issued PDF never changes either way.
 */
export function SheetBlockFreshnessChip({ freshness, blockId }: { freshness: BlockFreshnessState & { readonly retry: () => void }; blockId?: string }) {
  if (freshness.status === 'unavailable') return null
  if (freshness.status === 'loading') {
    return (
      <Badge variant="outline" aria-live="polite" data-testid="block-freshness">
        <Spinner className="mr-1 size-3" />
        Checking the last issue…
      </Badge>
    )
  }
  if (freshness.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1" role="alert" data-testid="block-freshness">
        <Badge variant="outline" className="border-danger-300 text-danger-600" title={freshness.message}>
          Couldn&apos;t check the last issue
        </Badge>
        <Button type="button" variant="ghost" size="sm" onClick={freshness.retry} title={freshness.message}>
          <RotateCw data-icon="inline-start" />
          Retry
        </Button>
      </span>
    )
  }
  const mine = blockId ? freshness.blocks.filter((b) => b.blockId === blockId) : freshness.blocks
  const shown = worst(mine)
  if (!shown) {
    // A block placed but not saved yet has no answer; a sheet without blocks needs no chip.
    return blockId ? (
      <Badge variant="outline" title="Save the change; the issue check reads the saved model." data-testid="block-freshness">
        Not saved yet
      </Badge>
    ) : null
  }
  const changed = mine.filter((b) => b.freshness.state === 'changed_since')
  if (shown.freshness.state === 'live') {
    return (
      <Badge variant="outline" title="Not in any issued set yet: it updates as the model changes." data-testid="block-freshness" data-state="live">
        {shown.label}
      </Badge>
    )
  }
  if (shown.freshness.state === 'frozen_current') {
    return (
      <Badge variant="secondary" title={`Says what the issued copy says${shown.issuedAt ? ` (issued ${when(shown.issuedAt)})` : ''}.`} data-testid="block-freshness" data-state="frozen_current">
        {shown.label}
      </Badge>
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="border-warning-300 bg-warning-50 text-warning-800" data-testid="block-freshness" data-state="changed_since">
          <AlertTriangle data-icon="inline-start" />
          {shown.label}
          {changed.length > 1 ? ` (${changed.length} blocks)` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="start">
        <PopoverHeader>
          <PopoverTitle>{shown.label}</PopoverTitle>
          <PopoverDescription>
            The issued set keeps what it said{shown.issuedAt ? ` on ${when(shown.issuedAt)}` : ''}. The sheet now shows the model as it is; issue again to send the new values.
          </PopoverDescription>
        </PopoverHeader>
        <div className="mt-3 flex max-h-80 flex-col gap-3 overflow-y-auto" data-testid="block-freshness-diff">
          {changed.map((b) => (
            <div key={b.blockId} className="flex flex-col gap-1">
              {b.title && <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{b.title}</span>}
              <span className="text-xs text-muted-foreground">Issued</span>
              <pre className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{b.issuedText}</pre>
              <span className="text-xs text-muted-foreground">Now</span>
              <pre className="rounded-md border p-2 text-xs whitespace-pre-wrap">{b.text}</pre>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
