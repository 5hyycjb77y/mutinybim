'use client'

import { formatLengthImperial, type Primitive, type SnapKind, type Vec2 } from '@permitzip/bim-kernel'
import type { Constrained } from './draft-input'

const PRIMARY = 'var(--mutiny-selection)'
const CROSSING = '#15803d'

function SnapGlyph({ at, kind, r, strokeWidth }: { at: Vec2; kind: SnapKind | null | undefined; r: number; strokeWidth: number }) {
  switch (kind) {
    case 'midpoint':
      return <polygon points={`${at.x},${at.y - r * 1.15} ${at.x - r * 1.05},${at.y + r * 0.85} ${at.x + r * 1.05},${at.y + r * 0.85}`} fill="none" stroke={PRIMARY} strokeWidth={strokeWidth} />
    case 'center':
      return <circle cx={at.x} cy={at.y} r={r} fill="none" stroke={PRIMARY} strokeWidth={strokeWidth} />
    case 'quadrant':
      return <polygon points={`${at.x},${at.y - r * 1.15} ${at.x + r * 1.15},${at.y} ${at.x},${at.y + r * 1.15} ${at.x - r * 1.15},${at.y}`} fill="none" stroke={PRIMARY} strokeWidth={strokeWidth} />
    case 'tangent':
      return (
        <g stroke={PRIMARY} strokeWidth={strokeWidth} fill="none">
          <circle cx={at.x} cy={at.y} r={r * 0.85} />
          <line x1={at.x - r * 1.2} y1={at.y - r * 0.85} x2={at.x + r * 1.2} y2={at.y - r * 0.85} />
        </g>
      )
    case 'intersection':
      return (
        <g stroke={PRIMARY} strokeWidth={strokeWidth}>
          <line x1={at.x - r} y1={at.y - r} x2={at.x + r} y2={at.y + r} />
          <line x1={at.x + r} y1={at.y - r} x2={at.x - r} y2={at.y + r} />
        </g>
      )
    case 'perpendicular':
      return (
        <g stroke={PRIMARY} strokeWidth={strokeWidth} fill="none">
          <polyline points={`${at.x - r},${at.y - r} ${at.x - r},${at.y + r} ${at.x + r},${at.y + r}`} />
          <polyline points={`${at.x - r},${at.y} ${at.x},${at.y} ${at.x},${at.y + r}`} />
        </g>
      )
    default:
      return <rect x={at.x - r} y={at.y - r} width={r * 2} height={r * 2} fill="none" stroke={PRIMARY} strokeWidth={strokeWidth} />
  }
}

/** What a Draft tool will draw, as it will print, plus the rubber band, temporary/listening dimension, snap glyph, tracking line, and marquee box. Never takes the pointer. */
export function DraftOverlay({
  prims,
  rubber,
  marker,
  zoom,
  typedLength = '',
  storedPerPaperMm = 1,
  marquee = null,
}: {
  prims: readonly Primitive[]
  rubber: readonly Vec2[]
  marker: Constrained | null
  zoom: number
  typedLength?: string
  storedPerPaperMm?: number
  marquee?: { readonly a: Vec2; readonly b: Vec2 } | null
}) {
  const px = 1 / Math.max(zoom, 0.25)
  const w = 0.35 * px
  const r = 1.3 * px
  const segA = rubber.length >= 2 ? rubber[rubber.length - 2] : null
  const segB = rubber.length >= 2 ? rubber[rubber.length - 1] : null
  const segLenPaper = segA && segB ? Math.hypot(segB.x - segA.x, segB.y - segA.y) : 0
  const segLabel =
    segA && segB && (segLenPaper > 0.3 || typedLength.length > 0)
      ? typedLength.length > 0
        ? `${typedLength} ↵`
        : `${formatLengthImperial(segLenPaper * storedPerPaperMm)} · ${Math.round(((Math.atan2(-(segB.y - segA.y), segB.x - segA.x) * 180) / Math.PI + 360) % 360)}°`
      : null
  const segMid = segA && segB ? { x: (segA.x + segB.x) / 2, y: (segA.y + segB.y) / 2 } : null

  return (
    <g pointerEvents="none" data-testid="draft-preview">
      {marquee && (() => {
        const crossing = marquee.b.x < marquee.a.x
        const x = Math.min(marquee.a.x, marquee.b.x)
        const y = Math.min(marquee.a.y, marquee.b.y)
        const mw = Math.abs(marquee.b.x - marquee.a.x)
        const mh = Math.abs(marquee.b.y - marquee.a.y)
        return (
          <rect
            x={x}
            y={y}
            width={mw}
            height={mh}
            fill={crossing ? CROSSING : PRIMARY}
            fillOpacity={0.08}
            stroke={crossing ? CROSSING : PRIMARY}
            strokeWidth={w * 1.2}
            strokeDasharray={crossing ? `${2 * px} ${1.2 * px}` : undefined}
            data-testid={crossing ? 'marquee-crossing' : 'marquee-window'}
          />
        )
      })()}
      {prims.map((p, i) => {
        if (p.kind === 'line') return <line key={i} x1={p.a.x} y1={p.a.y} x2={p.b.x} y2={p.b.y} stroke={PRIMARY} strokeWidth={w} strokeDasharray={p.dash?.join(' ')} />
        if (p.kind === 'fill') return <polygon key={i} points={p.points.map((q) => `${q.x},${q.y}`).join(' ')} fill={PRIMARY} fillOpacity={p.grey >= 1 ? 0.08 : 0.25} />
        return null
      })}
      {rubber.length > 1 && <polyline points={rubber.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={PRIMARY} strokeWidth={w} strokeDasharray="1.2 0.8" strokeOpacity={0.6} />}
      {rubber.map((q, i) => (
        <circle key={`c${i}`} cx={q.x} cy={q.y} r={0.6 * px} fill={PRIMARY} />
      ))}
      {segLabel && segMid && (
        <g data-testid="draft-temp-dim">
          <rect
            x={segMid.x - (segLabel.length * 1.05 + 2.4) * px}
            y={segMid.y - 5.8 * px}
            width={(segLabel.length * 2.1 + 4.8) * px}
            height={4.6 * px}
            rx={1 * px}
            fill={typedLength ? PRIMARY : '#ffffff'}
            stroke={PRIMARY}
            strokeWidth={w}
          />
          <text
            x={segMid.x}
            y={segMid.y - 2.5 * px}
            textAnchor="middle"
            fontSize={2.8 * px}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill={typedLength ? '#ffffff' : PRIMARY}
          >
            {segLabel}
          </text>
        </g>
      )}
      {marker?.tracking && <TrackingLine from={marker.tracking.from} angleDeg={marker.tracking.angleDeg} width={w} />}
      {marker?.snapLabel && (
        <g data-testid="draft-snap" data-snap={marker.snapLabel}>
          <SnapGlyph at={marker.at} kind={marker.snapKind} r={r} strokeWidth={w * 1.3} />
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
