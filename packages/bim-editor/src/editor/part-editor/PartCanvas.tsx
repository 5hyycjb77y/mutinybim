'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PartViewLinework, PlaneAxis, ResolvedSketch } from '@permitzip/bim-kernel'
import { MM_PER_IN, dimLength, type PlaneDim, type PlaneLine } from './draft'
import { FlatViewNavigator } from '../input/flat-view-nav'
import { panBy, zoomAt, type FlatViewState } from './zoom'

/**
 * One 2D view of the part (plan, front or side): the solid's faces and edges,
 * reference planes as dashed lines, dimensions between them (click one to set
 * its length or the parameter it follows), sketches lying face-on to this
 * view, and the drawing tools. Coordinates are the view's own (u right, v up)
 * in model millimetres; the SVG flips v.
 */

export type DrawTool = 'select' | 'rectangle' | 'circle' | 'polyline' | 'axis'
export type FlatView = 'plan' | 'front' | 'side'

/** Which plane axis a view looks along: sketches on planes square to it lie face-on. */
export const VIEW_AXIS: Readonly<Record<FlatView, PlaneAxis>> = { plan: 'z', front: 'x', side: 'y' }
export const AXIS_VIEW: Readonly<Record<PlaneAxis, FlatView>> = { z: 'plan', x: 'front', y: 'side' }

export interface UV {
  readonly u: number
  readonly v: number
}

interface Props {
  view: FlatView
  linework: PartViewLinework | null
  planes: readonly PlaneLine[]
  dims: readonly PlaneDim[]
  /** Parameter labels by name, for dimension text. */
  paramLabels: ReadonlyMap<string, string>
  selectedDim: string | null
  onDim: (id: string) => void
  /** Sketches on planes square to this view, solved. */
  sketches: readonly ResolvedSketch[]
  activeSketchId: string | null
  tool: DrawTool
  /** Changing it fits the view to the part again. */
  fitKey: number
  onRectangle: (a: UV, b: UV, tolerance: number) => void
  onCircle: (center: UV, radius: number) => void
  onPolyline: (points: UV[]) => void
  onAxis: (a: UV, b: UV) => void
}

const fmt = (n: number) => Math.round(n * 100) / 100
const inches = (mm: number) => `${Math.round((mm / MM_PER_IN) * 100) / 100}"`
const FIT: FlatViewState = { zoom: 1, center: null }

export function PartCanvas({ view, linework, planes, dims, paramLabels, selectedDim, onDim, sketches, activeSketchId, tool, fitKey, onRectangle, onCircle, onPolyline, onAxis }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [nav, setNav] = useState<FlatViewState>(FIT)
  const [lastFit, setLastFit] = useState(fitKey)
  const [drag, setDrag] = useState<{ a: UV; b: UV } | null>(null)
  const [poly, setPoly] = useState<UV[]>([])
  const [hover, setHover] = useState<UV | null>(null)
  if (lastFit !== fitKey) {
    setLastFit(fitKey)
    setNav(FIT)
  }

  const content = useMemo(() => {
    let minU = linework?.min.u ?? -600
    let minV = linework?.min.v ?? -600
    let maxU = linework?.max.u ?? 600
    let maxV = linework?.max.v ?? 600
    for (const p of planes) {
      if (p.coordinate === 'u') {
        minU = Math.min(minU, p.value)
        maxU = Math.max(maxU, p.value)
      } else {
        minV = Math.min(minV, p.value)
        maxV = Math.max(maxV, p.value)
      }
    }
    for (const s of sketches) for (const p of s.solution.points.values()) {
      minU = Math.min(minU, p.u)
      maxU = Math.max(maxU, p.u)
      minV = Math.min(minV, p.v)
      maxV = Math.max(maxV, p.v)
    }
    return { center: { u: (minU + maxU) / 2, v: (minV + maxV) / 2 }, span: Math.max(maxU - minU, maxV - minV, 300) * 1.5 }
  }, [linework, planes, sketches])

  const center = nav.center ?? content.center
  const span = content.span / nav.zoom
  const box = { minU: center.u - span / 2, maxU: center.u + span / 2, minV: center.v - span / 2, maxV: center.v + span / 2, span }

  const X = (u: number) => u
  const Y = (v: number) => -v
  const pxPerUnit = 640 / box.span
  const stroke = 1 / pxPerUnit

  const toUv = (e: { clientX: number; clientY: number }) => svgPoint(svgRef.current, e)

  // The same zoom and pan as sheets and drawings (input/flat-view-nav.ts): wheel and pinch toward the pointer,
  // middle-drag or a drag off the drawing tools pans, a middle double-click fits. Keys stay with the building model.
  const latest = useRef({ nav, center })
  useEffect(() => {
    latest.current = { nav, center }
  })
  const [navigator, setNavigator] = useState<FlatViewNavigator | null>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const n = new FlatViewNavigator(
      svg,
      {
        zoom: (factor, clientX, clientY) => {
          const at = svgPoint(svg, { clientX, clientY })
          if (!at) return
          const { nav: v, center: c } = latest.current
          const next = zoomAt(v, factor, at, c)
          latest.current = { nav: next, center: next.center ?? c }
          setNav(next)
        },
        pan: (dx, dy) => {
          const r = svg.getBoundingClientRect()
          const a = svgPoint(svg, { clientX: r.left, clientY: r.top })
          const b = svgPoint(svg, { clientX: r.left + dx, clientY: r.top + dy })
          if (!a || !b) return
          const { nav: v, center: c } = latest.current
          const next = panBy(v, c, b.u - a.u, b.v - a.v)
          latest.current = { nav: next, center: next.center ?? c }
          setNav(next)
        },
        fit: () => {
          latest.current = { ...latest.current, nav: FIT }
          setNav(FIT)
        },
      },
      { keyboard: false },
    )
    setNavigator(n)
    return () => {
      n.dispose()
      setNavigator(null)
    }
  }, [])

  // A sketch stroke owns the pointer: the middle button doesn't pan under it (the wheel still zooms).
  const sketching = drag !== null
  useEffect(() => (sketching && navigator ? navigator.claimPointer('sketch') : undefined), [sketching, navigator])

  const tolerance = 10 / pxPerUnit
  const drawing = activeSketchId !== null && tool !== 'select'

  const onDown = (e: React.PointerEvent) => {
    if (!drawing) {
      navigator?.pressEmpty(e.nativeEvent)
      return
    }
    const at = toUv(e)
    if (!at) return
    if (tool === 'polyline') {
      const first = poly[0]
      if (first && poly.length >= 3 && Math.hypot(first.u - at.u, first.v - at.v) < tolerance) {
        onPolyline(poly)
        setPoly([])
      } else setPoly([...poly, at])
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDrag({ a: at, b: at })
  }
  const onMove = (e: React.PointerEvent) => {
    const at = toUv(e)
    setHover(at)
    if (drag && at) setDrag({ ...drag, b: at })
  }
  const onUp = () => {
    if (!drag) return
    const { a, b } = drag
    setDrag(null)
    const size = Math.hypot(b.u - a.u, b.v - a.v)
    if (size < tolerance) return
    if (tool === 'rectangle') onRectangle(a, b, tolerance)
    else if (tool === 'circle') onCircle(a, size)
    else if (tool === 'axis') onAxis(a, b)
  }

  // Shorter dimensions sit nearer the part, longer ones outside them, so none cross.
  const byLength = (a: PlaneDim, b: PlaneDim) => dimLength(a) - dimLength(b)
  const uDims = dims.filter((d) => d.coordinate === 'u').sort(byLength)
  const vDims = dims.filter((d) => d.coordinate === 'v').sort(byLength)
  const top = Math.max(content.center.v + content.span / 3, ...planes.filter((p) => p.coordinate === 'v').map((p) => p.value))
  const left = Math.min(content.center.u - content.span / 3, ...planes.filter((p) => p.coordinate === 'u').map((p) => p.value))
  const dimText = (d: PlaneDim) => `${d.param ? `${paramLabels.get(d.param) ?? d.param} ` : ''}${inches(dimLength(d))}`

  return (
    <div className="relative size-full" data-testid={`part-canvas-${view}`} data-zoom={fmt(nav.zoom)}>
      <svg
        ref={svgRef}
        className={`size-full bg-background ${drawing ? 'cursor-crosshair' : ''}`}
        viewBox={`${fmt(box.minU)} ${fmt(-box.maxV)} ${fmt(box.span)} ${fmt(box.span)}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => !drawing && setNav(FIT)}
        role="img"
        aria-label={`${view} view of the part`}
      >
        {linework?.faces.map((f, i) => (
          <polygon key={`f${i}`} points={f.poly.map((q) => `${X(q.u)},${Y(q.v)}`).join(' ')} className="fill-muted" opacity={0.55 + 0.35 * f.light} />
        ))}
        {linework?.hidden.map((s, i) => (
          <line key={`h${i}`} x1={X(s.a.u)} y1={Y(s.a.v)} x2={X(s.b.u)} y2={Y(s.b.v)} className="stroke-muted-foreground" strokeWidth={stroke} strokeDasharray={`${4 * stroke} ${3 * stroke}`} />
        ))}
        {linework?.visible.map((s, i) => (
          <line key={`v${i}`} x1={X(s.a.u)} y1={Y(s.a.v)} x2={X(s.b.u)} y2={Y(s.b.v)} className="stroke-foreground" strokeWidth={1.5 * stroke} />
        ))}
        {planes.map((p) =>
          p.coordinate === 'u' ? (
            <g key={p.id}>
              <line data-plane={p.id} x1={X(p.value)} y1={Y(box.minV)} x2={X(p.value)} y2={Y(box.maxV)} className="stroke-primary" strokeWidth={stroke} strokeDasharray={`${8 * stroke} ${4 * stroke}`} opacity={0.6} />
              <text x={X(p.value) + 4 * stroke} y={Y(box.maxV) + 14 * stroke} fontSize={11 * stroke} className="fill-primary">
                {p.name}
              </text>
            </g>
          ) : (
            <g key={p.id}>
              <line data-plane={p.id} x1={X(box.minU)} y1={Y(p.value)} x2={X(box.maxU)} y2={Y(p.value)} className="stroke-primary" strokeWidth={stroke} strokeDasharray={`${8 * stroke} ${4 * stroke}`} opacity={0.6} />
              <text x={X(box.minU) + 4 * stroke} y={Y(p.value) - 4 * stroke} fontSize={11 * stroke} className="fill-primary">
                {p.name}
              </text>
            </g>
          ),
        )}
        {uDims.map((d, i) => {
          const v = top + (28 + 24 * i) * stroke
          return <DimMark key={d.id} dim={d} text={dimText(d)} a={{ u: d.from, v }} b={{ u: d.to, v }} ext={{ coordinate: 'u', base: top }} stroke={stroke} selected={selectedDim === d.id} onPick={onDim} />
        })}
        {vDims.map((d, i) => {
          const u = left - (36 + 30 * i) * stroke
          return <DimMark key={d.id} dim={d} text={dimText(d)} a={{ u, v: d.from }} b={{ u, v: d.to }} ext={{ coordinate: 'v', base: left }} stroke={stroke} selected={selectedDim === d.id} onPick={onDim} />
        })}
        {sketches.map((rs) => (
          <SketchShapes key={rs.sketch.id} rs={rs} active={rs.sketch.id === activeSketchId} stroke={stroke} />
        ))}
        {linework?.connectors.map((c) => (
          <g key={c.id}>
            <circle cx={X(c.u)} cy={Y(c.v)} r={6 * stroke} className={c.domain === 'duct' ? 'fill-info-500' : c.domain === 'pipe' ? 'fill-success-600' : 'fill-warning-500'} />
            <text x={X(c.u) + 8 * stroke} y={Y(c.v) - 8 * stroke} fontSize={11 * stroke} className="fill-foreground">
              {c.label}
            </text>
          </g>
        ))}
        {drag && tool === 'rectangle' && (
          <rect x={Math.min(drag.a.u, drag.b.u)} y={Math.min(-drag.a.v, -drag.b.v)} width={Math.abs(drag.b.u - drag.a.u)} height={Math.abs(drag.b.v - drag.a.v)} className="fill-primary/10 stroke-primary" strokeWidth={stroke} />
        )}
        {drag && tool === 'circle' && <circle cx={drag.a.u} cy={-drag.a.v} r={Math.hypot(drag.b.u - drag.a.u, drag.b.v - drag.a.v)} className="fill-primary/10 stroke-primary" strokeWidth={stroke} />}
        {drag && tool === 'axis' && <line x1={drag.a.u} y1={-drag.a.v} x2={drag.b.u} y2={-drag.b.v} className="stroke-primary" strokeWidth={stroke} strokeDasharray={`${6 * stroke} ${3 * stroke}`} />}
        {poly.length > 0 && (
          <polyline points={[...poly, ...(hover ? [hover] : [])].map((p) => `${p.u},${-p.v}`).join(' ')} className="fill-none stroke-primary" strokeWidth={stroke} />
        )}
      </svg>
      {drawing && hover && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground">
          {`${Math.round((hover.u / 25.4) * 10) / 10}", ${Math.round((hover.v / 25.4) * 10) / 10}"`}
          {tool === 'polyline' ? ' · click the first point to close' : ' · corners near a dashed reference plane lock to it'}
        </div>
      )}
      {!drawing && dims.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground">Click a dimension to change it or link it to a parameter · scroll to zoom at the pointer · drag to pan · double-click to fit</div>
      )}
    </div>
  )
}

/** A screen point in the view's own coordinates (v up). */
function svgPoint(svg: SVGSVGElement | null, e: { clientX: number; clientY: number }): UV | null {
  const ctm = svg?.getScreenCTM()
  if (!svg || !ctm) return null
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
  return { u: pt.x, v: -pt.y }
}

/** A dimension line with its text; the whole mark is one click target. */
function DimMark({ dim, text, a, b, ext, stroke, selected, onPick }: { dim: PlaneDim; text: string; a: UV; b: UV; ext: { coordinate: 'u' | 'v'; base: number }; stroke: number; selected: boolean; onPick: (id: string) => void }) {
  const cls = selected ? 'stroke-accent-600' : dim.param ? 'stroke-primary' : 'stroke-muted-foreground'
  const fill = selected ? 'fill-accent-700' : dim.param ? 'fill-primary' : 'fill-muted-foreground'
  const tick = 5 * stroke
  const mid = { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 }
  const ends = [a, b]
  return (
    <>
    <g className="pointer-events-none">
      {ends.map((p, i) =>
        ext.coordinate === 'u' ? (
          <line key={i} x1={p.u} y1={-ext.base} x2={p.u} y2={-(p.v + tick)} className="stroke-muted-foreground" strokeWidth={0.6 * stroke} opacity={0.6} />
        ) : (
          <line key={i} x1={ext.base} y1={-p.v} x2={p.u - tick} y2={-p.v} className="stroke-muted-foreground" strokeWidth={0.6 * stroke} opacity={0.6} />
        ),
      )}
    </g>
    <g
      data-testid={`pe-dim-${dim.id}`}
      data-dim-param={dim.param ?? ''}
      role="button"
      tabIndex={0}
      aria-label={`Dimension ${dim.names}: ${text}`}
      className="cursor-pointer outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onPick(dim.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick(dim.id)
        }
      }}
    >
      <line x1={a.u} y1={-a.v} x2={b.u} y2={-b.v} className="stroke-transparent" strokeWidth={14 * stroke} />
      <line x1={a.u} y1={-a.v} x2={b.u} y2={-b.v} className={cls} strokeWidth={(selected ? 2 : 1.2) * stroke} />
      {ends.map((p, i) => (
        <line key={`t${i}`} x1={p.u - tick} y1={-(p.v - tick)} x2={p.u + tick} y2={-(p.v + tick)} className={cls} strokeWidth={1.2 * stroke} />
      ))}
      <text
        x={ext.coordinate === 'u' ? mid.u : mid.u - 4 * stroke}
        y={ext.coordinate === 'u' ? -(mid.v + 4 * stroke) : -mid.v}
        fontSize={12 * stroke}
        textAnchor="middle"
        transform={ext.coordinate === 'v' ? `rotate(-90 ${mid.u - 4 * stroke} ${-mid.v})` : undefined}
        className={fill}
      >
        {text}
      </text>
    </g>
    </>
  )
}

function SketchShapes({ rs, active, stroke }: { rs: ResolvedSketch; active: boolean; stroke: number }) {
  const pt = (id: string) => rs.solution.points.get(id)
  const cls = active ? 'stroke-primary' : 'stroke-accent-600'
  const out: React.ReactNode[] = []
  for (const e of rs.sketch.entities) {
    if (e.kind === 'line') {
      const a = pt(e.a)
      const b = pt(e.b)
      if (a && b) out.push(<line key={e.id} x1={a.u} y1={-a.v} x2={b.u} y2={-b.v} className={cls} strokeWidth={1.5 * stroke} strokeDasharray={e.construction ? `${6 * stroke} ${3 * stroke}` : undefined} />)
    } else if (e.kind === 'rectangle' || e.kind === 'polyline') {
      const ids = e.kind === 'rectangle' ? e.corners : e.points
      const pts = ids.map(pt).filter((p): p is NonNullable<typeof p> => p !== undefined)
      out.push(<polygon key={e.id} points={pts.map((p) => `${p.u},${-p.v}`).join(' ')} className={`fill-none ${cls}`} strokeWidth={1.5 * stroke} />)
    } else if (e.kind === 'arc') {
      const c = pt(e.center)
      const s = pt(e.start)
      const t = pt(e.end)
      if (c && s && t) {
        const r = Math.hypot(s.u - c.u, s.v - c.v)
        out.push(<path key={e.id} d={`M ${s.u} ${-s.v} A ${r} ${r} 0 0 0 ${t.u} ${-t.v}`} className={`fill-none ${cls}`} strokeWidth={1.5 * stroke} />)
      }
    }
  }
  for (const p of rs.solution.points.values()) out.push(<circle key={`pt-${p.u}-${p.v}-${out.length}`} cx={p.u} cy={-p.v} r={2.5 * stroke} className={active ? 'fill-primary' : 'fill-accent-600'} />)
  return <g data-testid={`sketch-${rs.sketch.id}`}>{out}</g>
}
