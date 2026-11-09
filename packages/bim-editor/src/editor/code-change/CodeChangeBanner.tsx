'use client'

import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { BlockedApproval } from '@permitzip/bim-sheets'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/spinner'

/** The banner's title until the state seal rules are researched (round 10 question 1): never "sealed". */
export const CODE_CHANGED_TITLE = 'Code changed since this was signed'

/** Lines shown with their buttons before "Show all", so the banner keeps at most five controls in view. */
const LINES_IN_VIEW = 2

export type BannerLoad = { readonly state: 'loading' } | { readonly state: 'error'; readonly message: string } | { readonly state: 'ready'; readonly blocked: readonly BlockedApproval[] }

/**
 * A sheet's banner when an approval it carries was checked against an older
 * rule (round 10, C10). One line per affected signer, each with exactly who
 * must act and their two choices: **Re-check and sign** or **Override with a
 * reason**. Only that signer may use them; anyone else is told why. A signer
 * who left the project can't act: someone licensed signs a new approval.
 * Nothing shows when nothing blocks.
 */
export function CodeChangeBanner({
  load,
  viewerId,
  onRecheck,
  onOverride,
  onNewApproval,
  onRetry,
}: {
  readonly load: BannerLoad
  readonly viewerId: string
  readonly onRecheck: (approval: BlockedApproval) => void
  readonly onOverride: (approval: BlockedApproval) => void
  readonly onNewApproval: (approval: BlockedApproval) => void
  readonly onRetry: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  if (load.state === 'loading') {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-busy="true" data-testid="code-change-banner-loading">
        <Spinner aria-hidden />
        Checking the approvals on this sheet…
      </p>
    )
  }
  if (load.state === 'error') {
    return (
      <Alert variant="destructive" data-testid="code-change-banner-error">
        <TriangleAlert aria-hidden />
        <AlertTitle>Couldn’t check this sheet’s approvals</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {load.message}
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (load.blocked.length === 0) return null
  const lines = showAll ? load.blocked : load.blocked.slice(0, LINES_IN_VIEW)
  return (
    <Alert data-testid="code-change-banner">
      <TriangleAlert aria-hidden className="text-warning-700" />
      <AlertTitle>{CODE_CHANGED_TITLE}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>Issuing this sheet again needs each signer below to re-check and sign, or to override with a reason.</span>
        <ul className="flex flex-col gap-2">
          {lines.map((b) => {
            const mine = b.signer === viewerId
            const departed = b.choices.includes('new_approval')
            return (
              <li key={b.recordId} className="flex flex-col gap-1" data-testid="code-change-line">
                <span className="text-foreground">
                  <span className="font-medium">{b.signerName}</span> · {b.words}
                </span>
                {departed ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">{b.signerName} can no longer act on this project. Someone licensed re-checks it and signs a new approval.</span>
                    <Button size="xs" variant="outline" onClick={() => onNewApproval(b)}>
                      Sign a new approval
                    </Button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <Button size="xs" onClick={() => onRecheck(b)} disabled={!mine} data-testid="code-change-recheck">
                      Re-check and sign
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => onOverride(b)} disabled={!mine} data-testid="code-change-override">
                      Override with a reason
                    </Button>
                    {mine ? null : (
                      <span className="text-muted-foreground" data-testid="code-change-why-disabled">
                        Only {b.signerName}, who signed this, can re-check or override it.
                      </span>
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        {load.blocked.length > LINES_IN_VIEW ? (
          <Button size="xs" variant="link" className="self-start p-0" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${load.blocked.length} signers`}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
