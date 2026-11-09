'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Compass, EyeOff, Keyboard, Move3d, RotateCcw } from 'lucide-react'
import {
  bearingDeg,
  originPointPosition,
  type Command,
  type ModelState,
  type OriginPoint,
  type SiteFrame,
  type SitePoint,
} from '@permitzip/bim-kernel'
import type { GizmoAxis, GizmoScreen, ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { kernelToScene, snapPlanPoint } from '@permitzip/bim-viewer-3d/light'
import { Button } from '../../ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../../ui/context-menu'
import { cn } from '../../ui/cn'
import { moveOriginCommand, moveOriginLabel, originLabel, originSnapCandidates, resetOriginCommand, type OriginMoveMode } from '../coordinates'
import { MoveModeChoice } from './MoveModeChoice'

const AXIS_STROKE: Readonly<Record<GizmoAxis, string>> = { x: 'stroke-danger-600', y: 'stroke-success-600', z: 'stroke-info-600' }
/** Room the label needs to the right of the marker before it flips to the left, px. */
const LABEL_ROOM_PX = 170
/** Room the placement choice needs to the right of / below the marker, px. */
const CHOICE_W_PX = 340
const CHOICE_H_PX = 190
/** A press that moves less than this is a click (place), not an orbit, px. */
const CLICK_SLOP_PX = 5
const HUB_PX = 22

export const ORIGIN_HOVER_HINT = 'Right-click for origin options'

interface Props {
  readonly viewer: ModelViewer3D
  readonly model: ModelState
  readonly site: SiteFrame
  readonly which: OriginPoint
  /** Dragging the origin: the marker follows the pointer and a click places it. */
  readonly editing: boolean
  /** A model tool (Place part, Route, Measure…) is armed: a click on the marker goes to the tool, not the marker. */
  readonly toolArmed?: boolean
  /** Why editing is off (read-only access, not connected); null when it is allowed. */
  readonly editBlocked: string | null
  /** The last way a move applied this session; the placement choice offers it first. */
  readonly mode: OriginMoveMode
  readonly onModeChange: (mode: OriginMoveMode) => void
  /** Set true north by picking two points. */
  readonly pickingNorth: boolean
  readonly onCommit: (command: Command, label: string) => string | null
  /** Start dragging the origin (right-click › Move origin…, double-click, Enter). */
  readonly onStartMove: () => void
  readonly onOpenDialog: () => void
  readonly onHide: () => void
  readonly onSetTrueNorth: () => void
  readonly onExit: () => void
  readonly onHint: (message: string) => void
}

interface Preview {
  readonly at: SitePoint
  readonly snappedTo: string | null
}

/**
 * The origin marker's screen-space half: its X, Y and Z axes as dashed lines to
 * the edges of the view, a label with its site coordinates, and the marker
 * itself as a control. Hover says it is interactive; right-click opens Move
 * origin…, Type coordinates…, Reset to model zero, Set true north… and
 * Hide origin. Double-click (or Move origin…) starts dragging: the marker
 * follows the pointer (click-through, so the click lands on the view),
 * snapping to parts, run ends and the other origin points; Shift keeps it on
 * one plan axis. A click places it, and one inline question says whether only
 * the marker moves or the building moves on the site. Choosing commits (undo
 * in the toast). Elevation is typed (Type coordinates…). Esc puts a placed
 * marker back, then leaves dragging.
 */
export function OriginOverlay({ viewer, model, site, which, editing, toolArmed = false, editBlocked, mode, onModeChange, pickingNorth, onCommit, onStartMove, onOpenDialog, onHide, onSetTrueNorth, onExit, onHint }: Props) {
  const [screen, setScreen] = useState<GizmoScreen | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  /** Placed, waiting for the one question. */
  const [placed, setPlaced] = useState<Preview | null>(null)
  const [hovered, setHovered] = useState(false)
  const [northStart, setNorthStart] = useState<{ x: number; y: number } | null>(null)
  const [northCursor, setNorthCursor] = useState<{ x: number; y: number } | null>(null)
  /** Where a press on the view started while dragging; a release close by is a click. */
  const pressAt = useRef<{ x: number; y: number } | null>(null)
  /** The marker was moved off its point for a preview and must go back if nothing commits. */
  const displaced = useRef(false)
  const home = originPointPosition(site, which)
  const homeRef = useRef(home)
  useEffect(() => {
    homeRef.current = home
  })
  const candidates = useMemo(() => originSnapCandidates(model, site, which), [model, site, which])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setScreen(viewer.originGizmoScreen())
      })
    }
    schedule()
    const off = viewer.onCameraChange(schedule)
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [viewer])

  const canvasXY = useCallback(
    (clientX: number, clientY: number) => {
      const rect = viewer.renderer.domElement.getBoundingClientRect()
      return { x: clientX - rect.left, y: clientY - rect.top }
    },
    [viewer],
  )

  const showAt = useCallback(
    (at: SitePoint) => {
      displaced.current = true
      viewer.setOriginGizmo(kernelToScene(at.x, at.y, at.z), true)
    },
    [viewer],
  )

  /** Marker back on its point, nothing pending. */
  const putBack = useCallback(() => {
    if (displaced.current) {
      const h = homeRef.current
      viewer.setOriginGizmo(kernelToScene(h.x, h.y, h.z), true)
      displaced.current = false
    }
    setPreview(null)
    setPlaced(null)
  }, [viewer])

  // Leaving drag mode any way (Esc, Cancel, the ribbon) drops whatever was pending.
  const [wasEditing, setWasEditing] = useState(editing)
  if (wasEditing !== editing) {
    setWasEditing(editing)
    setHovered(false)
    if (!editing) {
      setPreview(null)
      setPlaced(null)
    }
  }
  useEffect(() => {
    if (editing || !displaced.current) return
    const h = homeRef.current
    viewer.setOriginGizmo(kernelToScene(h.x, h.y, h.z), true)
    displaced.current = false
  }, [editing, viewer])

  /** The plan point under the pointer at the marker's elevation, snapped; with Shift, kept on the plan axis it moved furthest along. */
  const planAt = useCallback(
    (e: { readonly clientX: number; readonly clientY: number; readonly shiftKey: boolean }): Preview | null => {
      const h = homeRef.current
      const raw = viewer.planPointAt(e.clientX, e.clientY, h.z)
      if (!raw) return null
      const snapped = snapPlanPoint(raw, candidates, (x, y) => viewer.canvasPointOf(x, y, h.z), canvasXY(e.clientX, e.clientY))
      if (!e.shiftKey) return { at: { x: snapped.x, y: snapped.y, z: h.z }, snappedTo: snapped.snappedTo }
      const alongX = Math.abs(snapped.x - h.x) >= Math.abs(snapped.y - h.y)
      return { at: alongX ? { x: snapped.x, y: h.y, z: h.z } : { x: h.x, y: snapped.y, z: h.z }, snappedTo: snapped.snappedTo }
    },
    [viewer, candidates, canvasXY],
  )

  const place = useCallback(
    (p: Preview) => {
      const h = homeRef.current
      if (Math.hypot(p.at.x - h.x, p.at.y - h.y, p.at.z - h.z) <= 0.5) return
      showAt(p.at)
      setPreview(p)
      setPlaced(p)
    },
    [showAt],
  )

  // Dragging: the marker follows the pointer over the view; a click places it. A press that moves orbits as usual.
  useEffect(() => {
    if (!editing || placed || which === 'internal_origin') return
    const el = viewer.renderer.domElement
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return
      const p = planAt(e)
      if (!p) return
      showAt(p.at)
      setPreview(p)
    }
    const onDown = (e: PointerEvent) => {
      pressAt.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onUp = (e: PointerEvent) => {
      const start = pressAt.current
      pressAt.current = null
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return
      const p = planAt(e)
      if (p) place(p)
    }
    const cursor = el.style.getPropertyValue('cursor')
    el.style.setProperty('cursor', 'crosshair')
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.style.setProperty('cursor', cursor)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [editing, placed, which, viewer, planAt, showAt, place])

  useEffect(() => {
    if (!editing && !pickingNorth) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (placed) {
        putBack()
        return
      }
      setNorthStart(null)
      onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, pickingNorth, placed, putBack, onExit])

  const choose = (chosen: OriginMoveMode) => {
    const p = placed
    if (!p) return
    onModeChange(chosen)
    const command = moveOriginCommand(which, chosen, { position: p.at })
    if (!command) return
    const refusal = onCommit(command, moveOriginLabel(which, chosen))
    if (refusal) {
      putBack()
      onHint(refusal)
      return
    }
    displaced.current = false
    setPreview(null)
    setPlaced(null)
    onExit()
  }

  const pickNorth = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const at = viewer.planPointAt(e.clientX, e.clientY, site.basePoint.z)
    if (!at) return
    if (!northStart) {
      setNorthStart(at)
      onHint('Now click a second point in the direction of true north. Esc cancels.')
      return
    }
    if (bearingDeg(northStart, at) === null) {
      onHint('That is the same point. Click a second point toward true north.')
      return
    }
    const refusal = onCommit({ type: 'set_true_north', from: northStart, to: at }, 'set true north')
    setNorthStart(null)
    setNorthCursor(null)
    if (refusal) onHint(refusal)
    onExit()
  }

  const reset = () => {
    const command = resetOriginCommand(site, which)
    if (!command) return
    const refusal = onCommit(command, `reset the ${which === 'survey_point' ? 'site point' : 'project origin'} to model zero`)
    if (refusal) onHint(refusal)
  }

  const label = originLabel(site, which, preview?.at ?? home)
  const o = screen?.origin ?? null
  const width = viewer.renderer.domElement.clientWidth
  const height = viewer.renderer.domElement.clientHeight
  const labelLeft = o !== null && o.x + LABEL_ROOM_PX > width
  const startPx = northStart ? viewer.canvasPointOf(northStart.x, northStart.y, site.basePoint.z) : null
  const resetBlocked = editBlocked ?? (resetOriginCommand(site, which) ? null : 'Already on model zero.')
  const pointName = which === 'survey_point' ? 'site point' : 'project origin'

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 size-full" data-testid="origin-overlay" data-origin-point={which} aria-hidden>
        {screen &&
          (['x', 'y', 'z'] as const).map((axis) => {
            const seg = screen.lines[axis]
            return seg ? (
              <line key={axis} data-testid={`origin-axis-${axis}`} x1={seg.a.x} y1={seg.a.y} x2={seg.b.x} y2={seg.b.y} className={cn(AXIS_STROKE[axis], 'opacity-70')} strokeWidth={1} strokeDasharray="6 5" />
            ) : null
          })}
        {startPx && northCursor && <line x1={startPx.x} y1={startPx.y} x2={northCursor.x} y2={northCursor.y} className="stroke-danger-600" strokeWidth={1.5} />}
      </svg>
      {o && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              data-testid="origin-hub"
              data-hovered={hovered || undefined}
              aria-label={`${label.title}: origin options`}
              title={`${label.title}. ${ORIGIN_HOVER_HINT}; double-click to move it.`}
              className={cn(
                'absolute cursor-pointer rounded-full border-2 border-transparent p-0 hover:border-info-600 hover:bg-info-500/15 focus-visible:border-info-600',
                // While dragging, the marker sits under the pointer: let the placing click through to the view.
                (editing || toolArmed) && 'pointer-events-none',
              )}
              style={{ left: o.x - HUB_PX / 2, top: o.y - HUB_PX / 2, width: HUB_PX, height: HUB_PX }}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (!editing && !editBlocked) onStartMove()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !editing && !editBlocked) onStartMove()
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-64" data-testid="origin-menu">
            <MenuItem testId="origin-menu-move" icon={<Move3d />} label="Move origin…" blocked={editBlocked} onSelect={onStartMove} />
            <MenuItem testId="origin-menu-type" icon={<Keyboard />} label="Type coordinates…" blocked={null} onSelect={onOpenDialog} />
            <MenuItem testId="origin-menu-reset" icon={<RotateCcw />} label="Reset to model zero" blocked={resetBlocked} onSelect={reset} />
            <ContextMenuSeparator />
            <MenuItem testId="origin-menu-north" icon={<Compass />} label="Set true north…" blocked={editBlocked} onSelect={onSetTrueNorth} />
            <MenuItem testId="origin-menu-hide" icon={<EyeOff />} label="Hide origin" blocked={null} onSelect={onHide} />
          </ContextMenuContent>
        </ContextMenu>
      )}
      {o && !placed && (
        <div
          className="pointer-events-none absolute flex flex-col whitespace-nowrap rounded-sm bg-background/85 px-1.5 py-1 text-[11px] leading-tight shadow-sm"
          style={labelLeft ? { left: o.x - 16, top: o.y - 14, transform: 'translate(-100%, -100%)' } : { left: o.x + 16, top: o.y - 14, transform: 'translateY(-100%)' }}
          data-testid="origin-label"
        >
          <span className="font-medium text-info-700">{label.title}</span>
          <span className="text-muted-foreground">Shared site:</span>
          {label.lines.map((l) => (
            <span key={l.key} className="tabular-nums text-info-700" data-testid={`origin-label-${l.key.toLowerCase().replace('/', '')}`}>
              {l.key} {l.value}
            </span>
          ))}
          {preview?.snappedTo && <span className="text-success-700">Snapped to {preview.snappedTo}</span>}
          {hovered && !editing && (
            <span className="text-muted-foreground" data-testid="origin-hint">
              {ORIGIN_HOVER_HINT}
            </span>
          )}
        </div>
      )}
      {editing && (
        <div
          role="status"
          className="absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background/95 py-1.5 pl-3 pr-1.5 shadow-sm"
          data-testid="move-origin-bar"
        >
          <span className="text-sm font-medium">
            {placed ? `Choose how this move applies — Esc puts the ${pointName} back` : `Dragging the ${pointName} — click to place, Esc to cancel`}
          </span>
          <span className="flex gap-2 text-xs tabular-nums text-muted-foreground" data-testid="move-origin-readout">
            {label.lines.map((l) => (
              <span key={l.key}>
                {l.key} {l.value}
              </span>
            ))}
            {preview?.snappedTo && <span className="text-success-700">Snapped to {preview.snappedTo}</span>}
            {!placed && <span>Shift keeps it on one axis</span>}
          </span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={onOpenDialog} data-testid="move-origin-type">
              Type coordinates…
            </Button>
            <Button size="sm" variant="outline" onClick={onExit} data-testid="move-origin-cancel">
              Cancel
            </Button>
          </span>
        </div>
      )}
      {placed && o && (
        <div
          className="absolute z-20 flex w-80 flex-col gap-2 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
          style={{ left: Math.max(8, o.x + 16 + CHOICE_W_PX > width ? o.x - 16 - CHOICE_W_PX : o.x + 16), top: Math.max(8, o.y + CHOICE_H_PX > height ? o.y - CHOICE_H_PX : o.y + 8) }}
          data-testid="move-origin-choice"
        >
          <MoveModeChoice value={mode} testIdPrefix="move-origin-choose" onCommit={choose} />
          <span className="px-1 text-xs text-muted-foreground">Geometry, drawings and linked models never move. Undo is in the message that follows.</span>
        </div>
      )}
      {pickingNorth && (
        <div
          className="absolute inset-0 cursor-crosshair"
          data-testid="true-north-pick"
          onPointerDown={pickNorth}
          onPointerMove={(e) => northStart && setNorthCursor(canvasXY(e.clientX, e.clientY))}
        />
      )}
    </>
  )
}

function MenuItem({ testId, icon, label, blocked, onSelect }: { readonly testId: string; readonly icon: React.ReactNode; readonly label: string; readonly blocked: string | null; readonly onSelect: () => void }) {
  return (
    <ContextMenuItem data-testid={testId} disabled={blocked !== null} onSelect={onSelect} className="items-start">
      {icon}
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
      </span>
    </ContextMenuItem>
  )
}
