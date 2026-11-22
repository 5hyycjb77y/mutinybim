'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@permitzip/bim-ui'
import { Lock, Sparkles, Sun, Unlock } from 'lucide-react'
import { toggleSelectionLock, useSelectionLocks } from './selection-locks'

interface ViewerLightingControls {
  setSun(azimuthDeg: number, elevationDeg: number): void
  setShadows(enabled: boolean): void
  setRenderQuality(quality: 'draft' | 'standard' | 'high'): void
}

const SUN_PRESETS = [
  { label: 'Morning', azimuth: 55, elevation: 32, shadows: true },
  { label: 'Noon', azimuth: 135, elevation: 62, shadows: true },
  { label: 'Afternoon', azimuth: 235, elevation: 28, shadows: true },
  { label: 'No shadows', azimuth: 135, elevation: 62, shadows: false },
] as const

const QUALITY_ORDER = ['draft', 'standard', 'high'] as const
const QUALITY_LABEL: Record<(typeof QUALITY_ORDER)[number], string> = { draft: 'Draft', standard: 'Std', high: 'High' }

interface Props {
  readonly hasSelection: boolean
  readonly selectionLocked: boolean
  readonly canEdit: boolean
  readonly onTogglePin?: () => void
  readonly viewer?: ViewerLightingControls | null
  readonly is3d?: boolean
}

/**
 * Compact Revit-style selection-lock + 3D sun/render-quality strip docked in the bottom status bar.
 * Uses only `@permitzip/bim-ui` controls and `--mutiny-*` theme tokens.
 */
export function SelectionLocksBar({ hasSelection, selectionLocked, canEdit, onTogglePin, viewer, is3d = false }: Props): ReactNode {
  const locks = useSelectionLocks()
  const [sunIdx, setSunIdx] = useState(1)
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard')

  const cycleSun = () => {
    const next = (sunIdx + 1) % SUN_PRESETS.length
    setSunIdx(next)
    const p = SUN_PRESETS[next]!
    viewer?.setSun(p.azimuth, p.elevation)
    viewer?.setShadows(p.shadows)
  }

  const cycleQuality = () => {
    const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(quality) + 1) % QUALITY_ORDER.length]!
    setQuality(next)
    viewer?.setRenderQuality(next)
  }

  const sunPreset = SUN_PRESETS[sunIdx]!
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
            variant={sunPreset.shadows ? 'outline' : 'ghost'}
            onClick={cycleSun}
            title="Cycle 3D sun angle and shadows (Morning / Noon / Afternoon / Off)"
            data-testid="sun-preset-toggle"
          >
            <Sun className="size-3" />
            {sunPreset.label}
          </Button>
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
