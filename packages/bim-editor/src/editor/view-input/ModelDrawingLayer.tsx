'use client'

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  asElementId,
  buildViewPickIndex,
  describeModelDelta,
  drawPartSymbol,
  editableLinePlacement,
  hostLineOf,
  isWallFaceMountable,
  joinedEndFollowers,
  modelToPaperPoint,
  nearestWallFace,
  paperToDrawing,
  planAutoPartMarks,
  viewLevelElements,
  viewModelLevel,
  type AutoPartMarkHit,
  type ModelState,
  type PartInstance,
  type RunPoint,
  type Vec2,
  type ViewElement,
  type ViewOnPaper,
  type ViewPickIndex,
} from '@permitzip/bim-kernel'
import { DRAFTING_GRID_MM, snapPoint, type Snap } from '../architecture/tools/snap'
import { endDragHint, endDropCommand } from '../architecture/WallEndGrips'
import { isSelectableUnderLocks, useSelectionLocks } from '../selection-locks'
import {
  WireContextMenu,
  previewWireCurve,
  submitSwitchLabelOffset,
  submitWireHomeRun,
  submitWireWaypoints,
  wireHomeRunNear,
  wireHomeRunsOnPaper,
  wireJoinNear,
  wireJoinsOnPaper,
  wireSwitchLabelNear,
  wireSwitchLabelsOnPaper,
  type WireHomeRunHitPart,
  type WireHomeRunOnPaper,
  type WireJoinOnPaper,
  type WireMenuState,
  type WireSwitchLabelOnPaper,
} from '../electrical/WireContextMenu'
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
  /** A plan wire (or one of its spline vertices) dragged to reshape it. */
  | { readonly kind: 'bend'; readonly from: Vec2; readonly to: Vec2; readonly join: WireJoinOnPaper; readonly vertexIndex: number | null }
  /** A home run arrow tip, shaft curve, or label dragged to reposition it while staying anchored to its host device. */
  | { readonly kind: 'homerun'; readonly from: Vec2; readonly to: Vec2; readonly homeRun: WireHomeRunOnPaper; readonly part: WireHomeRunHitPart }
  /** An automatic device mark dragged to reposition it (promotes into a movable masked tag with auto-leader when pulled away). */
  | { readonly kind: 'mark'; readonly from: Vec2; readonly to: Vec2; readonly mark: AutoPartMarkHit }
  /** A lowercase switch-leg designation ("a", "b") dragged to reposition it relative to its device. */
  | { readonly kind: 'switch_label'; readonly from: Vec2; readonly to: Vec2; readonly label: WireSwitchLabelOnPaper }
  /** A routed piece, end or elbow, dragged through the session's `drag_run` (as in 3D). */
  | { readonly kind: 'run'; readonly from: Vec2; readonly to: Vec2; readonly hint: string | null; readonly exclude: ReadonlySet<string>; readonly typed: string; readonly snap: SnapHit | null }

/** Insert `pt` into `existing` waypoints at the position closest along the segment `a -> ... -> b`. */
function insertWaypointOrdered(a: Vec2, b: Vec2, existing: readonly Vec2[], pt: Vec2): Vec2[] {
  const chain = [a, ...existing, b]
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i + 1 < chain.length; i++) {
    const p0 = chain[i]!
    const p1 = chain[i + 1]!
    const dx = p1.x - p0.x
    const dy = p1.y - p0.y
    const l2 = dx * dx + dy * dy
    const t = l2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((pt.x - p0.x) * dx + (pt.y - p0.y) * dy) / l2))
    const d = Math.hypot(pt.x - (p0.x + dx * t), pt.y - (p0.y + dy * t))
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  const out = [...existing]
  out.splice(bestIdx, 0, pt)
  return out
}

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
  const locks = useSelectionLocks()
  const [hover, setHover] = useState<readonly string[] | null>(null)
  const [hoverJoin, setHoverJoin] = useState<WireJoinOnPaper | null>(null)
  const [hoverHomeRun, setHoverHomeRun] = useState<{ readonly homeRun: WireHomeRunOnPaper; readonly part: WireHomeRunHitPart } | null>(null)
  const [hoverMark, setHoverMark] = useState<AutoPartMarkHit | null>(null)
  const [hoverSwitchLabel, setHoverSwitchLabel] = useState<WireSwitchLabelOnPaper | null>(null)
  const [wireMenu, setWireMenu] = useState<WireMenuState | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [wallEndDrag, setWallEndDrag] = useState<{ readonly wallId: string; readonly end: 'start' | 'end'; readonly at: Vec2; readonly snap: Snap | null; readonly disjoin: boolean } | null>(null)
  const overlapRef = useRef<{ stack: string[]; idx: number }>({ stack: [], idx: 0 })
  const pickIdsAt = (p: Vec2): string[] => idsAt(index, view, p, paperMmPerPx).filter((id) => isSelectableUnderLocks(model.elements[id], locks))
  /** Split or Route: where the tool would act under the pointer (a tick on the duct, or the next route point). */
  const [toolMark, setToolMark] = useState<{ readonly paper: Vec2; readonly label: string } | null>(null)
  const r = view.paperRect
  const clipId = `model-layer-clip-${view.viewport?.id ?? view.view.id}`
  const tool = bridge.tool
  const routing = tool === 'route'
  const splitting = tool === 'split'
  const snapTolerance = toleranceMm(view, paperMmPerPx, SNAP_PX)
  const isPlanView = view.view.viewType === 'floor_plan' || view.view.viewType === 'ceiling_plan'
  const shownPlanParts = useMemo(() => {
    const shown = new Map<string, PartInstance>()
    if (!isPlanView) return shown
    for (const el of viewLevelElements(model, view.view)) if (el.kind === 'part') shown.set(el.id, el)
    return shown
  }, [isPlanView, model, view.view])
  // Circuit & switch-leg spans on paper (plans only): drag to bend/reshape, right-click to add/remove spline vertices.
  const wireJoins = useMemo(() => {
    if (!isPlanView) return []
    return wireJoinsOnPaper(model, view.view, shownPlanParts, view.frame.scale, (q) => modelToPaperPoint(view, { x: q.x, y: q.y, z: 0 }))
  }, [isPlanView, model, shownPlanParts, view])
  // Home runs on paper (plans only): drag arrow tip, curve shaft, or label.
  const wireHomeRuns = useMemo(() => {
    if (!isPlanView) return []
    return wireHomeRunsOnPaper(model, view.view, shownPlanParts, view.frame.scale, (q) => modelToPaperPoint(view, { x: q.x, y: q.y, z: 0 }))
  }, [isPlanView, model, shownPlanParts, view])
  // Switch-leg designations ("a", "b") on paper (plans only): drag any letter to reposition it relative to its device.
  const switchLegLabels = useMemo(() => {
    if (!isPlanView) return []
    return wireSwitchLabelsOnPaper(model, view.view, shownPlanParts, view.frame.scale, (q) => modelToPaperPoint(view, { x: q.x, y: q.y, z: 0 }))
  }, [isPlanView, model, shownPlanParts, view])
  // Untagged device marks on paper (plans only): drag any mark directly to turn it into a movable tag.
  const autoMarks = useMemo(
    () => (isPlanView ? planAutoPartMarks(model, view.view, view.frame, (q) => modelToPaperPoint(view, { x: q.x, y: q.y, z: 0 })) : []),
    [isPlanView, model, view],
  )
  const wireTolMm = Math.max(1.2, 7 * paperMmPerPx)
  const joinAt = (p: Vec2) => wireJoinNear(wireJoins, p, wireTolMm)
  const homeRunAt = (p: Vec2) => wireHomeRunNear(wireHomeRuns, p, wireTolMm)
  const switchLabelAt = (p: Vec2) => wireSwitchLabelNear(switchLegLabels, p, Math.max(1.8, 7 * paperMmPerPx))
  /** Model elements that take click/hover priority over drawn wires (devices, runs, fittings, openings, columns). Wires win over rooms, grids, and walls they cross. */
  const isForegroundModelEl = (elId: string | null): boolean => {
    if (!elId) return false
    const k = model.elements[elId]?.kind
    return k !== 'room' && k !== 'grid' && k !== 'wall'
  }
  const autoMarkAt = (p: Vec2): AutoPartMarkHit | null => {
    const pad = Math.max(1.0, CLICK_PX * 0.5 * paperMmPerPx)
    for (const m of autoMarks) {
      if (p.x >= m.box.min.x - pad && p.x <= m.box.max.x + pad && p.y >= m.box.min.y - pad && p.y <= m.box.max.y + pad) return m
    }
    return null
  }
  const vertexNearJoin = (join: WireJoinOnPaper, p: Vec2): number | null => {
    const tol = Math.max(1.8, 8 * paperMmPerPx)
    let best = -1
    let bestD = tol
    join.waypointsPaper.forEach((wp, i) => {
      const d = Math.hypot(p.x - wp.x, p.y - wp.y)
      if (d <= bestD) {
        bestD = d
        best = i
      }
    })
    return best >= 0 ? best : null
  }
  const vertexHitAnyJoin = (p: Vec2): { readonly join: WireJoinOnPaper; readonly vertexIndex: number } | null => {
    for (const join of wireJoins) {
      const idx = vertexNearJoin(join, p)
      if (idx !== null) return { join, vertexIndex: idx }
    }
    return null
  }
  useEffect(() => {
    if (!wireMenu) return
    const close = () => setWireMenu(null)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setWireMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [wireMenu])

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
        const ov = overlapRef.current
        if (ov.stack.length > 1) {
          const step = e.shiftKey ? -1 : 1
          const nextIdx = (ov.idx + step + ov.stack.length) % ov.stack.length
          ov.idx = nextIdx
          const id = ov.stack[nextIdx] ?? null
          const el = id ? model.elements[id] : undefined
          const label = el ? ('name' in el && typeof el.name === 'string' && el.name ? el.name : 'mark' in el && typeof el.mark === 'string' && el.mark ? el.mark : el.kind.replace(/_/g, ' ')) : ''
          bridge.hover(id)
          bridge.hint(`Tab (${nextIdx + 1}/${ov.stack.length}): ${label} — click to select, Tab for next`)
          setHover(id ? [id] : null)
        } else {
          bridge.hint(bridge.tab(e.shiftKey ? -1 : 1))
          setHover(bridge.highlighted())
        }
      } else if (routing && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        bridge.hint(bridge.tools.finishRoute())
        setToolMark(null)
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        const step = drawingEscapeStep({ tool: bridge.tool, dragging: drag !== null || wallEndDrag !== null, routeInProgress: routing && bridge.tools.routeLastPoint() !== null })
        if (step === null) return
        e.stopPropagation()
        if (step === 'cancel-drag' && (drag || wallEndDrag)) {
          if (wallEndDrag) {
            setWallEndDrag(null)
            bridge.hint('Wall end drag cancelled; nothing changed.')
          } else if (drag) {
            setDrag(null)
            if (drag.kind === 'run') bridge.runDrag.end(false)
            bridge.hint(drag.kind === 'run' ? 'Drag cancelled; nothing changed.' : 'Move cancelled; nothing changed.')
          }
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
    if (tool === 'select') {
      const vh = vertexHitAnyJoin(p)
      if (vh) {
        bridge.hover(null)
        setHover(null)
        setHoverHomeRun(null)
        setHoverMark(null)
        setHoverJoin(vh.join)
        bridge.hint(`${vh.join.kind === 'switch_leg' ? vh.join.name : `Circuit ${vh.join.name}`}: drag spline vertex to reshape, right-click to add or remove vertices.`)
        return
      }
      const hr = homeRunAt(p)
      if (hr && (hr.part === 'tip' || hr.part === 'label')) {
        bridge.hover(null)
        setHover(null)
        setHoverJoin(null)
        setHoverMark(null)
        setHoverHomeRun(hr)
        bridge.hint(
          hr.part === 'tip'
            ? `Home run ${hr.homeRun.name}: drag tip to aim or resize arrow; right-click to reset.`
            : `Home run label ${hr.homeRun.label}: drag to move label; right-click to reset.`,
        )
        return
      }
      const sw = switchLabelAt(p)
      if (sw) {
        bridge.hover(null)
        setHover(null)
        setHoverJoin(null)
        setHoverHomeRun(null)
        setHoverMark(null)
        setHoverSwitchLabel(sw)
        bridge.hint(`Switch leg "${sw.text}": drag to reposition letter; right-click to reset.`)
        return
      }
      const mark = autoMarkAt(p)
      if (mark) {
        bridge.hover(null)
        setHover(null)
        setHoverJoin(null)
        setHoverHomeRun(null)
        setHoverSwitchLabel(null)
        setHoverMark(mark)
        bridge.hint(`Mark ${mark.text}: drag to reposition as a movable tag (pull away for a leader).`)
        return
      }
    }
    setHoverMark(null)
    setHoverSwitchLabel(null)
    const stack = pickIdsAt(p)
    const prev = overlapRef.current
    const sameStack = stack.length === prev.stack.length && stack.every((id, i) => prev.stack[i] === id)
    const idx = sameStack ? Math.min(prev.idx, Math.max(0, stack.length - 1)) : 0
    overlapRef.current = { stack, idx }
    const id = stack[idx] ?? null
    const tabNote = stack.length > 1 ? ` · Tab cycles ${stack.length} overlapping` : ''
    if (isForegroundModelEl(id)) {
      const hint = bridge.hover(id)
      setHoverJoin(null)
      setHoverHomeRun(null)
      bridge.hint(hint ? `${hint}${tabNote}` : tabNote ? `Tab cycles ${stack.length} overlapping elements` : null)
      setHover(sameStack && idx > 0 && id ? [id] : (bridge.highlighted() ?? (id ? [id] : null)))
      return
    }
    // Wires and home-run shafts draw in front of rooms, grids, and crossed walls, so check them before background picks.
    if (tool === 'select') {
      const hr = homeRunAt(p)
      if (hr) {
        bridge.hover(null)
        setHoverJoin(null)
        setHoverHomeRun(hr)
        bridge.hint(`Home run ${hr.homeRun.name}: drag tip to aim/resize, drag shaft to curve, drag label to move; right-click to reset.`)
        setHover(null)
        return
      }
      const join = joinAt(p)
      if (join) {
        bridge.hover(null)
        setHoverHomeRun(null)
        setHoverJoin(join)
        bridge.hint(`${join.kind === 'switch_leg' ? join.name : `Circuit ${join.name}`}: drag to bend, right-click to insert/remove spline vertices or flip arc.`)
        setHover(null)
        return
      }
    }
    const hint = bridge.hover(id)
    setHoverHomeRun(null)
    setHoverJoin(null)
    bridge.hint(hint ? `${hint}${tabNote}` : tabNote ? `Tab cycles ${stack.length} overlapping elements` : null)
    setHover(sameStack && idx > 0 && id ? [id] : (bridge.highlighted() ?? (id ? [id] : null)))
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
    setWireMenu(null)
    const p = paperOf(e)
    if (!p) return
    e.stopPropagation()
    const shiftBox = e.shiftKey || bridge.tool === 'box'
    // 1. Direct handles that sit outside device symbols: pinned spline vertices, home-run tip/label, and auto-placed device marks.
    if (tool === 'select' && !shiftBox && !routing && !splitting) {
      const vh = vertexHitAnyJoin(p)
      if (vh) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'bend', from: p, to: p, join: vh.join, vertexIndex: vh.vertexIndex })
        return
      }
      const hr = homeRunAt(p)
      if (hr && (hr.part === 'tip' || hr.part === 'label')) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'homerun', from: p, to: p, homeRun: hr.homeRun, part: hr.part })
        return
      }
      const sw = switchLabelAt(p)
      if (sw) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'switch_label', from: p, to: p, label: sw })
        return
      }
      const mark = autoMarkAt(p)
      if (mark) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'mark', from: p, to: p, mark })
        return
      }
    }
    const stack = routing || splitting || shiftBox ? [] : pickIdsAt(p)
    const ov = overlapRef.current
    const sameStack = stack.length === ov.stack.length && stack.every((x, i) => ov.stack[i] === x)
    const id = stack[sameStack ? Math.min(ov.idx, Math.max(0, stack.length - 1)) : 0] ?? null
    const hitKind = id ? model.elements[id]?.kind : undefined
    // Background rooms/spaces never block dragging a box-select on empty floor.
    const isAreaBg = hitKind === 'room' || hitKind === 'space'
    // 2. When no foreground device/run is under the pointer, check home-run shaft & circuit/switch-leg wire spans
    //    (wins over background rooms, grids, and walls the wire crosses!).
    if (tool === 'select' && !shiftBox && !isForegroundModelEl(id)) {
      const hr = homeRunAt(p)
      if (hr) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'homerun', from: p, to: p, homeRun: hr.homeRun, part: hr.part })
        return
      }
      const join = joinAt(p)
      if (join) {
        if (!bridge.canEdit) {
          toast.error(bridge.blockedReason)
          return
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'bend', from: p, to: p, join, vertexIndex: vertexNearJoin(join, p) })
        return
      }
    }
    // Nothing under a Select press (or only a background room/space): drag makes a box, short click selects/deselects.
    const boxing = shiftBox || (tool === 'select' && (id === null || isAreaBg))
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

  const onContextMenu = (e: React.MouseEvent<SVGRectElement>) => {
    if (tool !== 'select' || !isPlanView || !bridge.canEdit) return
    const p = paperOf(e as unknown as React.PointerEvent<SVGElement>)
    if (!p) return
    const sw = switchLabelAt(p)
    if (sw) {
      e.preventDefault()
      e.stopPropagation()
      setWireMenu({ kind: 'switch_label', clientX: e.clientX, clientY: e.clientY, paper: p, label: sw })
      return
    }
    const hr = homeRunAt(p)
    if (hr) {
      e.preventDefault()
      e.stopPropagation()
      setWireMenu({ kind: 'homerun', clientX: e.clientX, clientY: e.clientY, paper: p, homeRun: hr.homeRun })
      return
    }
    const join = joinAt(p)
    if (join) {
      e.preventDefault()
      e.stopPropagation()
      setWireMenu({ kind: 'join', clientX: e.clientX, clientY: e.clientY, paper: p, join })
    }
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
      bridge.hint(drag.vertexIndex !== null ? 'Release to move spline vertex here, Esc to cancel.' : 'Release to reshape wire here (right-click wire to insert more spline vertices), Esc to cancel.')
      return
    }
    if (drag.kind === 'homerun') {
      setDrag({ ...drag, to: p })
      bridge.hint(
        drag.part === 'tip'
          ? 'Release to aim and resize home run arrow here, Esc to cancel.'
          : drag.part === 'label'
            ? 'Release to move home run label here, Esc to cancel.'
            : 'Release to curve home run arrow through here, Esc to cancel.',
      )
      return
    }
    if (drag.kind === 'switch_label') {
      setDrag({ ...drag, to: p })
      bridge.hint(`Release to place switch-leg letter "${drag.label.text}" here, Esc to cancel.`)
      return
    }
    if (drag.kind === 'mark') {
      setDrag({ ...drag, to: p })
      const far = Math.hypot(p.x - drag.mark.partAt.x, p.y - drag.mark.partAt.y) > 7
      bridge.hint(far ? `Release to place ${drag.mark.text} tag with leader, Esc to cancel.` : `Release to reposition ${drag.mark.text}, Esc to cancel.`)
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
      const nextPt = { x: at.x, y: at.y }
      let nextWaypoints: Vec2[]
      if (d.vertexIndex !== null && d.vertexIndex < d.join.waypointsModel.length) {
        nextWaypoints = d.join.waypointsModel.map((wp, i) => (i === d.vertexIndex ? nextPt : wp))
      } else if (d.join.waypointsModel.length <= 1) {
        nextWaypoints = [nextPt]
      } else {
        // Dragging on an existing multi-vertex spline moves its closest control vertex.
        let closest = 0
        let bestD = Infinity
        d.join.waypointsPaper.forEach((wp, i) => {
          const distP = Math.hypot(d.from.x - wp.x, d.from.y - wp.y)
          if (distP < bestD) {
            bestD = distP
            closest = i
          }
        })
        nextWaypoints = d.join.waypointsModel.map((wp, i) => (i === closest ? nextPt : wp))
      }
      const refused = submitWireWaypoints(bridge, view, d.join, nextWaypoints)
      bridge.hint(refused ?? 'Wire reshaped. Right-click the wire to add/remove spline vertices, flip arc, or reset.')
      if (refused) toast.error(refused)
      return
    }
    if (d.kind === 'homerun') {
      if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < CLICK_PX * paperMmPerPx) return
      const at = view.mapping.toModel(paperToDrawing(view, d.to))
      if (!at) {
        bridge.hint(view.mapping.modelReason)
        return
      }
      const refused = submitWireHomeRun(bridge, view, d.homeRun, d.part, at)
      bridge.hint(refused ?? 'Home run updated (it still follows the device when moved). Right-click to reset.')
      if (refused) toast.error(refused)
      return
    }
    if (d.kind === 'switch_label') {
      if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < CLICK_PX * paperMmPerPx) {
        bridge.select(d.label.memberId)
        onPicked?.()
        return
      }
      const at = view.mapping.toModel(paperToDrawing(view, d.to))
      if (!at) {
        bridge.hint(view.mapping.modelReason)
        return
      }
      const offset = { x: at.x - d.label.memberAnchorModel.x, y: at.y - d.label.memberAnchorModel.y }
      const refused = submitSwitchLabelOffset(bridge, view, d.label, offset)
      bridge.hint(refused ?? `Moved switch-leg letter "${d.label.text}". Right-click it to reset.`)
      if (refused) toast.error(refused)
      return
    }
    if (d.kind === 'mark') {
      if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < CLICK_PX * paperMmPerPx) {
        bridge.select(d.mark.partId)
        onPicked?.()
        return
      }
      const at = view.mapping.toModel(paperToDrawing(view, d.to))
      if (!at) {
        bridge.hint(view.mapping.modelReason)
        return
      }
      const pulledFar = Math.hypot(d.to.x - d.mark.partAt.x, d.to.y - d.mark.partAt.y) > 7
      const itemId = newElementId('tag')
      const refused = bridge.submit(
        {
          type: 'add_drawing_item',
          itemId,
          ownerId: view.view.id,
          shape: 'tag',
          points: [{ x: Math.round(at.x), y: Math.round(at.y) }],
          tag: {
            elementId: asElementId(d.mark.partId),
            template: 'mark',
            styleId: 'tst-mark-clean',
            leader: pulledFar,
            leaderOverride: pulledFar,
            mask: true,
            ...(pulledFar ? { elbow: 'auto' as const } : {}),
          },
        },
        `move ${d.mark.text} mark`,
      )
      bridge.hint(refused ?? `Moved ${d.mark.text} as a movable tag. Drag it again anytime or right-click to toggle its leader.`)
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
        const id = pickIdsAt(d.a)[0] ?? null
        if (id === null && bridge.claimEmptyClick?.()) return
        bridge.select(id)
        return
      }
      const { ids: rawIds, mode } = idsInBox(index, view, d.a, d.b)
      const ids = rawIds.filter((id) => isSelectableUnderLocks(model.elements[id], locks))
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
  // Live wall-face snap & rotated symbol preview when dragging a single wall-mountable part near a wall.
  const moveWallPreview = useMemo(() => {
    if (drag?.kind !== 'move' || drag.free || !isPlanView || !moveDelta || drag.ids.length !== 1) return null
    const id = drag.ids[0]
    if (!id) return null
    const el = model.elements[id]
    if (el?.kind !== 'part' || el.planned !== undefined) return null
    const typeEl = model.elements[el.typeId]
    if (typeEl?.kind !== 'part_type' || !isWallFaceMountable(typeEl.definition)) return null
    const targetPt = { x: el.position.x + moveDelta.x, y: el.position.y + moveDelta.y }
    const snap = nearestWallFace(model, el.levelId, targetPt, { maxDistanceMm: 450 })
    if (!snap) return null
    const level = model.elements[el.levelId]
    const z = (level?.kind === 'level' ? level.elevationMm : 0) + el.offsetMm
    const previewPart: PartInstance = {
      ...el,
      position: snap.position,
      rotationDeg: snap.rotationDeg,
      host: { kind: 'wall_face', elementId: snap.wallId, stationMm: snap.stationMm, side: snap.side },
    }
    const previewModel: ModelState = { ...model, elements: { ...model.elements, [el.id]: previewPart } }
    const lines: Array<{ readonly a: Vec2; readonly b: Vec2 }> = []
    const circles: Array<{ readonly c: Vec2; readonly r: number }> = []
    const texts: Array<{ readonly at: Vec2; readonly text: string; readonly sizeMm: number; readonly anchor?: 'start' | 'middle' | 'end' }> = []
    const toPaper = (q: Vec2): Vec2 => modelToPaperPoint(view, { x: q.x, y: q.y, z })
    drawPartSymbol(
      previewModel,
      previewPart,
      (a, b) => lines.push({ a: toPaper(a), b: toPaper(b) }),
      (pt, text, sizeMm, anchor) => texts.push({ at: toPaper(pt), text, sizeMm, anchor }),
      null,
      view.view.props?.detailLevel ?? 'medium',
      {
        scale: view.frame.scale,
        symbolScale: view.view.props?.symbolScale ?? 1,
        showMark: false,
        circle: (c, rad) => {
          const pc = toPaper(c)
          const pe = toPaper({ x: c.x + rad, y: c.y })
          circles.push({ c: pc, r: Math.hypot(pe.x - pc.x, pe.y - pc.y) })
        },
      },
    )
    return { center: toPaper(snap.position), lines, circles, texts }
  }, [drag, isPlanView, moveDelta, model, view])
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
        {moveWallPreview ? (
          <g pointerEvents="none" data-testid="model-wall-snap-preview">
            {moveWallPreview.circles.map((c, i) => (
              <circle key={`mwc-${i}`} cx={c.c.x} cy={c.c.y} r={c.r} fill="none" stroke={PRIMARY} strokeWidth={0.45} />
            ))}
            {moveWallPreview.lines.map((l, i) => (
              <line key={`mwl-${i}`} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} stroke={PRIMARY} strokeWidth={0.45} strokeLinecap="round" />
            ))}
            {moveWallPreview.texts.map((t, i) => (
              <text key={`mwt-${i}`} x={t.at.x} y={t.at.y} fontSize={t.sizeMm} textAnchor={t.anchor ?? 'middle'} fill={PRIMARY} fontFamily="sans-serif">
                {t.text}
              </text>
            ))}
            <circle cx={moveWallPreview.center.x} cy={moveWallPreview.center.y} r={0.75} fill={PRIMARY} />
          </g>
        ) : (
          moveOffset &&
          drag?.kind === 'move' &&
          drag.ids.slice(0, MAX_OUTLINES).map((id) => {
            const poly = outlineOnPaper(index, view, id)
            return poly ? <polygon key={`m-${id}`} points={points(poly, moveOffset)} fill="none" stroke={PRIMARY} strokeWidth={0.45} strokeDasharray="1.5 1" data-testid="model-move-preview" /> : null
          })
        )}
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
      {hoverJoin && !drag && (
        <g pointerEvents="none" data-testid="model-wire-hover">
          <polyline points={points(hoverJoin.points)} fill="none" stroke={PRIMARY} strokeOpacity={0.55} strokeWidth={0.9} />
          {hoverJoin.waypointsPaper.map((wp, i) => (
            <circle key={`wp-${i}`} cx={wp.x} cy={wp.y} r={1.25} fill="#ffffff" stroke={PRIMARY} strokeWidth={0.5} />
          ))}
        </g>
      )}
      {hoverHomeRun && !drag && (
        <g pointerEvents="none" data-testid="model-homerun-hover">
          <polyline points={points(hoverHomeRun.homeRun.pathPaper)} fill="none" stroke={PRIMARY} strokeOpacity={0.55} strokeWidth={0.9} />
          <circle cx={hoverHomeRun.homeRun.tipPaper.x} cy={hoverHomeRun.homeRun.tipPaper.y} r={1.4} fill={hoverHomeRun.part === 'tip' ? PRIMARY : '#ffffff'} stroke={PRIMARY} strokeWidth={0.5} />
          <rect
            x={hoverHomeRun.homeRun.labelBoxPaper.min.x}
            y={hoverHomeRun.homeRun.labelBoxPaper.min.y}
            width={hoverHomeRun.homeRun.labelBoxPaper.max.x - hoverHomeRun.homeRun.labelBoxPaper.min.x}
            height={hoverHomeRun.homeRun.labelBoxPaper.max.y - hoverHomeRun.homeRun.labelBoxPaper.min.y}
            fill={hoverHomeRun.part === 'label' ? PRIMARY : 'none'}
            fillOpacity={hoverHomeRun.part === 'label' ? 0.14 : 0}
            stroke={PRIMARY}
            strokeWidth={0.35}
            strokeDasharray="1 0.8"
          />
        </g>
      )}
      {hoverSwitchLabel && !drag && (
        <g pointerEvents="none" data-testid="model-switch-label-hover">
          <rect
            x={hoverSwitchLabel.atPaper.x - 0.6}
            y={hoverSwitchLabel.atPaper.y - 2.4}
            width={Math.max(2.4, hoverSwitchLabel.text.length * 1.4 + 1.2)}
            height={3.0}
            fill={PRIMARY}
            fillOpacity={0.14}
            stroke={PRIMARY}
            strokeWidth={0.35}
            strokeDasharray="1 0.8"
          />
        </g>
      )}
      {drag?.kind === 'switch_label' && (
        <g pointerEvents="none" data-testid="model-switch-label-preview">
          <line x1={drag.label.atPaper.x} y1={drag.label.atPaper.y} x2={drag.to.x} y2={drag.to.y} stroke={PRIMARY} strokeWidth={0.3} strokeDasharray="1 0.8" />
          <text x={drag.to.x} y={drag.to.y} fontSize={2.1} fontStyle="italic" fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.7}>
            {drag.label.text}
          </text>
        </g>
      )}
      {hoverMark && !drag && (
        <g pointerEvents="none" data-testid="model-mark-hover">
          <rect
            x={hoverMark.box.min.x}
            y={hoverMark.box.min.y}
            width={hoverMark.box.max.x - hoverMark.box.min.x}
            height={hoverMark.box.max.y - hoverMark.box.min.y}
            fill={PRIMARY}
            fillOpacity={0.12}
            stroke={PRIMARY}
            strokeWidth={0.35}
            strokeDasharray="1 0.8"
          />
        </g>
      )}
      {drag?.kind === 'bend' && (
        <g pointerEvents="none" data-testid="model-bend-preview" data-link-id={drag.join.linkId}>
          {(() => {
            const start = drag.join.points[0] ?? drag.from
            const end = drag.join.points[drag.join.points.length - 1] ?? drag.from
            const wps =
              drag.vertexIndex !== null && drag.vertexIndex < drag.join.waypointsPaper.length
                ? drag.join.waypointsPaper.map((wp, i) => (i === drag.vertexIndex ? drag.to : wp))
                : drag.join.waypointsPaper.length <= 1
                  ? [drag.to]
                  : drag.join.waypointsPaper.map((wp, i) => {
                      let closest = 0
                      let bestD = Infinity
                      drag.join.waypointsPaper.forEach((c, ci) => {
                        const d = Math.hypot(drag.from.x - c.x, drag.from.y - c.y)
                        if (d < bestD) {
                          bestD = d
                          closest = ci
                        }
                      })
                      return i === closest ? drag.to : wp
                    })
            return (
              <>
                <polyline points={points(previewWireCurve(start, wps, end))} fill="none" stroke={PRIMARY} strokeWidth={0.5} strokeDasharray="1.5 1" />
                {wps.map((wp, i) => (
                  <circle key={`dwp-${i}`} cx={wp.x} cy={wp.y} r={1.15} fill="#ffffff" stroke={PRIMARY} strokeWidth={0.45} />
                ))}
              </>
            )
          })()}
        </g>
      )}
      {drag?.kind === 'homerun' && (
        <g pointerEvents="none" data-testid="model-homerun-preview" data-link-id={drag.homeRun.linkId}>
          {drag.part === 'tip' && (
            <>
              <line x1={drag.homeRun.fromPaper.x} y1={drag.homeRun.fromPaper.y} x2={drag.to.x} y2={drag.to.y} stroke={PRIMARY} strokeWidth={0.5} strokeDasharray="1.5 1" />
              <circle cx={drag.to.x} cy={drag.to.y} r={1.3} fill={PRIMARY} />
            </>
          )}
          {drag.part === 'shaft' && (
            <>
              <polyline points={points(previewWireCurve(drag.homeRun.fromPaper, [drag.to], drag.homeRun.tipPaper))} fill="none" stroke={PRIMARY} strokeWidth={0.5} strokeDasharray="1.5 1" />
              <circle cx={drag.to.x} cy={drag.to.y} r={1.15} fill="#ffffff" stroke={PRIMARY} strokeWidth={0.45} />
            </>
          )}
          {drag.part === 'label' && (
            <>
              <line x1={drag.homeRun.tipPaper.x} y1={drag.homeRun.tipPaper.y} x2={drag.to.x} y2={drag.to.y} stroke={PRIMARY} strokeWidth={0.3} strokeDasharray="1 0.8" />
              <text x={drag.to.x} y={drag.to.y} fontSize={2.6} textAnchor="middle" fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.7}>
                {drag.homeRun.label}
              </text>
            </>
          )}
        </g>
      )}
      {drag?.kind === 'mark' && (
        <g pointerEvents="none" data-testid="model-mark-preview">
          {Math.hypot(drag.to.x - drag.mark.partAt.x, drag.to.y - drag.mark.partAt.y) > 7 && (
            <line x1={drag.mark.partAt.x} y1={drag.mark.partAt.y} x2={drag.to.x} y2={drag.to.y} stroke={PRIMARY} strokeWidth={0.35} strokeDasharray="1.2 0.8" />
          )}
          <text x={drag.to.x} y={drag.to.y} fontSize={2.6} textAnchor="middle" fill={PRIMARY} paintOrder="stroke" stroke="white" strokeWidth={0.7}>
            {drag.mark.text}
          </text>
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
        className={drawingCursorClass({
          aiming: routing || splitting,
          dragging: drag?.kind === 'move' || drag?.kind === 'run' || drag?.kind === 'homerun' || drag?.kind === 'bend' || drag?.kind === 'mark',
          clickPlaces: hover !== null && (bridge.clickPlaces?.() ?? false),
          overSelected: overSelected || hoverMark !== null || hoverHomeRun !== null || hoverJoin !== null,
          canEdit: bridge.canEdit,
          hovering: hover !== null || hoverMark !== null || hoverHomeRun !== null || hoverJoin !== null,
        })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        onPointerCancel={() => {
          if (drag?.kind === 'run') bridge.runDrag.end(false)
          setDrag(null)
        }}
        onPointerLeave={() => {
          pointerAt.current = null
          if (drag) return
          bridge.hover(null)
          setHover(null)
          setHoverJoin(null)
          setHoverHomeRun(null)
          setHoverMark(null)
        }}
        data-testid="model-drawing-hit"
      >
        <title>{`${view.view.name}: click to select, drag devices by their symbol, drag any mark to reposition as a tag, drag wires or home run tips/labels to reshape, right-click wires for spline vertices.`}</title>
      </rect>
      {wireMenu && (
        <WireContextMenu
          menu={wireMenu}
          model={model}
          view={view}
          bridge={bridge}
          homeRuns={wireHomeRuns}
          insertWaypoint={insertWaypointOrdered}
          onClose={() => setWireMenu(null)}
        />
      )}
      {bridge.canEdit && bridge.plus && !drag && !routing && (
        <DrawingPlusSpots model={model} view={view} selectedIds={bridge.selectedIds} serverFeatures={bridge.serverFeatures ?? []} paperMmPerPx={paperMmPerPx} onPick={bridge.plus} hint={bridge.hint} />
      )}
      {(() => {
        // Printed-plan Revit-style wall end grips when 1 editable wall is selected on a floor plan.
        if (!bridge.canEdit || drag || routing || splitting || view.view.viewType !== 'floor_plan' || bridge.selectedIds.length !== 1) return null
        const wid = bridge.selectedIds[0]
        const el = wid ? model.elements[wid] : undefined
        if (!el || el.kind !== 'wall') return null
        const level = viewModelLevel(model, view.view.props?.level, view.view.props?.levelElevationMm)
        const pLine = editableLinePlacement(el, model.elements)
        const line = hostLineOf(el, model.elements)
        if (!level || !pLine || !line || pLine.levelId !== level.id) return null
        const wallObj = { id: el.id, start: line.start, end: line.end }
        const startPaper = modelToPaperPoint(view, { x: line.start.x, y: line.start.y, z: 0 })
        const endPaper = modelToPaperPoint(view, { x: line.end.x, y: line.end.y, z: 0 })
        const gripR = Math.max(1.2, 5.5 * paperMmPerPx)
        const aimEnd = (end: 'start' | 'end', e: React.PointerEvent<SVGCircleElement>) => {
          const pp = paperOf(e)
          if (!pp) return null
          const m = view.mapping.toModel(paperToDrawing(view, pp))
          if (!m) return null
          const fixed = end === 'start' ? line.end : line.start
          const partners = e.altKey
            ? []
            : joinedEndFollowers(model.elements, el.id, end).filter((fid) => {
                const other = model.elements[fid]
                const ol = other ? hostLineOf(other, model.elements) : null
                const pt = end === 'start' ? line.start : line.end
                return ol !== null && ((ol.start.x === pt.x && ol.start.y === pt.y) || (ol.end.x === pt.x && ol.end.y === pt.y))
              })
          const snap = snapPoint({ model, levelId: level.id, raw: { x: m.x, y: m.y }, toleranceMm: snapTolerance, corners: [fixed], gridMm: DRAFTING_GRID_MM, ignoreIds: [el.id, ...partners] })
          return { wallId: el.id, end, at: snap.point, snap, disjoin: e.altKey }
        }
        const previewPaper = wallEndDrag ? modelToPaperPoint(view, { x: wallEndDrag.at.x, y: wallEndDrag.at.y, z: 0 }) : null
        const fixedPaper = wallEndDrag ? (wallEndDrag.end === 'start' ? endPaper : startPaper) : null
        return (
          <g data-testid="drawing-wall-end-grips" data-wall={el.id}>
            {fixedPaper && previewPaper && (
              <line x1={fixedPaper.x} y1={fixedPaper.y} x2={previewPaper.x} y2={previewPaper.y} stroke={PRIMARY} strokeWidth={0.5} strokeDasharray="1.5 1" pointerEvents="none" />
            )}
            {(['start', 'end'] as const).map((end) => {
              const gp = end === 'start' ? startPaper : endPaper
              return (
                <circle
                  key={end}
                  cx={gp.x}
                  cy={gp.y}
                  r={gripR}
                  fill="var(--mutiny-background)"
                  stroke={PRIMARY}
                  strokeWidth={Math.max(0.35, 1.8 * paperMmPerPx)}
                  style={{ cursor: 'grab' }}
                  data-testid="drawing-wall-end-grip"
                  data-end={end}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    e.currentTarget.setPointerCapture(e.pointerId)
                    const next = aimEnd(end, e)
                    if (next) {
                      setWallEndDrag(next)
                      const len = Math.hypot(next.at.x - (end === 'start' ? line.end.x : line.start.x), next.at.y - (end === 'start' ? line.end.y : line.start.y))
                      bridge.hint(endDragHint(model.elements, el.id, end, next.snap, len, next.disjoin))
                    }
                  }}
                  onPointerMove={(e) => {
                    if (!wallEndDrag) return
                    e.stopPropagation()
                    const next = aimEnd(wallEndDrag.end, e)
                    if (next) {
                      setWallEndDrag(next)
                      const len = Math.hypot(next.at.x - (wallEndDrag.end === 'start' ? line.end.x : line.start.x), next.at.y - (wallEndDrag.end === 'start' ? line.end.y : line.start.y))
                      bridge.hint(endDragHint(model.elements, el.id, wallEndDrag.end, next.snap, len, next.disjoin))
                    }
                  }}
                  onPointerUp={(e) => {
                    if (!wallEndDrag) return
                    e.stopPropagation()
                    const d = wallEndDrag
                    setWallEndDrag(null)
                    bridge.hint(null)
                    const cmd = endDropCommand(wallObj, d.end, d.at, d.disjoin)
                    if (typeof cmd === 'string') return
                    const err = bridge.submit(cmd, d.disjoin ? "disjoin and move the wall's end" : "move the wall's end")
                    if (err) toast.error(err)
                  }}
                  onPointerCancel={(e) => {
                    if (!wallEndDrag) return
                    e.stopPropagation()
                    setWallEndDrag(null)
                    bridge.hint(null)
                  }}
                  onLostPointerCapture={() => {
                    if (!wallEndDrag) return
                    setWallEndDrag(null)
                    bridge.hint(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              )
            })}
          </g>
        )
      })()}
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
