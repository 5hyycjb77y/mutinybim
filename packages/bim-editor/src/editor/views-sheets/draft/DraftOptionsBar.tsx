'use client'

import { Check, ChevronDown, Crosshair, Magnet, RotateCw, X } from 'lucide-react'
import { DETAIL_LINE_STYLES, HATCH_PATTERNS, SNAP_KINDS, detailLineStyleOf, type HatchPattern, type SnapKind } from '@permitzip/bim-kernel'
import { Button } from '../../../ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../../../ui/dropdown-menu'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../../ui/select'
import { Switch } from '../../../ui/switch'
import { Toggle } from '../../../ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group'
import { componentGroups, isDraftShape, type DraftPending, type DraftSettings, type ModifyParams } from './draft-input'
import { CLOSES_AT_ONCE, handKeyboardToDrawing } from '../../menu-close'

/**
 * The Draft options bar: the prompt for the next click, and the values the
 * tool in hand uses (line style, hatch, component, thickness, polygon sides;
 * a modify operation's angle, count, distance, gap or radius, Copy, Delete
 * inner segment), and the drawing aids every drawing tool shares: snaps,
 * Ortho (F8) and polar tracking. Cancel is always here. While a region's
 * boundary is being edited it carries that sketch's Finish and Cancel.
 *
 * It floats over the top of the drawing and never takes layout space, so
 * picking a tool doesn't push the sheet down (same rule as the edit-in-place
 * indicator).
 */

const SNAP_LABEL: Record<SnapKind, string> = { endpoint: 'Endpoints', midpoint: 'Midpoints', center: 'Centres', intersection: 'Intersections', perpendicular: 'Perpendicular', nearest: 'Nearest point on a line' }
const POLAR_STEPS = [15, 30, 45, 90] as const

/** Snaps, Ortho and polar tracking: beside the drawing whichever drawing tool is in hand. */
function DrawingAids({ settings, set }: { settings: DraftSettings; set: (patch: Partial<DraftSettings>) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Drawing aids" data-testid="draft-aids">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7" title={`Clicks snap to: ${settings.snaps.length > 0 ? settings.snaps.map((k) => SNAP_LABEL[k].toLowerCase()).join(', ') : 'nothing (turn some on)'}`} data-testid="draft-snaps">
            <Magnet data-icon="inline-start" />
            Snaps
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={CLOSES_AT_ONCE} onCloseAutoFocus={handKeyboardToDrawing}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Clicks snap to</DropdownMenuLabel>
          <DropdownMenuGroup>
            {SNAP_KINDS.map((k) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={settings.snaps.includes(k)}
                onCheckedChange={(on) => set({ snaps: on ? [...settings.snaps.filter((x) => x !== k), k] : settings.snaps.filter((x) => x !== k) })}
                onSelect={(e) => e.preventDefault()}
                data-testid={`draft-snap-${k}`}
              >
                {SNAP_LABEL[k]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Toggle size="sm" className="h-7" pressed={settings.ortho} onPressedChange={(ortho) => set({ ortho, ...(ortho ? { polarDeg: null } : {}) })} aria-label="Ortho (F8)" title="Keep lines square to the paper (F8)" data-testid="draft-ortho">
        <Crosshair data-icon="inline-start" />
        Ortho
      </Toggle>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7" title={settings.polarDeg ? `Tracking every ${settings.polarDeg}° from the last point` : 'Track to set angles from the last point'} data-testid="draft-polar">
            <RotateCw data-icon="inline-start" />
            {settings.polarDeg ? `Polar ${settings.polarDeg}°` : 'Polar'}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={CLOSES_AT_ONCE} onCloseAutoFocus={handKeyboardToDrawing}>
          <DropdownMenuRadioGroup value={settings.polarDeg ? String(settings.polarDeg) : 'off'} onValueChange={(v) => { const deg = POLAR_STEPS.find((d) => String(d) === v) ?? null; set({ polarDeg: deg, ...(deg ? { ortho: false } : {}) }) }}>
            <DropdownMenuRadioItem value="off" data-testid="draft-polar-off">
              Off
            </DropdownMenuRadioItem>
            {POLAR_STEPS.map((deg) => (
              <DropdownMenuRadioItem key={deg} value={String(deg)} data-testid={`draft-polar-${deg}`}>
                Every {deg}°
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const HATCH_LABEL: Record<HatchPattern, string> = {
  solid: 'Solid fill',
  diagonal: 'Diagonal',
  diagonal_reverse: 'Diagonal (reverse)',
  crosshatch: 'Crosshatch',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  dots: 'Dots',
  concrete: 'Concrete',
  earth: 'Earth',
  insulation_rigid: 'Rigid insulation',
  masonry: 'Masonry',
}
const CATEGORY_LABEL: Record<string, string> = { insulation: 'Insulation', duct: 'Duct', pipe: 'Pipe', supports: 'Hangers and supports', valves: 'Valves', anchors: 'Anchors', structure: 'Structure' }
const LINEWORK = new Set(['line', 'rect', 'arc', 'circle', 'polyline', 'polygon', 'spline', 'region'])

/** One line style per line, the way BIM drafting views pick linework. */
function LineStylePicker({ settings, set }: { settings: DraftSettings; set: (patch: Partial<DraftSettings>) => void }) {
  const current = detailLineStyleOf({ weight: settings.weight, pattern: settings.pattern }) ?? 'medium'
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor="draft-line-style" className="whitespace-nowrap text-xs text-muted-foreground">
        Line style
      </Label>
      <Select
        value={current}
        onValueChange={(v) => {
          const style = DETAIL_LINE_STYLES.find((x) => x.id === v)
          if (style) set({ weight: style.weight, pattern: style.pattern })
        }}
      >
        <SelectTrigger id="draft-line-style" size="sm" className="h-7 min-w-32" data-testid="draft-line-style">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={CLOSES_AT_ONCE} onCloseAutoFocus={handKeyboardToDrawing}>
          <SelectGroup>
            {DETAIL_LINE_STYLES.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function Check2({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={id} />
      <Label htmlFor={id} className="whitespace-nowrap text-xs">
        {label}
      </Label>
    </div>
  )
}

/** A region's boundary sketch: what to do, Finish and Cancel. */
export interface BoundarySketch {
  readonly prompt: string
  readonly onFinish: () => void
  readonly onCancel: () => void
}

function Choice<T extends string>({ id, label, value, options, labels, onChange }: { id: string; label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="whitespace-nowrap text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={(v) => onChange(options.find((o) => o === v) ?? value)}>
        <SelectTrigger id={id} size="sm" className="h-7 min-w-24" data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={CLOSES_AT_ONCE} onCloseAutoFocus={handKeyboardToDrawing}>
          <SelectGroup>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {labels[o]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function Typed({ id, label, value, width = 'w-20', onChange }: { id: string; label: string; value: string; width?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="whitespace-nowrap text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`h-7 ${width}`} data-testid={id} />
    </div>
  )
}

export function DraftOptionsBar({
  tool,
  settings,
  onSettings,
  pending,
  params,
  onParams,
  prompt,
  onCancel,
  sketch = null,
  className = '',
}: {
  tool: string
  settings: DraftSettings
  onSettings: (next: DraftSettings) => void
  pending: DraftPending
  params: ModifyParams
  onParams: (next: ModifyParams) => void
  prompt: string | null
  onCancel: () => void
  sketch?: BoundarySketch | null
  /** Placement over the drawing (the bar is absolutely positioned by its parent). */
  className?: string
}) {
  const set = (patch: Partial<DraftSettings>) => onSettings({ ...settings, ...patch })
  const setP = (patch: Partial<ModifyParams>) => onParams({ ...params, ...patch })
  const op = pending?.kind === 'modify' ? pending.op : null
  const drawing = !pending && (isDraftShape(tool) || LINEWORK.has(tool))
  const aids = drawing || op !== null || tool === 'dimension'
  const frame = `pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-md border bg-background/95 px-3 py-1.5 text-sm shadow-sm ${className}`
  if (sketch) {
    return (
      <div className={frame} data-testid="draft-options">
        <span className="font-medium" role="status" aria-live="polite" data-testid="boundary-prompt">
          {sketch.prompt}
        </span>
        <Button size="sm" onClick={sketch.onFinish} data-testid="boundary-finish">
          <Check data-icon="inline-start" />
          Finish edit (Enter)
        </Button>
        <Button size="sm" variant="ghost" onClick={sketch.onCancel} data-testid="boundary-cancel">
          <X data-icon="inline-start" />
          Cancel (Esc)
        </Button>
      </div>
    )
  }
  if (!pending && !drawing && !prompt && !aids) return null
  return (
    <div className={frame} data-testid="draft-options">
      {prompt && (
        <span className="font-medium" role="status" aria-live="polite" data-testid="draft-prompt">
          {prompt}
        </span>
      )}
      {drawing && LINEWORK.has(tool) && !(tool === 'region' && settings.masking) && (
        <>
          <LineStylePicker settings={settings} set={set} />
        </>
      )}
      {drawing && tool === 'polygon' && (
        <>
          <Typed id="draft-polygon-sides" label="Sides" value={settings.polygonSides} width="w-14" onChange={(polygonSides) => set({ polygonSides })} />
          <ToggleGroup type="single" size="sm" variant="outline" value={settings.polygonInscribed ? 'inscribed' : 'circumscribed'} onValueChange={(v) => v && set({ polygonInscribed: v === 'inscribed' })} aria-label="Polygon fit" data-testid="draft-polygon-fit">
            <ToggleGroupItem value="inscribed" className="h-7 px-2 text-xs" title="The click is a corner">
              Inscribed
            </ToggleGroupItem>
            <ToggleGroupItem value="circumscribed" className="h-7 px-2 text-xs" title="The click is the middle of a side">
              Circumscribed
            </ToggleGroupItem>
          </ToggleGroup>
        </>
      )}
      {drawing && tool === 'region' && (
        <>
          <div className="flex items-center gap-1.5">
            <Switch id="draft-masking" checked={settings.masking} onCheckedChange={(masking) => set({ masking })} data-testid="draft-masking" />
            <Label htmlFor="draft-masking" className="text-xs">
              Masking (hides what&apos;s under it)
            </Label>
          </div>
          {!settings.masking && <Choice id="draft-hatch" label="Hatch" value={settings.hatch} options={HATCH_PATTERNS} labels={HATCH_LABEL} onChange={(hatch) => set({ hatch })} />}
        </>
      )}
      {drawing && (tool === 'component' || tool === 'repeat') && (
        <div className="flex items-center gap-1.5">
          <Label htmlFor="draft-symbol" className="whitespace-nowrap text-xs text-muted-foreground">
            Component
          </Label>
          <Select value={settings.symbolId} onValueChange={(symbolId) => set({ symbolId })}>
            <SelectTrigger id="draft-symbol" size="sm" className="h-7 min-w-40" data-testid="draft-symbol">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={CLOSES_AT_ONCE} onCloseAutoFocus={handKeyboardToDrawing}>
              {componentGroups().map((g) => (
                <SelectGroup key={g.category}>
                  <SelectLabel>{CATEGORY_LABEL[g.category] ?? g.category}</SelectLabel>
                  {g.items.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {drawing && tool === 'batt' && <Typed id="draft-batt" label="Thickness" value={settings.battThickness} onChange={(battThickness) => set({ battThickness })} />}
      {(op === 'rotate' || op === 'polar_array') && <Typed id="draft-angle" label={op === 'rotate' ? 'Angle (°, counter-clockwise)' : 'Spans (°)'} value={params.angle} width="w-16" onChange={(angle) => setP({ angle })} />}
      {(op === 'array' || op === 'polar_array') && <Typed id="draft-count" label="Copies, counting the original" value={params.count} width="w-14" onChange={(count) => setP({ count })} />}
      {op === 'scale' && <Typed id="draft-factor" label="Factor" value={params.factor} width="w-14" onChange={(factor) => setP({ factor })} />}
      {op === 'offset' && (
        <>
          <ToggleGroup type="single" size="sm" variant="outline" value={params.offsetMode} onValueChange={(v) => v && setP({ offsetMode: v === 'graphical' ? 'graphical' : 'numerical' })} aria-label="Offset by" data-testid="draft-offset-mode">
            <ToggleGroupItem value="numerical" className="h-7 px-2 text-xs" title="Type the distance, then click the side">
              Numerical
            </ToggleGroupItem>
            <ToggleGroupItem value="graphical" className="h-7 px-2 text-xs" title="Click two points to show the distance">
              Graphical
            </ToggleGroupItem>
          </ToggleGroup>
          {params.offsetMode === 'numerical' && <Typed id="draft-distance" label="Distance" value={params.distance} onChange={(distance) => setP({ distance })} />}
          <Check2 id="draft-offset-copy" label="Copy" checked={params.offsetCopy} onChange={(offsetCopy) => setP({ offsetCopy })} />
        </>
      )}
      {op === 'split' && <Check2 id="draft-delete-inner" label="Delete inner segment" checked={params.deleteInner} onChange={(deleteInner) => setP({ deleteInner })} />}
      {op === 'split_gap' && <Typed id="draft-gap" label="Gap" value={params.gap} width="w-16" onChange={(gap) => setP({ gap })} />}
      {op === 'fillet_arc' && <Typed id="draft-arc-radius" label="Radius" value={params.arcRadius} width="w-16" onChange={(arcRadius) => setP({ arcRadius })} />}
      {(op === 'rotate' || op === 'mirror') && (
        <div className="flex items-center gap-1.5">
          <Switch id="draft-copy" checked={params.copy} onCheckedChange={(copy) => setP({ copy })} />
          <Label htmlFor="draft-copy" className="text-xs">
            Keep the original
          </Label>
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        {aids && <DrawingAids settings={settings} set={set} />}
        {(pending || prompt) && (
          <Button size="sm" variant="ghost" onClick={onCancel} data-testid="draft-cancel">
            Cancel (Esc)
          </Button>
        )}
      </div>
    </div>
  )
}
