'use client'

import { useEffect, useRef, useState } from 'react'
import type { ElementId, SourceCandidates, Vec2 } from '@permitzip/bim-kernel'
import { GRIP_IDLE, gripFirstUseHint, gripHint, gripStep, gripTarget, type GripDrop, type GripState } from './grip-controller'
import { useGripFirstUse } from './use-grip-first-use'

const PRIMARY = 'var(--mutiny-selection)'
/** Grip radius, paper mm at 1 px = `paperMmPerPx`; drawn at a fixed screen size. */
const GRIP_PX = 7

/**
 * The "+" grip on a plan (round 12 E12), drawn on the drawing in paper mm,
 * for any network: shown beside an element with nothing serving it (the look
 * of the run "+"). Press and drag: sources that can take it are
 * outlined, the rest dashed and dimmed with their reason under the pointer;
 * let go on an outlined one to connect (one edit, one undo step). Esc or
 * letting go anywhere else writes nothing. Every word comes from the add-on's
 * `sourcesFor` answer.
 */
export interface PlanConnectGripProps {
  readonly elementId: ElementId
  readonly answer: SourceCandidates
  /** Where the "+" sits (paper mm). */
  readonly at: Vec2
  readonly paperMmPerPx: number
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  /** The source under a paper point (the drawing's own hit test). */
  readonly sourceUnder: (p: Vec2) => ElementId | null
  /** A source's outline on paper, for lighting it while dragging. */
  readonly outlineOf: (id: ElementId) => readonly Vec2[] | null
  /** Make the network's one edit; returns the plain reason when it was refused. */
  readonly onDrop: (drop: GripDrop) => string | null
  /** The status line. */
  readonly hint: (text: string | null) => void
}

function points(poly: readonly Vec2[]): string {
  return poly.map((q) => `${q.x},${q.y}`).join(' ')
}

export function PlanConnectGrip({ elementId, answer, at, paperMmPerPx, paperOf, sourceUnder, outlineOf, onDrop, hint }: PlanConnectGripProps) {
  const firstUse = useGripFirstUse()
  const [state, setState] = useState<GripState>(GRIP_IDLE)
  const live = useRef<GripState>(GRIP_IDLE)
  const set = (next: GripState) => {
    live.current = next
    setState(next)
  }

  useEffect(() => {
    if (firstUse.showHint) hint(gripFirstUseHint(answer))
  }, [firstUse.showHint, elementId, answer, hint])

  useEffect(() => {
    if (state.kind === 'idle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      set(gripStep(live.current, { type: 'escape' }).state)
      hint('Connect cancelled; nothing changed.')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state.kind, hint])

  const r = GRIP_PX * paperMmPerPx
  const dragging = state.kind === 'dragging'
  const sources = dragging ? [...answer.candidates.map((c) => c.sourceId), ...answer.refused.map((x) => x.sourceId)] : []

  return (
    <g data-testid="connect-grip-layer" data-element-id={elementId}>
      {sources.map((id) => {
        const poly = outlineOf(id)
        const t = gripTarget(answer, id)
        if (!poly || !t) return null
        const lit = t.kind === 'candidate'
        const over = dragging && state.over === id
        return (
          <polygon
            key={id}
            points={points(poly)}
            fill={PRIMARY}
            fillOpacity={lit ? (over ? 0.25 : 0.1) : 0.03}
            stroke={PRIMARY}
            strokeOpacity={lit ? 1 : 0.4}
            strokeWidth={lit ? 0.6 : 0.3}
            strokeDasharray={lit ? undefined : '1 0.8'}
            pointerEvents="none"
            data-testid={lit ? 'connect-grip-candidate' : 'connect-grip-refused'}
            data-source-id={id}
          />
        )
      })}
      {dragging && <line x1={at.x} y1={at.y} x2={state.at.x} y2={state.at.y} stroke={PRIMARY} strokeWidth={0.4} strokeDasharray="1.2 0.8" pointerEvents="none" data-testid="connect-grip-rubber-band" />}
      <g
        role="button"
        tabIndex={0}
        aria-label={answer.prompt}
        data-testid="connect-grip"
        data-element-id={elementId}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        onPointerDown={(e) => {
          e.stopPropagation()
          const p = paperOf(e)
          if (!p) return
          e.currentTarget.setPointerCapture(e.pointerId)
          set(gripStep(GRIP_IDLE, { type: 'press', elementId, answer, at: p }).state)
          hint(`${answer.prompt}. Esc cancels.`)
        }}
        onPointerMove={(e) => {
          if (live.current.kind !== 'dragging') return
          const p = paperOf(e)
          if (!p) return
          const next = gripStep(live.current, { type: 'move', at: p, over: sourceUnder(p) }).state
          set(next)
          hint(gripHint(next))
        }}
        onPointerUp={(e) => {
          if (live.current.kind !== 'dragging') return
          e.stopPropagation()
          const p = paperOf(e)
          const step = gripStep(live.current, { type: 'release', over: p ? sourceUnder(p) : null })
          set(step.state)
          if (!step.drop) {
            const t = p ? gripTarget(answer, sourceUnder(p)) : null
            hint(t?.kind === 'refused' ? t.refusal.reason : `Nothing connected: let go on a ${answer.sourceWord}.`)
            return
          }
          const refused = onDrop(step.drop)
          if (refused === null) firstUse.markUsed()
          hint(refused ?? `Connected to ${step.drop.candidate.label}. Undo takes it back.`)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') set(GRIP_IDLE)
        }}
      >
        <title>{answer.prompt}</title>
        <circle cx={at.x} cy={at.y} r={r} fill="white" stroke={PRIMARY} strokeWidth={0.4} />
        <line x1={at.x - r * 0.55} y1={at.y} x2={at.x + r * 0.55} y2={at.y} stroke={PRIMARY} strokeWidth={0.45} pointerEvents="none" />
        <line x1={at.x} y1={at.y - r * 0.55} x2={at.x} y2={at.y + r * 0.55} stroke={PRIMARY} strokeWidth={0.45} pointerEvents="none" />
      </g>
    </g>
  )
}
