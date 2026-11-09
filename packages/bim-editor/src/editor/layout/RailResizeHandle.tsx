'use client'

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { clampLayoutWidth } from '../../contracts/building-model/layout-prefs'
import { cn } from '../../ui/cn'

/** How far one arrow key moves the edge, px (Shift: five times that). */
export const RAIL_KEY_STEP_PX = 16

interface Props {
  /** Which edge of its sidebar the handle sits on: a left sidebar's right edge, a right sidebar's left edge. */
  readonly edge: 'right' | 'left'
  readonly width: number
  /** While dragging: the width to show now (nothing is saved yet). */
  readonly onPreview: (px: number | null) => void
  /** Drag released, an arrow key, or double-click: the width to keep. */
  readonly onCommit: (px: number) => void
  readonly defaultWidth: number
  readonly ariaLabel: string
}

/**
 * The drag edge of a Building Model sidebar (the product owner, C6: "these little
 * sidebars, I can't stretch"). A wide grab zone centred on the border, a grip
 * that lights up on hover, a "Drag to resize" tooltip, double-click for the
 * default width, and arrow keys when focused.
 */
export function RailResizeHandle({ edge, width, onPreview, onCommit, defaultWidth, ariaLabel }: Props) {
  const from = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // The tooltip stays out of the way while the edge is dragged, and until the pointer leaves after a drag.
  const [tipOpen, setTipOpen] = useState(false)
  const justDragged = useRef(false)
  // Dragging toward the inside of the screen makes a left sidebar wider and a right one narrower.
  const sign = edge === 'right' ? 1 : -1
  const at = (clientX: number): number | null => (from.current ? clampLayoutWidth(from.current.width + sign * (clientX - from.current.x)) : null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? RAIL_KEY_STEP_PX * 5 : RAIL_KEY_STEP_PX
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      onCommit(clampLayoutWidth(width + (e.key === 'ArrowRight' ? step : -step) * sign))
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault()
      onCommit(defaultWidth)
    }
  }

  return (
    <Tooltip open={tipOpen && !dragging} onOpenChange={(open) => setTipOpen(open && from.current === null && !justDragged.current)}>
      <TooltipTrigger asChild>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={ariaLabel}
          aria-valuenow={width}
          aria-valuemin={160}
          aria-valuemax={960}
          tabIndex={0}
          data-dragging={dragging ? 'true' : undefined}
          data-testid="rail-resize-handle"
          className={cn(
            'group absolute top-0 bottom-0 z-30 w-3 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
            edge === 'right' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2',
          )}
          onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            from.current = { x: e.clientX, width }
            setDragging(true)
            setTipOpen(false)
          }}
          onPointerMove={(e) => {
            const next = at(e.clientX)
            if (next !== null) onPreview(next)
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId)
            const next = at(e.clientX)
            const start = from.current
            from.current = null
            justDragged.current = start !== null
            setDragging(false)
            onPreview(null)
            if (next !== null && start && next !== start.width) onCommit(next)
          }}
          onPointerCancel={() => {
            from.current = null
            setDragging(false)
            onPreview(null)
          }}
          onPointerLeave={() => {
            if (!from.current) justDragged.current = false
          }}
          onDoubleClick={() => onCommit(defaultWidth)}
          onKeyDown={onKeyDown}
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/50 group-data-[dragging=true]:bg-primary" />
          <div className="pointer-events-none absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-primary/70 group-data-[dragging=true]:bg-primary" />
        </div>
      </TooltipTrigger>
      <TooltipContent side={edge === 'right' ? 'right' : 'left'}>Drag to resize. Double-click for the default width.</TooltipContent>
    </Tooltip>
  )
}
