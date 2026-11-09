'use client'

import { Check, CircleAlert, Pipette, X } from 'lucide-react'
import { fittingFamilies, defaultPipeSpec, inPerFtLabel, isGravity, isStoredPipeSpec, minSlopeFor, pipeProducts, pipeTurnAngles, runSlopeAngles, type FittingChoice, type FittingSlot, type Level, type PipeMaterial, type PipeSpecId, type RunSize, type SystemDesign, type SystemKind } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { MM_PER_IN } from './placement'
import { DEFAULT_ROUTE_DUCT_DESIGN, type RouteDuctDesign } from './route-design'
import { RouteSections } from './contributions/route-sections'
import { RouteDefaultsControl } from './RouteDefaultsControl'
import { proposedSystemName } from './system-name'
import type { RouteDefaultsApi } from './use-route-defaults'
import { SLOPE_CHOICES, systemKindOfChoice } from './route-slope'
import { CLOSES_AT_ONCE } from './menu-close'
import { AddLevel } from './PartsPanel'
import { RISE_STYLES, isRiseStyle, riseStyleLabel, riseStylesFor, type RiseStyle } from './route-rise'

export type RouteKind = 'duct' | 'pipe'
export type DuctShape = 'rect' | 'round'

/** The Route tool's choices, as typed (strings until they parse). */
export interface RouteChoices extends RouteDuctDesign {
  readonly kind: RouteKind
  /** An existing system id, or `new:<kind>` for a new one. */
  readonly system: string
  readonly shape: DuctShape
  readonly widthIn: string
  readonly heightIn: string
  readonly diameterIn: string
  readonly nominalIn: string
  readonly material: PipeMaterial
  /** The product standard within the material ('' = the material's usual one: copper type L, PVC DWV…). */
  /** Any add-on's spec id (`pipes:open_specs`); '' = the material's default. */
  readonly pipeSpec: string
  /** Name for a new system ('' = the proposed one, "Vent 2"). */
  readonly systemName: string
  readonly elevationFt: string
  /** How a height change mid-run is made: straight, or a slope at an angle the pipe's bends come in. */
  readonly riseStyle: RiseStyle
  /** Elbow and takeoff families this route places ('' = the system's default). */
  readonly elbowFamily: string
  readonly takeoffFamily: string
  /** The pipe type drawn with (its name; '' or absent: the material picked by hand). */
  readonly pipeType?: string
  /** Drains: inches of fall per foot ('' or absent: the system's rule for the size). */
  readonly slopeInPerFt?: string
  /** Drains: which way the run falls. `auto` (absent): toward the pipe it drains into, else the way it is drawn. */
  readonly slopeDirection?: 'auto' | 'down' | 'up'
}

/** A pipe type a route can draw with, as the Route tool lists it. */
export interface RoutePipeTypeOption {
  readonly name: string
  readonly description?: string
}

/**
 * Pipe types for the Route tool, from the add-on that owns them (absent: the
 * person picks the material by hand). Which type a system takes, its sizes,
 * bends and fittings are that add-on's rules; the Route tool only shows them.
 */
export interface RoutePipeTypes {
  /** Where the types are edited, in the add-on's words. */
  readonly home: string
  /** `next` (a system just chosen, of `kind`; `prevKind` before it) with that system's pipe type, material and a size it comes in. */
  forSystem(next: RouteChoices, prevKind: SystemKind | null, kind: SystemKind | null): RouteChoices
  typesFor(kind: SystemKind): readonly RoutePipeTypeOption[]
  chosen(c: RouteChoices): RoutePipeTypeOption | null
  /** The choices drawing with the type named `name`, keeping the size when it comes in it; null when no such type carries `kind`. */
  withType(c: RouteChoices, name: string, kind: SystemKind): RouteChoices | null
  /** The bend angles (degrees) the chosen type comes in for `kind`, smallest first; empty with no type. */
  bendAngles(c: RouteChoices, kind: SystemKind): readonly number[]
  /** Fittings the chosen type places over its material's defaults. */
  fittings(c: RouteChoices): Partial<Record<FittingSlot, FittingChoice>>
}

export const DEFAULT_ROUTE: RouteChoices = {
  ...DEFAULT_ROUTE_DUCT_DESIGN,
  kind: 'duct',
  system: 'new:supply_air',
  shape: 'rect',
  widthIn: '14',
  heightIn: '10',
  diameterIn: '8',
  nominalIn: '1',
  material: 'copper',
  pipeSpec: '',
  systemName: '',
  elevationFt: '10',
  riseStyle: 'vertical',
  elbowFamily: '',
  takeoffFamily: '',
}

const SYSTEM_DEFAULT = 'default'
const BY_MATERIAL = '__by_material__'

function angleText(a: number): string {
  return a === 22.5 ? '22½°' : `${a}°`
}

/** The slope the system's rule gives this size, in words. */
function systemSlopeText(c: RouteChoices, kind: SystemKind, systems: readonly ExistingSystem[]): string {
  const n = Number(c.nominalIn)
  if (!Number.isFinite(n) || n <= 0) return 'by size'
  return inPerFtLabel(minSlopeFor(n, systems.find((s) => s.id === c.system && s.kind === kind)?.design?.pipe))
}

/** Elbow families the library makes for this duct shape. */
export function elbowFamiliesFor(c: RouteChoices) {
  return c.kind === 'duct' ? fittingFamilies().filter((f) => f.domain === 'duct' && f.fittingTypes.includes('elbow') && f.shapes.includes(c.shape)) : []
}

/** Takeoff (tap, tee, wye) families for a branch of this shape. */
export function takeoffFamiliesFor(c: RouteChoices) {
  return c.kind === 'duct' ? fittingFamilies().filter((f) => f.domain === 'duct' && (f.fittingTypes.includes('tap') || f.fittingTypes.includes('tee') || f.fittingTypes.includes('wye')) && f.shapes.includes(c.shape)) : []
}

/** The fittings the route asks for over its system's defaults: the elbow and takeoff picks, or the chosen pipe type's own fittings. */
export function routeFittings(c: RouteChoices, pipeTypes: RoutePipeTypes | null = null): Partial<Record<FittingSlot, FittingChoice>> {
  const out: Partial<Record<FittingSlot, FittingChoice>> = {}
  if (c.kind === 'pipe') return pipeTypes?.fittings(c) ?? out
  if (c.kind !== 'duct') return out
  if (c.elbowFamily && elbowFamiliesFor(c).some((f) => f.id === c.elbowFamily)) out[c.shape === 'round' ? 'elbow_round' : 'elbow_rect'] = { family: c.elbowFamily }
  if (c.takeoffFamily && takeoffFamiliesFor(c).some((f) => f.id === c.takeoffFamily)) out[c.shape === 'round' ? 'branch_round' : 'branch_rect'] = { family: c.takeoffFamily }
  return out
}

const DUCT_SYSTEMS: readonly { kind: SystemKind; label: string }[] = [
  { kind: 'supply_air', label: 'Supply air' },
  { kind: 'return_air', label: 'Return air' },
  { kind: 'exhaust_air', label: 'Exhaust air' },
  { kind: 'outside_air', label: 'Outside air' },
]
const PIPE_SYSTEMS: readonly { kind: SystemKind; label: string }[] = [
  { kind: 'domestic_cold_water', label: 'Domestic cold water' },
  { kind: 'domestic_hot_water', label: 'Domestic hot water' },
  { kind: 'sanitary', label: 'Sanitary' },
  { kind: 'vent', label: 'Vent' },
  { kind: 'grease_waste', label: 'Grease waste' },
  { kind: 'indirect_waste', label: 'Indirect waste' },
  { kind: 'storm', label: 'Storm' },
  { kind: 'hydronic_supply', label: 'Hydronic supply' },
  { kind: 'hydronic_return', label: 'Hydronic return' },
  { kind: 'natural_gas', label: 'Natural gas' },
]
const MATERIAL_LABEL: Readonly<Record<PipeMaterial, string>> = {
  copper: 'Copper',
  pex: 'PEX',
  cpvc: 'CPVC',
  pp_r: 'PP-R',
  pvc: 'PVC',
  abs: 'ABS',
  cast_iron: 'Cast iron',
  black_steel: 'Black steel',
  steel: 'Steel',
  galvanized: 'Galvanized steel',
  csst: 'CSST',
  pe: 'Polyethylene (PE)',
}

/** Every pipe product the add-ons here make, by material: each product standard is its own choice. */
export function pipeMaterialChoices(): readonly { material: PipeMaterial; label: string; specs: readonly { value: string; spec: PipeSpecId; label: string }[] }[] {
  const products = pipeProducts()
  return (Object.keys(MATERIAL_LABEL) as PipeMaterial[]).map((material) => ({
    material,
    label: MATERIAL_LABEL[material],
    specs: products.filter((s) => s.materialId === material).flatMap((s) => (isStoredPipeSpec(s.spec) ? [{ value: `${material}:${s.spec}`, spec: s.spec, label: `${s.name} (${s.standard})` }] : [])),
  }))
}

function materialValue(c: Pick<RouteChoices, 'material' | 'pipeSpec'>): string {
  return `${c.material}:${c.pipeSpec || defaultPipeSpec(c.material) || ''}`
}

function fromMaterialValue(v: string): Pick<RouteChoices, 'material' | 'pipeSpec'> | null {
  for (const m of pipeMaterialChoices()) {
    const hit = m.specs.find((s) => s.value === v)
    if (hit) return { material: m.material, pipeSpec: hit.spec === defaultPipeSpec(m.material) ? '' : hit.spec }
  }
  return null
}


export interface ExistingSystem {
  readonly id: string
  readonly name: string
  readonly kind: SystemKind
  readonly domain: string
  readonly design?: SystemDesign
}

/** The size the choices describe, or the plain reason they don't describe one. */
export function routeSize(c: RouteChoices): RunSize | string {
  const n = (s: string) => Number(s)
  const mm = (inches: number) => Math.round(inches * MM_PER_IN * 1000) / 1000
  if (c.kind === 'pipe') {
    const v = n(c.nominalIn)
    return Number.isFinite(v) && v > 0 ? { shape: 'pipe', nominalMm: mm(v), material: c.material, ...(c.pipeSpec ? { spec: c.pipeSpec } : {}) } : 'Give the pipe size in inches.'
  }
  if (c.shape === 'round') {
    const d = n(c.diameterIn)
    return Number.isFinite(d) && d > 0 ? { shape: 'round', diameter: mm(d) } : 'Give the duct diameter in inches.'
  }
  const w = n(c.widthIn)
  const h = n(c.heightIn)
  return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { shape: 'rect', width: mm(w), height: mm(h) } : 'Give the duct width and height in inches.'
}

export function systemKindsFor(kind: RouteKind): readonly { kind: SystemKind; label: string }[] {
  return kind === 'duct' ? DUCT_SYSTEMS : PIPE_SYSTEMS
}

interface Props {
  choices: RouteChoices
  onChange: (next: RouteChoices) => void
  systems: readonly ExistingSystem[]
  levels: readonly Level[]
  levelId: string | null
  onLevel: (levelId: string) => void
  /** Points clicked so far on the route being drawn (0 when none). */
  pointCount: number
  /** Why Finish can't be pressed (null when it can). */
  finishBlocked: string | null
  onFinish: () => void
  onStop: () => void
  /** The person's saved defaults (absent: the control isn't shown, e.g. in tests). */
  myDefaults?: RouteDefaultsApi
  /** Where the route being drawn meets a rule (a rated wall, a ceiling), in the add-on's words, leg by leg; empty or absent: nothing to say. */
  checks?: readonly RouteCheckLine[]
  /** The project's pipe types: a system's own type is loaded when it is chosen. Absent: the material is picked by hand. */
  pipeTypes?: RoutePipeTypes | null
  /** Inherit: the next click on a pipe, a fitting or a part's connector sets the height, size, system and slope. */
  inheritArmed?: boolean
  onInherit?: () => void
  /** No level yet: add one right here (returns the refusal, or null). Absent: only the level list says so. */
  onAddLevel?: (name: string, elevationMm: number) => string | null
  onUseArchitectLevels?: () => void
}

/** One place the route being drawn meets a rule, as the preview reports it. */
export interface RouteCheckLine {
  readonly key: string
  readonly message: string
}

/** Left panel while the Route tool is on: what to route (duct or pipe), its system, size and height, on which level. */
export function RoutePanel({ choices, onChange, systems, levels, levelId, onLevel, pointCount, finishBlocked, onFinish, onStop, myDefaults, checks, pipeTypes = null, inheritArmed = false, onInherit, onAddLevel, onUseArchitectLevels }: Props) {
  const set = (patch: Partial<RouteChoices>) => onChange({ ...choices, ...patch })
  const kinds = systemKindsFor(choices.kind)
  const kindNow = systemKindOfChoice(choices.system, systems, kinds)
  // A new system loads its pipe type, material and a size it comes in (an existing system keeps its pipe's material).
  const chooseSystem = (next: RouteChoices) => {
    const nextKind = systemKindOfChoice(next.system, systems, systemKindsFor(next.kind))
    onChange(pipeTypes ? pipeTypes.forSystem(next, next.kind === choices.kind ? kindNow : null, nextKind) : next)
  }
  const typesHere = pipeTypes && choices.kind === 'pipe' && kindNow ? pipeTypes.typesFor(kindNow) : []
  const typeNow = pipeTypes?.chosen(choices) ?? null
  const gravity = choices.kind === 'pipe' && kindNow !== null && isGravity(kindNow)
  const angles = pipeTypes && typeNow && kindNow ? pipeTypes.bendAngles(choices, kindNow) : []
  const mine = systems.filter((s) => s.domain === choices.kind)
  const size = routeSize(choices)
  // The turns the route will take: the kernel reads them from the fitting families for this system and pipe.
  const turnAngles = choices.kind === 'pipe' && kindNow && typeof size !== 'string' && size.shape === 'pipe' ? pipeTurnAngles(kindNow, size) : angles
  const riseOffered = RISE_STYLES
  // A run other than pipe rises on the slopes its elbow families are made for, read from the families in force.
  const otherSlopes = choices.kind === 'pipe' ? [] : runSlopeAngles(choices.kind, kindNow ?? undefined, typeof size === 'string' ? undefined : size)
  const riseMade = choices.kind === 'pipe' ? riseStylesFor(turnAngles) : riseStylesFor([...otherSlopes, 90])
  const pipeName = typeNow?.name ?? 'This pipe'
  const riseWhyNot = (s: RiseStyle): string | null => (riseMade.includes(s) ? null : choices.kind === 'pipe' ? `${pipeName} has no ${riseStyleLabel(s).replace(' slope', '')} bend, so it can't rise on that slope` : `No ${choices.kind} elbow here is made for ${riseStyleLabel(s).replace(' slope', '')}, so it can't rise on that slope`)
  const riseNow = riseWhyNot(choices.riseStyle)
  const newKind = choices.system.startsWith('new:') ? (kinds.find((k) => `new:${k.kind}` === choices.system)?.kind ?? null) : null
  return (
    <div className="flex flex-col gap-3" data-testid="route-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Route {choices.kind}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Stop routing" onClick={onStop}>
          <X />
        </Button>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={choices.kind}
        onValueChange={(v) => {
          if (v !== 'duct' && v !== 'pipe') return
          const first = systemKindsFor(v)[0]?.kind ?? 'other'
          chooseSystem({ ...choices, kind: v, system: `new:${first}`, systemName: '' })
        }}
        aria-label="What to route"
      >
        <ToggleGroupItem value="duct" aria-label="Duct" data-testid="route-kind-duct">
          Duct
        </ToggleGroupItem>
        <ToggleGroupItem value="pipe" aria-label="Pipe" data-testid="route-kind-pipe">
          Pipe
        </ToggleGroupItem>
      </ToggleGroup>
      <Field>
        <FieldLabel htmlFor="bm-route-system">System</FieldLabel>
        <Select value={choices.system} onValueChange={(v) => chooseSystem({ ...choices, system: v, systemName: '' })}>
          <SelectTrigger id="bm-route-system" size="sm" data-testid="route-system">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={CLOSES_AT_ONCE}>
            {mine.length > 0 && (
              <SelectGroup>
                <SelectLabel>In this model</SelectLabel>
                {mine.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            <SelectGroup>
              <SelectLabel>New system</SelectLabel>
              {kinds.map((k) => (
                <SelectItem key={k.kind} value={`new:${k.kind}`}>
                  New {k.label.toLowerCase()}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>Starting on an existing run continues its system. Choosing a system loads its pipe type.</FieldDescription>
      </Field>
      {newKind && (
        <Field>
          <FieldLabel htmlFor="bm-route-system-name">Name of the new system</FieldLabel>
          <Input id="bm-route-system-name" value={choices.systemName} placeholder={proposedSystemName(newKind, systems)} onChange={(e) => set({ systemName: e.target.value })} data-testid="route-system-name" />
          <FieldDescription>Leave it empty for {proposedSystemName(newKind, systems)}.</FieldDescription>
        </Field>
      )}
      {choices.kind === 'duct' ? (
        <FieldGroup className="flex flex-col gap-2">
          <ToggleGroup type="single" variant="outline" size="sm" value={choices.shape} onValueChange={(v) => (v === 'rect' || v === 'round') && set({ shape: v })} aria-label="Duct shape">
            <ToggleGroupItem value="rect">Rectangular</ToggleGroupItem>
            <ToggleGroupItem value="round">Round</ToggleGroupItem>
          </ToggleGroup>
          {choices.shape === 'rect' ? (
            <div className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel htmlFor="bm-route-w">Width (in)</FieldLabel>
                <Input id="bm-route-w" inputMode="decimal" value={choices.widthIn} onChange={(e) => set({ widthIn: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="bm-route-h">Height (in)</FieldLabel>
                <Input id="bm-route-h" inputMode="decimal" value={choices.heightIn} onChange={(e) => set({ heightIn: e.target.value })} />
              </Field>
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="bm-route-d">Diameter (in)</FieldLabel>
              <Input id="bm-route-d" inputMode="decimal" value={choices.diameterIn} onChange={(e) => set({ diameterIn: e.target.value })} />
            </Field>
          )}
        </FieldGroup>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {typesHere.length > 0 && (
            <Field className="col-span-2">
              <FieldLabel htmlFor="bm-route-pipe-type">Pipe type</FieldLabel>
              <Select
                value={typeNow?.name ?? BY_MATERIAL}
                onValueChange={(v) => {
                  const next = pipeTypes && kindNow ? pipeTypes.withType(choices, v, kindNow) : null
                  if (!next) return set({ pipeType: '' })
                  onChange(next)
                }}
              >
                <SelectTrigger id="bm-route-pipe-type" size="sm" data-testid="route-pipe-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={CLOSES_AT_ONCE}>
                  <SelectGroup>
                    {typesHere.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                        {t.description ? ` — ${t.description}` : ''}
                      </SelectItem>
                    ))}
                    <SelectItem value={BY_MATERIAL}>No pipe type: pick the material</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>Fittings follow the type&apos;s material and any fitting picked on it in {pipeTypes?.home ?? 'Pipe types'}.</FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="bm-route-n">Size (in)</FieldLabel>
            <Input id="bm-route-n" inputMode="decimal" value={choices.nominalIn} onChange={(e) => set({ nominalIn: e.target.value })} />
          </Field>
          <Field className="col-span-2">
            <FieldLabel htmlFor="bm-route-mat">Material</FieldLabel>
            <Select value={materialValue(choices)} onValueChange={(v) => set({ ...(fromMaterialValue(v) ?? {}), pipeType: '' })}>
              <SelectTrigger id="bm-route-mat" size="sm" data-testid="route-material">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                {pipeMaterialChoices().map((m) => (
                  <SelectGroup key={m.material}>
                    <SelectLabel>{m.label}</SelectLabel>
                    {m.specs.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <RouteSections choices={choices} size={size} systems={systems} onChange={set} />
      {levels.length === 0 && onAddLevel && <AddLevel what="Routes" idPrefix="route-level" onAddLevel={onAddLevel} onUseArchitectLevels={onUseArchitectLevels} />}
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor="bm-route-level">Level</FieldLabel>
          <Select value={levelId ?? undefined} onValueChange={onLevel} disabled={levels.length === 0}>
            <SelectTrigger id="bm-route-level" size="sm">
              <SelectValue placeholder={levels.length === 0 ? 'No levels yet' : 'Choose'} />
            </SelectTrigger>
            <SelectContent className={CLOSES_AT_ONCE}>
              <SelectGroup>
                {levels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-route-elev">Height (ft)</FieldLabel>
          <Input id="bm-route-elev" inputMode="decimal" value={choices.elevationFt} onChange={(e) => set({ elevationFt: e.target.value })} data-testid="route-elevation" />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="bm-route-rise">Rises and drops</FieldLabel>
        <ToggleGroup id="bm-route-rise" type="single" variant="outline" size="sm" className="flex-wrap" value={choices.riseStyle} onValueChange={(v) => isRiseStyle(v) && !riseWhyNot(v) && set({ riseStyle: v })} aria-label="Rises and drops" data-testid="route-rise-style">
          {riseOffered.map((s) => {
            const why = riseWhyNot(s)
            return (
              <ToggleGroupItem key={s} value={s} disabled={why !== null} title={why ?? undefined} aria-label={why ? `${riseStyleLabel(s)}: ${why}` : riseStyleLabel(s)} data-testid={`route-rise-${s}`}>
                {riseStyleLabel(s)}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>
        {riseNow && (
          <FieldDescription className="text-destructive" data-testid="route-rise-unavailable">
            {riseNow}. Pick another slope or Straight.
          </FieldDescription>
        )}
        <FieldDescription>Change the height while drawing (or press ] and [) and the run rises or drops at the current point. In 3D, Z, Shift or the vertical line through the last point draws straight up or down.</FieldDescription>
        {angles.length > 0 && (
          <FieldDescription data-testid="route-bend-angles">
            {typeNow?.name} bends: {angles.map(angleText).join(', ')}. Turns are drawn at {turnAngles.map(angleText).join(', ')}.
          </FieldDescription>
        )}
      </Field>
      {gravity && kindNow && (
        <FieldGroup className="flex flex-col gap-2" data-testid="route-slope">
          <Field>
            <FieldLabel htmlFor="bm-route-slope">Slope</FieldLabel>
            <Select value={choices.slopeInPerFt || SYSTEM_DEFAULT} onValueChange={(v) => set({ slopeInPerFt: v === SYSTEM_DEFAULT ? '' : v })}>
              <SelectTrigger id="bm-route-slope" size="sm" data-testid="route-slope-value">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={CLOSES_AT_ONCE}>
                <SelectGroup>
                  <SelectItem value={SYSTEM_DEFAULT}>System rule ({systemSlopeText(choices, kindNow, systems)})</SelectItem>
                  {SLOPE_CHOICES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                  {choices.slopeInPerFt && !SLOPE_CHOICES.some((s) => s.value === choices.slopeInPerFt) && <SelectItem value={choices.slopeInPerFt}>{inPerFtLabel(Number(choices.slopeInPerFt))}</SelectItem>}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="bm-route-fall">Falls</FieldLabel>
            <ToggleGroup id="bm-route-fall" type="single" variant="outline" size="sm" value={choices.slopeDirection ?? 'auto'} onValueChange={(v) => (v === 'auto' || v === 'down' || v === 'up') && set({ slopeDirection: v })} aria-label="Which way the drain falls" data-testid="route-slope-direction">
              <ToggleGroupItem value="auto">Toward the main</ToggleGroupItem>
              <ToggleGroupItem value="down">Down as drawn</ToggleGroupItem>
              <ToggleGroupItem value="up">Up as drawn</ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>Toward the main: a branch falls into the pipe it joins, whichever way you draw it; a run on its own falls the way you draw it.</FieldDescription>
          </Field>
        </FieldGroup>
      )}
      {onInherit && (
        <Field>
          <Button size="sm" variant={inheritArmed ? 'default' : 'outline'} aria-pressed={inheritArmed} onClick={onInherit} data-testid="route-inherit">
            <Pipette data-icon="inline-start" />
            {inheritArmed ? 'Click a pipe, fitting or part…' : 'Inherit from a pipe or part'}
          </Button>
          <FieldDescription>Takes the height there, and the size, system and slope of what you click. Esc or press it again to stop.</FieldDescription>
        </Field>
      )}
      {choices.kind === 'duct' && (
        <div className="grid grid-cols-1 gap-2">
          <FamilySelect id="bm-route-elbow" label="Elbows" value={choices.elbowFamily} families={elbowFamiliesFor(choices)} onChange={(v) => set({ elbowFamily: v })} testId="route-elbow" />
          <FamilySelect id="bm-route-takeoff" label="Branch takeoffs" value={choices.takeoffFamily} families={takeoffFamiliesFor(choices)} onChange={(v) => set({ takeoffFamily: v })} testId="route-takeoff" />
        </div>
      )}
      {typeof size === 'string' && (
        <FieldDescription className="text-danger-600" role="alert">
          {size}
        </FieldDescription>
      )}
      {levels.length === 0 && <FieldDescription>Runs sit on a level and this model has none yet: use Add level in the message over the view, or Model › Add level.</FieldDescription>}
      {myDefaults && (
        <>
          <Separator />
          <RouteDefaultsControl choices={choices} api={myDefaults} />
        </>
      )}
      <Separator />
      {checks && checks.length > 0 && <RouteChecks checks={checks} />}
      <FieldDescription>
        Click (or press and drag) from a connector, an open end, a run or a point; click or drag to each next point; click a connector or run to finish there. Enter finishes at the last point, Esc cancels. O then click offsets around what is in the way.
      </FieldDescription>
      <Button size="sm" variant="outline" onClick={onFinish} disabled={finishBlocked !== null} title={finishBlocked ?? undefined} data-testid="route-finish">
        <Check data-icon="inline-start" />
        {pointCount > 0 ? `Finish here (${pointCount} point${pointCount === 1 ? '' : 's'})` : 'Finish here'}
      </Button>
      {finishBlocked && <FieldDescription>{finishBlocked}</FieldDescription>}
    </div>
  )
}

/** The preview's findings on the route being drawn: what each crossing needs, and what Finish does about it. */
export function RouteChecks({ checks }: { checks: readonly RouteCheckLine[] }) {
  return (
    <Alert variant="destructive" data-testid="route-checks" aria-live="polite">
      <CircleAlert />
      <AlertTitle>
        Along this route ({checks.length} {checks.length === 1 ? 'place' : 'places'})
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {checks.map((c) => (
            <li key={c.key} data-testid="route-check-line">
              {c.message}
            </li>
          ))}
        </ul>
        <p>Finish places what each crossing needs where this model has a type for it; anything else stays on the Checklist with Select and Fix. Esc cancels the route.</p>
      </AlertDescription>
    </Alert>
  )
}

function FamilySelect({ id, label, value, families, onChange, testId }: { id: string; label: string; value: string; families: readonly { id: string; name: string }[]; onChange: (v: string) => void; testId: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value || SYSTEM_DEFAULT} onValueChange={(v) => onChange(v === SYSTEM_DEFAULT ? '' : v)}>
        <SelectTrigger id={id} size="sm" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={CLOSES_AT_ONCE}>
          <SelectGroup>
            <SelectItem value={SYSTEM_DEFAULT}>The system&apos;s default</SelectItem>
            {families.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
