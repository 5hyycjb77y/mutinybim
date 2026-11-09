'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { isOpenRequirement, type Requirement } from '@permitzip/bim-kernel'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Spinner } from '../../ui/spinner'
import type { BranchChannel } from './useBranches'
import { useMainCompare } from './useMainCompare'

const NO_IDS: readonly string[] = []

/** Open requirements on this branch whose anchor this branch changed relative to Main. */
export function reopenedAgainstMain(requirements: readonly Requirement[], changed: ReadonlySet<string>): readonly Requirement[] {
  return requirements.filter((r) => isOpenRequirement(r) && r.anchor.id !== null && changed.has(r.anchor.id))
}

/**
 * Checklist › Re-opened against Main (on a branch): what is still open here
 * on things this branch changed, so the people approving a merge see what it
 * would re-open. One request for the ids that differ from Main; the rest is
 * the requirements the Checklist already derived. Clicking a row selects it.
 */
export function ReopenedAgainstMain({ channel, requirements, onSelect }: { readonly channel: BranchChannel | null; readonly requirements: readonly Requirement[]; readonly onSelect: (ids: readonly string[]) => void }) {
  const [open, setOpen] = useState(false)
  const branch = channel?.branch() ?? null
  const compare = useMainCompare(channel, open, NO_IDS)
  const reopened = useMemo(() => (compare.state.status === 'ready' ? reopenedAgainstMain(requirements, compare.state.changed) : null), [compare.state, requirements])
  if (!branch) return null
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2" data-testid="reopened-against-main">
      <Button variant="ghost" size="sm" className="h-auto justify-start gap-2 px-1 py-1 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="reopened-toggle">
        {open ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
        <span className="flex min-w-0 flex-col items-start">
          <span className="text-sm font-medium">Re-opened against Main</span>
          <span className="text-xs font-normal text-muted-foreground">What this branch leaves open on things it changed</span>
        </span>
        {open && compare.state.status === 'loading' ? <Spinner className="ml-auto" /> : null}
      </Button>
      {!open ? null : compare.state.status === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t compare with Main</AlertTitle>
          <AlertDescription>{compare.state.message}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={compare.retry}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : reopened === null ? null : reopened.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground" data-testid="reopened-empty">
          Nothing this branch changed has an open requirement.
        </p>
      ) : (
        <ItemGroup className="gap-1" aria-label="Requirements re-opened against Main">
          {reopened.slice(0, 50).map((r) => (
            <Item key={r.id} variant="outline" size="sm" className="p-1" data-testid="reopened-row">
              <Button variant="ghost" size="sm" className="h-auto w-full justify-start px-2 py-1 text-left" onClick={() => r.anchor.id && onSelect([r.anchor.id])}>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="text-sm">{r.title}</ItemTitle>
                  <ItemDescription className="text-xs">{r.cause}</ItemDescription>
                </ItemContent>
              </Button>
            </Item>
          ))}
          {reopened.length > 50 ? <p className="px-1 text-xs text-muted-foreground">and {(reopened.length - 50).toLocaleString('en-US')} more</p> : null}
        </ItemGroup>
      )}
    </section>
  )
}
