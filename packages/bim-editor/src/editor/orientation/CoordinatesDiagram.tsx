'use client'

import { useState } from 'react'
import { cn } from '../../ui/cn'
import type { OriginMoveMode } from '../coordinates'

/** Which idea the diagram is explaining right now (the dialog's open tab). */
export type CoordinatesTopic = 'origin' | 'site_point' | 'north' | 'working_angle'

/** The illustrative skew of the building and true north in the picture (not the model's values: it explains, it doesn't map). */
const BUILDING_DEG = -18
const NORTH_DEG = 28

const CSS = `
@keyframes bm-coord-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
@keyframes bm-coord-slide-marker { 0%, 15% { transform: translate(0, 0) } 55%, 85% { transform: translate(34px, -11px) } 100% { transform: translate(0, 0) } }
@keyframes bm-coord-slide-building { 0%, 15% { transform: translate(0, 0) } 55%, 85% { transform: translate(-26px, 14px) } 100% { transform: translate(0, 0) } }
@keyframes bm-coord-sweep { 0%, 15% { stroke-dashoffset: 60 } 60%, 100% { stroke-dashoffset: 0 } }
.bm-coord-svg g[transform] { transform-origin: 0 0; transform-box: view-box; }
.bm-coord-anim { animation-duration: 4s; animation-iteration-count: infinite; animation-timing-function: ease-in-out; transform-box: view-box; }
.bm-coord-pulse { animation-name: bm-coord-pulse; animation-duration: 1.6s; }
.bm-coord-slide-marker { animation-name: bm-coord-slide-marker; }
.bm-coord-slide-building { animation-name: bm-coord-slide-building; }
.bm-coord-sweep { animation-name: bm-coord-sweep; }
@media (prefers-reduced-motion: reduce) { .bm-coord-anim { animation: none !important; } }
`

const CAPTION: Readonly<Record<CoordinatesTopic, string>> = {
  origin: 'The project origin sits on the building. Your drawings and site coordinates are measured from it.',
  site_point: 'The site point is a fixed mark on the land, usually from the survey. It stays put when the building moves on the site.',
  north: 'True north is real-world north. Plan north is straight up on your screen. The angle between them is set once, for the whole model.',
  working_angle: 'The working angle turns the directions you draw in to match the building’s walls. Nothing moves.',
}

/**
 * A small picture of the four ideas in the Coordinates dialog: the project
 * origin on the building, the site point on the land, true north against plan
 * north (up on the screen), and the working angle along the building's walls.
 * The open tab's idea is drawn strong and moves; the rest fade back.
 */
export function CoordinatesDiagram({ topic, mode }: { readonly topic: CoordinatesTopic; readonly mode: OriginMoveMode }) {
  const [reducedMotion] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const dim = (on: boolean) => (on ? 'opacity-100' : 'opacity-30')
  const relocating = topic === 'origin' && mode === 'relocate_project'
  const movingMarker = topic === 'origin' && mode === 'move_point'
  return (
    <figure className="flex flex-col gap-1" data-testid="coordinates-diagram" data-topic={topic}>
      <style>{CSS}</style>
      <svg viewBox="0 0 320 150" role="img" aria-labelledby="bm-coord-diagram-caption" className="bm-coord-svg h-auto w-full rounded-md border bg-muted/40 text-[9px]">
        {/* The site: a faint survey grid. */}
        <g className="stroke-border" strokeWidth={0.5}>
          {[40, 80, 120, 160, 200, 240, 280].map((x) => (
            <line key={`v${x}`} x1={x} y1={8} x2={x} y2={142} />
          ))}
          {[30, 60, 90, 120].map((y) => (
            <line key={`h${y}`} x1={8} y1={y} x2={312} y2={y} />
          ))}
        </g>

        {/* Model zero: the model's own 0,0,0. */}
        <g className={dim(topic === 'origin')} data-testid="diagram-model-zero">
          <circle cx={46} cy={124} r={2.5} className="fill-muted-foreground" />
          <text x={52} y={127} className="fill-muted-foreground">Model zero</text>
        </g>

        {/* The building, skewed on the site, with its project origin on a corner. */}
        <g className={cn(relocating && 'bm-coord-anim bm-coord-slide-building')}>
          <g transform={`rotate(${BUILDING_DEG} 150 82)`}>
            <rect x={108} y={56} width={84} height={52} className="fill-background stroke-foreground" strokeWidth={1.2} data-testid="diagram-building" />
            <text x={176} y={102} textAnchor="middle" className="fill-muted-foreground">Building</text>
            {/* Working axes along the walls. */}
            <g className={dim(topic === 'working_angle')} data-testid="diagram-working-axes">
              <line x1={96} y1={108} x2={204} y2={108} className="stroke-success-600" strokeWidth={1.2} strokeDasharray="4 3" />
              <line x1={108} y1={120} x2={108} y2={46} className="stroke-success-600" strokeWidth={1.2} strokeDasharray="4 3" />
            </g>
          </g>
          <g className={cn(dim(topic === 'origin'), topic === 'origin' && 'bm-coord-anim bm-coord-pulse')} data-testid="diagram-project-origin">
            <g className={cn(movingMarker && 'bm-coord-anim bm-coord-slide-marker')}>
              <circle cx={118} cy={113} r={5} className="fill-info-500/20 stroke-info-600" strokeWidth={1.4} />
              <line x1={113} y1={113} x2={123} y2={113} className="stroke-info-600" strokeWidth={1.2} />
              <line x1={118} y1={108} x2={118} y2={118} className="stroke-info-600" strokeWidth={1.2} />
            </g>
            <text x={96} y={134} className="fill-info-700">Project origin</text>
          </g>
        </g>

        {/* The working angle: screen-square axes turning to the building (at rest, and with reduced motion, already turned). */}
        {topic === 'working_angle' && (
          <g transform={`rotate(${BUILDING_DEG} 150 82)`} data-testid="diagram-working-turn">
            {!reducedMotion && (
              <animateTransform attributeName="transform" type="rotate" values={`0 150 82; 0 150 82; ${BUILDING_DEG} 150 82; ${BUILDING_DEG} 150 82`} keyTimes="0; 0.15; 0.55; 1" dur="4s" repeatCount="indefinite" />
            )}
            <line x1={150} y1={82} x2={196} y2={82} className="stroke-success-600" strokeWidth={1.6} />
            <line x1={150} y1={82} x2={150} y2={36} className="stroke-success-600" strokeWidth={1.6} />
            <text x={199} y={85} className="fill-success-700">X</text>
            <text x={147} y={33} className="fill-success-700">Y</text>
          </g>
        )}
        <text x={214} y={118} className={cn('fill-success-700', dim(topic === 'working_angle'))}>Working angle</text>

        {/* The site point: a fixed mark on the land. */}
        <g className={cn(dim(topic === 'site_point'), topic === 'site_point' && 'bm-coord-anim bm-coord-pulse')} data-testid="diagram-site-point">
          <path d="M 252 40 L 259 52 L 245 52 Z" className="fill-warning-500/30 stroke-warning-600" strokeWidth={1.2} />
          <text x={232} y={63} className="fill-warning-700">Site point</text>
        </g>

        {/* North: plan north (up on the screen) and true north, drawn once. */}
        <g className={dim(topic === 'north')} data-testid="diagram-north">
          <line x1={34} y1={58} x2={34} y2={18} className="stroke-muted-foreground" strokeWidth={1.2} strokeDasharray="3 2" />
          <text x={20} y={14} className="fill-muted-foreground">Plan north</text>
          <g transform={`rotate(${NORTH_DEG} 34 58)`}>
            <line x1={34} y1={58} x2={34} y2={20} className="stroke-danger-600" strokeWidth={1.6} />
            <path d="M 34 14 L 38 23 L 30 23 Z" className="fill-danger-600" />
          </g>
          <text x={56} y={26} className="fill-danger-600">True north</text>
          {topic === 'north' && (
            <path d="M 34 34 A 24 24 0 0 1 45.3 36.8" className="bm-coord-anim bm-coord-sweep fill-none stroke-danger-600" strokeWidth={1} strokeDasharray="60" />
          )}
        </g>
      </svg>
      <figcaption id="bm-coord-diagram-caption" className="text-xs text-muted-foreground" data-testid="coordinates-diagram-caption">
        {CAPTION[topic]}
      </figcaption>
    </figure>
  )
}
