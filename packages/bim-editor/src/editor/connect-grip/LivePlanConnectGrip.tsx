'use client'

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { asElementId, type Command, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import type { ScreenRect } from '@permitzip/bim-viewer-3d'
import { newElementId } from '../placement'
import { gripFor, submitGripDrop } from './grip-controller'

// The same "+" grip plan drawings show (round 12 E12), loaded on demand.
const PlanConnectGrip = lazy(() => import('./PlanConnectGrip').then((m) => ({ default: m.PlanConnectGrip })))

/** What the live plan's grip reads from the 3D viewer: where an element is on screen, and what is in front under a point. */
export interface LiveGripViewer {
  elementScreenBox(elementId: string): ScreenRect | null
  pickNativeInFront(clientX: number, clientY: number): { readonly elementId: string } | null
  onCameraChange(listener: () => void): () => void
}

export interface LivePlanConnectGripProps {
  readonly viewer: LiveGripViewer
  readonly model: ModelState
  /** The one selected element, else the hovered one; null when neither. */
  readonly elementId: string | null
  readonly submit: (command: Command, label: string) => string | null
  readonly hint: (text: string | null) => void
}

const rectPoly = (r: ScreenRect, o: Vec2): Vec2[] => [
  { x: r.minX - o.x, y: r.minY - o.y },
  { x: r.maxX - o.x, y: r.minY - o.y },
  { x: r.maxX - o.x, y: r.maxY - o.y },
  { x: r.minX - o.x, y: r.maxY - o.y },
]

/**
 * The "+" grip in the live plan: the drawing grip (`PlanConnectGrip`, `grip-controller`)
 * drawn over the 3D canvas in screen pixels (1 px = 1 "paper" unit), placed from the
 * viewer's box for the element and hit-testing sources with the viewer's front pick.
 * Pointer events on the grip stay here, so pressing it never hovers or selects behind it.
 * The canvas loses its hover when the pointer moves onto the "+" (a sibling layer), so the
 * grip holds its element while the pointer is on it and through a drag.
 */
export function LivePlanConnectGrip({ viewer, model, elementId, submit, hint }: LivePlanConnectGripProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [held, setHeld] = useState<string | null>(null)
  const shown = held ?? elementId
  const [camera, setCamera] = useState(0)
  useEffect(() => {
    let frame = 0
    const off = viewer.onCameraChange(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setCamera((n) => n + 1))
    })
    return () => {
      cancelAnimationFrame(frame)
      off()
    }
  }, [viewer])

  const answer = useMemo(() => (shown ? gripFor(model, asElementId(shown)) : null), [model, shown])
  const origin = (): Vec2 => {
    const r = svgRef.current?.getBoundingClientRect()
    return r ? { x: r.left, y: r.top } : { x: 0, y: 0 }
  }
  // Where the overlay is on the page, measured after each render (the canvas can move when the page's sides open or close).
  const [o, setO] = useState<Vec2>({ x: 0, y: 0 })
  useLayoutEffect(() => {
    const r = svgRef.current?.getBoundingClientRect()
    if (r && (r.left !== o.x || r.top !== o.y)) setO({ x: r.left, y: r.top })
  }, [camera, shown, o.x, o.y])
  const box = shown && answer ? viewer.elementScreenBox(shown) : null
  const at = box ? { x: box.maxX - o.x + 3, y: box.minY - o.y - 3 } : null

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 size-full overflow-visible" data-testid="live-plan-connect-grip" aria-hidden={!at}>
      {shown && answer && at && (
        <g
          style={{ pointerEvents: 'auto' }}
          onPointerEnter={() => setHeld(shown)}
          onPointerLeave={(e) => {
            if (e.buttons === 0) setHeld(null)
          }}
          onPointerUpCapture={() => setHeld(null)}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Suspense fallback={null}>
            <PlanConnectGrip
              key={shown}
              elementId={asElementId(shown)}
              answer={answer}
              at={at}
              paperMmPerPx={1}
              paperOf={(e) => {
                const p = origin()
                return { x: e.clientX - p.x, y: e.clientY - p.y }
              }}
              sourceUnder={(p) => {
                const q = origin()
                const id = viewer.pickNativeInFront(q.x + p.x, q.y + p.y)?.elementId
                return id ? asElementId(id) : null
              }}
              outlineOf={(id) => {
                const r = viewer.elementScreenBox(id)
                return r ? rectPoly(r, origin()) : null
              }}
              onDrop={(drop) => submitGripDrop(model, drop, newElementId('lnk'), submit)}
              hint={hint}
            />
          </Suspense>
        </g>
      )}
    </svg>
  )
}
