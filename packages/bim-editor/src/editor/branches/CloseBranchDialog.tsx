'use client'

import { useState } from 'react'
import type { BranchRef } from '@permitzip/bim-kernel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Spinner } from '../../ui/spinner'

export interface CloseBranchDialogProps {
  readonly branch: BranchRef | null
  /** The branch has edits Main doesn't have (its head is past its base). */
  readonly hasUnmergedWork: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Closes the branch; throws an Error with words to show when refused. */
  readonly onConfirm: (branch: BranchRef) => Promise<void>
}

/** Closing a branch always asks first; with unmerged work it says plainly that nothing reaches Main. */
export function CloseBranchDialog({ branch, hasUnmergedWork, onOpenChange, onConfirm }: CloseBranchDialogProps) {
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <AlertDialog
      open={branch !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close branch “{branch?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasUnmergedWork
              ? 'This branch has changes that are not in Main. Closing it means nothing from it reaches Main, and nobody can edit it again.'
              : 'Nobody can edit this branch after it is closed. Main is not changed.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={closing}>Keep it open</AlertDialogCancel>
          <AlertDialogAction
            disabled={closing || branch === null}
            onClick={(e) => {
              e.preventDefault()
              if (!branch) return
              setClosing(true)
              setError(null)
              onConfirm(branch).then(
                () => onOpenChange(false),
                (err: unknown) => {
                  console.error('[CloseBranchDialog] closing the branch failed', err)
                  setError(err instanceof Error ? err.message : "Couldn't close the branch. Try again.")
                },
              ).finally(() => setClosing(false))
            }}
          >
            {closing ? <Spinner aria-hidden /> : null}
            Close branch
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
