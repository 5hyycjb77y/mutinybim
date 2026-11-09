'use client'

import { useState } from 'react'
import {
  COMMON_INSULATION_THICKNESS_IN,
  ductAirway,
  ductOuterSize,
  insulationLabel,
  linerSurface,
  sameInsulation,
  sameSize,
  sizeLabel,
  type Command,
  type DuctInsulation,
  type LinerSurface,
  type ModelState,
  type RunFitting,
  type RunSegment,
  type RunSize,
} from '@permitzip/bim-kernel'
import {
  ductPerformance,
  sizingCriteriaFor,
  suggestDuctSize,
} from '@permitzip/bim-pack-mechanical'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { MM_PER_IN } from '../placement'

type Kind = 'none' | 'wrap' | 'liner'
type Scope = 'piece' | 'run' | 'system'

const NOT_LIVE = "Live editing isn't connected, so changes can't be saved"
const inches = (mm: number) => String(Math.round((mm / MM_PER_IN) * 1000) / 1000)

interface Props {
  element: RunSegment | RunFitting
  model: ModelState
  canEdit: boolean
  onCommand: (command: Command) => string | null
  onResize: (segmentId: string, size: RunSize) => string | null
}

/** Duct pieces: insulation or liner (with what it does to the inside and outside size), and a size from the airflow the piece carries. */
export function RunDuctDesign({ element: el, model, canEdit, onCommand, onResize }: Props) {
  if (el.domain !== 'duct') return null
  return <DuctDesignForm key={`${el.id}:${el.version}`} element={el} model={model} canEdit={canEdit} onCommand={onCommand} onResize={onResize} />
}

function DuctDesignForm({ element: el, model, canEdit, onCommand, onResize }: Props) {
  const system = model.elements[el.systemId]
  const mep = system?.kind === 'mep_system' ? system : null
  const current = el.insulation
  const [kind, setKind] = useState<Kind>(current?.kind ?? 'none')
  const [thicknessIn, setThicknessIn] = useState(current ? inches(current.thicknessMm) : '1')
  const [surface, setSurface] = useState<LinerSurface>(linerSurface(current) ?? 'faced')
  const [scope, setScope] = useState<Scope>('run')
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const chosen: DuctInsulation | undefined = kind === 'none' ? undefined : { kind, thicknessMm: Math.round(Number(thicknessIn) * MM_PER_IN * 1000) / 1000, ...(kind === 'liner' && surface === 'spray_coated' ? { surface } : {}) }
  const size = el.kind === 'run_segment' ? el.size : el.ports[0]?.size
  const thicknessOptions = [...new Set([...COMMON_INSULATION_THICKNESS_IN.map(String), thicknessIn])]

  const rows: [string, string][] = [['Insulation', insulationLabel(current)]]
  if (current && size) rows.push(['Inside', sizeLabel(ductAirway(size, current))], ['Outside', sizeLabel(ductOuterSize(size, current))])

  const report = (err: string | null, ok: string) => setMessage(err ? { error: true, text: err } : { error: false, text: ok })
  const apply = () => report(onCommand({ type: 'set_run_insulation', elementId: el.id, insulation: chosen ?? null, scope }), `${insulationLabel(chosen)} applied.`)
  const isDefault = sameInsulation(mep?.design?.insulation, chosen)
  const makeDefault = () => mep && report(onCommand({ type: 'set_system_design', systemId: mep.id, design: { insulation: chosen ?? null } }), `New ${mep.name} runs get ${insulationLabel(chosen).toLowerCase()}.`)

  // A size from what the segment carries (airflow is derived from the air devices it reaches).
  const seg = el.kind === 'run_segment' ? el : null
  const perf = seg && seg.flow > 0 ? ductPerformance(seg.flow, seg.size, current, mep?.design) : null
  const criteria = mep ? sizingCriteriaFor(mep.systemKind, mep.design) : null
  const shape = seg?.size.shape === 'round' ? 'round' : seg?.size.shape === 'rect' ? 'rect' : null
  const suggestion = seg && perf && criteria && shape ? suggestDuctSize({ cfm: seg.flow, shape, criteria, ...(current ? { insulation: current } : {}), ...(mep?.design ? { design: mep.design } : {}), ...(seg.size.shape === 'rect' ? { holdHeightMm: seg.size.height } : {}) }) : null
  const suggested = suggestion?.ok ? (suggestion.atHeight ?? suggestion.best) : null

  return (
    <div className="flex flex-col gap-2" data-testid="run-duct-design">
      <Separator />
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
      <Field>
        <FieldLabel htmlFor="bm-run-insulation">Change insulation</FieldLabel>
        <div className="flex items-center gap-2">
          <ToggleGroup id="bm-run-insulation" type="single" variant="outline" size="sm" value={kind} onValueChange={(v) => (v === 'none' || v === 'wrap' || v === 'liner') && setKind(v)} aria-label="Insulation" disabled={!canEdit}>
            <ToggleGroupItem value="none">None</ToggleGroupItem>
            <ToggleGroupItem value="wrap">Wrap</ToggleGroupItem>
            <ToggleGroupItem value="liner">Liner</ToggleGroupItem>
          </ToggleGroup>
          <Select value={thicknessIn} onValueChange={setThicknessIn} disabled={!canEdit || kind === 'none'}>
            <SelectTrigger size="sm" aria-label="Insulation thickness">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {thicknessOptions.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace('.5', '½')}&quot;
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {kind === 'liner' && (
          <ToggleGroup type="single" variant="outline" size="sm" value={surface} onValueChange={(v) => (v === 'faced' || v === 'spray_coated') && setSurface(v)} aria-label="Liner surface" disabled={!canEdit} data-testid="run-liner-surface">
            <ToggleGroupItem value="faced">Faced</ToggleGroupItem>
            <ToggleGroupItem value="spray_coated">Spray-coated</ToggleGroupItem>
          </ToggleGroup>
        )}
        <ToggleGroup type="single" variant="outline" size="sm" value={scope} onValueChange={(v) => (v === 'piece' || v === 'run' || v === 'system') && setScope(v)} aria-label="Apply to" disabled={!canEdit}>
          <ToggleGroupItem value="piece">This piece</ToggleGroupItem>
          <ToggleGroupItem value="run">This run</ToggleGroupItem>
          <ToggleGroupItem value="system">Whole system</ToggleGroupItem>
        </ToggleGroup>
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" onClick={apply} disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE} data-testid="run-insulation-apply">
            Apply
          </Button>
          <Button size="sm" variant="outline" onClick={makeDefault} disabled={!canEdit || !mep || isDefault} title={!canEdit ? NOT_LIVE : isDefault ? `This is already ${mep?.name ?? 'the system'}'s default` : undefined} data-testid="run-insulation-default">
            Make system default
          </Button>
        </div>
        {message && (
          <FieldDescription className={message.error ? 'text-danger-600' : 'text-success-700'} role={message.error ? 'alert' : 'status'} data-testid="run-insulation-message">
            {message.text}
          </FieldDescription>
        )}
        <FieldDescription>
          A run stops at transitions and branches. Fittings take the insulation of the duct they join. {mep ? `${mep.name}'s default: ${insulationLabel(mep.design?.insulation).replace('No insulation', 'none')}.` : ''}
        </FieldDescription>
      </Field>
      {seg && perf && (
        <Field data-testid="run-airflow-sizing">
          <FieldLabel>Airflow</FieldLabel>
          <FieldDescription>
            Carries {Math.round(seg.flow).toLocaleString('en-US')} CFM: {Math.round(perf.velocityFpm).toLocaleString('en-US')} fpm, {Math.round(perf.frictionInPer100Ft * 1000) / 1000}&quot; per 100 ft{current?.kind === 'liner' ? ` through ${sizeLabel(perf.airway)} inside` : ''}.
          </FieldDescription>
          {suggestion && !suggestion.ok && <FieldDescription className="text-danger-600">{suggestion.reason}.</FieldDescription>}
          {suggested && !sameSize(suggested.size, seg.size) && (
            <Button size="sm" variant="outline" disabled={!canEdit} title={canEdit ? undefined : NOT_LIVE} onClick={() => report(onResize(seg.id, suggested.size), `Resized to ${sizeLabel(suggested.size)}.`)} data-testid="run-size-accept">
              Resize to {sizeLabel(suggested.size)} ({Math.round(suggested.velocityFpm).toLocaleString('en-US')} fpm, {Math.round(suggested.frictionInPer100Ft * 1000) / 1000}&quot;)
            </Button>
          )}
          {suggested && sameSize(suggested.size, seg.size) && <FieldDescription>This is the size its airflow calls for.</FieldDescription>}
        </Field>
      )}
    </div>
  )
}
