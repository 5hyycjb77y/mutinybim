'use client'

import { BookCheck, BookAlert } from 'lucide-react'
import { checkedAgainstWords, type ContextStanding, type CheckingContext, type FindingDisposition } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'

/**
 * One sign-off line's "checked against" words (round 10, C10):
 * "Checked against IBC 2021 §903.2 (Virginia adoption), rule v3",
 * "Checked against an older rule" with what changed, or, for a record from
 * before this was recorded, a plain "Checking context not recorded" (not an
 * error, never a block). An override by the signer is shown with its reason.
 */
export function CheckedAgainstLine({ context, standing, dispositions = [] }: { readonly context: CheckingContext | null; readonly standing: ContextStanding | null; readonly dispositions?: readonly FindingDisposition[] }) {
  if (!context || standing?.state === 'not_recorded') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="checked-against" data-state="not_recorded">
        Checking context not recorded
      </span>
    )
  }
  if (!standing || standing.state === 'current') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="checked-against" data-state="current">
        <BookCheck aria-hidden className="text-muted-foreground" />
        {standing?.words ?? checkedAgainstWords(context)}
        {standing && standing.carried.length > 0 ? <span>· {standing.carried[0]}</span> : null}
      </span>
    )
  }
  const override = dispositions.find((d) => d.sourceVersion === standing.sourceVersion)
  const first = standing.items[0]
  const more = standing.items.length > 1 ? ` and ${standing.items.length - 1} more` : ''
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid="checked-against" data-state={override ? 'overridden' : 'older'}>
      <BookAlert aria-hidden className="text-warning-700" />
      <Badge variant="outline">{standing.words}</Badge>
      <span className="text-muted-foreground">
        {first?.words}
        {more}
      </span>
      {override ? (
        <span className="text-foreground" data-testid="checked-against-override">
          · Overridden by {override.by.displayName ?? 'the signer'}: “{override.reason}”
        </span>
      ) : null}
    </span>
  )
}
