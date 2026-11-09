'use client'

import type { ReferenceDisplayPreset } from '@permitzip/bim-kernel'
import { cn } from '../../ui/cn'

/**
 * A small picture of what a linked-model look does (ROADMAP U8): the
 * architect's wall and door drawn the way the look draws them, with one of
 * our ducts crossing in front, so Normal, Halftone, See-through, Underlay and
 * Hidden can be told apart before choosing.
 */

interface Look {
  /** Opacity of the architect's lines (0 hides them). */
  readonly opacity: number
  /** Grey instead of ink. */
  readonly grey: boolean
  /** Drawn faint beneath our duct (the duct covers it), rather than over it. */
  readonly beneath: boolean
}

const LOOK: Record<ReferenceDisplayPreset | 'custom', Look> = {
  normal: { opacity: 1, grey: false, beneath: false },
  halftone: { opacity: 1, grey: true, beneath: false },
  transparent: { opacity: 0.45, grey: true, beneath: false },
  underlay: { opacity: 0.35, grey: true, beneath: true },
  hidden: { opacity: 0, grey: true, beneath: false },
  custom: { opacity: 0.7, grey: true, beneath: false },
}

function Architect({ look }: { look: Look }) {
  if (look.opacity === 0) return null
  return (
    <g className={look.grey ? 'text-muted-foreground' : 'text-foreground'} stroke="currentColor" fill="none" strokeWidth={look.grey ? 1.5 : 2} opacity={look.opacity}>
      <path d="M4 8 H44 M4 13 H44" />
      <path d="M4 8 V30 M9 13 V30" />
      <path d="M22 13 A9 9 0 0 1 31 22" strokeWidth={1} />
    </g>
  )
}

function Duct() {
  return <rect x={14} y={17} width={30} height={8} rx={1} className="fill-primary-100 text-primary" stroke="currentColor" strokeWidth={1.5} />
}

/** One look, as a 48 × 32 picture. */
export function LinkedDisplayPreview({ preset, className }: { preset: ReferenceDisplayPreset | 'custom'; className?: string }) {
  const look = LOOK[preset]
  return (
    <svg viewBox="0 0 48 32" className={cn('h-8 w-12 shrink-0 rounded-sm border bg-background', className)} aria-hidden="true" data-testid={`linked-display-preview-${preset}`}>
      {look.beneath && <Architect look={look} />}
      <Duct />
      {!look.beneath && <Architect look={look} />}
    </svg>
  )
}

/** Before (Normal) and after (the chosen look), side by side, for the control. */
export function LinkedDisplayBeforeAfter({ preset }: { preset: ReferenceDisplayPreset | 'custom' }) {
  if (preset === 'normal') return null
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="linked-display-before-after">
      <LinkedDisplayPreview preset="normal" />
      <span aria-hidden="true">→</span>
      <LinkedDisplayPreview preset={preset} />
      <span className="sr-only">Normal on the left, this look on the right.</span>
    </div>
  )
}
