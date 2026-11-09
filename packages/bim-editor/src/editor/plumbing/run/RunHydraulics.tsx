'use client'

import { useState } from 'react'
import {
  fittingFamilies,
  familyMismatch,
  inPerFtLabel,
  minSlopeFor,
  nominalInOf,
  resolveFitting,
  serviceOf,
  slopeInPerFt,
  type Command,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from '@permitzip/bim-kernel'
import {
  PipeHydraulicsEngine,
  elementHydraulics,
  type DrainSegmentResult,
  type FittingLossResult,
  type GasSegmentResult,
  type PipeSystemReport,
  type WaterSegmentResult,
} from '@permitzip/bim-pack-plumbing'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../../ui/field'
import { Input } from '../../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { Separator } from '../../../ui/separator'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { GasSizingFrom, RegulatorSettings } from '../GasSizing'
import { PipeSizing } from '../PipeSizing'

/** One engine for the panel: a system's report is reused until one of its elements changes. */
const engine = new PipeHydraulicsEngine()

const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"

interface Props {
  element: RunSegment | RunFitting
  model: ModelState
  canEdit: boolean
  onCommand: (command: Command) => string | null
  /** For the project's Code Study (its fuel gas code). */
  projectId?: string
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <ItemGroup className="gap-1">
      {rows.map(([k, v]) => (
        <Item key={k} size="sm">
          <ItemContent>
            <ItemDescription className="text-xs">{k}</ItemDescription>
            <ItemTitle className="text-xs font-normal">{v}</ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

function ventSystem(model: ModelState, systemId: string): boolean {
  const system = model.elements[systemId]
  return system?.kind === 'mep_system' && serviceOf(system.systemKind) === 'vent'
}

function n(v: number, d = 2): string {
  return (Math.round(v * 10 ** d) / 10 ** d).toString()
}

/** Hydraulics for a routed pipe piece: flow, velocity and friction (water), fixture units and capacity at slope (drains), drop (gas); the system's result; type, slope and accessories. */
export function RunHydraulics({ element: el, model, canEdit, onCommand, projectId }: Props) {
  const codeAdoption = useEditorHost().data.codeAdoption
  const [error, setError] = useState<string | null>(null)
  if (el.domain !== 'pipe') return null
  const found = elementHydraulics(engine, model, el.id)
  if (!found) return null
  const { report, segment, fitting } = found
  const mine = report.warnings.filter((w) => w.elementId === el.id)
  const others = report.warnings.filter((w) => w.elementId !== el.id)
  return (
    <div className="flex flex-col gap-3" data-testid="run-hydraulics">
      <Separator />
      <span className="text-sm font-medium">Hydraulics</span>
      {report.kind === 'not_calculated' ? (
        <FieldDescription data-testid="run-hydraulics-unavailable">{report.reason}</FieldDescription>
      ) : (
        <>
          {segment && <SegmentRows report={report} segment={segment} />}
          {fitting && <FittingLosses fitting={fitting} unit={report.kind === 'gas' ? 'in. w.c.' : 'psi'} />}
          <SystemSummary report={report} />
        </>
      )}
      {el.kind === 'run_fitting' && <RegulatorSettings key={`reg:${el.id}:${el.version}`} fitting={el} model={model} canEdit={canEdit} onCommand={onCommand} />}
      {el.kind === 'run_fitting' && <PipeTypePicker fitting={el} model={model} canEdit={canEdit} onCommand={onCommand} onError={setError} />}
      {el.kind === 'run_segment' && <SlopeForm key={`${el.id}:${el.version}`} segment={el} model={model} canEdit={canEdit} onCommand={onCommand} onError={setError} />}
      {report.kind === 'gas' && <GasSizingFrom port={codeAdoption} systemId={el.systemId} model={model} canEdit={canEdit} onCommand={onCommand} {...(projectId ? { projectId } : {})} />}
      {(report.kind === 'water' || report.kind === 'drainage' || ventSystem(model, el.systemId)) && <PipeSizing systemId={el.systemId} model={model} canEdit={canEdit} onCommand={onCommand} {...(projectId ? { projectId } : {})} />}
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="run-hydraulics-error">
          {error}
        </FieldDescription>
      )}
      {[...mine, ...others.slice(0, 3)].map((w) => (
        <FieldDescription key={`${w.elementId ?? 'system'}:${w.message}`} className="text-warning-700" role="status">
          {w.message}
        </FieldDescription>
      ))}
      {others.length > 3 && <FieldDescription>{others.length - 3} more notes on this system in the pipe report.</FieldDescription>}
    </div>
  )
}

function SegmentRows({ report, segment }: { report: Exclude<PipeSystemReport, { kind: 'not_calculated' }>; segment: WaterSegmentResult | DrainSegmentResult | GasSegmentResult }) {
  if (report.kind === 'water') {
    const s = segment as WaterSegmentResult
    return (
      <Rows
        rows={[
          ['Fixture units', n(s.fixtureUnits)],
          ['Flow', `${n(s.gpm)} gpm`],
          ['Velocity', `${n(s.velocityFps)} ft/s${s.overVelocity ? ' (over the limit)' : ''}`],
          ['Friction', `${n(s.frictionPsiPer100Ft, 3)} psi / 100 ft`],
          ['Loss here', `${n(s.frictionPsi, 3)} psi friction, ${n(s.elevationPsi, 3)} psi height`],
        ]}
      />
    )
  }
  if (report.kind === 'drainage') {
    const s = segment as DrainSegmentResult
    return (
      <Rows
        rows={[
          ['Fixture units', `${n(s.fixtureUnits)} DFU (${n(s.designGpm)} gpm)`],
          [s.role === 'stack' ? 'Stack capacity' : 'Capacity at slope', `${n(s.capacityGpm)} gpm${s.slopeInPerFt !== null ? ` at ${inPerFtLabel(s.slopeInPerFt)}` : ''}`],
          ['Used', `${Math.round(s.utilisation * 100)}%${s.tableMaxDfu !== null ? ` (table allows ${s.tableMaxDfu} DFU)` : ''}`],
          ...(s.role === 'horizontal' ? ([['Velocity', `${n(s.velocityFps)} ft/s`]] as [string, string][]) : []),
        ]}
      />
    )
  }
  const s = segment as GasSegmentResult
  return (
    <Rows
      rows={[
        ['Load', `${n(s.mbh)} MBH (${n(s.cfh)} cfh)`],
        ['Drop here', `${n(s.dropInWc, 4)} in. w.c.`],
        ['Over the longest run', `${n(s.designDropInWc, 4)} in. w.c.${s.ok ? '' : ' (too much)'}`],
      ]}
    />
  )
}

function FittingLosses({ fitting, unit }: { fitting: FittingLossResult; unit: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="pipe-fitting-loss">
      {fitting.paths.map((p) => (
        <div key={p.role} className="flex flex-col gap-1">
          <Rows rows={[[fitting.paths.length > 1 ? `${p.role === 'branch' ? 'Branch' : 'Through'}: K` : 'K', `${n(p.k, 3)} (${n(p.equivalentLengthFt)} ft of pipe), ${n(p.loss, 4)} ${unit}`]]} />
          <Badge variant={p.verify ? 'outline' : 'secondary'} className="w-fit">
            {p.source}
          </Badge>
        </div>
      ))}
    </div>
  )
}

function SystemSummary({ report }: { report: Exclude<PipeSystemReport, { kind: 'not_calculated' }> }) {
  const verdict = report.pass === null ? null : report.pass ? 'Passes' : 'Fails'
  const rows: [string, string][] =
    report.kind === 'water'
      ? [
          [`${report.systemName}: critical fixture`, report.critical ? `${report.critical.label}, ${n(report.critical.pressure)} psi` : 'None connected yet'],
          ['Needs', report.minFixturePsi !== null ? `${report.minFixturePsi} psi` : 'Not set'],
        ]
      : report.kind === 'drainage'
        ? [[`${report.systemName}: total`, `${n(report.totalFixtureUnits)} DFU`]]
        : report.zones
          ? report.zones.map((z): [string, string] => [z.label, `${z.pass ? 'Within' : 'Over'} its ${z.allowableDropInWc} in. w.c. drop over ${n(z.longestFt, 1)} ft`])
          : [
              [`${report.systemName}: longest run`, `${n(report.longestRunFt, 1)} ft`],
              ['Worst outlet', report.critical ? `${report.critical.label}, ${n(report.critical.pressure, 3)} in. w.c. (${report.allowableDropInWc} allowed drop)` : 'None connected yet'],
            ]
  return (
    <div className="flex flex-col gap-1" data-testid="pipe-system-summary">
      <Rows rows={rows} />
      {verdict && (
        <Badge variant={report.pass ? 'secondary' : 'destructive'} className="w-fit">
          {verdict}
        </Badge>
      )}
      <FieldDescription className="text-xs">{report.basis[0]}</FieldDescription>
    </div>
  )
}

function PipeTypePicker({ fitting, model, canEdit, onCommand, onError }: { fitting: RunFitting; model: ModelState; canEdit: boolean; onCommand: (command: Command) => string | null; onError: (message: string | null) => void }) {
  const system = model.elements[fitting.systemId]
  const host = fitting.host ? model.elements[fitting.host.segmentId] : undefined
  if (system?.kind !== 'mep_system') return null
  const sizes = fitting.fittingType === 'accessory' && host?.kind === 'run_segment' ? [host.size] : fitting.ports.map((p) => p.size)
  const current = resolveFitting(system, fitting)
  // Types that fit this fitting's shape, material and service; a direction change the kernel refuses is explained on choosing.
  const choices = fittingFamilies().filter(
    (f) =>
      familyMismatch(f, {
        fittingType: fitting.fittingType,
        domain: 'pipe',
        sizes,
        systemKind: system.systemKind,
        ...(fitting.angleDeg !== undefined ? { angleDeg: fitting.angleDeg } : {}),
        ...(host?.kind === 'run_segment' ? { main: host.size } : {}),
      }) === null,
  )
  return (
    <Field>
      <FieldLabel htmlFor="bm-pipe-fitting-type">Fitting type</FieldLabel>
      <Select value={current?.family.id} onValueChange={(family) => onError(onCommand({ type: 'swap_fitting', fittingId: fitting.id, family }))} disabled={!canEdit || choices.length < 2}>
        <SelectTrigger id="bm-pipe-fitting-type" data-testid="pipe-fitting-type" title={canEdit ? (choices.length < 2 ? 'No other type fits this fitting' : undefined) : NOT_LIVE}>
          <SelectValue placeholder="Choose a type" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {choices.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {current?.family.pipe?.joints && typeof current.params.joint === 'string' && <FieldDescription>Joint: {current.params.joint.replace(/_/g, ' ')}. Drainage types that can&apos;t make this change of direction are refused with the one to use.</FieldDescription>}
    </Field>
  )
}

function SlopeForm({ segment, model, canEdit, onCommand, onError }: { segment: RunSegment; model: ModelState; canEdit: boolean; onCommand: (command: Command) => string | null; onError: (message: string | null) => void }) {
  const system = model.elements[segment.systemId]
  const plan = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y)
  const service = system?.kind === 'mep_system' ? serviceOf(system.systemKind) : null
  const has = slopeInPerFt(segment)
  const [value, setValue] = useState(has > 0 ? String(Math.round(has * 1000) / 1000) : '')
  if (system?.kind !== 'mep_system' || service !== 'drainage' || plan < 1 || has > 1.001) return null
  const need = minSlopeFor(nominalInOf(segment.size), system.design?.pipe)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v = value.trim() === '' ? undefined : Number(value)
    if (v !== undefined && !(v >= 0)) {
      onError('Enter the fall in inches per foot, for example 0.25.')
      return
    }
    onError(onCommand({ type: 'set_slope', segmentId: segment.id, ...(v !== undefined ? { inPerFt: v } : {}) }))
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="pipe-slope">
      <Field>
        <FieldLabel htmlFor="bm-pipe-slope">Slope (in per ft)</FieldLabel>
        <Input id="bm-pipe-slope" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit} placeholder={String(need)} />
        <FieldDescription>
          Now {inPerFtLabel(has)}; this system needs at least {inPerFtLabel(need)}. Empty uses the minimum. The far end moves and what is connected follows.
        </FieldDescription>
      </Field>
      <Button type="submit" size="sm" disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE}>
        Set slope
      </Button>
    </form>
  )
}
