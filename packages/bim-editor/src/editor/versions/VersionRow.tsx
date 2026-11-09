'use client'

import type { ReactNode } from 'react'
import { GitBranchIcon } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '../../ui/item'
import type { VersionEntry } from '../../contracts/building-model/branch-versions'

export interface VersionRowProps {
  readonly entry: VersionEntry
  /** Absent: the person can't start branches (the reason is shown instead). */
  readonly onNewBranch?: (entry: VersionEntry) => void
  readonly cantStartReason?: string | null
  /** Slot under the row (lane O: "What kind of change was this?"). */
  readonly renderExtra?: (entry: VersionEntry) => ReactNode
}

const KIND_LABEL: Record<Exclude<VersionEntry['kind'], 'now'>, string> = { saved: 'Saved', issued: 'Issued set' }

export function VersionRow({ entry, onNewBranch, cantStartReason, renderExtra }: VersionRowProps) {
  return (
    <Item variant="outline" size="sm" className="flex-wrap">
      <ItemContent>
        <ItemTitle>
          {entry.label}
          {entry.kind !== 'now' ? <Badge variant="secondary">{KIND_LABEL[entry.kind]}</Badge> : null}
        </ItemTitle>
        <ItemDescription>{entry.detail}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline" disabled={!onNewBranch} title={onNewBranch ? undefined : (cantStartReason ?? undefined)} onClick={() => onNewBranch?.(entry)}>
          <GitBranchIcon aria-hidden />
          New branch from this version
        </Button>
      </ItemActions>
      {renderExtra ? <div className="basis-full">{renderExtra(entry)}</div> : null}
    </Item>
  )
}
