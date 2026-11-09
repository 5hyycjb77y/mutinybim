'use client'

import { useMemo, useState } from 'react'
import { Wind } from 'lucide-react'
import type { ElementId, ModelState } from '@permitzip/bim-kernel'
import type { PressurizationScope } from '@permitzip/bim-pack-mechanical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { pressurizationView, type PressurizationRow, type PressurizationView } from './pressurization-rows'

export interface PressurizationSectionProps {
  readonly model: ModelState
  /** The same scope the Ventilation panel lists; null when "This level" has no plan open. */
  readonly scope: PressurizationScope | null
  readonly onSelectPart?: (partId: ElementId) => void
}

/**
 * Building Model › Ventilation › Pressurization (ROADMAP M1): each zone and the
 * building with exhaust, makeup air, outdoor air and net, positive or negative
 * against its target (kitchens negative to dining, the building slightly
 * positive), the items behind each line, and the untempered makeup-air load on
 * the unit that serves it. Read only: change the items' airflows to change it.
 */
export function PressurizationSection({ model, scope, onSelectPart }: PressurizationSectionProps) {
  const [open, setOpen] = useState<string | null>(null)
  const computed = useMemo((): { view: PressurizationView } | { failure: string } | null => {
    if (!scope) return null
    try {
      return { view: pressurizationView(model.elements, scope) }
    } catch (err) {
      console.error('[PressurizationSection] the pressurization balance failed', err)
      return { failure: err instanceof Error ? err.message : String(err) }
    }
  }, [model, scope])

  const view = computed && 'view' in computed ? computed.view : null
  const detail = view?.rows.find((r) => r.id === open) ?? null

  return (
    <section className="flex flex-col gap-2" aria-label="Pressurization" data-testid="pressurization-section">
      <h3 className="flex items-center gap-1 text-xs font-semibold">
        <Wind className="size-3.5 text-muted-foreground" aria-hidden />
        Pressurization
      </h3>
      {computed && 'failure' in computed && (
        <Alert variant="destructive">
          <AlertTitle>The pressurization couldn’t be worked out</AlertTitle>
          <AlertDescription>{computed.failure}. Reload the page; if it keeps happening, tell the team which model this is.</AlertDescription>
        </Alert>
      )}
      {view?.empty && (
        <Empty className="border p-3">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Wind />
            </EmptyMedia>
            <EmptyTitle>No air balance to show</EmptyTitle>
            <EmptyDescription>{view.empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {view && !view.empty && (
        <>
          <Table>
            <TableCaption>
              Net = makeup air + outdoor air − exhaust. {view.tolerance}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Zone</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>Pressure</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((r) => (
                <TableRow key={r.id} data-state={open === r.id ? 'selected' : undefined} className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)} data-testid={`pressurization-row-${r.id}`}>
                  <TableCell className="max-w-32">
                    <Button variant="link" size="xs" className="h-auto max-w-full justify-start truncate p-0 text-foreground" aria-expanded={open === r.id} title={r.text}>
                      {r.name}
                    </Button>
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-testid={`pressurization-net-${r.id}`}>
                    {r.net}
                  </TableCell>
                  <TableCell>
                    <VerdictBadge row={r} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {detail && <RowDetail row={detail} onSelectPart={onSelectPart} />}
          {view.heat.length > 0 && (
            <div className="flex flex-col gap-1 text-xs" data-testid="pressurization-heat">
              <span className="font-medium">Makeup air load</span>
              {view.heat.map((h) => (
                <p key={h.partId} className={h.problem ? 'text-muted-foreground' : 'tabular-nums'}>
                  {h.problem ? h.text : `${h.mark}: ${h.text}`}
                </p>
              ))}
            </div>
          )}
          {view.unassigned.length > 0 && <p className="text-xs text-muted-foreground">In no zone (counted for the building only): {view.unassigned.join(', ')}. Name a zone in its “serves zone” value, or place it inside a space.</p>}
        </>
      )}
    </section>
  )
}

function VerdictBadge({ row }: { readonly row: PressurizationRow }) {
  if (row.verdict === 'incomplete') return <Badge variant="outline">can’t add up</Badge>
  if (row.verdict === 'nothing') return <Badge variant="outline">no air moved</Badge>
  const word = row.state ?? '—'
  if (row.verdict === 'misses') return <Badge variant="destructive">{`${word}, should be ${row.target}`}</Badge>
  if (row.verdict === 'meets') return <Badge variant="secondary">{`${word}, as targeted`}</Badge>
  return <Badge variant="outline">{word}</Badge>
}

function RowDetail({ row, onSelectPart }: { readonly row: PressurizationRow; readonly onSelectPart?: (id: ElementId) => void }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2 text-xs" data-testid="pressurization-detail">
      <span className="font-medium">{row.name}</span>
      <p className={row.verdict === 'incomplete' || row.verdict === 'misses' ? 'text-destructive' : 'text-muted-foreground'}>{row.text}</p>
      {row.why && <p className="text-muted-foreground">Target: {row.why}</p>}
      <dl className="grid grid-cols-2 gap-x-2 tabular-nums">
        <dt className="text-muted-foreground">Exhaust</dt>
        <dd>{row.exhaust}</dd>
        <dt className="text-muted-foreground">Makeup air</dt>
        <dd>{row.makeup}</dd>
        <dt className="text-muted-foreground">Outdoor air</dt>
        <dd>{row.outdoor}</dd>
      </dl>
      {row.exhaustNote && <p className="text-muted-foreground">{row.exhaustNote}</p>}
      {row.items.length === 0 ? (
        <p className="text-muted-foreground">Nothing here moves air in or out. Give exhaust fans an exhaust airflow, makeup air units a makeup airflow and units an outdoor airflow.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {row.items.map((it) => (
            <li key={it.partId} className="flex items-center gap-2">
              {onSelectPart ? (
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => onSelectPart(it.partId)} title={`Select ${it.label} in the model`}>
                  {it.label}
                </Button>
              ) : (
                <span>{it.label}</span>
              )}
              <span className="text-muted-foreground">
                {it.role}
                {it.planned ? ' (planned)' : ''}
              </span>
              <span className="ml-auto tabular-nums">{it.missing ? <Badge variant="outline">no airflow</Badge> : it.cfm}</span>
            </li>
          ))}
        </ul>
      )}
      {row.items.filter((it) => it.missing).map((it) => (
        <p key={it.partId} className="text-destructive">
          {it.missing}
        </p>
      ))}
    </div>
  )
}
