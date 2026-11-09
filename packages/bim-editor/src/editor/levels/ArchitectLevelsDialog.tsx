'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Layers, RotateCw } from 'lucide-react'
import { levelHeightLabel, planLevelSync, type Command, type LevelSyncRow, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import type { LinkedModelStoreys } from '../../contracts/building-model/linked-levels-contract'
import { newElementId } from '../placement'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchLinkedLevelsFrom } from './levels-api'

type Load = { readonly state: 'loading' } | { readonly state: 'failed'; readonly message: string } | { readonly state: 'ready'; readonly models: readonly LinkedModelStoreys[] }

/** The storeys as the sync command takes them, with a fresh id for each level it might add. */
export function syncStoreysOf(model: LinkedModelStoreys): Extract<Command, { type: 'sync_levels' }>['storeys'] {
  return model.storeys.map((s) => ({ storeyId: s.storeyId, name: s.name, elevationMm: s.elevationMm, levelId: newElementId('lvl') }))
}

export function actionText(row: LevelSyncRow): string {
  switch (row.action) {
    case 'add':
      return row.name === row.storeyName ? 'New level' : `New level ${row.name}`
    case 'match':
      return row.before && Math.abs(row.before.elevationMm - row.elevationMm) >= 0.5 ? `Your ${row.name}, moved from ${levelHeightLabel(row.before.elevationMm)}` : `Your ${row.name}`
    case 'update': {
      const before = row.before
      if (!before) return 'Updated'
      const parts = [before.name !== row.name ? `renamed from ${before.name}` : null, Math.abs(before.elevationMm - row.elevationMm) >= 0.5 ? `moved from ${levelHeightLabel(before.elevationMm)}` : null].filter((p): p is string => p !== null)
      return parts.length > 0 ? `${row.name}, ${parts.join(', ')}` : `${row.name}, tied to the renamed storey`
    }
    case 'unchanged':
      return 'Up to date'
  }
}

/** The primary button's words: exactly what one click does. */
export function applyLabel(rows: readonly LevelSyncRow[]): string {
  const added = rows.filter((r) => r.action === 'add').length
  const changed = rows.filter((r) => r.action === 'update' || r.action === 'match').length
  if (added === 0 && changed === 0) return 'Up to date'
  if (added > 0 && changed === 0) return `Create ${added} level${added === 1 ? '' : 's'}`
  if (added === 0) return `Update ${changed} level${changed === 1 ? '' : 's'}`
  return `Create ${added}, update ${changed}`
}

/**
 * Model › Architect's levels: the linked model's storeys,
 * placed where the model sits, with what one click will do to each. Nothing
 * changes until the button; the whole sync is one change you can undo.
 * Running it again after the architect moves a floor updates that level.
 */
export function ArchitectLevelsDialog({
  projectId,
  model,
  canEdit,
  blockedReason,
  submit,
  onClose,
}: {
  readonly projectId: string
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: (command: Command, label: string) => string | null
  readonly onClose: () => void
}) {
  const levels = useEditorHost().data.levels
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    fetchLinkedLevelsFrom(levels, projectId, abort.signal)
      .then((res) => {
        setLoad({ state: 'ready', models: res.models })
        setChosen((c) => c ?? res.models.find((m) => m.storeys.length > 0)?.referenceId ?? null)
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        console.error("[ArchitectLevelsDialog] reading the architect's storeys failed", err)
        setLoad({ state: 'failed', message: err instanceof Error ? err.message : "The linked models' storeys couldn't be read." })
      })
    return () => abort.abort()
  }, [levels, projectId, attempt])

  const models = load.state === 'ready' ? load.models : []
  const source = models.find((m) => m.referenceId === chosen) ?? null
  const storeys = useMemo(() => (source ? syncStoreysOf(source) : []), [source])
  const plan = useMemo(() => (source && storeys.length > 0 ? planLevelSync(model, source.referenceId, storeys) : null), [model, source, storeys])

  const apply = useCallback(() => {
    if (!source || !plan) return
    const refusal = submit({ type: 'sync_levels', referenceId: source.referenceId, storeys }, `levels from ${source.label}`)
    if (refusal) setError(refusal)
    else onClose()
  }, [source, plan, storeys, submit, onClose])

  const disabledReason = !canEdit ? blockedReason : plan && !plan.changes ? `The levels already match ${source?.label ?? 'the linked model'}. Run this again after the architect changes their levels.` : null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl" data-testid="architect-levels-dialog">
        <DialogHeader>
          <DialogTitle>Use the architect&apos;s levels</DialogTitle>
          <DialogDescription>Each storey in the linked model becomes a level at the height it sits in this model. It is one change; you can undo it.</DialogDescription>
        </DialogHeader>
        {load.state === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner />
            Reading the linked model&apos;s storeys…
          </div>
        )}
        {load.state === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>The storeys couldn&apos;t be read</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {load.message}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setLoad({ state: 'loading' })
                  setAttempt((n) => n + 1)
                }}
              >
                <RotateCw data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {load.state === 'ready' && models.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Layers />
              </EmptyMedia>
              <EmptyTitle>No linked model to take levels from</EmptyTitle>
              <EmptyDescription>Link the architect&apos;s model in the Linked models panel, then come back here. Or close this and add a level by hand.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {models.length > 1 && (
          <Field>
            <FieldLabel htmlFor="bm-levels-source">From</FieldLabel>
            <Select value={chosen ?? undefined} onValueChange={setChosen}>
              <SelectTrigger id="bm-levels-source">
                <SelectValue placeholder="Pick a linked model" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {models.map((m) => (
                    <SelectItem key={m.referenceId} value={m.referenceId}>
                      {m.label} ({m.storeys.length} storeys)
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
        {source?.problem && (
          <Alert>
            <AlertTitle>{source.label}</AlertTitle>
            <AlertDescription>{source.problem}</AlertDescription>
          </Alert>
        )}
        {plan && (
          <Table data-testid="architect-levels-preview">
            <TableCaption className="sr-only">Each storey in {source?.label}, its height in this model and what happens to it</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Storey</TableHead>
                <TableHead className="text-right">Floor</TableHead>
                <TableHead>What happens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...plan.rows].reverse().map((row) => (
                <TableRow key={row.storeyId} data-testid="architect-level-row" data-action={row.action}>
                  <TableCell className="font-medium">{row.storeyName}</TableCell>
                  <TableCell className="text-right tabular-nums">{levelHeightLabel(row.elevationMm)}</TableCell>
                  <TableCell className={row.action === 'unchanged' ? 'text-muted-foreground' : undefined}>{actionText(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {plan && plan.orphaned.length > 0 && (
          <FieldDescription>
            No longer in {source?.label}: {plan.orphaned.map((o) => o.name).join(', ')}. They stay; delete them yourself if you don&apos;t need them.
          </FieldDescription>
        )}
        {(error ?? disabledReason) && (
          <FieldDescription className={error ? 'text-danger-600' : undefined} role={error ? 'alert' : undefined}>
            {error ?? disabledReason}
          </FieldDescription>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={apply} disabled={!plan || disabledReason !== null} data-testid="architect-levels-apply">
            <Layers data-icon="inline-start" />
            {plan ? applyLabel(plan.rows) : 'Create levels'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
