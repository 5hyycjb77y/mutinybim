'use client'

import { formatLengthImperial, type Primitive, type SnapKind, type Vec2 } from '@permitzip/bim-kernel'
import type { Constrained } from './draft-input'

const PRIMARY = 'var(--mutiny-selection)'
const REVIT_BLUE = '#0284c7'
const SNAP_ACCENT = '#c026d3'
const CLOSE_GREEN = '#16a34a'
const CROSSING = '#15803d'

function SnapGlyph({ at, kind, r, strokeWidth, closeLoop }: { at: Vec2; kind: SnapKind | null | undefined; r: number; strokeWidth: number; closeLoop?: boolean }) {
  const color = closeLoop ? CLOSE_GREEN : SNAP_ACCENT
  if (closeLoop) {
    return (
      <g>
        <circle cx={at.x} cy={at.y} r={r * 1.45} fill="#ffffff" fillOpacity={0.9} stroke={CLOSE_GREEN} strokeWidth={strokeWidth * 1.15} />
        <circle cx={at.x} cy={at.y} r={r * 0.7} fill="none" stroke={CLOSE_GREEN} strokeWidth={strokeWidth} />
      </g>
    )
  }
  const halo = strokeWidth * 2.4
  switch (kind) {
    case 'midpoint': {
      const pts = `${at.x},${at.y - r * 1.2} ${at.x - r * 1.1},${at.y + r * 0.9} ${at.x + r * 1.1},${at.y + r * 0.9}`
      return (
        <g fill="none">
          <polygon points={pts} stroke="#ffffff" strokeWidth={halo} strokeLinejoin="round" />
          <polygon points={pts} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </g>
      )
    }
    case 'center':
      return (
        <g fill="none">
          <circle cx={at.x} cy={at.y} r={r} stroke="#ffffff" strokeWidth={halo} />
          <circle cx={at.x} cy={at.y} r={r} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
    case 'quadrant': {
      const pts = `${at.x},${at.y - r * 1.2} ${at.x + r * 1.2},${at.y} ${at.x},${at.y + r * 1.2} ${at.x - r * 1.2},${at.y}`
      return (
        <g fill="none">
          <polygon points={pts} stroke="#ffffff" strokeWidth={halo} strokeLinejoin="round" />
          <polygon points={pts} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
        </g>
      )
    }
    case 'tangent':
      return (
        <g fill="none">
          <circle cx={at.x} cy={at.y} r={r * 0.85} stroke="#ffffff" strokeWidth={halo} />
          <line x1={at.x - r * 1.2} y1={at.y - r * 0.85} x2={at.x + r * 1.2} y2={at.y - r * 0.85} stroke="#ffffff" strokeWidth={halo} />
          <circle cx={at.x} cy={at.y} r={r * 0.85} stroke={color} strokeWidth={strokeWidth} />
          <line x1={at.x - r * 1.2} y1={at.y - r * 0.85} x2={at.x + r * 1.2} y2={at.y - r * 0.85} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
    case 'intersection':
      return (
        <g>
          <line x1={at.x - r} y1={at.y - r} x2={at.x + r} y2={at.y + r} stroke="#ffffff" strokeWidth={halo} />
          <line x1={at.x + r} y1={at.y - r} x2={at.x - r} y2={at.y + r} stroke="#ffffff" strokeWidth={halo} />
          <line x1={at.x - r} y1={at.y - r} x2={at.x + r} y2={at.y + r} stroke={color} strokeWidth={strokeWidth} />
          <line x1={at.x + r} y1={at.y - r} x2={at.x - r} y2={at.y + r} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
    case 'perpendicular':
      return (
        <g fill="none">
          <polyline points={`${at.x - r},${at.y - r} ${at.x - r},${at.y + r} ${at.x + r},${at.y + r}`} stroke="#ffffff" strokeWidth={halo} />
          <polyline points={`${at.x - r},${at.y} ${at.x},${at.y} ${at.x},${at.y + r}`} stroke="#ffffff" strokeWidth={halo} />
          <polyline points={`${at.x - r},${at.y - r} ${at.x - r},${at.y + r} ${at.x + r},${at.y + r}`} stroke={color} strokeWidth={strokeWidth} />
          <polyline points={`${at.x - r},${at.y} ${at.x},${at.y} ${at.x},${at.y + r}`} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
    case 'nearest':
      return (
        <g fill="none">
          <polygon points={`${at.x - r},${at.y - r * 0.85} ${at.x + r},${at.y - r * 0.85} ${at.x - r},${at.y + r * 0.85} ${at.x + r},${at.y + r * 0.85}`} stroke="#ffffff" strokeWidth={halo} />
          <polygon points={`${at.x - r},${at.y - r * 0.85} ${at.x + r},${at.y - r * 0.85} ${at.x - r},${at.y + r * 0.85} ${at.x + r},${at.y + r * 0.85}`} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
    default:
      return (
        <g fill="none">
          <rect x={at.x - r} y={at.y - r} width={r * 2} height={r * 2} stroke="#ffffff" strokeWidth={halo} />
          <rect x={at.x - r} y={at.y - r} width={r * 2} height={r * 2} stroke={color} strokeWidth={strokeWidth} />
        </g>
      )
  }
}

/** Offset Revit-style temporary witness dimension along segment `a -> b`. */
function TempDimension({
  a,
  b,
  label,
  activeInput,
  offset,
  px,
  w,
}: {
  a: Vec2
  b: Vec2
  label: string
  activeInput: boolean
  offset: number
  px: number
  w: number
}) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 0.25) return null
  // Perpendicular normal (pointing upward/left on screen for clean readability)
  let nx = -dy / len
  let ny = dx / len
  if (ny > 0.2 || (Math.abs(ny) <= 0.2 && nx < 0)) {
    nx = -nx
    ny = -ny
  }
  const da = { x: a.x + nx * offset, y: a.y + ny * offset }
  const db = { x: b.x + nx * offset, y: b.y + ny * offset }
  const mid = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 }
  const pillW = (label.length * 1.9 + 4.4) * px
  const pillH = 4.4 * px
  const tick = 1.1 * px
  const ux = dx / len
  const uy = dy / len

  return (
    <g data-testid="draft-temp-dim">
      {/* Witness extension lines */}
      <line x1={a.x + nx * (1.2 * px)} y1={a.y + ny * (1.2 * px)} x2={da.x + nx * (1.4 * px)} y2={da.y + ny * (1.4 * px)} stroke={REVIT_BLUE} strokeWidth={w * 0.7} strokeOpacity={0.55} />
      <line x1={b.x + nx * (1.2 * px)} y1={b.y + ny * (1.2 * px)} x2={db.x + nx * (1.4 * px)} y2={db.y + ny * (1.4 * px)} stroke={REVIT_BLUE} strokeWidth={w * 0.7} strokeOpacity={0.55} />
      {/* Dimension line */}
      <line x1={da.x} y1={da.y} x2={db.x} y2={db.y} stroke={REVIT_BLUE} strokeWidth={w * 0.8} strokeOpacity={0.75} />
      {/* Architectural 45° end ticks */}
      <line x1={da.x - (ux + nx) * tick * 0.7} y1={da.y - (uy + ny) * tick * 0.7} x2={da.x + (ux + nx) * tick * 0.7} y2={da.y + (uy + ny) * tick * 0.7} stroke={REVIT_BLUE} strokeWidth={w * 1.1} />
      <line x1={db.x - (ux + nx) * tick * 0.7} y1={db.y - (uy + ny) * tick * 0.7} x2={db.x + (ux + nx) * tick * 0.7} y2={db.y + (uy + ny) * tick * 0.7} stroke={REVIT_BLUE} strokeWidth={w * 1.1} />
      {/* Listening dimension pill */}
      <rect
        x={mid.x - pillW / 2}
        y={mid.y - pillH / 2}
        width={pillW}
        height={pillH}
        rx={0.9 * px}
        fill={activeInput ? REVIT_BLUE : '#ffffff'}
        fillOpacity={activeInput ? 0.98 : 0.96}
        stroke={REVIT_BLUE}
        strokeWidth={w * 0.95}
      />
      <text
        x={mid.x}
        y={mid.y + 0.95 * px}
        textAnchor="middle"
        fontSize={2.65 * px}
        fontWeight={600}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fill={activeInput ? '#ffffff' : REVIT_BLUE}
      >
        {label}
      </text>
    </g>
  )
}

/** What a Draft tool will draw, as it will print, plus Revit-style temporary/listening dimensions, snap glyphs + badge, tracking & alignment guides, and marquee box. Never takes the pointer. */
export function DraftOverlay({
  tool = null,
  prims,
  rubber,
  marker,
  zoom,
  typedLength = '',
  storedPerPaperMm = 1,
  marquee = null,
}: {
  tool?: string | null
  prims: readonly Primitive[]
  rubber: readonly Vec2[]
  marker: Constrained | null
  zoom: number
  typedLength?: string
  storedPerPaperMm?: number
  marquee?: { readonly a: Vec2; readonly b: Vec2 } | null
}) {
  const px = 1 / Math.max(zoom, 0.25)
  const w = 0.36 * px
  const r = 1.45 * px
  const isRect = tool === 'rect' && rubber.length >= 2
  const segA = rubber.length >= 2 ? rubber[rubber.length - 2] : null
  const segB = rubber.length >= 2 ? rubber[rubber.length - 1] : null
  const segLenPaper = segA && segB ? Math.hypot(segB.x - segA.x, segB.y - segA.y) : 0
  const angleDeg = segA && segB ? Math.round(((Math.atan2(-(segB.y - segA.y), segB.x - segA.x) * 180) / Math.PI + 360) % 360) : 0
  const isAxisAngle = angleDeg % 90 === 0
  const segLabel =
    !isRect && segA && segB && (segLenPaper > 0.3 || typedLength.length > 0)
      ? typedLength.length > 0
        ? `${typedLength} ↵`
        : isAxisAngle
          ? formatLengthImperial(segLenPaper * storedPerPaperMm)
          : `${formatLengthImperial(segLenPaper * storedPerPaperMm)} · ${angleDeg}°`
      : null

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

      {/* Revit-style alignment / tracking guides underneath active geometry */}
      {marker?.tracking && <TrackingLine from={marker.tracking.from} angleDeg={marker.tracking.angleDeg} width={w} px={px} />}
      {marker?.guideLine && (
        <line
          x1={marker.guideLine[0].x}
          y1={marker.guideLine[0].y}
          x2={marker.guideLine[1].x}
          y2={marker.guideLine[1].y}
          stroke={REVIT_BLUE}
          strokeWidth={w * 0.85}
          strokeDasharray={`${2.2 * px} ${1.4 * px}`}
          strokeOpacity={0.75}
        />
      )}

      {/* Active preview geometry rendered cleanly in Revit cyan/blue */}
      {prims.map((p, i) => {
        if (p.kind === 'line') {
          return (
            <line
              key={i}
              x1={p.a.x}
              y1={p.a.y}
              x2={p.b.x}
              y2={p.b.y}
              stroke={REVIT_BLUE}
              strokeWidth={w * 1.45}
              strokeLinecap="round"
              strokeDasharray={p.dash?.join(' ')}
            />
          )
        }
        if (p.kind === 'fill') {
          return <polygon key={i} points={p.points.map((q) => `${q.x},${q.y}`).join(' ')} fill={REVIT_BLUE} fillOpacity={p.grey >= 1 ? 0.08 : 0.2} />
        }
        return null
      })}

      {/* Rubber-band guide for tools that don't yet have full prims (or chain vertices) */}
      {!isRect && prims.length === 0 && rubber.length > 1 && (
        <polyline
          points={rubber.map((q) => `${q.x},${q.y}`).join(' ')}
          fill="none"
          stroke={REVIT_BLUE}
          strokeWidth={w * 1.1}
          strokeDasharray={`${1.8 * px} ${1.1 * px}`}
          strokeOpacity={0.75}
        />
      )}

      {/* Subtle vertex dots along committed chain vertices (with start ring for close-loop target) */}
      {rubber.slice(0, -1).map((q, i) => (
        <circle
          key={`c${i}`}
          cx={q.x}
          cy={q.y}
          r={(i === 0 && (tool === 'polyline' || tool === 'region') && rubber.length >= 4 ? 1.05 : 0.65) * px}
          fill="#ffffff"
          stroke={i === 0 && marker?.closeLoop ? CLOSE_GREEN : REVIT_BLUE}
          strokeWidth={w * 1.1}
        />
      ))}

      {/* Dual Revit W × H temporary dimensions for Rectangle */}
      {isRect && segA && segB && (() => {
        const minX = Math.min(segA.x, segB.x)
        const maxX = Math.max(segA.x, segB.x)
        const minY = Math.min(segA.y, segB.y)
        const maxY = Math.max(segA.y, segB.y)
        const rw = maxX - minX
        const rh = maxY - minY
        return (
          <>
            {rw > 0.3 && (
              <TempDimension
                a={{ x: minX, y: minY }}
                b={{ x: maxX, y: minY }}
                label={formatLengthImperial(rw * storedPerPaperMm)}
                activeInput={false}
                offset={6.0 * px}
                px={px}
                w={w}
              />
            )}
            {rh > 0.3 && (
              <TempDimension
                a={{ x: maxX, y: minY }}
                b={{ x: maxX, y: maxY }}
                label={formatLengthImperial(rh * storedPerPaperMm)}
                activeInput={false}
                offset={6.5 * px}
                px={px}
                w={w}
              />
            )}
          </>
        )
      })()}

      {/* Offset Revit temporary witness dimension for Line / P-Line / Arc / Circle / Polygon */}
      {segLabel && segA && segB && (
        <TempDimension
          a={segA}
          b={segB}
          label={segLabel}
          activeInput={typedLength.length > 0}
          offset={6.0 * px}
          px={px}
          w={w}
        />
      )}

      {/* High-contrast Revit snap glyph + compact tooltip badge */}
      {marker?.snapLabel && (
        <g data-testid="draft-snap" data-snap={marker.snapLabel}>
          <SnapGlyph at={marker.at} kind={marker.snapKind} r={r} strokeWidth={w * 1.4} closeLoop={marker.closeLoop} />
          <g transform={`translate(${marker.at.x + 2.4 * px}, ${marker.at.y - 3.6 * px})`}>
            <rect
              x={0}
              y={-2.6 * px}
              width={(marker.snapLabel.length * 1.45 + 3.2) * px}
              height={3.6 * px}
              rx={0.7 * px}
              fill={marker.closeLoop ? CLOSE_GREEN : '#0f172a'}
              fillOpacity={0.88}
            />
            <text
              x={1.6 * px}
              y={-0.1 * px}
              fontSize={2.15 * px}
              fontWeight={500}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="#ffffff"
            >
              {marker.snapLabel}
            </text>
          </g>
          <title>{`Snaps to the ${marker.snapLabel}`}</title>
        </g>
      )}
    </g>
  )
}

function TrackingLine({ from, angleDeg, width, px }: { from: Vec2; angleDeg: number; width: number; px: number }) {
  // Paper is y-down; tracking angles are counter-clockwise on paper as you see it.
  const r = (angleDeg * Math.PI) / 180
  const far = 2000
  const dx = Math.cos(r) * far
  const dy = -Math.sin(r) * far
  return (
    <line
      x1={from.x - dx}
      y1={from.y - dy}
      x2={from.x + dx}
      y2={from.y + dy}
      stroke={REVIT_BLUE}
      strokeWidth={width * 0.8}
      strokeDasharray={`${2.4 * px} ${1.6 * px}`}
      strokeOpacity={0.55}
    />
  )
}
