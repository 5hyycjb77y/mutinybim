'use client'

import { useEffect, useRef, useState } from 'react'
import type { Vec2 } from '@permitzip/bim-kernel'
import { ToolHintBar } from '../ToolHintBar'

/**
 * Pick one point in the plan for something a dialog is placing (the service
 * lineup's left end): click in the plan or 3D view, Esc goes back to the
 * dialog with nothing changed.
 */
export function PlanPointPick({
  prompt,
  pickPlanPointAt,
  onPicked,
  onCancel,
}: {
  readonly prompt: string
  readonly pickPlanPointAt: (clientX: number, clientY: number) => Vec2 | null
  readonly onPicked: (point: Vec2) => void
  readonly onCancel: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [hint, setHint] = useState(`${prompt} Esc goes back.`)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCancel()
    }
    // Capture: the pick owns Esc while it is armed, ahead of menus that kept focus.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  useEffect(() => {
    box.current?.focus()
  }, [])

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const at = pickPlanPointAt(e.clientX, e.clientY)
    if (!at) {
      setHint('That point is off the plan. Click inside the plan or 3D view, or Esc to go back.')
      return
    }
    onPicked(at)
  }

  return (
    <div ref={box} tabIndex={-1} className="absolute inset-0 z-10 cursor-crosshair touch-none outline-none" onPointerDown={down} data-testid="plan-point-pick" aria-label={prompt}>
      <ToolHintBar text={hint} testId="plan-point-pick-hint" />
    </div>
  )
}
