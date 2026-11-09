'use client'

import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { useCallback, useState, type ReactNode } from 'react'
import { useEditorNavigation } from '@permitzip/bim-editor/host'
import type { BranchRef } from '@permitzip/bim-kernel'
import { toast } from 'sonner'
import { withBranch } from '../../contracts/building-model/branch-href'
import type { VersionEntry } from '../../contracts/building-model/branch-versions'
import { BranchBanner } from './BranchBanner'
import { BranchPicker } from './BranchPicker'
import { useBranches, type BranchChannel } from './useBranches'

const CloseBranchDialog = dynamic(() => import('./CloseBranchDialog').then((m) => m.CloseBranchDialog), { ssr: false })
const NewBranchDialog = dynamic(() => import('./NewBranchDialog').then((m) => m.NewBranchDialog), { ssr: false })

export const CANT_START_BRANCHES = 'You can view this model but not start branches. Ask a project admin for model editing access.'

export interface BranchHeaderProps {
  /** The model socket (null until the Building Model connects). */
  readonly channel: BranchChannel | null
  readonly connected: boolean
  /** The person may edit the model (starting and closing branches needs it). */
  readonly canEdit: boolean
  /** The open session's revision (unmerged work = a branch past its base). */
  readonly revision: number | null
  /** Versions to start from, for the New branch dialog (null while loading). */
  readonly versions: readonly VersionEntry[] | null
  /** Set by Versions › New branch from this version: opens the dialog at that version. */
  readonly startFrom?: { readonly key: string; readonly nonce: number } | null
  /** The person opened a branch (or Main) here: the page's follow rule hears it (useFollowThreadBranch). */
  readonly onPersonChose?: (branchId: string | null) => void
  /** Beside the picker on a branch: Propose merge to Main. */
  readonly trailing?: ReactNode
}

/**
 * The page's address as it is now. The project page writes ?node= with history.replaceState, which the
 * router's search params don't see, so building from them dropped node=building-model: the page fell back
 * to Overview with the branch half-open (copy-rights, main run 42378325886).
 */
export function addressHere(pathname: string, search: URLSearchParams): string {
  if (typeof window !== 'undefined') return `${window.location.pathname}${window.location.search}`
  return `${pathname}${search.size > 0 ? `?${search.toString()}` : ''}`
}

/**
 * The header's branch controls: Branch: Main ▾, the always-visible banner on a
 * branch with Back to Main, New branch… and Close branch (confirmed). Opening
 * a branch writes `?branch=` into the page address, which the Building Model
 * reads to connect, and which the thread's workspace bookmark keeps for its agent.
 */
export function BranchHeader({ channel, connected, canEdit, revision, versions, startFrom, onPersonChose, trailing }: BranchHeaderProps) {
  const { router, pathname, searchParams: search } = useEditorNavigation()
  const { state, reload, create, close } = useBranches(channel, connected)
  const current = channel?.branch() ?? null
  const [newOpen, setNewOpen] = useState(false)
  const [fromKey, setFromKey] = useState<string | undefined>(undefined)
  const [closing, setClosing] = useState<BranchRef | null>(null)
  const [seenStart, setSeenStart] = useState<number | null>(null)

  if (startFrom && startFrom.nonce !== seenStart) {
    setSeenStart(startFrom.nonce)
    setFromKey(startFrom.key)
    setNewOpen(true)
  }

  const open = useCallback(
    (branch: BranchRef | null) => {
      const here = addressHere(pathname, search)
      onPersonChose?.(branch?.branchId ?? null)
      router.replace(withBranch(here, branch?.branchId ?? null))
    },
    [onPersonChose, pathname, router, search],
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
      <BranchPicker
        current={current}
        state={state}
        onOpen={open}
        onRetry={reload}
        cantStartReason={canEdit ? null : CANT_START_BRANCHES}
        onNewBranch={() => {
          setFromKey(undefined)
          setNewOpen(true)
        }}
      />
      {current ? trailing : null}
      </div>
      {current ? <BranchBanner branch={current} onBackToMain={() => open(null)} {...(canEdit ? { onClose: () => setClosing(current) } : {})} /> : null}
      <NewBranchDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        versions={versions}
        {...(fromKey ? { fromKey } : {})}
        onCreate={async (name, fromRevision) => {
          const branch = await create(name, fromRevision)
          toast.success(`Started branch “${branch.name}”. Main is not changed.`)
          open(branch)
        }}
      />
      <CloseBranchDialog
        branch={closing}
        hasUnmergedWork={closing !== null && revision !== null && revision > closing.baseRevision}
        onOpenChange={(isOpen) => {
          if (!isOpen) setClosing(null)
        }}
        onConfirm={async (branch) => {
          await close(branch.branchId)
          toast.success(`Closed branch “${branch.name}”.`)
          open(null)
        }}
      />
    </div>
  )
}
