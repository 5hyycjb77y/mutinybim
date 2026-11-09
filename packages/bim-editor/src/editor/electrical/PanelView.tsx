'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, CircleDot, Info, Pencil, Plus, Scale, TriangleAlert, Unplug, X } from 'lucide-react'
import { type ModelState } from '@permitzip/bim-kernel'
import { countEstimatesAtCommand, distributionEquipment, hasPositions, panelSchedule, spareCapacityReading, unassignedElectricalEstimates, type ElectricalNodeReport, type PanelCircuit, type PanelSlot } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Field, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import type { SubmitCommand } from '../views-sheets/types'
import { CapacityTargetLine } from './CapacityTargetLine'
import { FaultCurrentStrip } from './FaultCurrentStrip'
import type { CapacityTargets } from './use-capacity-targets'
import { NEC_EDITIONS, type NecRules } from './use-nec-rules'

const kva = (va: number) => (va / 1000).toFixed(1)

const LOADS_MIME = 'application/x-permitzip-loads'
const CIRCUIT_MIME = 'application/x-permitzip-circuit'

/** What can be dropped on the schedule: loads onto a free slot or a circuit, a circuit onto a free slot. */
export interface PanelDrop {
  readonly onLoads: (ids: readonly string[], target: { readonly slot?: number; readonly linkId?: string }) => void
  readonly onCircuit: (linkId: string, slot: number) => void
}

function readDrop(e: React.DragEvent): { loads: string[] } | { circuit: string } | null {
  const circuit = e.dataTransfer.getData(CIRCUIT_MIME)
  if (circuit) return { circuit }
  const raw = e.dataTransfer.getData(LOADS_MIME)
  if (!raw) return null
  try {
    const ids: unknown = JSON.parse(raw)
    return Array.isArray(ids) ? { loads: ids.filter((x): x is string => typeof x === 'string') } : null
  } catch (err) {
    console.error('[PanelView] a dropped list of devices could not be read', err)
    return null
  }
}

function dropProps(slot: PanelSlot, drop: PanelDrop | undefined): React.TdHTMLAttributes<HTMLTableCellElement> {
  if (!drop) return {}
  const c = slot.circuit
  if (c && (c.role !== 'branch' || !slot.first)) return {}
  return {
    onDragOver: (e) => {
      const types = e.dataTransfer.types
      if (types.includes(LOADS_MIME) || (!c && types.includes(CIRCUIT_MIME))) e.preventDefault()
    },
    onDrop: (e) => {
      e.preventDefault()
      const d = readDrop(e)
      if (!d) return
      if ('circuit' in d) {
        if (!c) drop.onCircuit(d.circuit, slot.slot)
      } else drop.onLoads(d.loads, c ? { linkId: c.linkId } : { slot: slot.slot })
    },
  }
}

/** "not placed yet" when what the circuit serves exists only on the list; "2 not placed yet" for some of several. */
function notPlacedText(c: PanelCircuit): string | null {
  const n = c.members.filter((m) => m.notPlaced).length
  if (n === 0) return null
  return n === c.members.length ? 'not placed yet' : `${n} not placed yet`
}

/** One half-row of the schedule: a slot and, on a breaker's first slot, its circuit. */
function SlotCells({ slot, onEdit, side, linkVa, drop }: { readonly slot: PanelSlot | undefined; readonly onEdit: (c: PanelCircuit) => void; readonly side: 'left' | 'right'; readonly linkVa: ReadonlyMap<string, number>; readonly drop?: PanelDrop }) {
  if (!slot) return <TableCell colSpan={5} />
  const c = slot.circuit
  const va = c ? linkVa.get(c.linkId) : undefined
  const share = c && va !== undefined && c.positions.length > 0 ? va / c.positions.length : null
  const cells = [
    <TableCell key="n" className="w-8 text-xs tabular-nums text-muted-foreground">
      {slot.slot}
    </TableCell>,
    <TableCell key="d" className="max-w-40 text-xs" data-testid={`panel-slot-${slot.slot}`} {...dropProps(slot, drop)}>
      {c ? (
        slot.first ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => onEdit(c)}
            data-testid={`panel-circuit-${c.positions.join('-')}`}
            draggable={drop !== undefined && c.role === 'branch'}
            onDragStart={(e) => {
              e.dataTransfer.setData(CIRCUIT_MIME, c.linkId)
              e.dataTransfer.effectAllowed = 'move'
            }}
          >
            {c.role === 'feeder' ? `Feeder to ${c.feeds?.name ?? 'spare'}${c.typicalCount ? ` (typical, ×${c.typicalCount})` : ''}` : c.description || `${c.members.length} device${c.members.length === 1 ? '' : 's'}`}
            {c.existing && (
              <span className="ml-1 font-normal text-muted-foreground no-underline" title={`Existing (${c.existing.phase}): keeps its panel and number; Rebalance leaves it alone`} data-testid={`panel-circuit-existing-${c.positions.join('-')}`}>
                · existing
              </span>
            )}
            {notPlacedText(c) && (
              <span className="ml-1 font-normal text-muted-foreground no-underline" data-testid={`panel-circuit-not-placed-${c.positions.join('-')}`}>
                · {notPlacedText(c)}
              </span>
            )}
          </Button>
        ) : (
          <span className="text-muted-foreground">↳ {c.name}</span>
        )
      ) : (
        <span className="text-muted-foreground">Space</span>
      )}
    </TableCell>,
    <TableCell key="b" className="w-10 text-xs tabular-nums">
      {c && slot.first ? (c.ratingA ?? '—') : ''}
    </TableCell>,
    <TableCell key="p" className="w-6 text-xs tabular-nums">
      {c && slot.first ? c.poles : ''}
    </TableCell>,
    <TableCell key="l" className="w-16 text-right text-xs tabular-nums">
      {c ? (share === null ? '—' : kva(share)) : ''}
    </TableCell>,
  ]
  return <>{side === 'left' ? cells : [...cells].reverse()}</>
}

/**
 * Panel view: the live schedule of a panelboard, switchboard or transformer:
 * header (system, bus, main, what feeds it), every slot in two columns with
 * its circuit, breaker, poles and load, and connected load by phase. Click a
 * circuit to edit it. Values are the model's; nothing here is typed text.
 */
export function PanelView({
  model,
  panelId,
  canEdit,
  editBlocked,
  submit,
  onPanel,
  onClose,
  onEditCircuit,
  onFeed,
  report,
  nec,
  drop,
  dragLoads,
  onRebalance,
  capacityTargets,
}: {
  readonly model: ModelState
  readonly panelId: string
  /** The aggregation engine's report for this panel (connected, NEC demand, per phase, capacity, findings). */
  readonly report: ElectricalNodeReport | null
  readonly nec: NecRules
  readonly canEdit: boolean
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
  readonly onPanel: (id: string) => void
  readonly onClose: () => void
  readonly onEditCircuit: (linkId: string) => void
  readonly onFeed: (panelId: string) => void
  /** Drag and drop onto the schedule; absent when editing isn't allowed. */
  readonly drop?: PanelDrop
  /** Loads offered for dragging: the selection, then devices on no circuit. */
  readonly dragLoads?: readonly { readonly ids: readonly string[]; readonly label: string }[]
  readonly onRebalance?: (panelId: string) => void
  /** The firm's and project's design limits for the spare-capacity line; absent: the defaults, with no way to change them here. */
  readonly capacityTargets?: CapacityTargets
}) {
  const els = model.elements
  const s = panelSchedule(els, panelId)
  const all = distributionEquipment(els)
  const [name, setName] = useState('')
  /** Space estimates no panel counts yet: one click names this panel as their source. */
  const unassigned = useMemo(() => unassignedElectricalEstimates(els), [els])
  const [countError, setCountError] = useState<string | null>(null)
  if (!s) {
    return (
      <section className="flex flex-col gap-2 p-3" aria-label="Panel view" data-testid="panel-view">
        <p className="text-sm">That panel is gone (deleted, or undo took it back).</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </section>
    )
  }
  const rows = s.spaces !== null ? Math.ceil(s.spaces / 2) : 0
  const bySlot = new Map(s.slots.map((x) => [x.slot, x]))
  const linkVa = new Map(report?.links.map((l) => [l.linkId, l.inventory.va]) ?? [])
  const saveName = (e: React.FormEvent) => {
    e.preventDefault()
    const v = name.trim()
    if (!v) return
    const refusal = submit({ type: 'set_parameters', id: panelId, scope: 'instance', values: { panel_name: v } }, `name the panel ${v}`)
    if (!refusal) setName('')
  }
  return (
    <section className="flex max-h-full min-h-0 flex-col gap-2 p-3" aria-label={`Panel view: ${s.name}`} data-testid="panel-view" data-panel={s.name}>
      <header className="flex flex-wrap items-center gap-2">
        <CircleDot className="size-4 text-muted-foreground" aria-hidden />
        <Select value={panelId} onValueChange={onPanel}>
          <SelectTrigger size="sm" className="w-48" aria-label="Panel shown" data-testid="panel-view-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {all.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Badge variant="outline">{s.system}</Badge>
        {!hasPositions(s.kind) ? <Badge variant="outline">{[s.kva ? `${s.kva} kVA` : null, s.busA ? `${s.busA} A` : null, s.mainA ? `${s.mainA} A fuses` : null, s.supply ? `fed at ${s.supply}` : null].filter(Boolean).join(', ') || s.kind.replace(/_/g, ' ')}</Badge> : <Badge variant="outline">{s.busA ? `${s.busA} A bus` : 'no bus rating'}, {s.mainA ? `${s.mainA} A main` : 'main lugs'}</Badge>}
        <span className="text-xs text-muted-foreground" data-testid="panel-view-supply">
          Supply from: {s.fedBy ? `${s.fedBy.sourceName}${s.fedBy.positions.length > 0 ? ` via ${s.fedBy.ratingA ? `${s.fedBy.ratingA} A ` : ''}breaker ${s.fedBy.positions.join(',')}` : ''}` : 'not fed yet'}
        </span>
        {s.spaces !== null && <span className="text-xs text-muted-foreground">{s.freeSlots} of {s.spaces} slots free</span>}
        {onRebalance && hasPositions(s.kind) && s.circuits.length > 1 && (
          <Button variant="outline" size="sm" onClick={() => onRebalance(panelId)} disabled={!canEdit} title={canEdit ? 'Even out the load on A, B and C' : (editBlocked ?? undefined)} data-testid="panel-view-rebalance">
            <Scale data-icon="inline-start" />
            Rebalance
          </Button>
        )}
        {!s.fedBy && (
          <Button variant="outline" size="sm" onClick={() => onFeed(panelId)} disabled={!canEdit} title={canEdit ? undefined : (editBlocked ?? undefined)}>
            <Unplug data-icon="inline-start" />
            Feed {s.name}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close panel view" onClick={onClose}>
          <X />
        </Button>
      </header>
      <FaultCurrentStrip model={model} panelId={panelId} canEdit={canEdit} editBlocked={editBlocked} submit={submit} />
      {!s.named && (
        <form className="flex items-end gap-2" onSubmit={saveName}>
          <Field className="w-56">
            <FieldLabel htmlFor="bm-panel-name" className="text-xs">
              Name this panel so its circuits read L1-3, not “{s.name}-3”
            </FieldLabel>
            <Input id="bm-panel-name" placeholder="L1" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
          </Field>
          <Button type="submit" size="sm" disabled={!canEdit || name.trim() === ''}>
            <Pencil data-icon="inline-start" />
            Name it
          </Button>
        </form>
      )}
      {drop && hasPositions(s.kind) && dragLoads && dragLoads.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="panel-view-drag-strip" aria-label="Drag onto a slot or a circuit">
          <span className="text-muted-foreground">Drag onto a slot or a circuit:</span>
          {dragLoads.map((d) => (
            <Badge
              key={d.ids.join(',')}
              variant="outline"
              className="cursor-grab"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(LOADS_MIME, JSON.stringify(d.ids))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              data-testid="panel-view-drag-load"
            >
              {d.label}
            </Badge>
          ))}
        </div>
      )}
      {!hasPositions(s.kind) ? (
        <div className="text-sm" data-testid="panel-view-feeds">
          {s.circuits.length === 0
            ? `Feeds nothing yet. Select what it should feed and press Electrical › Feed panel (or Add to circuit for a load), then choose ${s.name}.`
            : `Feeds ${s.circuits.map((c) => c.feeds?.name ?? (c.members.map((m) => m.name).join(', ') || 'a spare')).join(', ')}${s.kind === 'transformer' ? ' from its secondary' : ''}.`}
        </div>
      ) : s.circuits.length === 0 ? (
        <Empty
          className="border py-6"
          data-testid="panel-view-empty"
          onDragOver={(e) => drop && e.dataTransfer.types.includes(LOADS_MIME) && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const d = drop ? readDrop(e) : null
            if (drop && d && 'loads' in d) drop.onLoads(d.loads, {})
          }}
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleDot />
            </EmptyMedia>
            <EmptyTitle>No circuits on {s.name} yet</EmptyTitle>
            <EmptyDescription>Select receptacles, lights or equipment (box select with B), then press Electrical › Add to circuit and choose {s.name}, or drag them here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-40 flex-1 overflow-auto rounded-md border">
          <Table data-testid="panel-view-table">
            <TableCaption className="sr-only">Slots of {s.name}: odd slots on the left, even on the right</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">#</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs">Bkr</TableHead>
                <TableHead className="text-xs">P</TableHead>
                <TableHead className="text-right text-xs">kVA</TableHead>
                <TableHead className="w-8 text-center text-xs">Ph</TableHead>
                <TableHead className="text-right text-xs">kVA</TableHead>
                <TableHead className="text-xs">P</TableHead>
                <TableHead className="text-xs">Bkr</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-xs">#</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: rows }, (_, r) => {
                const left = bySlot.get(2 * r + 1)
                const right = bySlot.get(2 * r + 2)
                return (
                  <TableRow key={r} data-testid={`panel-row-${2 * r + 1}`}>
                    <SlotCells slot={left} onEdit={(c) => onEditCircuit(c.linkId)} side="left" linkVa={linkVa} drop={drop} />
                    <TableCell className="text-center text-xs font-medium text-muted-foreground">{left?.phase}</TableCell>
                    <SlotCells slot={right} onEdit={(c) => onEditCircuit(c.linkId)} side="right" linkVa={linkVa} drop={drop} />
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {report?.estimates && report.estimates.length > 0 && (
        <div className="flex flex-col gap-1 text-xs" data-testid="panel-view-estimates">
          <span className="font-medium">Also counted here, not on a circuit yet</span>
          {report.estimates.map((e) => (
            <span key={e.loadIds.join(',')} data-testid="panel-view-estimate">
              {e.label}: <span className="tabular-nums">{kva(e.va)} kVA</span>
              <span className="text-muted-foreground">{e.kind === 'estimate' ? ' (counts until the devices inside it are more)' : ' (circuit it to move it onto a breaker)'}</span>
            </span>
          ))}
        </div>
      )}
      {unassigned.length > 0 && hasPositions(s.kind) && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="panel-view-unassigned">
          <span className="text-muted-foreground">
            Estimates no panel counts yet: {unassigned.map((u) => `${u.label} ${kva(u.va)} kVA`).join(', ')}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!canEdit}
            title={canEdit ? `${s.name} counts them in its connected load (and everything above it counts them too)` : (editBlocked ?? undefined)}
            onClick={() => {
              const command = countEstimatesAtCommand(panelId, s.name, unassigned.map((u) => u.loadId))
              if (!command) return
              const refusal = submit(command, `count ${unassigned.length === 1 ? 'the estimate' : `${unassigned.length} estimates`} on ${s.name}`)
              setCountError(refusal)
            }}
            data-testid="panel-view-count-estimates"
          >
            <Plus data-icon="inline-start" />
            Count {unassigned.length === 1 ? 'it' : 'them'} on {s.name}
          </Button>
          {countError && (
            <span className="text-danger-600" role="alert">
              {countError}
            </span>
          )}
        </div>
      )}
      <PanelTotals report={report} nec={nec} targets={capacityTargets} canEdit={canEdit} />
    </section>
  )
}

const amps = (a: number) => `${Math.round(a)} A`
const SEVERITY_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const

/** Totals from the aggregation engine: connected and NEC demand, per phase, what the panel can carry and why, and findings. */
function PanelTotals({ report, nec, targets, canEdit }: { readonly report: ElectricalNodeReport | null; readonly nec: NecRules; readonly targets: CapacityTargets | undefined; readonly canEdit: boolean }) {
  if (!report) return null
  const d = report.demand
  return (
    <footer className="flex flex-col gap-2 text-xs" data-testid="panel-view-totals">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span data-testid="panel-view-connected">
          Connected: <span className="font-medium tabular-nums">{kva(report.connectedVa)} kVA, {amps(report.connectedA)}</span>
        </span>
        <span data-testid="panel-view-demand">
          {report.rules.placeholder ? 'Demand (no code)' : 'NEC demand'}: <span className="font-medium tabular-nums">{kva(d.demandVa)} kVA, {amps(report.demandA)}</span>
        </span>
        <span>
          Sized for: <span className="font-medium tabular-nums">{kva(d.sizingVa)} kVA, {amps(report.sizingA)}</span>
          {d.minimumDeviceA ? ` (at least a ${d.minimumDeviceA} A device)` : ''}
        </span>
        {report.perPhase.map((p) => (
          <span key={p.phase} data-testid={`panel-view-phase-${p.phase}`}>
            Phase {p.phase}: <span className="font-medium tabular-nums">{kva(p.va)} kVA, {amps(p.amps)}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground" data-testid="panel-view-code">
          {nec.label}
        </span>
        {nec.source !== 'project' && (
          <Select value={nec.picked ?? 'none'} onValueChange={(v) => nec.pick(v === 'none' ? null : (NEC_EDITIONS.find((e) => e === v) ?? null))}>
            <SelectTrigger size="sm" className="w-44" aria-label="NEC edition for these totals" data-testid="panel-view-nec">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">Connected loads only</SelectItem>
                {NEC_EDITIONS.map((e) => (
                  <SelectItem key={e} value={e}>
                    NEC {e}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        {nec.problem && <span className="text-danger-600">{nec.problem}</span>}
      </div>
      {d.lines.length > 0 && (
        <p className="text-muted-foreground" data-testid="panel-view-demand-lines">
          {d.lines.map((l) => `${l.label}: ${kva(l.connectedVa)} → ${kva(l.demandVa)} kVA (${l.basis})`).join(' · ')}
        </p>
      )}
      <p data-testid="panel-view-capacity">{report.capacity.reason}</p>
      <CapacityTargetLine reading={spareCapacityReading(report.capacity, targets?.sources)} targets={targets} canEdit={canEdit} testId="spare-capacity" />
      {report.findings.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="panel-view-findings">
          {report.findings.map((f, i) => {
            const Icon = SEVERITY_ICON[f.severity]
            return (
              <Alert key={`${f.kind}-${i}`} variant={f.severity === 'error' ? 'destructive' : 'default'} className="py-1.5">
                <Icon />
                <AlertDescription className="text-xs">{f.message}</AlertDescription>
              </Alert>
            )
          })}
        </div>
      )}
    </footer>
  )
}
