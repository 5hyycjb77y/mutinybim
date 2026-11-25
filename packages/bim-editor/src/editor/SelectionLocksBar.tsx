'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { VIEW_CATEGORY_LABELS, type ViewCategory } from '@permitzip/bim-kernel'
import { Button } from '@permitzip/bim-ui'
import type { SceneLightingPreset } from '@permitzip/bim-viewer-3d'
import { BatteryCharging, ChevronDown, Eye, Lock, Moon, Sparkles, Sun, Sunrise, Sunset, Unlock } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { toggleSelectionLock, useSelectionLocks } from './selection-locks'

const NON_LOCKABLE_VIEW_CATEGORIES: ReadonlySet<ViewCategory> = new Set(['tags', 'dimensions', 'rooms', 'grids', 'opening_tags', 'insulation'])
const LOCKABLE_CATEGORIES: ReadonlyArray<{ readonly id: string; readonly label: string }> = (Object.entries(VIEW_CATEGORY_LABELS) as [ViewCategory, string][])
  .filter(([id]) => !NON_LOCKABLE_VIEW_CATEGORIES.has(id))
  .map(([id, label]) => ({ id, label }))

interface ViewerLightingControls {
  setSun(azimuthDeg: number, elevationDeg: number): void
  setShadows(enabled: boolean): void
  setRenderQuality(quality: 'draft' | 'standard' | 'high'): void
  getRenderQuality?: () => 'draft' | 'standard' | 'high'
  setLightingPreset?(preset: SceneLightingPreset): void
}

const LIGHTING_PRESETS: readonly {
  readonly id: SceneLightingPreset
  readonly label: string
  readonly azimuth: number
  readonly elevation: number
  readonly shadows: boolean
  readonly activeTone: boolean
}[] = [
  { id: 'morning', label: 'Morning', azimuth: 55, elevation: 28, shadows: true, activeTone: false },
  { id: 'noon', label: 'Noon', azimuth: 135, elevation: 62, shadows: true, activeTone: false },
  { id: 'afternoon', label: 'Afternoon', azimuth: 235, elevation: 24, shadows: true, activeTone: false },
  { id: 'evening', label: 'Evening', azimuth: 268, elevation: 10, shadows: true, activeTone: true },
  { id: 'night', label: 'Night', azimuth: 210, elevation: 48, shadows: true, activeTone: true },
  { id: 'no_shadows', label: 'No shadows', azimuth: 135, elevation: 62, shadows: false, activeTone: false },
]

const QUALITY_ORDER = ['draft', 'standard', 'high'] as const
const QUALITY_LABEL: Record<(typeof QUALITY_ORDER)[number], string> = { draft: 'Draft', standard: 'Std', high: 'High' }

interface Props {
  readonly hasSelection: boolean
  readonly selectionLocked: boolean
  readonly canEdit: boolean
  readonly onTogglePin?: () => void
  readonly onLockCategory?: (category: string, locked: boolean) => void
  readonly viewer?: ViewerLightingControls | null
  readonly lightingPreset?: SceneLightingPreset
  readonly onLightingPresetChange?: (preset: SceneLightingPreset) => void
  readonly is3d?: boolean
}

function PresetIcon({ preset }: { readonly preset: SceneLightingPreset }): ReactNode {
  if (preset === 'morning') return <Sunrise className="size-3" />
  if (preset === 'evening') return <Sunset className="size-3" />
  if (preset === 'night' || preset === 'night_blackout' || preset === 'night_blackout_90min') return <Moon className="size-3" />
  return <Sun className="size-3" />
}

/**
 * Compact Revit-style selection-lock + 3D time-of-day lighting/render-quality strip docked in the bottom status bar.
 * Uses only `@permitzip/bim-ui` controls and `--mutiny-*` theme tokens.
 */
export function SelectionLocksBar({
  hasSelection,
  selectionLocked,
  canEdit,
  onTogglePin,
  onLockCategory,
  viewer,
  lightingPreset,
  onLightingPresetChange,
  is3d = false,
}: Props): ReactNode {
  const locks = useSelectionLocks()
  const [localPreset, setLocalPreset] = useState<SceneLightingPreset>('noon')
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>(() => viewer?.getRenderQuality?.() ?? 'standard')

  useEffect(() => {
    const current = viewer?.getRenderQuality?.()
    if (current) setQuality(current)
  }, [viewer])

  const currentPreset = lightingPreset ?? localPreset
  const isEmergencyMode = currentPreset === 'night_blackout' || currentPreset === 'night_blackout_90min'
  const isLitMode = currentPreset === 'evening' || currentPreset === 'night' || isEmergencyMode
  const baseTimePreset: SceneLightingPreset = isEmergencyMode ? 'night' : currentPreset
  const presetEntry = LIGHTING_PRESETS.find((p) => p.id === baseTimePreset) ?? LIGHTING_PRESETS[1]!

  const applyPreset = (nextId: SceneLightingPreset) => {
    setLocalPreset(nextId)
    if (onLightingPresetChange) {
      onLightingPresetChange(nextId)
    } else if (viewer?.setLightingPreset) {
      viewer.setLightingPreset(nextId)
    } else {
      const entry = LIGHTING_PRESETS.find((p) => p.id === nextId) ?? LIGHTING_PRESETS[1]!
      viewer?.setSun(entry.azimuth, entry.elevation)
      viewer?.setShadows(entry.shadows)
    }
  }

  const cycleSun = () => {
    const idx = LIGHTING_PRESETS.findIndex((p) => p.id === baseTimePreset)
    const next = LIGHTING_PRESETS[(idx + 1) % LIGHTING_PRESETS.length]!
    applyPreset(next.id)
  }

  // Dedicated 1-click toggle between Normal lighting, Emergency Initial (0 min), and Emergency 90-Min battery derate
  const cycleEmergencyMode = () => {
    if (currentPreset === 'night_blackout') {
      applyPreset('night_blackout_90min')
    } else if (currentPreset === 'night_blackout_90min') {
      applyPreset('night')
    } else {
      applyPreset('night_blackout')
    }
  }

  const cycleQuality = () => {
    const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(quality) + 1) % QUALITY_ORDER.length]!
    setQuality(next)
    viewer?.setRenderQuality(next)
  }

  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-1"
      data-testid="selection-locks-bar"
      role="toolbar"
      aria-label="Selection locks"
    >
      <span className="px-1 text-[11px] font-medium text-muted-foreground select-none">Select:</span>
      <Button
        size="sm"
        variant={locks.rooms ? 'outline' : 'ghost'}
        onClick={() => toggleSelectionLock('rooms')}
        aria-pressed={locks.rooms}
        title={locks.rooms ? 'Rooms & spaces are selectable (click to lock)' : 'Rooms & spaces locked so they stay out of the way (click to allow selecting)'}
        data-testid="lock-toggle-rooms"
      >
        {locks.rooms ? <Unlock className="size-3" /> : <Lock className="size-3" />}
        Rooms
      </Button>
      <Button
        size="sm"
        variant={locks.locked ? 'outline' : 'ghost'}
        onClick={() => toggleSelectionLock('locked')}
        aria-pressed={locks.locked}
        title={locks.locked ? 'Pinned elements are selectable' : 'Pinned elements are protected from selection'}
        data-testid="lock-toggle-pinned"
      >
        {locks.locked ? <Unlock className="size-3" /> : <Lock className="size-3" />}
        Pinned
      </Button>
      <Button
        size="sm"
        variant={locks.links ? 'outline' : 'ghost'}
        onClick={() => toggleSelectionLock('links')}
        aria-pressed={locks.links}
        title={locks.links ? 'Linked models are selectable' : 'Linked models locked'}
        data-testid="lock-toggle-links"
      >
        {locks.links ? <Unlock className="size-3" /> : <Lock className="size-3" />}
        Links
      </Button>
      <Button
        size="sm"
        variant={locks.showLocked ? 'default' : 'ghost'}
        onClick={() => toggleSelectionLock('showLocked')}
        aria-pressed={locks.showLocked}
        title={locks.showLocked ? 'Hide locked/pinned element highlight overlay' : 'Highlight every locked or pinned element on the drawing'}
        data-testid="lock-toggle-show-locked"
      >
        <Eye className="size-3" />
        Show locked
      </Button>
      {canEdit && onLockCategory && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" title="Lock or unlock an entire category across the model" data-testid="lock-category-menu">
              <Lock className="size-3" />
              Categories
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs">Lock / unlock by category</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {LOCKABLE_CATEGORIES.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between gap-2 px-2 py-1 text-xs">
                <span className="truncate">{cat.label}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <DropdownMenuItem
                    className="h-6 cursor-pointer px-1.5 py-0 text-xs"
                    onSelect={() => onLockCategory(cat.id, true)}
                    data-testid={`lock-cat-${cat.id}`}
                  >
                    Lock
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="h-6 cursor-pointer px-1.5 py-0 text-xs text-muted-foreground"
                    onSelect={() => onLockCategory(cat.id, false)}
                    data-testid={`unlock-cat-${cat.id}`}
                  >
                    Unlock
                  </DropdownMenuItem>
                </div>
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {hasSelection && canEdit && onTogglePin && (
        <Button
          size="sm"
          variant={selectionLocked ? 'default' : 'outline'}
          onClick={onTogglePin}
          title={selectionLocked ? 'Unpin selected element(s)' : 'Pin selected element(s) so they cannot be moved'}
          data-testid="selection-pin-button"
        >
          {selectionLocked ? <Unlock className="size-3" /> : <Lock className="size-3" />}
          {selectionLocked ? 'Unpin' : 'Pin'}
        </Button>
      )}
      {is3d && viewer && (
        <>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            size="sm"
            variant={presetEntry.activeTone ? 'default' : presetEntry.shadows ? 'outline' : 'ghost'}
            onClick={cycleSun}
            title="Cycle 3D time of day (Morning / Noon / Afternoon / Evening lights / Night lights / No shadows)"
            data-testid="sun-preset-toggle"
          >
            <PresetIcon preset={presetEntry.id} />
            {presetEntry.label}
          </Button>
          {isLitMode && (
            <Button
              size="sm"
              variant={isEmergencyMode ? 'default' : 'outline'}
              onClick={cycleEmergencyMode}
              title={
                currentPreset === 'night_blackout'
                  ? 'Emergency Initial (0 min) — emergency lights at rated emergency_lumens, exit-combo heads ON. Click for 90-Min battery derate.'
                  : currentPreset === 'night_blackout_90min'
                    ? 'Emergency 90-Min (NFPA 101 end-of-discharge) — battery-backed lights derated to 60%. Click to restore Normal power.'
                    : 'Normal power — click to simulate Emergency Blackout (egress lights only at emergency_lumens)'
              }
              data-testid="emergency-lighting-toggle"
            >
              <BatteryCharging className="size-3" />
              {currentPreset === 'night_blackout'
                ? 'EM Initial'
                : currentPreset === 'night_blackout_90min'
                  ? 'EM 90-Min'
                  : 'Normal'}
            </Button>
          )}
          <Button
            size="sm"
            variant={quality === 'high' ? 'default' : 'ghost'}
            onClick={cycleQuality}
            title="Cycle 3D rendering quality (Draft / Standard / High 4K shadows)"
            data-testid="render-quality-toggle"
          >
            <Sparkles className="size-3" />
            {QUALITY_LABEL[quality]}
          </Button>
        </>
      )}
    </div>
  )
}
