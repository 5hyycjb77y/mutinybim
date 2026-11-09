'use client'

import { useMemo, useState } from 'react'
import type { ModelState } from '@permitzip/bim-kernel'
import { STATE_AT_MAX_IDS } from '@permitzip/bim-sync/branch-limits'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { scheduleRowsVsMain } from '../../contracts/building-model/branch-compare'
import type { BranchChannel } from './useBranches'
import { useMainCompare } from './useMainCompare'

const NO_IDS: readonly string[] = []

const STATE_WORDS = { changed: 'Changed on this branch', new_on_branch: 'New on this branch', removed_on_branch: 'Removed on this branch' } as const

/**
 * A schedule on a branch › Show Main beside: the rows that differ from Main,
 * each changed cell as this branch has it and as Main has it. Asks the model
 * server which elements differ, then Main's records for only those; never
 * reads all of Main. Off (and absent) on Main.
 */
export function ShowMainBeside({ channel, model, viewId, onShowInModel }: { readonly channel: BranchChannel | null; readonly model: ModelState | null; readonly viewId: string; readonly onShowInModel: (ids: readonly string[]) => void }) {
  const [on, setOn] = useState(false)
  const branch = channel?.branch() ?? null
  const changes = useMainCompare(channel, on, NO_IDS)
  const changedIds = useMemo(() => (changes.state.status === 'ready' ? [...changes.state.changed].slice(0, STATE_AT_MAX_IDS) : NO_IDS), [changes.state])
  const records = useMainCompare(channel, on && changedIds.length > 0, changedIds)
  const diff = useMemo(() => {
    if (!model || changes.state.status !== 'ready' || records.state.status !== 'ready') return null
    return scheduleRowsVsMain(model, viewId, changes.state.changed, records.state.main)
  }, [model, viewId, changes.state, records.state])
  if (!branch) return null

  const failed = changes.state.status === 'error' ? changes.state.message : records.state.status === 'error' ? records.state.message : null
  const retry = () => {
    changes.retry()
    records.retry()
  }
  const truncated = changes.state.status === 'ready' && changes.state.changed.size > STATE_AT_MAX_IDS
  const mainRevision = records.state.status === 'ready' ? records.state.mainRevision : changes.state.status === 'ready' ? changes.state.mainRevision : null

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="show-main-beside">
      <div>
        <Button size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={() => setOn((v) => !v)} data-testid="show-main-beside-toggle">
          {on ? 'Hide Main' : 'Show Main beside'}
        </Button>
      </div>
      {!on ? null : failed ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t compare with Main</AlertTitle>
          <AlertDescription>{failed}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={retry}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : changes.state.status === 'ready' && changedIds.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing differs from Main</EmptyTitle>
            <EmptyDescription>This branch hasn&apos;t changed anything Main doesn&apos;t have the same way.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !diff ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Comparing with Main…
        </div>
      ) : !diff.ok ? (
        <Alert>
          <AlertTitle>No rows to compare</AlertTitle>
          <AlertDescription>{diff.message}</AlertDescription>
        </Alert>
      ) : diff.rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No rows in this schedule differ from Main</EmptyTitle>
            <EmptyDescription>The branch changes things this schedule doesn&apos;t list.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableCaption>
            {diff.rows.length} row{diff.rows.length === 1 ? '' : 's'} differ from Main{mainRevision !== null ? ` (Main at version ${mainRevision})` : ''}.{truncated ? ` Only the first ${STATE_AT_MAX_IDS.toLocaleString('en-US')} changed elements were compared.` : ''} Click a row to show it in the model.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>What</TableHead>
              <TableHead>This branch</TableHead>
              <TableHead>Main</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {diff.rows.flatMap((row) =>
              (row.cells.length > 0 ? row.cells : [{ heading: STATE_WORDS[row.state], branch: '', main: '' }]).map((cell, i) => (
                <TableRow key={`${row.key}:${cell.heading}`} className="cursor-pointer" onClick={() => onShowInModel(row.elementIds)} data-testid="show-main-beside-row">
                  <TableCell className="font-medium">{i === 0 ? `${row.label}${row.state === 'changed' ? '' : ` · ${STATE_WORDS[row.state]}`}` : ''}</TableCell>
                  <TableCell>{cell.heading}</TableCell>
                  <TableCell>{cell.branch || '—'}</TableCell>
                  <TableCell>{cell.main || '—'}</TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
