'use client'

import type { ReactNode } from 'react'
import { hostLineOf, type BimElement, type Vec2 } from '@permitzip/bim-kernel'
import { feetInches } from '../placement'
import { rectangleCorners, type Draft } from './tools/draft'
import type { Snap } from './tools/snap'

type ToScreen = (p: Vec2) => { readonly x: number; readonly y: number } | null

interface Props {
  readonly draft: Draft
  /** The snapped point under the pointer; null off the plan. */
  readonly pointer: Vec2 | null
  readonly snap: Snap | null
  readonly elements: Readonly<Record<string, BimElement>>
  readonly toScreen: ToScreen
}

function pathOf(points: readonly Vec2[], toScreen: ToScreen, close: boolean): string | null {
  const parts: string[] = []
  for (const p of points) {
    const s = toScreen(p)
    if (!s) return null
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`)
  }
  if (parts.length < 2) return null
  return close ? `${parts.join(' ')} Z` : parts.join(' ')
}

function lengthLabel(a: Vec2, b: Vec2, toScreen: ToScreen): ReactNode {
  const sa = toScreen(a)
  const sb = toScreen(b)
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (!sa || !sb || len < 1) return null
  const deg = Math.round(((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360)
  return (
    <text x={(sa.x + sb.x) / 2} y={(sa.y + sb.y) / 2 - 8} textAnchor="middle" className="fill-foreground stroke-background text-xs font-medium" paintOrder="stroke" strokeWidth={3} data-testid="architecture-draft-length">
      {`${feetInches(len)} · ${deg}°`}
    </text>
  )
}

/**
 * What the armed Architecture tool will make, drawn over the canvas as the
 * pointer moves: the corners clicked, the next segment with its length and
 * angle, a floor's sketch, the door or window on its wall, the walls a floor
 * or room would fill, and what the pointer snapped to.
 */
export function DraftOverlay({ draft, pointer, snap, elements, toScreen }: Props): ReactNode {
  const { tool, chain, aim, face } = draft
  const corners = chain.points
  const last = corners[corners.length - 1]
  const drawn = tool.mode === 'chain' || tool.mode === 'line' || tool.mode === 'area' ? pathOf(corners, toScreen, false) : null
  const band = last && pointer ? pathOf([last, pointer], toScreen, false) : null
  const first = corners[0]
  const sketch =
    tool.mode === 'area' && corners.length >= 2 && pointer
      ? pathOf([...corners, pointer], toScreen, true)
      : tool.mode === 'rectangle' && first && pointer
        ? pathOf(rectangleCorners(first, pointer), toScreen, true)
        : null
  const fill = face?.ok ? pathOf(face.outline, toScreen, true) : null

  let ghost: ReactNode = null
  if (aim?.ok) {
    const host = elements[aim.hostId]
    const line = host ? hostLineOf(host, elements) : null
    if (line) {
      const len = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) || 1
      const u = { x: (line.end.x - line.start.x) / len, y: (line.end.y - line.start.y) / len }
      const n = { x: -u.y * draft.side, y: u.x * draft.side }
      const h = aim.widthMm / 2
      const w = line.widthMm / 2
      const a = { x: aim.at.x - u.x * h, y: aim.at.y - u.y * h }
      const b = { x: aim.at.x + u.x * h, y: aim.at.y + u.y * h }
      const body = pathOf([{ x: a.x + n.x * w, y: a.y + n.y * w }, { x: b.x + n.x * w, y: b.y + n.y * w }, { x: b.x - n.x * w, y: b.y - n.y * w }, { x: a.x - n.x * w, y: a.y - n.y * w }], toScreen, true)
      // A door's leaf swings to the side it opens to.
      const leaf = tool.kind === 'door' ? pathOf([a, { x: a.x + n.x * aim.widthMm, y: a.y + n.y * aim.widthMm }], toScreen, false) : null
      ghost = (
        <g data-testid="architecture-opening-ghost">
          {body && <path d={body} className="fill-primary/30 stroke-primary" strokeWidth={2} />}
          {leaf && <path d={leaf} className="stroke-primary" strokeWidth={2} />}
        </g>
      )
    }
  }

  const mark = snap && pointer ? toScreen(snap.point) : null
  const guide = snap?.guide ? pathOf([snap.guide.start, snap.guide.end], toScreen, false) : null

  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden data-testid="architecture-draft-overlay" data-corners={corners.length}>
      {fill && <path d={fill} className="fill-primary/15 stroke-primary" strokeWidth={2} data-testid="architecture-face-preview" />}
      {sketch && <path d={sketch} className="fill-primary/10 stroke-none" />}
      {guide && <path d={guide} className="stroke-info-500" strokeWidth={1} strokeDasharray="6 4" />}
      {drawn && <path d={drawn} className="fill-none stroke-primary" strokeWidth={3} data-testid="architecture-draft-drawn" />}
      {band && <path d={band} className="fill-none stroke-primary" strokeWidth={2} strokeDasharray="8 5" data-testid="architecture-draft-band" />}
      {last && pointer ? lengthLabel(last, pointer, toScreen) : null}
      {ghost}
      {mark && (
        <g data-testid="architecture-snap-marker" data-kind={snap?.kind}>
          <rect x={mark.x - 5} y={mark.y - 5} width={10} height={10} className="fill-none stroke-warning-500" strokeWidth={2} transform={snap?.kind === 'middle' || snap?.kind === 'crossing' ? `rotate(45 ${mark.x} ${mark.y})` : undefined} />
          {snap?.kind === 'perpendicular' && <path d={`M${mark.x - 12} ${mark.y - 14} L${mark.x - 12} ${mark.y - 6} L${mark.x - 4} ${mark.y - 6}`} className="fill-none stroke-warning-500" strokeWidth={1.5} data-testid="architecture-perpendicular-mark" />}
          {snap && snap.kind !== 'grid' && (
            <text x={mark.x + 10} y={mark.y + 18} className="fill-foreground stroke-background text-xs" paintOrder="stroke" strokeWidth={3} data-testid="architecture-snap-label">
              {snap.label}
            </text>
          )}
        </g>
      )}
    </svg>
  )
}
