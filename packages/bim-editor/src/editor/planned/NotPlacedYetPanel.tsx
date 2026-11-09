'use client'

import { useMemo, useState } from 'react'
import { clientOnly as dynamic } from '@permitzip/bim-editor/client-only'
import { Cable, CircleCheck, MapPin, Trash2, X } from 'lucide-react'
import { disciplineWords, elementsOfKind, plannedPartGroups, type Discipline, type ModelState } from '@permitzip/bim-kernel'
import { distributionOf, electricalConnections, isCircuitableLoad } from '@permitzip/bim-pack-electrical/host'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
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
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Skeleton } from '../../ui/skeleton'
import type { SubmitCommand } from '../views-sheets/types'
import { DISCIPLINE_WORDS, type PlaceSurface } from './place-surface'
import { planPlannedRemoval, type PlannedRemoval } from './remove-planned'
import type { CircuitRules } from './CircuitPlannedDialog'
import { useWindowedRows, windowBoxStyle, windowSlice } from '../use-windowed-rows'

// Round 11 R11-pre: loads when first opened (`ui.first_chunk.kb`).
const LoadsPlannedDialog = dynamic(() => import('./CircuitPlannedDialog').then((m) => m.CircuitPlannedDialog), { ssr: false })

interface Props {
  /** Null while the model is loading. */
  readonly model: ModelState | null
  /** The model didn't load, in words. */
  readonly error?: string | null
  readonly onRetry?: () => void
  /** The ribbon tab it was opened from (Electrical, Mechanical, Plumbing); absent: every trade. */
  readonly disciplines?: readonly Discipline[]
  /** The view the person is on, and whether a part can be placed there. Placing never switches view. */
  readonly surface: PlaceSurface
  readonly canEdit: boolean
  /** Why the model can't be changed now, in words. */
  readonly blockedReason: string
  /** The part being placed now (its row shows Placing… and Stop). */
  readonly placingId: string | null
  /** Start placing this part in the current view. */
  readonly onPlace: (partId: string) => void
  /** Stop placing (Esc does the same in the view). */
  readonly onStopPlacing: () => void
  /** Sends an edit through the session's undoable path (the surface's `submitWithUndo`); returns why not, or null. */
  readonly submit: SubmitCommand
  readonly onClose: () => void
  /** The project's code rules, so Circuit sizes breakers by the NEC edition; absent: connected loads only, default breakers. */
  readonly circuitRules?: CircuitRules | null
}

/**
 * The "Not placed yet" list (ROADMAP F1): parts that exist (circuits,
 * schedules, the one-line) but nobody has drawn. Grouped by trade and class
 * with counts; each row's Place starts placement in the view the person is on
 * (a plan, a section, or the viewport opened on a sheet) and the list shrinks
 * as parts land. Remove deletes a planned part (after a confirm that names
 * the circuits it comes off and anything that goes with it); Undo brings it back.
 * Circuit puts an item with an electrical load on a panel without drawing it
 * (one circuit each); Circuit all does every such row at once.
 */
type PlannedRow = ReturnType<typeof plannedPartGroups>[number]['rows'][number]
type FlatEntry = { readonly kind: 'group'; readonly key: string; readonly label: string; readonly count: number } | { readonly kind: 'row'; readonly row: PlannedRow }

/** Estimated height of one not-placed row (an outline item with buttons), px. */
const NOT_PLACED_ROW_PX = 60

export function NotPlacedYetPanel({ model, error, onRetry, disciplines, surface, canEdit, blockedReason, placingId, onPlace, onStopPlacing, submit, onClose, circuitRules }: Props) {
  const groups = useMemo(() => (model ? plannedPartGroups(model.elements, disciplines) : []), [model, disciplines])
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const flat = useMemo<readonly FlatEntry[]>(
    () =>
      groups.flatMap((g): FlatEntry[] => [
        { kind: 'group', key: `${g.discipline}:${g.categoryLabel}`, label: `${disciplineWords(g.discipline, DISCIPLINE_WORDS)} · ${g.categoryLabel}`, count: g.rows.length },
        ...g.rows.map((row): FlatEntry => ({ kind: 'row', row })),
      ]),
    [groups],
  )
  const windowRows = useWindowedRows(flat.length, NOT_PLACED_ROW_PX)
  /** Per row: the circuit it is on ("MDP-1,3"), null when it could go on one, absent when it has no electrical load. */
  const circuitOf = useMemo(() => {
    const out = new Map<string, string | null>()
    if (!model) return out
    for (const g of groups)
      for (const row of g.rows) {
        const part = model.elements[row.id]
        if (part?.kind !== 'part' || !isCircuitableLoad(model.elements, part)) continue
        out.set(row.id, electricalConnections(model.elements, row.id).find((c) => c.circuit)?.circuit?.name ?? null)
      }
    return out
  }, [model, groups])
  const uncircuited = useMemo(() => [...circuitOf].filter(([, c]) => c === null).map(([id]) => id), [circuitOf])
  /** Only asked while something is waiting for a circuit; stops at the first panel or switchboard. */
  const noPanel = useMemo(() => {
    if (!model || uncircuited.length === 0) return false
    for (const part of elementsOfKind(model.elements, 'part')) {
      const kind = distributionOf(model.elements, part)?.kind
      if (kind === 'panelboard' || kind === 'switchboard') return false
    }
    return true
  }, [model, uncircuited.length])
  const circuitHint = (what: string) => (!canEdit ? blockedReason : noPanel ? `No panel yet: add a planned panel (MDP), then put ${what} on it` : null)
  const [circuiting, setCircuiting] = useState<readonly string[] | null>(null)
  const placeReason = !canEdit ? blockedReason : surface.canPlace ? null : surface.reason
  /** The plan stays while the confirm closes, so its words don't change mid-fade. */
  const [removing, setRemoving] = useState<{ readonly plan: PlannedRemoval; readonly open: boolean } | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const askRemove = (partId: string) => {
    if (!model) return
    setRemoveError(null)
    setRemoving({ plan: planPlannedRemoval(model, [partId]), open: true })
  }
  const closeRemove = () => setRemoving((r) => (r ? { ...r, open: false } : null))
  const confirmRemove = () => {
    const plan = removing?.plan
    closeRemove()
    if (plan?.kind !== 'ready') return
    const refused = submit(plan.command, plan.label)
    if (refused) setRemoveError(refused)
  }

  const rowItem = (row: PlannedRow) => {
    const placing = placingId === row.id
    return (
      <Item key={row.id} size="sm" variant="outline" data-testid={`not-placed-yet-row-${row.id}`}>
        <ItemContent>
          <ItemTitle>{row.name}</ItemTitle>
          <ItemDescription>
            {[row.name !== row.typeName ? row.typeName : null, row.levelHint ? `for ${row.levelHint}` : null, circuitOf.get(row.id) ? `on ${circuitOf.get(row.id)}` : null, row.note].filter(Boolean).join(' · ') || 'No level chosen yet'}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {placing ? (
            <Button size="sm" variant="outline" onClick={onStopPlacing} data-testid={`not-placed-yet-stop-${row.id}`}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={placeReason !== null}
              title={placeReason ?? `Place ${row.name} in ${surface.label}`}
              aria-label={`Place ${row.name} in ${surface.label}`}
              onClick={() => onPlace(row.id)}
              data-testid={`not-placed-yet-place-${row.id}`}
            >
              <MapPin />
              Place
            </Button>
          )}
          {circuitOf.get(row.id) === null && (
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              title={circuitHint(row.name) ?? `Put ${row.name} on a panel circuit; it doesn't need to be drawn`}
              aria-label={`Circuit ${row.name}`}
              onClick={() => setCircuiting([row.id])}
              data-testid={`not-placed-yet-circuit-${row.id}`}
            >
              <Cable data-icon="inline-start" />
              Circuit
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!canEdit || placing}
            title={!canEdit ? blockedReason : placing ? 'Stop placing it first.' : `Remove ${row.name} from the model`}
            aria-label={`Remove ${row.name}`}
            onClick={() => askRemove(row.id)}
            data-testid={`not-placed-yet-remove-${row.id}`}
          >
            <Trash2 />
          </Button>
        </ItemActions>
      </Item>
    )
  }

  return (
    <section className="flex min-h-0 flex-col gap-3" aria-label="Not placed yet" data-testid="not-placed-yet-panel">
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">
          Not placed yet{model && !error ? `: ${total}` : ''}
        </h2>
        {uncircuited.length > 1 && (
          <Button size="sm" variant="outline" className="ml-auto" disabled={!canEdit} title={circuitHint(`the ${uncircuited.length} items`) ?? `Put the ${uncircuited.length} items with an electrical load on a panel, one circuit each`} onClick={() => setCircuiting(uncircuited)} data-testid="not-placed-yet-circuit-all">
            <Cable data-icon="inline-start" />
            Circuit all {uncircuited.length}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className={uncircuited.length > 1 ? undefined : 'ml-auto'} aria-label="Close Not placed yet" onClick={onClose}>
          <X />
        </Button>
      </header>

      {error ? (
        <Alert variant="destructive" data-testid="not-placed-yet-error">
          <AlertTitle>The list didn’t load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : !model ? (
        <div className="flex flex-col gap-2" aria-busy="true" data-testid="not-placed-yet-loading">
          <span className="sr-only">Loading the parts that aren’t placed yet</span>
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : total === 0 ? (
        <Empty className="border" data-testid="not-placed-yet-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleCheck />
            </EmptyMedia>
            <EmptyTitle>Everything is placed</EmptyTitle>
            <EmptyDescription>Parts planned from the one-line or a service layout show here until someone draws them.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="not-placed-yet-where">
            {placeReason ?? `Place puts it in ${surface.label}. Click where it goes, R to turn it, Esc to stop.`}
          </p>
          {noPanel && (
            <p className="text-xs text-muted-foreground" role="status" data-testid="not-placed-yet-no-panel">
              No panel yet. Circuit lets you add a planned panel (MDP) first, then puts the items on it.
            </p>
          )}
          {removeError && (
            <Alert variant="destructive" data-testid="not-placed-yet-remove-error">
              <AlertTitle>Nothing was removed</AlertTitle>
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          <div ref={windowRows.scrollRef} className="flex min-h-0 flex-col gap-3 overflow-y-auto" style={windowBoxStyle(windowRows)}>
            {windowRows.windowed ? (
              <ItemGroup data-testid="not-placed-yet-windowed">
                {windowRows.padTop > 0 && <div aria-hidden="true" style={{ height: windowRows.padTop }} />}
                {windowSlice(flat, windowRows).map(({ item, index }) => (
                  <div key={item.kind === 'group' ? `g:${item.key}` : item.row.id} ref={windowRows.measure} data-index={index} className={item.kind === 'group' ? 'pt-2' : undefined}>
                    {item.kind === 'group' ? (
                      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        {item.label}
                        <Badge variant="secondary">{item.count}</Badge>
                      </h3>
                    ) : (
                      rowItem(item.row)
                    )}
                  </div>
                ))}
                {windowRows.padBottom > 0 && <div aria-hidden="true" style={{ height: windowRows.padBottom }} />}
              </ItemGroup>
            ) : (
              groups.map((g) => (
                <div key={`${g.discipline}:${g.categoryLabel}`} className="flex flex-col gap-1" data-testid={`not-placed-yet-group-${g.discipline}`}>
                  <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    {disciplineWords(g.discipline, DISCIPLINE_WORDS)} · {g.categoryLabel}
                    <Badge variant="secondary">{g.rows.length}</Badge>
                  </h3>
                  <ItemGroup>{g.rows.map((row) => rowItem(row))}</ItemGroup>
                </div>
              ))
            )}
          </div>
        </>
      )}
      <RemoveConfirm plan={removing?.plan ?? null} open={removing?.open ?? false} onCancel={closeRemove} onConfirm={confirmRemove} />
      {circuiting && model && <LoadsPlannedDialog model={model} partIds={circuiting} rules={circuitRules ?? null} submit={submit} onClose={() => setCircuiting(null)} />}
    </section>
  )
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function RemoveConfirm({ plan, open, onCancel, onConfirm }: { plan: PlannedRemoval | null; open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ready = plan?.kind === 'ready' ? plan : null
  const name = ready ? (ready.names.length === 1 ? ready.names[0] : `${ready.names.length} planned items`) : null
  return (
    <AlertDialog open={open && plan !== null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent data-testid="not-placed-yet-remove-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{ready ? `Remove ${name} from the model?` : 'This can’t be removed'}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {plan?.kind === 'refused' && <p>{plan.message}</p>}
              {ready && (
                <>
                  <p>It isn’t drawn anywhere. Removing it deletes it with its values, so it leaves this list and every schedule.</p>
                  {ready.offCircuits.length > 0 && <p data-testid="not-placed-yet-remove-circuits">It comes off {list(ready.offCircuits)}; the circuit stays.</p>}
                  {ready.alsoRemoved.length > 0 && (
                    <>
                      <p>These go with it:</p>
                      <ul className="list-disc pl-5" data-testid="not-placed-yet-remove-also">
                        {ready.alsoRemoved.slice(0, 8).map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                        {ready.alsoRemoved.length > 8 && <li>and {ready.alsoRemoved.length - 8} more</li>}
                      </ul>
                    </>
                  )}
                  {ready.connectionsCut > 0 && <p>{ready.connectionsCut === 1 ? '1 connection is' : `${ready.connectionsCut} connections are`} cut.</p>}
                  <p>Undo (Ctrl+Z) brings it all back.</p>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{ready ? 'Keep it' : 'Close'}</AlertDialogCancel>
          {ready && (
            <AlertDialogAction variant="destructive" onClick={onConfirm} data-testid="not-placed-yet-remove-go">
              Remove {name}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
