'use client'

import { useEffect, useReducer, useRef, useState } from 'react'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import type { SectionCut, ViewElement } from '@permitzip/bim-kernel'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'

const FT = 304.8
const MIN_CUT_MM = 1 * FT

type Handle = 'new' | 'start' | 'end' | 'depth'

interface Props {
  readonly viewer: ModelViewer3D
  /** Elevation (mm) the cut line is drawn at: the plan's level plus its cut height. */
  readonly elevationMm: number
  /** Drawing a new cut (the Section tool is on). */
  readonly drawing: boolean
  /** Sections whose cut lines show on this plan; click one to open it. */
  readonly sections: readonly ViewElement[]
  readonly suggestedName: string
  readonly onOpenSection: (viewId: string) => void
  readonly onCreate: (cut: SectionCut, name: string) => string | null
  readonly onCancel: () => void
  /** Drag an existing section's depth grip: how far it sees (its far clip). Absent: grips hidden (no editing). */
  readonly onFarClip?: (viewId: string, depthMm: number) => string | null
}

/**
 * Mount with a key that changes when the tool turns on or off, so a fresh
 * drawing starts clean.
 *
 * Section tool over the plan: drag a cut line, then drag its ends, its depth
 * handle (how far it sees) and flip which side it looks at, name it and create
 * the section. Existing sections on this level show as cut lines you can open.
 */
export function SectionCutOverlay({ viewer, elevationMm, drawing, sections, suggestedName, onOpenSection, onCreate, onCancel, onFarClip }: Props) {
  const ref = useRef<SVGSVGElement | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [cut, setCut] = useState<SectionCut | null>(null)
  const [handle, setHandle] = useState<Handle | null>(null)
  const [name, setName] = useState(suggestedName)
  const [error, setError] = useState<string | null>(null)
  /** An existing section's far clip being dragged: which view and the depth so far. */
  const [farDrag, setFarDrag] = useState<{ viewId: string; depthMm: number } | null>(null)

  useEffect(() => viewer.onCameraChange(redraw), [viewer])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawing) {
        setCut(null)
        setHandle(null)
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing, onCancel])

  const local = (x: number, y: number) => viewer.canvasPointOf(x, y, elevationMm)
  const planAt = (e: React.PointerEvent) => viewer.planPointAt(e.clientX, e.clientY, elevationMm)

  const geometry = (c: SectionCut) => {
    const dx = c.end.x - c.start.x
    const dy = c.end.y - c.start.y
    const len = Math.hypot(dx, dy) || 1
    const look = { x: (-dy / len) * c.direction, y: (dx / len) * c.direction }
    const mid = { x: (c.start.x + c.end.x) / 2, y: (c.start.y + c.end.y) / 2 }
    return { look, mid, len, depthAt: { x: mid.x + look.x * c.depthMm, y: mid.y + look.y * c.depthMm } }
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawing || e.button !== 0) return
    const p = planAt(e)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    viewer.setNavigationEnabled(false)
    setError(null)
    setCut({ start: p, end: p, direction: 1, depthMm: 15 * FT })
    setHandle('new')
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (farDrag) {
      const s = sections.find((v) => v.id === farDrag.viewId)?.props?.section
      const p = planAt(e)
      if (!s || !p) return
      const { look, mid } = geometry(s)
      setFarDrag({ ...farDrag, depthMm: Math.max(FT, (p.x - mid.x) * look.x + (p.y - mid.y) * look.y) })
      return
    }
    if (!handle || !cut) return
    const p = planAt(e)
    if (!p) return
    if (handle === 'new' || handle === 'end') setCut({ ...cut, end: snap(cut.start, p) })
    else if (handle === 'start') setCut({ ...cut, start: snap(cut.end, p) })
    else {
      const { look, mid } = geometry(cut)
      setCut({ ...cut, depthMm: Math.max(FT, (p.x - mid.x) * look.x + (p.y - mid.y) * look.y) })
    }
  }

  const endDrag = () => {
    if (farDrag) {
      const d = farDrag
      setFarDrag(null)
      viewer.setNavigationEnabled(true)
      const before = sections.find((v) => v.id === d.viewId)?.props?.section?.depthMm
      if (onFarClip && before !== undefined && Math.abs(before - d.depthMm) > 1) setError(onFarClip(d.viewId, Math.round(d.depthMm)))
      return
    }
    if (!handle) return
    setHandle(null)
    viewer.setNavigationEnabled(true)
    if (cut && Math.hypot(cut.end.x - cut.start.x, cut.end.y - cut.start.y) < MIN_CUT_MM) {
      setCut(null)
      setError('Drag a longer line, at least 1 ft.')
    }
  }

  const grab = (h: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ref.current?.setPointerCapture(e.pointerId)
    viewer.setNavigationEnabled(false)
    setHandle(h)
  }

  const existing = sections.flatMap((s) => {
    const stored = s.props?.section
    if (!stored) return []
    const c = farDrag?.viewId === s.id ? { ...stored, depthMm: farDrag.depthMm } : stored
    const a = local(c.start.x, c.start.y)
    const b = local(c.end.x, c.end.y)
    const g = geometry(c)
    const m = local(g.mid.x, g.mid.y)
    const d = local(g.depthAt.x, g.depthAt.y)
    return a && b ? [{ view: s, a, b, m, d, depthMm: c.depthMm }] : []
  })

  const g = cut ? geometry(cut) : null
  const a = cut ? local(cut.start.x, cut.start.y) : null
  const b = cut ? local(cut.end.x, cut.end.y) : null
  const m = g ? local(g.mid.x, g.mid.y) : null
  const d = g ? local(g.depthAt.x, g.depthAt.y) : null
  const ready = cut && !handle && g && g.len >= MIN_CUT_MM

  return (
    <>
      <svg
        ref={ref}
        className={`absolute inset-0 h-full w-full ${drawing ? 'cursor-crosshair' : farDrag ? '' : 'pointer-events-none'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-label={drawing ? 'Drag a cut line for the section' : 'Section marks'}
        data-testid="section-overlay"
      >
        {existing.map(({ view, a: p, b: q, m, d, depthMm }) => (
          <g key={view.id}>
            <g className="pointer-events-auto cursor-pointer" onClick={() => onOpenSection(view.id)}>
              <title>{`${view.name}: click to open`}</title>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--mutiny-selection)" strokeWidth={8} strokeOpacity={0} />
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--mutiny-selection)" strokeWidth={2} strokeDasharray="10 4 2 4" />
              <text x={p.x} y={p.y - 6} fontSize={11} fill="var(--mutiny-selection)">
                {farDrag?.viewId === view.id ? `${view.name}: sees ${(depthMm / FT).toFixed(1)} ft. Release to save.` : view.name}
              </text>
            </g>
            {onFarClip && !drawing && m && d && (
              <>
                <line x1={m.x} y1={m.y} x2={d.x} y2={d.y} stroke="var(--mutiny-selection)" strokeWidth={1} strokeDasharray="3 3" />
                <circle
                  cx={d.x}
                  cy={d.y}
                  r={6}
                  fill="var(--mutiny-panel)"
                  stroke="var(--mutiny-selection)"
                  strokeWidth={2}
                  className="pointer-events-auto cursor-grab"
                  data-testid={`section-far-clip-${view.name}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    ref.current?.setPointerCapture(e.pointerId)
                    viewer.setNavigationEnabled(false)
                    setFarDrag({ viewId: view.id, depthMm })
                  }}
                >
                  <title>{`Drag to set how far ${view.name} sees (its far clip)`}</title>
                </circle>
              </>
            )}
          </g>
        ))}
        {a && b && m && d && (
          <g>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--mutiny-selection)" strokeWidth={2.5} />
            <line x1={m.x} y1={m.y} x2={d.x} y2={d.y} stroke="var(--mutiny-selection)" strokeWidth={1.5} strokeDasharray="4 3" />
            {!handle && (
              <>
                {[
                  { at: a, h: 'start' as const, label: 'Drag to move this end' },
                  { at: b, h: 'end' as const, label: 'Drag to move this end' },
                  { at: d, h: 'depth' as const, label: 'Drag to set how far the section sees' },
                ].map(({ at, h, label }) => (
                  <circle key={h} cx={at.x} cy={at.y} r={7} fill="var(--mutiny-panel)" stroke="var(--mutiny-selection)" strokeWidth={2} className="pointer-events-auto cursor-grab" onPointerDown={grab(h)} data-testid={`section-handle-${h}`}>
                    <title>{label}</title>
                  </circle>
                ))}
                <g
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    if (cut) setCut({ ...cut, direction: cut.direction === 1 ? -1 : 1 })
                  }}
                  data-testid="section-flip"
                >
                  <title>Click to look the other way</title>
                  <circle cx={m.x} cy={m.y} r={9} fill="var(--mutiny-selection)" />
                  <text x={m.x} y={m.y + 4} fontSize={12} textAnchor="middle" fill="var(--mutiny-panel)">
                    ⇄
                  </text>
                </g>
              </>
            )}
          </g>
        )}
      </svg>
      {!drawing && error && (
        <div className="pointer-events-auto absolute bottom-3 left-3 max-w-md rounded-md border bg-background/95 px-3 py-2 text-sm text-danger-600 shadow-sm" role="alert">
          {error}
        </div>
      )}
      {drawing && (
        <div className="pointer-events-auto absolute left-3 right-[21rem] top-3 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-sm shadow-sm" role="status">
          {ready ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const refusal = onCreate(cut, name.trim())
                setError(refusal)
                if (!refusal) setCut(null)
              }}
            >
              <span className="whitespace-nowrap">
                {(g.len / FT).toFixed(1)} ft cut, sees {(cut.depthMm / FT).toFixed(0)} ft.
              </span>
              <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Section name" className="h-7 w-44" maxLength={120} required />
              <Button type="submit" size="sm" disabled={!name.trim()}>
                Create section
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <span>{error ?? 'Drag across the plan where the section cuts. Esc to cancel.'}</span>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </>
  )
}

/** Hold the line horizontal or vertical when it is within 3° of one. */
function snap(from: { x: number; y: number }, p: { x: number; y: number }): { x: number; y: number } {
  const dx = p.x - from.x
  const dy = p.y - from.y
  const angle = Math.abs(Math.atan2(dy, dx))
  const tol = (3 * Math.PI) / 180
  if (angle < tol || Math.abs(angle - Math.PI) < tol) return { x: Math.round(p.x), y: from.y }
  if (Math.abs(angle - Math.PI / 2) < tol) return { x: from.x, y: Math.round(p.y) }
  return { x: Math.round(p.x), y: Math.round(p.y) }
}
