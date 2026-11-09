'use client'

import { useState } from 'react'
import {
  fittingFamilies,
  familyMismatch,
  type Command,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from '@permitzip/bim-kernel'
import {
  PA_PER_IN_WC,
  PressureEngine,
  type FittingPressure,
  type SegmentPressure,
} from '../../contracts/building-model/air-pressure'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'

/** One engine for the panel: a system's report is reused until one of its elements changes. */
const engine = new PressureEngine()

const wc = (pa: number) => `${(pa / PA_PER_IN_WC).toFixed(3)} in. w.c.`
const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"

interface Props {
  element: RunSegment | RunFitting
  model: ModelState
  canEdit: boolean
  actorName: string
  onCommand: (command: Command) => string | null
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

/** Velocity, friction and loss for a routed duct piece; C with its source and an override for fittings; the system's fan pressure. */
export function RunPressure({ element: el, model, canEdit, actorName, onCommand }: Props) {
  if (el.domain !== 'duct') return null
  const report = engine.report(model, el.systemId, el.id)
  if (!report) return null
  if (!report.calculable) {
    return <FieldDescription data-testid="run-pressure-unavailable">{report.reason}</FieldDescription>
  }
  const mine = report.elements[el.id]
  return (
    <div className="flex flex-col gap-3" data-testid="run-pressure">
      <Separator />
      <span className="text-sm font-medium">Pressure</span>
      {mine?.kind === 'segment' && <SegmentRows p={mine} />}
      {mine?.kind === 'fitting' && el.kind === 'run_fitting' && <FittingRows p={mine} fitting={el} model={model} canEdit={canEdit} actorName={actorName} onCommand={onCommand} />}
      {!mine && <FieldDescription>Not on a path from the fan, so no air flows through it.</FieldDescription>}
      <Rows
        rows={[
          [`${report.systemName}: fan needs`, `${wc(report.requiredEspPa)} external static`],
          ['Critical path', `${report.criticalPath.length} pieces, to ${report.criticalPath[report.criticalPath.length - 1]?.label ?? 'nothing yet'}`],
        ]}
      />
      {report.warnings.map((w) => (
        <FieldDescription key={w} className="text-warning-700" role="status">
          {w}
        </FieldDescription>
      ))}
    </div>
  )
}

function SegmentRows({ p }: { p: SegmentPressure }) {
  return (
    <Rows
      rows={[
        ['Airflow', `${Math.round(p.flowCfm)} CFM`],
        ['Velocity', `${Math.round(p.velocityFpm)} fpm`],
        ['Friction rate', `${p.frictionRateInPer100Ft.toFixed(3)} in. w.c. / 100 ft`],
        ['Straight length', `${(p.straightLengthMm / 304.8).toFixed(2)} ft`],
        ['Loss', wc(p.lossPa)],
      ]}
    />
  )
}

function FittingRows({ p, fitting, model, canEdit, actorName, onCommand }: { p: FittingPressure; fitting: RunFitting; model: ModelState; canEdit: boolean; actorName: string; onCommand: (command: Command) => string | null }) {
  const [error, setError] = useState<string | null>(null)
  const host = fitting.host ? model.elements[fitting.host.segmentId] : undefined
  const choices = fittingFamilies().filter(
    (f) =>
      familyMismatch(f, {
        fittingType: fitting.fittingType,
        domain: fitting.domain,
        sizes: fitting.ports.map((q) => q.size),
        ...(fitting.angleDeg !== undefined ? { angleDeg: fitting.angleDeg } : {}),
        ...(host?.kind === 'run_segment' ? { main: host.size } : {}),
      }) === null,
  )
  const swap = (family: string) => setError(onCommand({ type: 'swap_fitting', fittingId: fitting.id, family }))
  return (
    <div className="flex flex-col gap-2">
      <Field>
        <FieldLabel htmlFor="bm-fitting-type">Fitting type</FieldLabel>
        <Select value={p.familyId ?? undefined} onValueChange={swap} disabled={!canEdit || choices.length < 2}>
          <SelectTrigger id="bm-fitting-type" data-testid="fitting-type" title={canEdit ? undefined : NOT_LIVE}>
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
        {p.defaultedFamily && <FieldDescription>Shown as the system&apos;s default; choosing a type records it on this fitting.</FieldDescription>}
      </Field>
      {p.paths.map((path) => (
        <div key={path.role} className="flex flex-col gap-1" data-testid={`fitting-path-${path.role}`}>
          <Rows
            rows={[
              [p.paths.length > 1 ? `${path.role === 'branch' ? 'Branch' : 'Straight through'}: C` : 'Loss coefficient C', `${path.c.toFixed(3)} on the ${path.reference === 'small_end' ? 'small end' : path.reference === 'upstream' ? 'upstream' : path.reference === 'branch' ? 'branch' : 'fitting'}'s velocity pressure`],
              ['Velocity', `${Math.round(path.velocityFpm)} fpm (${Math.round(path.flowCfm)} CFM)`],
              ['Loss', wc(path.lossPa)],
            ]}
          />
          <Badge variant={path.verify ? 'outline' : 'secondary'} className="w-fit" title={path.method}>
            {path.source.label}
          </Badge>
        </div>
      ))}
      {p.paths.length > 0 && <OverrideForm key={`${fitting.id}:${fitting.coefficientOverride?.c ?? 'none'}`} fitting={fitting} roles={p.paths.map((x) => x.role)} canEdit={canEdit} actorName={actorName} onCommand={onCommand} onError={setError} />}
      {error && (
        <FieldDescription className="text-danger-600" role="alert" data-testid="fitting-error">
          {error}
        </FieldDescription>
      )}
    </div>
  )
}

function OverrideForm({ fitting, roles, canEdit, actorName, onCommand, onError }: { fitting: RunFitting; roles: readonly ('body' | 'branch' | 'main')[]; canEdit: boolean; actorName: string; onCommand: (command: Command) => string | null; onError: (message: string | null) => void }) {
  const current = fitting.coefficientOverride
  const role = current?.role ?? roles[0] ?? 'body'
  const [value, setValue] = useState(current ? String(current.c) : '')
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const c = Number(value)
    if (value.trim() === '' || !Number.isFinite(c) || c < 0) {
      onError('Enter a loss coefficient of 0 or more.')
      return
    }
    onError(onCommand({ type: 'set_fitting_coefficient', fittingId: fitting.id, role, c, by: actorName, at: new Date().toISOString() }))
  }
  const clear = () => onError(onCommand({ type: 'set_fitting_coefficient', fittingId: fitting.id, role, c: null, by: actorName, at: new Date().toISOString() }))
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid="fitting-override">
      <Field>
        <FieldLabel htmlFor="bm-fitting-c">Engineer&apos;s C{roles.length > 1 ? ` (${role === 'branch' ? 'branch' : 'straight through'})` : ''}</FieldLabel>
        <Input id="bm-fitting-c" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!canEdit} placeholder="Leave empty to use the source above" />
        {current && <FieldDescription>Set by {current.by} on {current.at.slice(0, 10)}.</FieldDescription>}
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE}>
          Use this C
        </Button>
        {current && (
          <Button type="button" size="sm" variant="outline" disabled={!canEdit} onClick={clear}>
            Clear
          </Button>
        )}
      </div>
    </form>
  )
}
