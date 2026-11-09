'use client'

import { useMemo, type KeyboardEvent } from 'react'
import { CircleAlert, Flame, X } from 'lucide-react'
import { elementsOfKind, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { heatGainLocator, spaceHeatGainNeed, type KitchenHeatSources, type SpaceHeatGainNeed } from '@permitzip/bim-pack-mechanical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Skeleton } from '../../ui/skeleton'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useKitchenHeatTablesFrom } from './kitchen-heat-client'

export interface KitchenHeatPanelProps {
  readonly model: ModelState | null
  readonly error: string | null
  /** The plan the person is on; null lists the whole model. */
  readonly levelId: ElementId | null
  readonly levelName: string | null
  readonly projectId?: string | null
  readonly onSelectSpace: (spaceId: ElementId) => void
  readonly onOpenSpaces: () => void
  readonly onClose: () => void
}

interface Row {
  readonly spaceId: ElementId
  readonly label: string
  readonly need: SpaceHeatGainNeed
}

/** Every space on the level (or in the model) with kitchen equipment in it, and the heat each gains. */
export function kitchenHeatSpaceRows(model: ModelState, levelId: ElementId | null, tables: Pick<KitchenHeatSources, 'firm' | 'project'>): Row[] {
  const locator = heatGainLocator(model.elements)
  const out: Row[] = []
  for (const space of elementsOfKind(model.elements, 'space')) {
    if (levelId && space.levelId !== levelId) continue
    const need = spaceHeatGainNeed(model.elements, space.id, { firm: tables.firm, project: tables.project }, locator)
    if (need) out.push({ spaceId: space.id, label: [space.number, space.name].filter((p) => p.trim().length > 0).join(' ') || 'Unnamed space', need })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'en-US', { numeric: true }))
}

/**
 * Building Model › Mechanical › Analyze › Kitchen heat…: each space with kitchen
 * equipment and the heat it gains from the firm's (or the project's) table,
 * or where to add the table. Read only; Select puts the space in Properties,
 * where its Loads show the same line. Esc closes.
 */
export function KitchenHeatPanel({ model, error, levelId, levelName, projectId, onSelectSpace, onOpenSpaces, onClose }: KitchenHeatPanelProps) {
  const tables = useKitchenHeatTablesFrom(useEditorHost().data.firmLibrary, projectId)
  const rows = useMemo(() => (model && tables.status === 'ready' ? kitchenHeatSpaceRows(model, levelId, tables) : null), [model, levelId, tables])
  const noTable = rows !== null && rows.length > 0 && rows.every((r) => r.need.state === 'needs_table')
  const where = levelId ? (levelName ?? 'this level') : 'the model'

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <section className="flex flex-col gap-3 p-3" aria-label="Kitchen heat" onKeyDown={onKeyDown} data-testid="kitchen-heat-panel">
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Flame aria-hidden="true" />
          Kitchen heat on {where}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close kitchen heat" title="Close (Esc)" onClick={onClose}>
          <X />
        </Button>
      </header>

      {error || tables.status === 'error' ? (
        <Alert data-testid="kitchen-heat-panel-error">
          <CircleAlert />
          <AlertTitle>Kitchen heat can’t be shown</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {error ?? tables.error}
            {tables.status === 'error' ? (
              <Button size="sm" variant="outline" onClick={tables.retry}>
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : rows === null ? (
        <div className="flex flex-col gap-2" data-testid="kitchen-heat-panel-loading" aria-label="Reading the model and the kitchen heat table">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border py-4" data-testid="kitchen-heat-panel-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Flame />
            </EmptyMedia>
            <EmptyTitle>No kitchen equipment in a space on {where}</EmptyTitle>
            <EmptyDescription>Place a part whose type names its kitchen appliance (Fryer, Range) inside a drawn space, and its heat shows here and in the space’s Loads.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={onOpenSpaces}>
              Open Spaces
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {noTable ? (
            <Alert data-testid="kitchen-heat-panel-needs-table">
              <CircleAlert />
              <AlertTitle>No kitchen heat table yet</AlertTitle>
              <AlertDescription>Add a kitchen heat table in the firm library › Lookup tables. The add-on ships no numbers, so nothing is added until a table with a citation is there.</AlertDescription>
            </Alert>
          ) : null}
          <Table data-testid="kitchen-heat-panel-rows">
            <TableCaption className="sr-only">Heat each space gains from its kitchen equipment</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Space</TableHead>
                <TableHead>Heat gain</TableHead>
                <TableHead>
                  <span className="sr-only">Select</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.spaceId} data-testid="kitchen-heat-panel-row" data-space={r.spaceId} data-state={r.need.state}>
                  <TableCell className="text-xs">{r.label}</TableCell>
                  <TableCell className="text-xs" title={[r.need.detail, ...r.need.missing].filter(Boolean).join('\n') || undefined}>
                    {r.need.state === 'heat' ? r.need.line : 'Needs a table'}
                    {r.need.missing.length > 0 ? <span className="block text-warning-700">{r.need.missing.length === 1 ? '1 appliance has no row' : `${r.need.missing.length} appliances have no row`}</span> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => onSelectSpace(r.spaceId)} aria-label={`Select ${r.label}`}>
                      Select
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  )
}
