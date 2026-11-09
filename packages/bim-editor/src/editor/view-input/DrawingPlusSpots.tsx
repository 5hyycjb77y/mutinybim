'use client'

import { useMemo } from 'react'
import type { ModelState, ViewOnPaper } from '@permitzip/bim-kernel'
import type { ModelEditBridge } from './bridge'
import { PLUS_RADIUS_PX, plusOnPaper } from './drawing-plus'

const PRIMARY = 'var(--mutiny-selection)'

interface Props {
  readonly model: ModelState
  readonly view: ViewOnPaper
  readonly selectedIds: readonly string[]
  readonly serverFeatures: readonly string[]
  readonly paperMmPerPx: number
  readonly onPick: NonNullable<ModelEditBridge['plus']>
  readonly hint: (text: string | null) => void
}

/**
 * The selected run piece's "+" on a printed drawing (product decision, Nov 6:
 * "the little plus button should be here on the plan"): the same buttons as
 * in 3D, drawn at a fixed screen size whatever the zoom. Each one says what
 * it does on hover and works from the keyboard.
 */
export function DrawingPlusSpots({ model, view, selectedIds, serverFeatures, paperMmPerPx, onPick, hint }: Props) {
  const spots = useMemo(() => plusOnPaper(model, view, selectedIds, serverFeatures, paperMmPerPx), [model, view, selectedIds, serverFeatures, paperMmPerPx])
  if (spots.length === 0) return null
  const r = PLUS_RADIUS_PX * paperMmPerPx
  const arm = r * 0.55
  return (
    <g data-testid="drawing-plus-spots">
      {spots.map(({ spot, paper }) => (
        <g
          key={`${spot.kind}-${spot.elementId}-${spot.port}-${spot.face ?? ''}`}
          role="button"
          tabIndex={0}
          aria-label={spot.label}
          data-testid="drawing-plus"
          data-kind={spot.kind}
          data-port={spot.port}
          className="cursor-pointer focus:outline-none"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={() => hint(spot.label)}
          onPointerLeave={() => hint(null)}
          onClick={(e) => {
            e.stopPropagation()
            onPick(spot)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            e.stopPropagation()
            onPick(spot)
          }}
        >
          <title>{spot.label}</title>
          <circle cx={paper.x} cy={paper.y} r={r} fill="white" stroke={PRIMARY} strokeWidth={r * 0.18} />
          <line x1={paper.x - arm} y1={paper.y} x2={paper.x + arm} y2={paper.y} stroke={PRIMARY} strokeWidth={r * 0.2} strokeLinecap="round" />
          <line x1={paper.x} y1={paper.y - arm} x2={paper.x} y2={paper.y + arm} stroke={PRIMARY} strokeWidth={r * 0.2} strokeLinecap="round" />
        </g>
      ))}
    </g>
  )
}
