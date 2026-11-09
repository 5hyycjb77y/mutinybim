'use client'

import { useEffect, useState } from 'react'
import { paperMapping, tagElbowLeader, tagTarget, type DrawingItem, type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import { elbowGripCommand, type TagCommand } from './tag-elbow-commands'

const GRIP_PX = 9
const SELECTION = 'var(--mutiny-selection)'

interface Props {
  readonly model: ModelState
  /** The view the tag labels (the open plan, or the view opened on the sheet). */
  readonly view: ViewElement
  /** The selected tag; the grip shows only when it draws an elbow leader. */
  readonly item: DrawingItem
  /** Stored model mm → this canvas's paper mm (the canvas's `toPaperPoint`). */
  readonly toPaper: (p: Vec2) => Vec2
  /** This canvas's paper mm → stored model mm (the canvas's `toStored`). */
  readonly toStored: (p: Vec2) => Vec2
  /** A pointer event's paper mm on this canvas (the canvas's `paperOf`). */
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  readonly paperMmPerPx: number
  /** Null when the drawing can be changed; otherwise why not (the grip shows but doesn't drag). */
  readonly editBlocked: string | null
  /** Sends one edit; true when it was accepted. */
  readonly send: (c: TagCommand) => boolean
}

/**
 * The square grip on the bend of a selected tag's elbow leader (U9). Drag it
 * and the leader bends there: a hand elbow, kept by Spread tags. Esc during
 * the drag puts it back; nothing is sent until the button comes up.
 */
export function TagElbowGrip({ model, view, item, toPaper, toStored, paperOf, paperMmPerPx, editBlocked, send }: Props) {
  const [drag, setDrag] = useState<{ readonly pointerId: number; readonly to: Vec2 } | null>(null)

  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDrag(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag])

  const leader = tagElbowLeader(model, view, item)
  if (!leader?.elbow || !item.tag) return null
  const { toModel } = paperMapping(view)
  const bend = toPaper(toModel(leader.elbow))
  const start = leader.points[0] ? toPaper(toModel(leader.points[0])) : null
  const targetModel = tagTarget(model, view, item.tag)
  const target = targetModel ? toPaper(targetModel) : null
  const size = GRIP_PX * paperMmPerPx
  const at = drag?.to ?? bend

  return (
    <g data-testid="tag-elbow-grip-layer">
      {drag && start && target && <polyline points={[start, at, target].map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={SELECTION} strokeDasharray={`${2 * paperMmPerPx} ${2 * paperMmPerPx}`} strokeWidth={paperMmPerPx} data-testid="tag-elbow-preview" />}
      <rect
        x={at.x - size / 2}
        y={at.y - size / 2}
        width={size}
        height={size}
        fill="white"
        stroke={SELECTION}
        strokeWidth={1.5 * paperMmPerPx}
        className={editBlocked ? 'cursor-not-allowed' : 'cursor-move'}
        role="button"
        aria-label={editBlocked ? `Leader bend (${editBlocked})` : 'Drag to bend the leader; Esc puts it back'}
        data-testid="tag-elbow-grip"
        onPointerDown={(e) => {
          if (e.button !== 0 || editBlocked) return
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ pointerId: e.pointerId, to: bend })
        }}
        onPointerMove={(e) => {
          if (!drag || e.pointerId !== drag.pointerId) return
          const p = paperOf(e)
          if (p) setDrag({ pointerId: drag.pointerId, to: p })
        }}
        onPointerUp={(e) => {
          if (!drag || e.pointerId !== drag.pointerId) return
          e.stopPropagation()
          const to = paperOf(e) ?? drag.to
          setDrag(null)
          const moved = Math.hypot(to.x - bend.x, to.y - bend.y) > 0.2
          const c = moved ? elbowGripCommand(item, toStored(to)) : null
          if (c) send(c)
        }}
        onLostPointerCapture={() => setDrag(null)}
      >
        <title>{editBlocked ?? 'Drag to bend the leader. Right-click › Straighten leader puts it back to automatic.'}</title>
      </rect>
    </g>
  )
}
