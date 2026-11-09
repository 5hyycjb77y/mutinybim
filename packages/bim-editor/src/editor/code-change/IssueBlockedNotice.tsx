'use client'

import type { ReissueCheck } from '@permitzip/bim-sheets'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'

/**
 * Sheets › Issue set, when the issue-time check blocks (round 10, C10):
 * "Issue blocked: 2 approvals were checked against an older rule", then each
 * blocked sheet with the signer who must act and their two choices. Approvals
 * from before this was recorded are counted, plainly, and never block.
 * Issued sets themselves never change.
 */
export function IssueBlockedNotice({ check }: { readonly check: ReissueCheck }) {
  if (check.ok) {
    return check.notRecorded > 0 ? (
      <p className="text-xs text-muted-foreground" data-testid="issue-not-recorded">
        {check.notRecorded} approval{check.notRecorded === 1 ? '' : 's'} on these sheets {check.notRecorded === 1 ? 'was' : 'were'} signed before the checked code was recorded; {check.notRecorded === 1 ? 'it doesn’t' : 'they don’t'} block issuing.
      </p>
    ) : null
  }
  return (
    <Alert variant="destructive" data-testid="issue-blocked">
      <AlertTitle>{check.words}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {check.blocked.map((b) => (
            <li key={`${b.sheetId}:${b.recordId}`}>
              <span className="font-medium">{b.sheetNumber}</span> · {b.signerName}:{' '}
              {b.choices.includes('new_approval') ? 'has left the project; someone licensed re-checks it and signs a new approval.' : 'only they can re-check and sign, or override with a reason (open the sheet).'}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
