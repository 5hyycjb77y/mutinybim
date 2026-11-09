'use client'

import type { BranchRef } from '@permitzip/bim-kernel'
import { GitBranchIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'

export interface BranchBannerProps {
  readonly branch: BranchRef
  readonly onBackToMain: () => void
  /** Absent: the person can't close branches (the button is not shown). */
  readonly onClose?: () => void
}

/** Always visible while a branch is open: which branch, where it came from, that Main is untouched, and one click back. */
export function BranchBanner({ branch, onBackToMain, onClose }: BranchBannerProps) {
  const ended = branch.state === 'merged' || branch.state === 'closed'
  return (
    <Alert role="status" aria-live="polite">
      <GitBranchIcon aria-hidden />
      <AlertTitle>
        Branch: {branch.name} (from version {branch.baseRevision}). Main is not changed.
      </AlertTitle>
      {ended ? (
        <AlertDescription>
          {branch.state === 'merged' ? 'This branch was merged. Start a new branch to keep working.' : 'This branch was closed. Start a new branch to keep working.'}
        </AlertDescription>
      ) : null}
      <AlertAction className="flex gap-2">
        <Button size="sm" onClick={onBackToMain}>
          Back to Main
        </Button>
        {onClose && !ended ? (
          <Button size="sm" variant="outline" onClick={onClose}>
            Close branch…
          </Button>
        ) : null}
      </AlertAction>
    </Alert>
  )
}
