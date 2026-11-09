'use client'

import { Check } from 'lucide-react'
import {
  COMMON_INSULATION_THICKNESS_IN,
  insulationLabel,
  linerSurface,
  sameSize,
  sizeLabel,
  type DuctInsulation,
  type LinerSurface,
  type RunSize,
} from '@permitzip/bim-kernel'
import {
  ductPerformance,
  sizingCriteriaFor,
  suggestDuctSize,
  type DuctSizeOption,
} from '@permitzip/bim-pack-mechanical'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { ExistingSystem, RouteChoices } from '../RoutePanel'
import { inches, mm, routeInsulationChoice, routeSystemDesign } from '../route-design'

function fpm(v: number) {
  return `${Math.round(v).toLocaleString('en-US')} fpm`
}

function friction(v: number) {
  return `${Math.round(v * 1000) / 1000}" per 100 ft`
}

interface Props {
  choices: RouteChoices
  /** The size the panel describes now, or why it doesn't describe one. */
  size: RunSize | string
  systems: readonly ExistingSystem[]
  onChange: (patch: Partial<RouteChoices>) => void
}

/** Duct only: insulation or liner for the route, and an airflow that suggests a size. */
export function RouteDuctDesignFields({ choices, size, systems, onChange }: Props) {
  const sys = routeSystemDesign(choices.system, systems)
  const fallback = sys.design?.insulation
  const kind = choices.insulation === 'default' ? (fallback?.kind ?? 'none') : choices.insulation
  const thicknessIn = choices.insulation === 'default' && fallback ? inches(fallback.thicknessMm) : choices.insulationIn
  const surface: LinerSurface = choices.insulation === 'default' ? (linerSurface(fallback) ?? 'faced') : choices.linerSurface
  const asked = routeInsulationChoice(choices)
  const insulation: DuctInsulation | undefined = asked === undefined ? fallback : (asked ?? undefined)
  const thicknessOptions = [...new Set([...COMMON_INSULATION_THICKNESS_IN.map(String), thicknessIn])]
  const who = sys.name ?? (sys.kind ? 'A new system' : 'This system')

  const cfm = Number(choices.airflowCfm)
  const hasAirflow = choices.airflowCfm.trim() !== '' && Number.isFinite(cfm) && cfm > 0
  const criteria = sys.kind ? sizingCriteriaFor(sys.kind, sys.design) : null
  const holdHeightMm = choices.shape === 'rect' && Number(choices.heightIn) > 0 ? mm(Number(choices.heightIn)) : undefined
  const suggestion = hasAirflow && criteria ? suggestDuctSize({ cfm, shape: choices.shape, criteria, ...(insulation ? { insulation } : {}), ...(sys.design ? { design: sys.design } : {}), ...(holdHeightMm ? { holdHeightMm } : {}) }) : null
  const current = hasAirflow && typeof size !== 'string' ? ductPerformance(cfm, size, insulation, sys.design) : null
  const over = current && criteria ? [current.frictionInPer100Ft > criteria.frictionInPer100Ft + 1e-9 ? `over ${friction(criteria.frictionInPer100Ft)}` : null, current.velocityFpm > criteria.maxVelocityFpm + 1e-9 ? `over ${fpm(criteria.maxVelocityFpm)}` : null].filter((x): x is string => x !== null) : []

  const use = (o: DuctSizeOption) => {
    const s = o.size
    if (s.shape === 'rect') onChange({ widthIn: inches(s.width), heightIn: inches(s.height) })
    else if (s.shape === 'round') onChange({ diameterIn: inches(s.diameter) })
  }
  const inUse = (o: DuctSizeOption) => typeof size !== 'string' && sameSize(size, o.size)
  const primary = suggestion?.ok ? (suggestion.atHeight ?? suggestion.best) : null
  const leastMetal = suggestion?.ok && suggestion.atHeight && !sameSize(suggestion.atHeight.size, suggestion.best.size) ? suggestion.best : null

  return (
    <FieldGroup className="flex flex-col gap-2" data-testid="route-duct-design">
      <Field>
        <FieldLabel htmlFor="bm-route-insulation">Insulation</FieldLabel>
        <div className="flex items-center gap-2">
          <ToggleGroup
            id="bm-route-insulation"
            type="single"
            variant="outline"
            size="sm"
            value={kind}
            onValueChange={(v) => (v === 'none' || v === 'wrap' || v === 'liner') && onChange({ insulation: v, insulationIn: thicknessIn, linerSurface: surface })}
            aria-label="Insulation"
            data-testid="route-insulation"
          >
            <ToggleGroupItem value="none">None</ToggleGroupItem>
            <ToggleGroupItem value="wrap">Wrap</ToggleGroupItem>
            <ToggleGroupItem value="liner">Liner</ToggleGroupItem>
          </ToggleGroup>
          <Select value={thicknessIn} onValueChange={(v) => onChange({ insulation: kind, insulationIn: v, linerSurface: surface })} disabled={kind === 'none'}>
            <SelectTrigger size="sm" aria-label="Insulation thickness" data-testid="route-insulation-thickness">
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
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={surface}
            onValueChange={(v) => (v === 'faced' || v === 'spray_coated') && onChange({ insulation: 'liner', insulationIn: thicknessIn, linerSurface: v })}
            aria-label="Liner surface"
            data-testid="route-liner-surface"
          >
            <ToggleGroupItem value="faced">Faced</ToggleGroupItem>
            <ToggleGroupItem value="spray_coated">Spray-coated</ToggleGroupItem>
          </ToggleGroup>
        )}
        <FieldDescription data-testid="route-insulation-note">
          {choices.insulation === 'default'
            ? `${who}'s default: ${insulationLabel(fallback).replace('No insulation', 'none')}.${sys.isNew ? ' A new system keeps its first route’s choice as its default.' : ''}`
            : `This route only${sys.isNew ? ', and the new system’s default' : ''}. Liner sits inside the size above and narrows the airway (spray-coated is rougher than faced); wrap goes outside it.`}
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="bm-route-cfm">Airflow (CFM)</FieldLabel>
        <Input id="bm-route-cfm" inputMode="numeric" placeholder="Size from airflow" value={choices.airflowCfm} onChange={(e) => onChange({ airflowCfm: e.target.value })} data-testid="route-airflow" />
        {choices.airflowCfm.trim() !== '' && !hasAirflow && (
          <FieldDescription className="text-danger-600" role="alert">
            Enter the airflow as a number of CFM.
          </FieldDescription>
        )}
        {suggestion && !suggestion.ok && (
          <FieldDescription className="text-danger-600" role="alert" data-testid="route-size-refused">
            {suggestion.reason}.
          </FieldDescription>
        )}
        {primary && (
          <div className="flex flex-col gap-1" data-testid="route-size-suggestion">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">
                Suggested <span className="font-medium">{sizeLabel(primary.size)}</span>: {fpm(primary.velocityFpm)}, {friction(primary.frictionInPer100Ft)}
              </span>
              <Button size="sm" variant={inUse(primary) ? 'ghost' : 'outline'} disabled={inUse(primary)} onClick={() => use(primary)} data-testid="route-size-accept">
                {inUse(primary) ? (
                  <>
                    <Check data-icon="inline-start" />
                    In use
                  </>
                ) : (
                  `Use ${sizeLabel(primary.size)}`
                )}
              </Button>
            </div>
            {leastMetal && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => use(leastMetal)} data-testid="route-size-least-metal">
                Or {sizeLabel(leastMetal.size)}, the least sheet metal
              </Button>
            )}
          </div>
        )}
        {current && typeof size !== 'string' && (
          <FieldDescription className={over.length > 0 ? 'text-warning-700' : undefined} data-testid="route-size-readout">
            At {sizeLabel(size)}{insulation?.kind === 'liner' ? ` (${sizeLabel(current.airway)} inside)` : ''}: {fpm(current.velocityFpm)}, {friction(current.frictionInPer100Ft)}
            {over.length > 0 ? `, ${over.join(' and ')}` : ''}.
          </FieldDescription>
        )}
        {criteria && (
          <FieldDescription>
            Sizes aim for {friction(criteria.frictionInPer100Ft)} or less and {fpm(criteria.maxVelocityFpm)} at most{choices.shape === 'rect' ? `, up to ${criteria.maxAspectRatio}:1` : ''}
            {criteria.typical.length > 0 ? ' (typical values; verify for the project)' : ''}. Nothing resizes until you choose a size.
          </FieldDescription>
        )}
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="bm-route-last-flex" checked={choices.lastStretchFlex === true} onCheckedChange={(v) => onChange({ lastStretchFlex: v === true })} data-testid="route-last-stretch-flex" />
        <FieldLabel htmlFor="bm-route-last-flex" className="font-normal">
          Finish with flex into the diffuser or grille
        </FieldLabel>
      </Field>
      <FieldDescription>When the route ends on a diffuser, grille or unit, the stretch from your last click into its neck is flex (6 ft or less is typical). Off: rigid duct all the way.</FieldDescription>
    </FieldGroup>
  )
}
