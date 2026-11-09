'use client'

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  asElementId,
  buildViewPickIndex,
  describeModelDelta,
  modelToPaperPoint,
  paperToDrawing,
  viewLevelElements,
  type ModelState,
  type PartInstance,
  type RunPoint,
  type Vec2,
  type ViewElement,
  type ViewOnPaper,
  type ViewPickIndex,
} from '@permitzip/bim-kernel'
import { circuitJoinNear, circuitJoinsOnPaper, withCircuitBend, type CircuitJoinOnPaper } from '@permitzip/bim-pack-electrical'
import { parseLength } from '../views-sheets/draft/draft-input'
import { clipOf, copiedHint, currentClip, pasteCommand, pasteIds, rememberClip, typingIn } from '../views-sheets/draft/copy-paste'
import type { ModelEditBridge } from './bridge'
import { dragToModel, idsAt, idsInBox, outlineOnPaper, paperOffsetFor, toleranceMm } from './drawing-pick'
import { isRunPiece, openEndNear, runDragDelta, runPointUnder, runPreviewOnPaper, runSideUnder, snapOnPaper, type DrawingModelPoint, type OpenEnd, type RunSide, type SnapHit } from './run-drag'
import { drawingCursorClass } from '../place-planned-live'
import { gripFor, submitGripDrop, type GripDrop } from '../connect-grip/grip-controller'
import { newElementId } from '../placement'
import { ROUTE_CHECK_COLOUR, routeTicksAcross } from './route-ticks'
import { drawingEscapeStep, escapeLeavesField, leftFieldHint, stoppedToolHint } from '../escape-step'
import { DrawingPlusSpots } from './DrawingPlusSpots'

// The "+" grip loads on demand: nothing of it is in the plan's first paint.
const PlanConnectGrip = lazy(() => import('../connect-grip/PlanConnectGrip').then((m) => ({ default: m.PlanConnectGrip })))

const PRIMARY = 'var(--mutiny-selection)'
/** Half the length (paper mm) of a route check's tick across the route. */
const TICK_HALF_MM = 2
/** A press that travels less than this (screen px) is a click. */
const CLICK_PX = 4
/** Outlines drawn at most (a whole system can be thousands of pieces). */
const MAX_OUTLINES = 2000
/** How near (screen px) a run end, elbow or part pulls a drag or route point onto itself. */
const SNAP_PX = 10
/** Keys that build a typed length while dragging an open end: 12'6", 12.5', 150mm, 3/4. */
const LENGTH_KEY = /^[0-9.'"\/ \-m]$/

/** What the Route tool would use under the pointer on a drawing. */
interface RouteInput {
  readonly point: DrawingModelPoint
  readonly vertical: boolean
  readonly end: OpenEnd | null
  readonly side: RunSide | null
  /** Where the marker goes (snapped). */
  readonly paper: Vec2
}

/** A run piece and the pieces joined to it: what a run drag moves, so it doesn't snap to itself. */
function joinedTo(model: ModelState, id: string): Set<string> {
  const out = new Set([id])
  const el = model.elements[id]
  if (el?.kind === 'run_segment') {
    if (el.links.start) out.add(el.links.start.elementId)
    if (el.links.end) out.add(el.links.end.elementId)
  } else if (el?.kind === 'run_fitting') {
    for (const p of el.ports) if (p.link) out.add(p.link.elementId)
  }
  return out
}

/** Keeps the pick index across edits, so each edit re-measures only what changed. */
class PickIndexCache {
  private last: ViewPickIndex | null = null
  get(model: ModelState, view: ViewElement): ViewPickIndex {
    this.last = buildViewPickIndex(model, view, this.last)
    return this.last
  }
}

type Drag =
  | { readonly kind: 'press'; readonly from: Vec2; readonly id: string | null }
  | { readonly kind: 'move'; readonly from: Vec2; readonly to: Vec2; readonly ids: readonly string[]; readonly free: boolean }
  | { readonly kind: 'box'; readonly a: Vec2; readonly b: Vec2 }
  /** A circuit line dragged to pin its bend where it is let go (a hint on the view; the line stays derived). */
  | { readonly kind: 'bend'; readonly from: Vec2; readonly to: Vec2; readonly join: CircuitJoinOnPaper }
  /** A routed piece, end or elbow, dragged through the session's `drag_run` (as in 3D). */
  | { readonly kind: 'run'; readonly from: Vec2; readonly to: Vec2; readonly hint: string | null; readonly exclude: ReadonlySet<string>; readonly typed: string; readonly snap: SnapHit | null }

interface Props {
  readonly model: ModelState
  /** The view on paper: by itself, or the viewport opened on the sheet. */
  readonly view: ViewOnPaper
  readonly bridge: ModelEditBridge
  /** Paper point under a pointer event on the overlay. */
  readonly paperOf: (e: React.PointerEvent<SVGElement>) => Vec2 | null
  /** Paper millimetres per screen pixel at the current zoom. */
  readonly paperMmPerPx: number
  /** A model element was picked here (the drawing's own selection of notes and viewports clears). */
  readonly onPicked?: () => void
}

/** Shown as a box drag starts on a drawing. */
export const BOX_HINT = 'Drag right to keep what is wholly inside, left to keep anything the box touches. Space-drag or middle-drag pans.'

function points(poly: readonly Vec2[], offset: Vec2 = { x: 0, y: 0 }): string {
  return poly.map((q) => `${q.x + offset.x},${q.y + offset.y}`).join(' ')
}

/**
 * Model editing on a plan, section or elevation drawing: hover pre-highlights
 * what a click selects (Tab widens it to the run, branch or system), a click
 * selects, a drag on empty paper box-selects (left to right: a window keeps
 * what is wholly inside; right to left: crossing keeps anything it touches),
 * and dragging a selected element moves it in the model. Space-drag,
 * middle-drag and a two-finger scroll pan. Highlights and the move preview are drawn on
 * the drawing itself, clipped to the view's frame.
 */
export function ModelDrawingLayer({ model, view, bridge, paperOf, paperMmPerPx, onPicked }: Props) {
  const [cache] = useState(() => new PickIndexCache())
  const index = useMemo(() => cache.get(model, view.view), [cache, model, view.view])
  const [hover, setHover] = useState<readonly string[] | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /** Split or Route: where the tool would act under the pointer (a tick on the duct, or the next route point). */
  const [toolMark, setToolMark] = useState<{ readonly paper: Vec2; readonly label: string } | null>(null)
  const r = view.paperRect
  const clipId = `model-layer-clip-${view.viewport?.id ?? view.view.id}`
  const tool = bridge.tool
  const routing = tool === 'route'
  const splitting = tool === 'split'
  const snapTolerance = toleranceMm(view, paperMmPerPx, SNAP_PX)
  // Circuit lines on paper, re-derived when the model or view changes (plans only): what a drag can bend.
  const circuitJoins = useMemo(() => {
    if (view.view.viewType !== 'floor_plan' && view.view.viewType !== 'ceiling_plan') return []
    const shown = new Map<string, PartInstance>()
    for (const el of viewLevelElements(model, view.view)) if (el.kind === 'part') shown.set(el.id, el)
    return circuitJoinsOnPaper(model, view.view, shown, view.frame.scale, (q) => modelToPaperPoint(view, { x: q.x, y: q.y, z: 0 }))
  }, [model, view])
  const joinAt = (p: Vec2) => circuitJoinNear(circuitJoins, p, CLICK_PX * paperMmPerPx)

  const commitTyped = (d: Extract<Drag, { kind: 'run' }>) => {
    const mm = parseLength(d.typed)
    if (mm === null || mm <= 0) {
      bridge.hint(`"${d.typed}" isn't a length. Type it like 12'6", 12.5' or 150mm, then Enter.`)
      setDrag({ ...d, typed: '' })
      return
    }
    const hint = bridge.runDrag.toLength(mm)
    setDrag(null)
    const refused = bridge.runDrag.end(true)
    bridge.hint(refused ?? hint)
    if (refused) toast.error(refused)
  }

  /** The paper point under the pointer while it is over this drawing: where a paste lands. */
  const pointerAt = useRef<Vec2 | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || typingIn(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'c') {
        // Only the drawing the pointer is over answers, so a sheet with several plans copies once.
        if (!pointerAt.current || bridge.selectedIds.length === 0) return
        const clip = clipOf(model, bridge.selectedIds)
        e.preventDefault()
        if (typeof clip === 'string') return bridge.hint(clip)
        rememberClip(clip)
        bridge.hint(copiedHint(clip))
      } else if (key === 'v') {
        const at = pointerAt.current
        const clipboard = currentClip()
        if (!at || !clipboard) return
        e.preventDefault()
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        const m = view.mapping.toModel(paperToDrawing(view, at))
        if (!m) return bridge.hint(view.mapping.modelReason ?? "This drawing can't place parts, so there is nowhere to paste them.")
        const command = pasteCommand(clipboard, { x: m.x, y: m.y }, pasteIds())
        const refused = bridge.submit(command, command.ids.length === 1 ? 'paste 1 part' : `paste ${command.ids.length} parts`)
        if (refused) toast.error(refused)
        bridge.hint(refused ?? `Pasted ${command.ids.length} ${command.ids.length === 1 ? 'part' : 'parts'}. Undo takes them back; Ctrl+V again pastes another set.`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    const toolOn = bridge.tool !== 'select'
    if (!hover && !drag && !routing && !toolOn) return
    const onKey = (e: KeyboardEvent) => {
      // Typing in the tool's own field (Route's width): Esc leaves the field first, the next one reaches the tool.
      const field = escapeLeavesField(e, toolOn)
      if (field) {
        e.stopPropagation()
        field.blur()
        bridge.hint(leftFieldHint(bridge.tool))
        return
      }
      if (drag?.kind === 'run' && !e.metaKey && !e.ctrlKey && (LENGTH_KEY.test(e.key) || e.key === 'Backspace' || (e.key === 'Enter' && drag.typed))) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Enter') return commitTyped(drag)
        const typed = e.key === 'Backspace' ? drag.typed.slice(0, -1) : drag.typed + e.key
        bridge.hint(typed ? `Length: ${typed} (Enter to make it exactly that long; a bare number is inches, 12' is feet)` : drag.hint)
        setDrag({ ...drag, typed })
        return
      }
      if (e.key === 'Tab' && hover && !drag) {
        e.preventDefault()
        bridge.hint(bridge.tab(e.shiftKey ? -1 : 1))
        setHover(bridge.highlighted())
      } else if (routing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        bridge.hint(bridge.tools.finishRoute())
        setToolMark(null)
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        const step = drawingEscapeStep({ tool: bridge.tool, dragging: drag !== null, routeInProgress: routing && bridge.tools.routeLastPoint() !== null })
        if (step === null) return
        e.stopPropagation()
        if (step === 'cancel-drag' && drag) {
          setDrag(null)
          if (drag.kind === 'run') bridge.runDrag.end(false)
          bridge.hint(drag.kind === 'run' ? 'Drag cancelled; nothing changed.' : 'Move cancelled; nothing changed.')
        } else if (step === 'cancel-route' && bridge.tools.cancelRoute()) {
          bridge.hint('Route cancelled; nothing was saved. Click to start another, or Esc again to stop routing.')
        } else if (bridge.stopTool) {
          bridge.tools.cancelRoute()
          bridge.stopTool()
          bridge.hint(stoppedToolHint(bridge.tool))
        } else {
          console.error('[ModelDrawingLayer] Esc could not stop the tool: the drawing has no stopTool', { tool: bridge.tool })
          bridge.hint('Esc could not stop this tool here. Choose Select in the ribbon.')
        }
        setToolMark(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const hoverAt = (p: Vec2) => {
    const id = idsAt(index, view, p, paperMmPerPx)[0] ?? null
    const hint = bridge.hover(id)
    const join = id === null && tool === 'select' ? joinAt(p) : null
    bridge.hint(join ? `Circuit ${join.name}: drag the line to bend it there.` : hint)
    setHover(bridge.highlighted() ?? (id ? [id] : null))
  }

  /** The straight piece and model point a Split click would cut at. */
  const splitInput = (p: Vec2): { id: string; at: RunPoint } | null => {
    const id = idsAt(index, view, p, paperMmPerPx).find((i) => model.elements[i]?.kind === 'run_segment')
    const at = id ? runPointUnder(model, view, id, p) : null
    return id && at ? { id, at } : null
  }

  /**
   * The Route tool's point under the pointer: an open end (start or finish
   * there), else snapped to a run end, elbow or part, at the depth of the
   * route's last point. In a section, a point more above or below the last
   * point than along is a rise or drop there.
   */
  const routeInput = (p: Vec2, free: boolean): RouteInput | null => {
    const end = openEndNear(model, view, p, snapTolerance)
    // Off any open end, on a straight run's side: start a tap off it, or finish the route into it (the marker says "tap").
    const side = end ? null : runSideUnder(model, view, idsAt(index, view, p, paperMmPerPx), p)
    const snap = end || side || free ? null : snapOnPaper(model, view, p, snapTolerance, new Set())
    const paper = end ? modelToPaperPoint(view, end.at) : side ? modelToPaperPoint(view, side.at) : (snap?.paper ?? p)
    const d = paperToDrawing(view, paper)
    const prev = bridge.tools.routeLastPoint()
    const m = view.mapping.toModel(d, prev ? view.mapping.depthOf(prev) : undefined)
    if (!m) return null
    if (view.mapping.kind !== 'section') return { point: { x: m.x, y: m.y }, vertical: false, end, side, paper }
    const pd = prev ? view.mapping.toDrawing(prev) : null
    const vertical = pd !== null && Math.abs(d.y - pd.v) > Math.abs(d.x - pd.u)
    return { point: { x: m.x, y: m.y, z: m.z }, vertical, end, side, paper }
  }

  const toolHover = (p: Vec2, free: boolean) => {
    if (splitting) {
      const s = splitInput(p)
      bridge.hint(s ? bridge.tools.previewSplit(s.id, s.at) : 'Point at a straight duct or pipe where it should be split.')
      setToolMark(s ? { paper: modelToPaperPoint(view, s.at), label: 'split' } : null)
      return
    }
    const ri = routeInput(p, free)
    bridge.hint(ri ? bridge.tools.previewRoute(ri.point, ri.vertical, ri.end, ri.side) : view.mapping.modelReason)
    setToolMark(ri ? { paper: ri.paper, label: ri.end ? 'open end' : ri.side ? 'tap' : ri.vertical ? 'rise / drop' : 'point' } : null)
  }

  const toolClick = (p: Vec2, free: boolean) => {
    if (!bridge.canEdit) {
      toast.error(bridge.blockedReason)
      return
    }
    if (splitting) {
      const s = splitInput(p)
      bridge.hint(s ? bridge.tools.split(s.id, s.at) : 'Click on a straight duct or pipe to split it.')
      return
    }
    const ri = routeInput(p, free)
    if (!ri) return
    bridge.hint(bridge.tools.clickRoute(ri.point, ri.vertical, ri.end, ri.side))
  }

  const onPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return
    const p = paperOf(e)
    if (!p) return
    e.stopPropagation()
    const shiftBox = e.shiftKey || bridge.tool === 'box'
    const id = routing || splitting || shiftBox ? null : (idsAt(index, view, p, paperMmPerPx)[0] ?? null)
    // A circuit line under a Select press (and no device): the drag bends it.
    const join = tool === 'select' && !shiftBox && id === null ? joinAt(p) : null
    if (join) {
      if (!bridge.canEdit) {
        toast.error(bridge.blockedReason)
        return
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ kind: 'bend', from: p, to: p, join })
      return
    }
    // Nothing under a Select press: a drag is a window or crossing box, a click deselects (the box's short-drag case).
    const boxing = shiftBox || (tool === 'select' && id === null)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (routing || splitting) {
      setDrag({ kind: 'press', from: p, id: null })
      return
    }
    if (boxing) {
      bridge.hover(null)
      setHover(null)
      setDrag({ kind: 'box', a: p, b: p })
      bridge.hint(BOX_HINT)
      return
    }
    setDrag({ kind: 'press', from: p, id })
  }

  const onPointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    const p = paperOf(e)
    pointerAt.current = p
    if (!p) return
    if (routing || splitting) {
      if (!drag) toolHover(p, e.ctrlKey || e.metaKey)
      return
    }
    if (!drag) {
      hoverAt(p)
      return
    }
    if (drag.kind === 'box') {
      setDrag({ ...drag, b: p })
      return
    }
    if (drag.kind === 'move') {
      setDrag({ ...drag, to: p, free: e.altKey })
      return
    }
    if (drag.kind === 'bend') {
      setDrag({ ...drag, to: p })
      bridge.hint('Release to pin the circuit line’s bend here, Esc to cancel.')
      return
    }
    if (drag.kind === 'run') {
      // Ctrl / Cmd drags without snapping to run ends, elbows and parts.
      const snap = e.ctrlKey || e.metaKey ? null : snapOnPaper(model, view, p, snapTolerance, drag.exclude)
      const to = snap?.paper ?? p
      const delta = runDragDelta(view, drag.from, to, e.shiftKey)
      const hint = delta ? bridge.runDrag.preview(delta, e.altKey) : null
      bridge.hint(drag.typed ? `Length: ${drag.typed} (Enter to make it exactly that long)` : hint)
      setDrag({ ...drag, to, hint: hint && snap ? `${hint} (on the ${snap.label}; Ctrl for no snap)` : hint, snap })
      return
    }
    if (Math.hypot(p.x - drag.from.x, p.y - drag.from.y) < CLICK_PX * paperMmPerPx || !drag.id) return
    if (!bridge.canEdit) {
      toast.error(bridge.blockedReason)
      setDrag(null)
      return
    }
    // A duct or pipe piece (not part of a bigger selection) drags like it does in 3D: middle, end or elbow.
    const groupMove = bridge.selectedIds.length > 1 && bridge.selectedIds.includes(drag.id)
    const at = !groupMove && isRunPiece(model.elements[drag.id]) ? runPointUnder(model, view, drag.id, drag.from) : null
    const began = at ? bridge.runDrag.begin(drag.id, at) : null
    if (began) {
      bridge.hover(null)
      setHover(null)
      const delta = runDragDelta(view, drag.from, p, e.shiftKey)
      const hint = (delta ? bridge.runDrag.preview(delta, e.altKey) : null) ?? began
      bridge.hint(hint)
      setDrag({ kind: 'run', from: drag.from, to: p, hint, exclude: joinedTo(model, drag.id), typed: '', snap: null })
      return
    }
    const ids = bridge.selectedIds.includes(drag.id) ? bridge.selectedIds : [drag.id]
    if (!bridge.selectedIds.includes(drag.id)) bridge.select(drag.id)
    bridge.hover(null)
    setHover(null)
    setDrag({ kind: 'move', from: drag.from, to: p, ids, free: e.altKey })
  }

  const onPointerUp = (e: React.PointerEvent<SVGRectElement>) => {
    const d = drag
    setDrag(null)
    if (!d) return
    if (d.kind === 'press' && (routing || splitting)) {
      toolClick(d.from, e.ctrlKey || e.metaKey)
      // Routing previews its next leg from here at once. A split's answer stays until the pointer moves:
      // previewing the same point again would read the new cut as "too close to an end" and hide "Split at …".
      if (routing) toolHover(d.from, e.ctrlKey || e.metaKey)
      return
    }
    if (d.kind === 'run' && d.typed) return commitTyped(d)
    if (d.kind === 'bend') {
      if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < CLICK_PX * paperMmPerPx) return
      const at = view.mapping.toModel(paperToDrawing(view, d.to))
      if (!at) {
        bridge.hint(view.mapping.modelReason)
        return
      }
      const refused = bridge.submit({ type: 'set_view_properties', viewId: view.view.id, props: { circuitGraphics: withCircuitBend(view.view, d.join.linkId, d.join.a, d.join.b, { x: at.x, y: at.y }) } }, 'bend the circuit line')
      bridge.hint(refused ?? 'Bend pinned. Clear it under Circuits on this plan in the view’s properties.')
      if (refused) toast.error(refused)
      return
    }
    if (d.kind === 'press') {
      // A tool drawing on the plan (an add-on's Wall) takes a click on empty paper as its next point.
      if (d.id === null && bridge.claimEmptyClick?.()) return
      bridge.select(d.id)
      if (d.id) onPicked?.()
      return
    }
    if (d.kind === 'box') {
      if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < CLICK_PX * paperMmPerPx) {
        bridge.hint(null)
        const id = idsAt(index, view, d.a, paperMmPerPx)[0] ?? null
        if (id === null && bridge.claimEmptyClick?.()) return
        bridge.select(id)
        return
      }
      const { ids, mode } = idsInBox(index, view, d.a, d.b)
      bridge.hint(bridge.selectBox(ids, mode))
      if (ids.length > 0) onPicked?.()
      return
    }
    if (d.kind === 'run') {
      const refused = bridge.runDrag.end(true)
      bridge.hint(refused)
      if (refused) toast.error(refused)
      return
    }
    const delta = dragToModel(view, d.from, d.to, d.free)
    if (!delta || (delta.x === 0 && delta.y === 0 && delta.z === 0)) return
    const refused = bridge.moveBy(d.ids, delta)
    if (refused) toast.error(refused)
  }

  const runPreviewModel = drag?.kind === 'run' ? bridge.runDrag.previewModel() : routing ? bridge.tools.routePreviewModel() : null
  const runStrokes = runPreviewModel ? runPreviewOnPaper(model, runPreviewModel, view, MAX_OUTLINES) : []
  const routeTicks = routing && runStrokes.length > 0 ? routeTicksAcross((bridge.tools.routeTicks?.() ?? []).map((q) => modelToPaperPoint(view, q)), runStrokes, TICK_HALF_MM) : []
  const moveDelta: RunPoint | null = drag?.kind === 'move' ? dragToModel(view, drag.from, drag.to, drag.free) : null
  const moveOffset = drag?.kind === 'move' ? paperOffsetFor(view, drag.from, drag.to, drag.free) : null
  const selectedOutlines = useMemo(
    () => bridge.selectedIds.slice(0, MAX_OUTLINES).flatMap((id) => {
      const poly = outlineOnPaper(index, view, id)
      return poly ? [{ id, poly }] : []
    }),
    [bridge.selectedIds, index, view],
  )
  const hoverOutlines = (hover ?? []).slice(0, MAX_OUTLINES).flatMap((id) => {
    if (bridge.selectedIds.includes(id)) return []
    const poly = outlineOnPaper(index, view, id)
    return poly ? [{ id, poly }] : []
  })
  const overSelected = hover !== null && hover.some((id) => bridge.selectedIds.includes(id))

  // "+" grip: on the one selected (else hovered) element when nothing serves it and a network says what could.
  const gripId = bridge.canEdit && !drag ? (bridge.selectedIds.length === 1 ? bridge.selectedIds[0] : hover?.length === 1 ? hover[0] : undefined) : undefined
  const gripAnswer = useMemo(() => (gripId ? gripFor(model, asElementId(gripId)) : null), [model, gripId])
  const gripOutline = gripId && gripAnswer ? outlineOnPaper(index, view, gripId) : null
  const gripAt = gripOutline && gripOutline.length > 0 ? { x: Math.max(...gripOutline.map((q) => q.x)) + 3 * paperMmPerPx, y: Math.min(...gripOutline.map((q) => q.y)) - 3 * paperMmPerPx } : null
  const gripDrop = (d: GripDrop): string | null => submitGripDrop(model, d, newElementId('lnk'), bridge.submit)

  return (
    <g data-testid="model-drawing-layer" data-view-id={view.view.id} data-pickable={index.footprints.size}>
      <defs>
        <clipPath id={clipId}>
          <rect x={r.min.x} y={r.min.y} width={r.max.x - r.min.x} height={r.max.y - r.min.y} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`} pointerEvents="none">
        {selectedOutlines.map(({ id, poly }) => (
          <polygon key={`s-${id}`} points={points(poly)} fill={PRIMARY} fillOpacity={0.14} stroke={PRIMARY} strokeWidth={0.5} data-testid="model-selected-outline" data-element-id={id} />
        ))}
        {hoverOutlines.map(({ id, poly }) => (
          <polygon key={`h-${id}`} points={points(poly)} fill={PRIMARY} fillOpacity={0.06} stroke={PRIMARY} strokeOpacity={0.7} strokeWidth={0.35} strokeDasharray="1.2 0.8" data-testid="model-hover-outline" data-element-id={id} />
        ))}
        {moveOffset &&
          drag?.kind === 'move' &&
          drag.ids.slice(0, MAX_OUTLINES).map((id) => {
            const poly = outlineOnPaper(index, view, id)
            return poly ? <polygon key={`m-${id}`} points={points(poly, moveOffset)} fill="none" stroke={PRIMARY} strokeWidth={0.45} strokeDasharray="1.5 1" data-testid="model-move-preview" /> : null
          })}
        {runStrokes.map((s) => (
          <line
            key={`r-${s.id}`}
            x1={s.a.x}
            y1={s.a.y}
            x2={s.b.x}
            y2={s.b.y}
            stroke={PRIMARY}
            strokeOpacity={0.45}
            strokeWidth={Math.max(s.width, 0.6)}
            strokeLinecap={s.a.x === s.b.x && s.a.y === s.b.y ? 'round' : 'butt'}
            data-testid="model-run-preview"
            data-element-id={s.id}
          />
        ))}
        {routeTicks.map((t, i) => (
          <line key={`t-${i}`} x1={t.a.x} y1={t.a.y} x2={t.b.x} y2={t.b.y} stroke={ROUTE_CHECK_COLOUR} strokeWidth={0.6} strokeLinecap="round" pointerEvents="none" data-testid="model-route-check-tick" />
        ))}
      </g>
      {drag?.kind === 'run' && drag.snap && (
        <circle cx={drag.snap.paper.x} cy={drag.snap.paper.y} r={1.4} fill="none" stroke={PRIMARY} strokeWidth={0.4} pointerEvents="none" data-testid="model-snap-marker" data-snap={drag.snap.label} />
      )}
      {(routing || splitting) && toolMark && (
        <g pointerEvents="none" data-testid="model-tool-marker" data-label={toolMark.label}>
          <line x1={toolMark.paper.x - 1.6} y1={toolMark.paper.y} x2={toolMark.paper.x + 1.6} y2={toolMark.paper.y} stroke={PRIMARY} strokeWidth={0.4} />
          <line x1={toolMark.paper.x} y1={toolMark.paper.y - 1.6} x2={toolMark.paper.x} y2={toolMark.paper.y + 1.6} stroke={PRIMARY} strokeWidth={0.4} />
        </g>
      )}
      {drag?.kind === 'run' && drag.hint && (
        <g pointerEvents="none" data-testid="model-run-dimension">
          <line x1={drag.from.x} y1={drag.from.y} x2={drag.to.x} y2={drag.to.y} stroke={PRIMARY} strokeWidth={0.3} strokeDasharray="1 0.8" />
          <text x={drag.to.x + 2} y={drag.to.y - 2} fontSize={2.6} fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.6}>
            {drag.typed ? `Length: ${drag.typed}` : drag.hint}
          </text>
        </g>
      )}
      {drag?.kind === 'move' && moveDelta && (
        <g pointerEvents="none" data-testid="model-move-dimension">
          <line x1={drag.from.x} y1={drag.from.y} x2={drag.from.x + (moveOffset?.x ?? 0)} y2={drag.from.y + (moveOffset?.y ?? 0)} stroke={PRIMARY} strokeWidth={0.3} />
          <text x={drag.to.x + 2} y={drag.to.y - 2} fontSize={2.6} fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.6}>
            {`${describeModelDelta(view.mapping, moveDelta)}. Release to move, Esc to cancel${view.mapping.kind === 'section' ? ', Alt to move both ways' : ''}.`}
          </text>
        </g>
      )}
      {drag?.kind === 'bend' && (
        <g pointerEvents="none" data-testid="model-bend-preview" data-link-id={drag.join.linkId}>
          <polyline
            points={points([drag.join.points[0] ?? drag.from, drag.to, drag.join.points[drag.join.points.length - 1] ?? drag.from])}
            fill="none"
            stroke={PRIMARY}
            strokeWidth={0.45}
            strokeDasharray="1.5 1"
          />
          <circle cx={drag.to.x} cy={drag.to.y} r={1} fill="none" stroke={PRIMARY} strokeWidth={0.4} />
        </g>
      )}
      {drag?.kind === 'box' && (
        <rect
          x={Math.min(drag.a.x, drag.b.x)}
          y={Math.min(drag.a.y, drag.b.y)}
          width={Math.abs(drag.b.x - drag.a.x)}
          height={Math.abs(drag.b.y - drag.a.y)}
          fill={PRIMARY}
          fillOpacity={0.08}
          stroke={PRIMARY}
          strokeWidth={0.4}
          strokeDasharray={drag.b.x < drag.a.x ? '1.5 1' : undefined}
          pointerEvents="none"
          data-testid="model-box-select"
          data-mode={drag.b.x < drag.a.x ? 'crossing' : 'window'}
        />
      )}
      <rect
        x={r.min.x}
        y={r.min.y}
        width={r.max.x - r.min.x}
        height={r.max.y - r.min.y}
        fill="transparent"
        className={drawingCursorClass({ aiming: routing || splitting, dragging: drag?.kind === 'move' || drag?.kind === 'run', clickPlaces: hover !== null && (bridge.clickPlaces?.() ?? false), overSelected, canEdit: bridge.canEdit, hovering: hover !== null })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          if (drag?.kind === 'run') bridge.hint(bridge.runDrag.end(false))
          setDrag(null)
        }}
        onPointerLeave={() => {
          pointerAt.current = null
          if (drag) return
          bridge.hover(null)
          setHover(null)
        }}
        data-testid="model-drawing-hit"
      >
        <title>{`${view.view.name}: click to select, Tab for more, drag empty space to box select (right: wholly inside, left: touching), drag a selection to move it, Ctrl+C / Ctrl+V to copy and paste parts at the pointer, Space-drag to pan. Drag duct or pipe by its middle, an end or an elbow.`}</title>
      </rect>
      {bridge.canEdit && bridge.plus && !drag && !routing && (
        <DrawingPlusSpots model={model} view={view} selectedIds={bridge.selectedIds} serverFeatures={bridge.serverFeatures ?? []} paperMmPerPx={paperMmPerPx} onPick={bridge.plus} hint={bridge.hint} />
      )}
      {gripId && gripAnswer && gripAt && (
        <Suspense fallback={null}>
          <PlanConnectGrip
            elementId={asElementId(gripId)}
            answer={gripAnswer}
            at={gripAt}
            paperMmPerPx={paperMmPerPx}
            paperOf={paperOf}
            sourceUnder={(p) => {
              const id = idsAt(index, view, p, paperMmPerPx)[0]
              return id ? asElementId(id) : null
            }}
            outlineOf={(id) => outlineOnPaper(index, view, id)}
            onDrop={gripDrop}
            hint={bridge.hint}
          />
        </Suspense>
      )}
    </g>
  )
}
