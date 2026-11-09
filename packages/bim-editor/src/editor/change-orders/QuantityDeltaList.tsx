'use client'

import { RotateCwIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/spinner'
import type { QuantityDeltaState } from './useQuantityDelta'

/** "What it does to quantities": loading, error with Retry, "no quantity change", or the rows. Never a price. */
export function QuantityDeltaList({ state, onRetry }: { readonly state: QuantityDeltaState; readonly onRetry: () => void }) {
  if (state.status === 'off') return null
  if (state.status === 'loading') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden /> Working out what this changes in quantities…
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <Alert variant="destructive">
        <AlertTitle>The quantity change didn’t load</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {state.message}
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCwIcon aria-hidden /> Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  const { deltas, changedIds } = state.read
  if (deltas.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {changedIds.length === 0 ? 'Nothing changed in this range.' : `${changedIds.length} element${changedIds.length === 1 ? '' : 's'} changed, with no change in quantities.`}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        What this changes in quantities ({changedIds.length} element{changedIds.length === 1 ? '' : 's'} changed):
      </p>
      <ul aria-label="Quantity change" className="flex flex-col gap-0.5 text-sm">
        {deltas.map((d) => (
          <li key={`${d.group}|${d.measure}`}>{d.label}</li>
        ))}
      </ul>
    </div>
  )
}
