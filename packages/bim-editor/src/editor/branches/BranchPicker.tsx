'use client'

import type { BranchRef } from '@permitzip/bim-kernel'
import { CheckIcon, ChevronDownIcon, GitBranchIcon, PlusIcon, RotateCwIcon } from 'lucide-react'
import { Button } from '../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import { Spinner } from '../../ui/spinner'
import { isOpenBranch, type BranchListState } from './useBranches'

export interface BranchPickerProps {
  /** The branch this page has open (null: Main). */
  readonly current: BranchRef | null
  readonly state: BranchListState
  /** Open a branch, or Main (null). */
  readonly onOpen: (branch: BranchRef | null) => void
  readonly onNewBranch: () => void
  readonly onRetry: () => void
  /** Null when the person can start branches; otherwise why they can't (shown on the disabled item). */
  readonly cantStartReason: string | null
}

/**
 * Building Model › header › Branch: Main ▾. Main first, then open branches;
 * loading, error with Retry and "No branches yet" are shown in the menu. A
 * server without branches shows nothing (`unavailable`).
 */
export function BranchPicker({ current, state, onOpen, onNewBranch, onRetry, cantStartReason }: BranchPickerProps) {
  if (state.status === 'unavailable') return null
  const open = state.status === 'ready' ? state.branches.filter(isOpenBranch) : []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Branch: ${current ? current.name : 'Main'}. Change branch`}>
          <GitBranchIcon aria-hidden />
          <span className="max-w-48 truncate">Branch: {current ? current.name : 'Main'}</span>
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => onOpen(null)}>
            {current === null ? <CheckIcon aria-hidden /> : <span aria-hidden className="size-4" />}
            Main
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        {state.status === 'loading' ? (
          <div role="status" className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <Spinner aria-hidden /> Loading branches…
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div role="alert" className="flex flex-col gap-2 px-2 py-1.5 text-sm">
            <span>Couldn&apos;t load branches: {state.message}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCwIcon aria-hidden /> Retry
            </Button>
          </div>
        ) : null}
        {state.status === 'ready' && open.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No branches yet</div> : null}
        {open.map((b) => (
          <DropdownMenuItem key={b.modelId} onSelect={() => onOpen(b)}>
            {current?.modelId === b.modelId ? <CheckIcon aria-hidden /> : <span aria-hidden className="size-4" />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{b.name}</span>
              <span className="text-xs text-muted-foreground">From version {b.baseRevision}{b.state === 'merge_proposed' ? ', merge proposed' : ''}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={cantStartReason !== null} onSelect={onNewBranch} title={cantStartReason ?? undefined}>
          <PlusIcon aria-hidden />
          <span className="flex flex-col">
            <span>New branch…</span>
            {cantStartReason ? <span className="text-xs text-muted-foreground">{cantStartReason}</span> : null}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
