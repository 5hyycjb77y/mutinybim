'use client'

import type { ConnectionStatus, SaveState } from '@permitzip/bim-sync'
import { RefreshCw } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Spinner } from '../../ui/spinner'
import { statusBadge, type BadgeTone, type ConnectionProblem } from '../operator-messages'

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: 'border-success-300 bg-success-50 text-success-700',
  busy: 'border-info-300 bg-info-50 text-info-700',
  warn: 'border-warning-300 bg-warning-50 text-warning-800',
  muted: 'border-border bg-muted text-muted-foreground',
}

/** What the open chip explains, beyond its one-line label. */
function details(status: ConnectionStatus | 'read_only', save: SaveState, problem: ConnectionProblem | null, editPaused: string | null): string {
  if (problem) return `${problem.title}. ${problem.message}`
  if (editPaused) return editPaused
  if (status === 'degraded') return save.message ?? 'The model server is up but can’t save right now. Your edits are kept and sent again.'
  if (save.pending > 0) return 'Your latest edit is on its way to the model server.'
  if (status === 'live') return 'The model server has every edit you made. Others see them live.'
  return 'Opening the live connection to the model server.'
}

/**
 * The header's connection chip: Connected. All changes saved / Reconnecting… /
 * Checking the connection… / Offline: changes kept on this computer. Click it
 * for what that means and, when the line is down, a Try now button.
 */
export function ConnectionStatusChip({
  status,
  save,
  problem,
  editPaused,
  onRetry,
}: {
  readonly status: ConnectionStatus | 'read_only'
  readonly save: SaveState
  readonly problem: ConnectionProblem | null
  /** `ModelSession.editPausedReason()`: why Move, Place, Route and Split are off, or null. */
  readonly editPaused: string | null
  /** Reconnect now (`ModelSession.retry`). */
  readonly onRetry: () => void
}) {
  const badge = statusBadge(status, save, problem, editPaused)
  const canRetry = status !== 'read_only' && (status !== 'live' || problem !== null || editPaused !== null) && problem?.kind !== 'no_model' && problem?.kind !== 'no_access' && status !== 'denied'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-auto p-0" aria-label={`Live editing: ${badge.label}. Show details`} data-testid="connection-status-chip" data-tone={badge.tone}>
          <Badge variant="outline" className={TONE_CLASS[badge.tone]} role="status" aria-live="polite" data-testid="building-model-save-state">
            {badge.tone === 'busy' && <Spinner className="mr-1.5 size-3" />}
            {badge.label}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 text-sm">
        <p className="font-medium">{badge.label}</p>
        <p className="text-muted-foreground" data-testid="connection-status-detail">
          {details(status, save, problem, editPaused)}
        </p>
        {canRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="connection-status-retry">
            <RefreshCw data-icon="inline-start" />
            Try now
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
