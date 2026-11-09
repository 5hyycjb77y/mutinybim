'use client'

import type { Primitive, Vec2 } from '@permitzip/bim-kernel'
import type { Constrained } from './draft-input'

const PRIMARY = 'var(--mutiny-selection)'

/** What a Draft tool will draw, as it will print, plus the rubber band, the snap marker and the tracking line. Never takes the pointer. */
export function DraftOverlay({ prims, rubber, marker, zoom }: { prims: readonly Primitive[]; rubber: readonly Vec2[]; marker: Constrained | null; zoom: number }) {
  const w = 0.35 / Math.max(zoom, 0.25)
  return (
    <g pointerEvents="none" data-testid="draft-preview">
      {prims.map((p, i) => {
        if (p.kind === 'line') return <line key={i} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={PRIMARY} strokeWidth={w} strokeDasharray={p.dash?.join(' ')} />
        if (p.kind === 'fill') return <polygon key={i} points={p.points.map((q) => `${q.x},${q.y}`).join(' ')} fill={PRIMARY} fillOpacity={p.grey >= 1 ? 0.08 : 0.25} />
        return null
      })}
      {rubber.length > 1 && <polyline points={rubber.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={PRIMARY} strokeWidth={w} strokeDasharray="1.2 0.8" strokeOpacity={0.6} />}
      {rubber.map((q, i) => (
        <circle key={`c${i}`} cx={q.x} cy={q.y} r={0.6 / Math.max(zoom, 0.25)} fill={PRIMARY} />
      ))}
      {marker?.tracking && <TrackingLine from={marker.tracking.from} angleDeg={marker.tracking.angleDeg} width={w} />}
      {marker?.snapLabel && (
        <g data-testid="draft-snap" data-snap={marker.snapLabel}>
          <rect x={marker.at.x - 1.3 / Math.max(zoom, 0.25)} y={marker.at.y - 1.3 / Math.max(zoom, 0.25)} width={2.6 / Math.max(zoom, 0.25)} height={2.6 / Math.max(zoom, 0.25)} fill="none" stroke={PRIMARY} strokeWidth={w * 1.3} />
          <title>{`Snaps to the ${marker.snapLabel}`}</title>
        </g>
      )}
    </g>
  )
}

function TrackingLine({ from, angleDeg, width }: { from: Vec2; angleDeg: number; width: number }) {
  // Paper is y-down; tracking angles are counter-clockwise on paper as you see it.
  const r = (angleDeg * Math.PI) / 180
  const far = 2000
  return <line x1={from.x} y1={from.y} x2={from.x + far * Math.cos(r)} y2={from.y - far * Math.sin(r)} stroke={PRIMARY} strokeWidth={width} strokeDasharray="0.6 1" strokeOpacity={0.7} data-testid="draft-tracking" />
}
