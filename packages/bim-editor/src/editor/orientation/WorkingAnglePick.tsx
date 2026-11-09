'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { describeWorkingAngle, workingAngleFromEdge, type Command, type Vec2 } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import type { EdgeHit, EdgePicker } from './edge-pick'

/** What the picked edge sets. */
export type WorkingAngleTarget =
  | { readonly kind: 'model' }
  | { readonly kind: 'view'; readonly viewId: string; readonly viewName: string }
  | { readonly kind: 'crop'; readonly label: string }

/** The command (or crop action) for an edge picked for a target. */
export function workingAngleCommand(target: WorkingAngleTarget, from: Vec2, to: Vec2): { command: Command; label: string } | null {
  switch (target.kind) {
    case 'model':
      return { command: { type: 'set_working_angle', from, to }, label: 'align the working angle to an edge' }
    case 'view': {
      const deg = workingAngleFromEdge(from, to)
      return deg === null ? null : { command: { type: 'set_view_properties', viewId: target.viewId, props: { workingAngleDeg: deg } }, label: `align the working angle of ${target.viewName} to an edge` }
    }
    case 'crop':
      return null
  }
}

const TARGET_WORDS: Readonly<Record<WorkingAngleTarget['kind'], string>> = {
  model: 'Align axes to an edge',
  view: 'Align this view’s axes to an edge',
  crop: 'Align the crop box to an edge',
}

interface Props {
  readonly picker: EdgePicker
  readonly target: WorkingAngleTarget
  /** Plan point → canvas px, for the rubber line and the highlighted edge. */
  readonly toCanvas: (p: Vec2) => { x: number; y: number } | null
  readonly canvasXY: (clientX: number, clientY: number) => { x: number; y: number }
  /** Sends the command for a model or view target; returns the refusal, or null when it was accepted. */
  readonly onCommit: (command: Command, label: string) => string | null
  /** Crop target: turn the crop box square to the edge; returns the refusal, or null. */
  readonly onCropEdge: (from: Vec2, to: Vec2) => string | null
  readonly onExit: () => void
  readonly onHint: (message: string) => void
}

/**
 * The pick for "Align axes to an edge" (and the crop box's "Align to an
 * edge"): click a wall or other straight edge to take its direction at once,
 * or click two points along a building edge. A bar says what to do and Esc or
 * Cancel leaves without changing anything. The picked direction becomes the
 * working angle (model or view) or the crop box's turn; nothing moves.
 */
export function WorkingAnglePick({ picker, target, toCanvas, canvasXY, onCommit, onCropEdge, onExit, onHint }: Props) {
  const [start, setStart] = useState<Vec2 | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [hoverEdge, setHoverEdge] = useState<EdgeHit | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const busy = useRef(false)

  const commit = useCallback(
    (from: Vec2, to: Vec2, what: string) => {
      const made = target.kind === 'crop' ? null : workingAngleCommand(target, from, to)
      const refusal = target.kind === 'crop' ? onCropEdge(from, to) : made ? onCommit(made.command, made.label) : 'The two points are the same; pick a second point further along the edge.'
      if (refusal) {
        onHint(refusal)
        return
      }
      const deg = workingAngleFromEdge(from, to)
      onHint(deg === null ? 'Done.' : `Lined up with ${what}: ${describeWorkingAngle(deg).toLowerCase()}. Undo is in the message.`)
      onExit()
    },
    [target, onCommit, onCropEdge, onExit, onHint],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (start) {
        setStart(null)
        setPreview(null)
        onHint('First point dropped. Click a wall, or two points along a building edge. Esc again leaves.')
        return
      }
      onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [start, onExit, onHint])

  // One read of what is under the pointer at a time; moves meanwhile keep only the latest, read when it lands, so the preview ends where the pointer stopped.
  const latest = useRef<{ clientX: number; clientY: number } | null>(null)
  const startRef = useRef(start)
  useLayoutEffect(() => {
    startRef.current = start
  })
  const readUnder = (clientX: number, clientY: number) => {
    busy.current = true
    const from = startRef.current
    void (from ? picker.pointAt(clientX, clientY).then((p) => {
      setHoverEdge(null)
      setPreview(p ? workingAngleFromEdge(from, p.at) : null)
    }) : picker.edgeAt(clientX, clientY).then((edge) => {
      setHoverEdge(edge)
      setPreview(edge ? workingAngleFromEdge(edge.from, edge.to) : null)
    }))
      .catch((err: unknown) => console.error('[WorkingAnglePick] reading what is under the pointer failed', err))
      .finally(() => {
        busy.current = false
        const next = latest.current
        latest.current = null
        if (next) readUnder(next.clientX, next.clientY)
      })
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const at = canvasXY(e.clientX, e.clientY)
    setCursor(at)
    if (busy.current) {
      latest.current = { clientX: e.clientX, clientY: e.clientY }
      return
    }
    readUnder(e.clientX, e.clientY)
  }

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const { clientX, clientY } = e
    void (async () => {
      if (!start) {
        const edge = await picker.edgeAt(clientX, clientY)
        if (edge) return commit(edge.from, edge.to, edge.label)
        const p = await picker.pointAt(clientX, clientY)
        if (!p) return onHint('That is off the work plane. Point at the building, or lower in the view.')
        setStart(p.at)
        onHint(`First point${p.label ? ` on ${p.label}` : ''}. Now click a second point further along the same edge. Esc drops it.`)
        return
      }
      const p = await picker.pointAt(clientX, clientY)
      if (!p) return onHint('That is off the work plane. Point at the building, or lower in the view.')
      if (workingAngleFromEdge(start, p.at) === null) return onHint('That is the same point. Click a second point further along the edge.')
      commit(start, p.at, 'that edge')
    })().catch((err: unknown) => {
      console.error('[WorkingAnglePick] pick failed', err)
      onHint('Picking that point failed. Try again, or type the angle in Coordinates.')
    })
  }

  const startPx = start ? toCanvas(start) : null
  const edgeA = hoverEdge ? toCanvas(hoverEdge.from) : null
  const edgeB = hoverEdge ? toCanvas(hoverEdge.to) : null

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-10 size-full" aria-hidden data-testid="working-angle-pick-lines">
        {edgeA && edgeB && <line x1={edgeA.x} y1={edgeA.y} x2={edgeB.x} y2={edgeB.y} className="stroke-info-600" strokeWidth={3} data-testid="working-angle-hover-edge" />}
        {startPx && <circle cx={startPx.x} cy={startPx.y} r={4} className="fill-info-600" />}
        {startPx && cursor && <line x1={startPx.x} y1={startPx.y} x2={cursor.x} y2={cursor.y} className="stroke-info-600" strokeWidth={1.5} strokeDasharray="6 4" />}
      </svg>
      <div className="absolute inset-0 z-10 cursor-crosshair" data-testid="working-angle-pick" onPointerDown={onDown} onPointerMove={onMove} />
      <div role="status" className="absolute inset-x-3 top-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/95 py-1.5 pl-3 pr-1.5 shadow-sm" data-testid="working-angle-bar">
        <span className="text-sm font-medium">{TARGET_WORDS[target.kind]}</span>
        <span className="text-xs text-muted-foreground">
          {start ? 'Click a second point along the same edge.' : hoverEdge ? `Click to line up with ${hoverEdge.label}.` : 'Click a wall, or two points along a building edge.'}
        </span>
        {preview !== null && (
          <span className="text-xs tabular-nums text-info-700" data-testid="working-angle-preview">
            {describeWorkingAngle(preview)}
          </span>
        )}
        <Button size="sm" variant="outline" onClick={onExit} data-testid="working-angle-cancel">
          Cancel (Esc)
        </Button>
      </div>
    </>
  )
}
