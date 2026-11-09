'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { orientationFor, projectAxis, SIDE_LABEL, type ModelAxis, type Orientation, type Side } from '@permitzip/bim-viewer-3d/light'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '../../ui/cn'

const SIZE = 72
const CENTRE = SIZE / 2
/** Radius of the ball, px. The dots sit on its surface. */
const RADIUS = 26
/** Dot diameter, px, at the far pole and the near pole. */
const DOT_FAR_PX = 13
const DOT_NEAR_PX = 18
/** Stacking: far dots under the ball, near dots over it. */
const BALL_Z = 10
/** Pixels of pointer travel before a press becomes an orbit drag. */
const DRAG_PX = 3
/** Radians of orbit per pixel dragged. */
const DRAG_RAD_PER_PX = 0.012

interface Dot {
  readonly side: Side
  readonly axis: ModelAxis
  /** +1 for the axis's positive end (east, north, up), -1 for its negative end. */
  readonly sign: 1 | -1
  readonly label: string
}

/** The six dots on the ball, one per side of the model. Each one turns the camera to look from that side; there is nothing else to pick. */
export const BALL_DOTS: readonly Dot[] = [
  { side: 'east', axis: 'x', sign: 1, label: 'E' },
  { side: 'west', axis: 'x', sign: -1, label: 'W' },
  { side: 'north', axis: 'y', sign: 1, label: 'N' },
  { side: 'south', axis: 'y', sign: -1, label: 'S' },
  { side: 'top', axis: 'z', sign: 1, label: 'Up' },
  { side: 'bottom', axis: 'z', sign: -1, label: 'Dn' },
]

export const lookFromLabel = (side: Side) => (side === 'top' ? 'Look from the top' : side === 'bottom' ? 'Look from below' : `Look from the ${side}`)

const DOT_CLASS = 'border-(--mutiny-border) bg-(--mutiny-panel) text-(--mutiny-text) hover:bg-(--mutiny-subtle) hover:text-(--mutiny-text) dark:hover:bg-(--mutiny-subtle)'
const NORTH_DOT_CLASS =
  'border-(--mutiny-accent) bg-(--mutiny-accent) text-(--mutiny-accent-foreground) hover:bg-(--mutiny-accent) hover:text-(--mutiny-accent-foreground) hover:brightness-95 dark:hover:bg-(--mutiny-accent)'

interface Props {
  readonly viewer: Pick<ModelViewer3D, 'orientation' | 'onCameraChange' | 'orientTo' | 'orbitBy'>
}

/**
 * A smooth shaded ball with six dots on its surface, one where each side of
 * the model (E, W, N, S, Up, Dn) faces the camera. A dot turns the camera to
 * look from that side; dragging anywhere on the ball orbits freely and never
 * settles on a preset. The ball itself has no faces, edges or corners and
 * nothing on it is selectable but the dots. Three-quarter views live in the
 * Orientation options menu, not here.
 *
 * Follows the camera through refs, not React state, so orbiting re-renders nothing.
 */
export function OrientationBall({ viewer }: Props) {
  const ids = useId()
  const shadeId = `${ids}-shade`
  const shadowId = `${ids}-shadow`
  const equatorRef = useRef<SVGEllipseElement | null>(null)
  const dotRefs = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({})
  const [available, setAvailable] = useState(true)
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  /** The last press orbited, so the click that ends it is not a pick. */
  const dragged = useRef(false)

  const place = useCallback((o: Orientation) => {
    for (const dot of BALL_DOTS) {
      const p = projectAxis(o, dot.axis)
      const button = dotRefs.current[dot.side]
      if (!button) continue
      // -1 at the far pole, +1 at the near pole.
      const depth = dot.sign * p.z
      const near = depth >= 0
      const px = DOT_FAR_PX + ((DOT_NEAR_PX - DOT_FAR_PX) * (depth + 1)) / 2
      button.style.left = `${CENTRE + dot.sign * p.x * RADIUS}px`
      button.style.top = `${CENTRE + dot.sign * p.y * RADIUS}px`
      button.style.width = `${px.toFixed(2)}px`
      button.style.height = `${px.toFixed(2)}px`
      button.style.fontSize = `${(px * 0.46).toFixed(2)}px`
      button.style.opacity = near ? '1' : (1 + depth * 0.4).toFixed(2)
      button.style.zIndex = String(near ? BALL_Z + 10 + Math.round(depth * 10) : 1 + Math.round((depth + 1) * 8))
      button.dataset.depth = near ? 'near' : 'far'
    }
    // The horizon: the circle through E, N, W and S, drawn as the camera sees it.
    const e = projectAxis(o, 'x')
    const n = projectAxis(o, 'y')
    equatorRef.current?.setAttribute('transform', `matrix(${[e.x, e.y, n.x, n.y].map((v) => (v * RADIUS).toFixed(3)).join(' ')} ${CENTRE} ${CENTRE})`)
  }, [])

  const follow = useCallback(() => {
    const o = viewer.orientation()
    setAvailable(o !== null)
    if (o) place(o)
  }, [viewer, place])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        follow()
      })
    }
    schedule()
    const off = viewer.onCameraChange(schedule)
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [viewer, follow])

  const lookFrom = useCallback(
    (side: Side) => {
      void viewer.orientTo(orientationFor(side)).catch((err: unknown) => console.error('[OrientationBall] turning the camera failed', { side, err }))
    },
    [viewer],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragged.current = false
    press.current = { x: e.clientX, y: e.clientY, dragging: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = press.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < DRAG_PX) return
      d.dragging = true
      dragged.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    viewer.orbitBy(-dx * DRAG_RAD_PER_PX, -dy * DRAG_RAD_PER_PX)
    d.x = e.clientX
    d.y = e.clientY
  }
  const endPress = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = press.current
    press.current = null
    if (d?.dragging && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (!available) return null

  return (
    <div
      className="relative cursor-grab touch-none select-none rounded-full active:cursor-grabbing"
      style={{ width: SIZE, height: SIZE }}
      data-testid="orientation-ball"
      role="group"
      aria-label="Orientation ball. Click a dot to look from that side; drag the ball to orbit."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-visible"
        style={{ zIndex: BALL_Z }}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        data-testid="orientation-ball-shape"
      >
        <defs>
          {/* Lit from the upper left: a soft highlight falling off to a darker rim. */}
          <radialGradient id={shadeId} cx="0.36" cy="0.32" r="0.72">
            <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--mutiny-panel) 45%, white)' }} />
            <stop offset="0.5" style={{ stopColor: 'color-mix(in srgb, var(--mutiny-panel) 70%, var(--mutiny-subtle))' }} />
            <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--mutiny-subtle) 72%, black)' }} />
          </radialGradient>
          <radialGradient id={shadowId}>
            <stop offset="0" style={{ stopColor: 'black', stopOpacity: 0.3 }} />
            <stop offset="1" style={{ stopColor: 'black', stopOpacity: 0 }} />
          </radialGradient>
        </defs>
        <ellipse cx={CENTRE} cy={CENTRE + RADIUS * 0.92} rx={RADIUS * 0.82} ry={RADIUS * 0.2} fill={`url(#${shadowId})`} />
        <circle cx={CENTRE} cy={CENTRE} r={RADIUS} fill={`url(#${shadeId})`} fillOpacity={0.84} style={{ stroke: 'var(--mutiny-border)' }} strokeOpacity={0.7} strokeWidth={0.75} />
        <ellipse
          ref={equatorRef}
          cx={0}
          cy={0}
          rx={1}
          ry={1}
          fill="none"
          style={{ stroke: 'var(--mutiny-muted)' }}
          strokeOpacity={0.35}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          transform={`matrix(${RADIUS} 0 0 ${RADIUS} ${CENTRE} ${CENTRE})`}
          data-testid="orientation-ball-horizon"
        />
      </svg>
      {BALL_DOTS.map((dot) => (
        <Tooltip key={dot.side}>
          <TooltipTrigger asChild>
            <Button
              ref={(el) => {
                dotRefs.current[dot.side] = el
              }}
              type="button"
              variant="ghost"
              aria-label={lookFromLabel(dot.side)}
              data-testid={`orientation-ball-${dot.side}`}
              onClick={(e) => {
                // A drag that ends over a dot is an orbit, not a pick. Keyboard clicks (detail 0) always pick.
                if (e.detail !== 0 && dragged.current) return
                lookFrom(dot.side)
              }}
              style={{ left: CENTRE, top: CENTRE, width: DOT_NEAR_PX, height: DOT_NEAR_PX }}
              className={cn(
                'absolute min-w-0 -translate-x-1/2 -translate-y-1/2 rounded-full p-0 font-semibold leading-none shadow-sm transition-[background-color,color,filter] active:not-aria-[haspopup]:-translate-y-1/2',
                dot.side === 'north' ? NORTH_DOT_CLASS : DOT_CLASS,
              )}
            >
              {dot.label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`${lookFromLabel(dot.side)} (${SIDE_LABEL[dot.side]})`}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
