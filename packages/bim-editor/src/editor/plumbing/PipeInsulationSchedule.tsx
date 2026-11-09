'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { pipeInsulationPlan, STARTER_PIPE_INSULATION, STARTER_PIPE_INSULATION_SOURCE, type PipeInsulationRow, type PlumbingSettingsEntry } from '@permitzip/bim-pack-plumbing'
import { serviceLabel, type Command, type MepSystem, type ModelState, type SystemKind } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { FieldDescription } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'

/** The pipe systems an insulation schedule usually covers; any pipe kind can have a row. */
const INSULATED_KINDS: readonly SystemKind[] = ['domestic_hot_water', 'domestic_hot_water_return', 'domestic_cold_water', 'hydronic_supply', 'hydronic_return', 'storm', 'condensate']

const sizeWord = (v: number) => (v >= 48 ? 'and larger' : `below ${v}"`)

interface Props {
  readonly model: ModelState
  readonly settings: PlumbingSettingsEntry
  readonly systems: readonly MepSystem[]
  readonly canEdit: boolean
  readonly send: (command: Command, label: string) => void
  /** Save the schedule (and its source; null clears it, absent keeps it). */
  readonly saveSchedule: (rows: readonly PipeInsulationRow[], label: string, source?: string | null) => void
}

/**
 * Plumbing › Systems › Insulation: the project's pipe insulation schedule
 * (thickness by system and pipe size), and one button per system that puts
 * it on every pipe of that system (one undo). The adopted energy code's
 * table isn't in the code library, so the rows are the project's own; a
 * starter from PermitZIP's issued schedule is offered, marked to verify.
 */
export function PipeInsulationSchedule({ model, settings, systems, canEdit, send, saveSchedule: save }: Props) {
  const rows = settings.pipeInsulation ?? []
  const [kind, setKind] = useState<SystemKind>('domestic_hot_water')
  const edit = (i: number, patch: Partial<PipeInsulationRow>) => save(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)), 'change the pipe insulation schedule')
  const blocked = canEdit ? undefined : 'View only: this model can’t be edited here'
  if (rows.length === 0) {
    return (
      <Empty className="border py-4" data-testid="pipe-insulation-empty">
        <EmptyHeader>
          <EmptyTitle>No pipe insulation schedule yet</EmptyTitle>
          <EmptyDescription>The energy code’s pipe insulation table isn’t in the code library. Start from PermitZIP’s issued schedule (hot water at 105–140 °F: 1&quot; below 1-1/2&quot;, 1-1/2&quot; above) and check it against the adopted energy code, or add your own rows.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" disabled={!canEdit} title={blocked} onClick={() => save(STARTER_PIPE_INSULATION, 'start the pipe insulation schedule', STARTER_PIPE_INSULATION_SOURCE)} data-testid="pipe-insulation-starter">
            Start from PermitZIP’s schedule
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-testid="pipe-insulation-schedule">
      {settings.pipeInsulationSource && <FieldDescription>Source: {settings.pipeInsulationSource}</FieldDescription>}
      <Table>
        <TableCaption className="sr-only">Pipe insulation schedule</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Systems</TableHead>
            <TableHead>Pipe size</TableHead>
            <TableHead>Thickness (in.)</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={`${r.systemKinds.join(',')}:${r.belowNominalIn}:${i}`} data-testid="pipe-insulation-row">
              <TableCell className="text-xs">{r.systemKinds.map((k) => serviceLabel(k)).join(', ')}</TableCell>
              <TableCell>
                <Input aria-label="Pipes below this size (in.)" inputMode="decimal" className="h-8 w-20" defaultValue={String(r.belowNominalIn)} disabled={!canEdit} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== r.belowNominalIn && edit(i, { belowNominalIn: Number(e.target.value) })} />
                <span className="ml-1 text-xs text-muted-foreground">{sizeWord(r.belowNominalIn)}</span>
              </TableCell>
              <TableCell>
                <Input aria-label="Insulation thickness (in.)" inputMode="decimal" className="h-8 w-20" defaultValue={String(r.thicknessIn)} disabled={!canEdit} onBlur={(e) => Number(e.target.value) >= 0 && Number(e.target.value) !== r.thicknessIn && edit(i, { thicknessIn: Number(e.target.value) })} data-testid="pipe-insulation-thickness" />
              </TableCell>
              <TableCell className="text-xs">{r.material ?? '—'}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon-sm" aria-label="Remove this row" disabled={!canEdit} onClick={() => save(rows.filter((_r, k) => k !== i), 'remove a pipe insulation row')}>
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as SystemKind)} disabled={!canEdit}>
          <SelectTrigger size="sm" aria-label="System for a new row">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {INSULATED_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {serviceLabel(k)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={!canEdit} title={blocked} onClick={() => save([...rows, { systemKinds: [kind], belowNominalIn: 48, thicknessIn: 1 }], 'add a pipe insulation row')}>
          <Plus data-icon="inline-start" />
          Add row
        </Button>
      </div>
      <ItemGroup className="gap-1">
        {systems.map((s) => {
          const plan = pipeInsulationPlan(model, s.id)
          const why = 'reason' in plan ? plan.reason : plan.pieces.length === 0 ? 'Every pipe already has its scheduled insulation' : null
          return (
            <Item key={s.id} size="sm" variant="outline" data-testid={`pipe-insulation-system-${s.id}`}>
              <ItemContent>
                <ItemTitle className="text-sm">{s.name}</ItemTitle>
                <ItemDescription className="text-xs">{'reason' in plan ? 'No row for this system' : plan.pieces.length === 0 ? 'Up to date' : `${plan.pieces.length} pipe${plan.pieces.length === 1 ? '' : 's'} to change`}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canEdit || why !== null}
                  title={blocked ?? why ?? undefined}
                  onClick={() => {
                    if ('reason' in plan) return
                    send({ type: 'set_pipe_insulation', systemId: s.id, label: `Pipe insulation from the schedule on ${plan.pieces.length} pipes of ${s.name}`.slice(0, 160), pieces: plan.pieces.map((p) => ({ segmentId: p.segmentId, insulation: p.insulation })) }, `insulate ${s.name}`)
                  }}
                  data-testid="pipe-insulation-apply"
                >
                  Apply
                </Button>
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
      <FieldDescription className="text-xs">Apply puts the schedule on every pipe of that system as one change; undo takes it off. A single run can still be set by hand in its properties.</FieldDescription>
    </div>
  )
}
