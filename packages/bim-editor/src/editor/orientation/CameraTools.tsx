'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { Camera, Play, Square, X } from 'lucide-react'
import { elementsOfKind, isBuildingStoryLevel, modelLevels, runLabel, type ModelState } from '@permitzip/bim-kernel'
import { Button, Card, Input, Label, NativeSelect } from '@permitzip/bim-ui'
import type { ModelViewer3D } from '@permitzip/bim-viewer-3d'
import { advanceWalker, walkFloor, walkingPose } from './floor-walk'
import { defaultFlight, flightPose, pointAlong, traceCameraRoute, trackingPose, validFlight, type CameraPose, type RunEnd, type Waypoint } from './camera-paths'

const modes = [
  { id: 'walk', title: 'Floor walk' },
  { id: 'route', title: 'Route tracking' },
  { id: 'flight', title: 'Waypoint flyover' },
] as const
type Mode = typeof modes[number]['id']
type Frame = { pose: CameraPose; status: string; done?: boolean }
type Tick = (dt: number, elapsed: number) => Frame
type Viewer = Pick<ModelViewer3D, 'camera3dState' | 'beginCameraMotion' | 'setCamera3d'>

function readFlight(key: string, camera: CameraPose | null): Waypoint[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Waypoint[] | null
    if (Array.isArray(saved) && validFlight(saved)) return saved
  } catch { /* An old or unavailable session store still allows a fresh flight. */ }
  return camera ? defaultFlight(camera) : []
}

export default function CameraTools({ viewer, model, initialLevel, selectedId, rightInset, canvasRef, onClose }: {
  viewer: Viewer
  model: ModelState
  initialLevel: string | null
  selectedId: string | null
  rightInset: number
  canvasRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const [mode, setMode] = useState<Mode>('walk')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const stopRef = useRef<((reason?: string) => void) | null>(null)
  const keys = useRef(new Set<string>())
  const look = useRef({ dx: 0, dy: 0 })
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  const levels = useMemo(() => modelLevels(model).filter(isBuildingStoryLevel).sort((a, b) => a.elevationMm - b.elevationMm), [model])
  const [levelId, setLevelId] = useState(initialLevel)
  const level = levels.find(l => l.id === levelId) ?? levels[0]
  const runs = useMemo(() => mode === 'route' ? elementsOfKind(model.elements, 'run_segment') : [], [model.elements, mode])
  const [runId, setRunId] = useState('')
  const run = runs.find(r => r.id === runId) ?? runs.find(r => r.id === selectedId) ?? runs[0]
  const [entry, setEntry] = useState<RunEnd>('start')
  const route = useMemo(() => run && traceCameraRoute(model, run, entry), [model, run, entry])
  const storageKey = `mutinybim.camera-waypoints.v1.${model.modelId}`
  const [shots, setShots] = useState(() => readFlight(storageKey, viewer.camera3dState()))
  const [shotIndex, setShotIndex] = useState(0)
  const shot = shots[shotIndex]
  const saveShots = (next: Waypoint[]) => {
    setShots(next)
    if (validFlight(next)) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep editing in memory. */ }
    }
  }

  // A model revision can move a wall or delete a run. Drop its playback geometry before the next frame.
  useLayoutEffect(() => () => stopRef.current?.('Model or view changed'), [viewer, model.elements])
  useLayoutEffect(() => {
    if (running) viewport.current?.focus({ preventScroll: true })
  }, [running])

  const play = useCallback((tick: Tick, guide?: readonly CameraPose['target'][]) => {
    const motion = viewer.beginCameraMotion(guide, () => stopRef.current?.())
    if (!motion) { setStatus('Finish the current edit to use the camera.'); return }
    keys.current.clear()
    look.current = { dx: 0, dy: 0 }
    let frame = 0, previous: number | undefined, elapsed = 0, announced = -1
    const stop = (reason = 'Camera released') => {
      if (stopRef.current !== stop) return
      stopRef.current = null
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', key, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('focusin', outside, true)
      document.removeEventListener('visibilitychange', visibility)
      keys.current.clear()
      drag.current = null
      motion.release()
      setRunning(false)
      setStatus(reason)
      if (root.current?.contains(document.activeElement)) canvasRef.current?.focus({ preventScroll: true })
    }
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Tab' || (e.target instanceof HTMLButtonElement && ['Enter', ' '].includes(e.key))) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (e.type === 'keyup') keys.current.delete(e.code)
      else if (e.key === 'Escape') stop()
      else keys.current.add(e.code)
    }
    const outside = (e: Event) => { if (e.target instanceof Node && !root.current?.contains(e.target)) stop() }
    const blur = () => stop()
    const visibility = () => { if (document.hidden) stop() }
    const draw = (now: number) => {
      const dt = previous === undefined ? 0 : Math.max(0, (now - previous) / 1000)
      elapsed += dt
      previous = now
      const state = tick(Math.min(dt, 0.25), elapsed)
      if (!motion.look(state.pose)) { stop(); return }
      if (state.done) { stop(state.status); return }
      if (elapsed - announced >= 0.25) { setStatus(state.status); announced = elapsed }
      frame = requestAnimationFrame(draw)
    }
    stopRef.current = stop
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', key, true)
    window.addEventListener('blur', blur)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('focusin', outside, true)
    document.addEventListener('visibilitychange', visibility)
    setRunning(true)
    draw(performance.now())
  }, [viewer, canvasRef])

  const start = () => {
    const camera = viewer.camera3dState()
    if (!camera) return
    if (mode === 'walk' && level) {
      const floor = walkFloor(model, level)
      const spawn = floor.spawn(camera)
      if (!spawn) { setStatus('Frame an open space on this floor and try again.'); return }
      let walker = spawn
      const axis = (pos: string, neg: string) => Number(keys.current.has(pos)) - Number(keys.current.has(neg))
      play(dt => {
        const yaw = walker.yaw + dt * 1.7 * axis('ArrowLeft', 'ArrowRight') - look.current.dx * 0.004
        const pitch = Math.max(-1.35, Math.min(1.35, walker.pitch + dt * 1.3 * axis('ArrowUp', 'ArrowDown') - look.current.dy * 0.004))
        look.current = { dx: 0, dy: 0 }
        const forward = axis('KeyW', 'KeyS'), right = axis('KeyD', 'KeyA')
        const step = 1800 * dt / Math.max(1, Math.hypot(forward, right))
        walker = advanceWalker({ ...walker, yaw, pitch }, step * (Math.cos(yaw) * forward + Math.sin(yaw) * right),
          step * (Math.sin(yaw) * forward - Math.cos(yaw) * right), floor.clear)
        return { pose: walkingPose(walker, level), status: `${level.name} · 1.60 m eye height` }
      })
    } else if (mode === 'route' && route && route.length > 0) {
      play((_, seconds) => {
        const at = Math.min(route.length, seconds * 1500)
        return { pose: trackingPose(pointAlong(route, at), camera), done: at >= route.length,
          status: `${(at / 1000).toFixed(1)} / ${(route.length / 1000).toFixed(1)} m · ${route.end}` }
      }, route.points)
    } else if (mode === 'flight' && validFlight(shots)) {
      const duration = shots[shots.length - 1]!.seconds
      play((_, seconds) => ({ pose: flightPose(shots, seconds), done: seconds >= duration, status: seconds >= duration ? 'Flyover complete' : `${seconds.toFixed(1)} / ${duration} s` }))
    }
  }
  const movePointer = (e: ReactPointerEvent) => {
    const last = drag.current
    if (!last || last.id !== e.pointerId) return
    look.current.dx += e.clientX - last.x
    look.current.dy += e.clientY - last.y
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  const capture = (replace: boolean) => {
    const pose = viewer.camera3dState()
    if (!pose) return
    const { eye, target } = pose
    if (replace && shot) saveShots(shots.map((s, i) => i === shotIndex ? { ...s, eye, target } : s))
    else {
      const seconds = shots.length ? shots[shots.length - 1]!.seconds + 4 : 0
      saveShots([...shots, { seconds, eye, target }])
      setShotIndex(shots.length)
    }
    setStatus('Position and aim captured')
  }
  const canStart = mode === 'walk' ? !!level : mode === 'route' ? !!route?.length : validFlight(shots)

  return (
    <div ref={root} className="pointer-events-none absolute inset-y-0 left-0 z-20" style={{ right: rightInset }}>
      {running && <div ref={viewport} tabIndex={-1} aria-label="Camera playback" className="pointer-events-auto absolute inset-0 touch-none outline-none"
        onPointerDown={e => {
          if (mode !== 'walk' || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        }}
        onPointerMove={movePointer} onLostPointerCapture={() => { drag.current = null }}
        onContextMenu={e => e.preventDefault()} />}
      <Card aria-label="Camera tools" className="pointer-events-auto absolute left-3 top-3 max-h-[calc(100%-1.5rem)] w-72 max-w-[calc(100%-1.5rem)] gap-3 overflow-y-auto p-3 shadow-md"
        onKeyDown={e => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          // Stop native propagation too so single-key shortcuts (W, Esc, O, F) inside the card do not reach BuildingModelSurface's window listener.
          e.stopPropagation()
          e.nativeEvent.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}>
        <header className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4" />{running ? modes.find(m => m.id === mode)?.title : 'Camera tools'}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close camera tools" onClick={onClose}><X /></Button>
        </header>
        {!running && <Label className="grid gap-1 text-xs">Camera mode
          <NativeSelect aria-label="Camera mode" value={mode} onChange={e => { setMode(e.target.value as Mode); setStatus('') }}>
            {modes.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
          </NativeSelect>
        </Label>}
        {mode === 'walk' && <>
          {!running && <Label className="grid gap-1 text-xs">Floor
            <NativeSelect aria-label="Walk floor" value={level?.id ?? ''} disabled={!levels.length} onChange={e => setLevelId(e.target.value)}>
              {!levels.length && <option value="">No floor levels in this model</option>}
              {levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </NativeSelect>
          </Label>}
          <p className="text-xs text-muted-foreground">Walk with WASD. Drag to look around or use the arrow keys. Esc releases the camera.</p>
          {running && <div className="grid grid-cols-4 gap-1" aria-label="Walk controls">
            {([['KeyA', 'Left'], ['KeyW', 'Forward'], ['KeyS', 'Back'], ['KeyD', 'Right']] as const).map(([code, label]) =>
              <Button key={code} size="sm" variant="outline" className="touch-none px-1 text-xs"
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); keys.current.add(code) }}
                onLostPointerCapture={() => keys.current.delete(code)}
                onClick={e => { if (e.detail === 0) { keys.current.add(code); window.setTimeout(() => keys.current.delete(code), 160) } }}>{label}</Button>)}
          </div>}
        </>}
        {mode === 'route' && !running && <>
          <Label className="grid gap-1 text-xs">Starting run
            <NativeSelect aria-label="Starting run" value={run?.id ?? ''} disabled={!runs.length} onChange={e => { setRunId(e.target.value); setStatus('') }}>
              {!runs.length && <option value="">No physical runs in this model</option>}
              {runs.map((r, i) => <option key={r.id} value={r.id}>{runLabel(model.elements, r)} · {i + 1}</option>)}
            </NativeSelect>
          </Label>
          {selectedId && selectedId !== run?.id && model.elements[selectedId]?.kind === 'run_segment' &&
            <Button size="sm" variant="outline" onClick={() => { setRunId(selectedId); setStatus('') }}>Use selected run</Button>}
          {run && <Label className="grid gap-1 text-xs">Direction
            <NativeSelect value={entry} onChange={e => { setEntry(e.target.value as RunEnd); setStatus('') }}><option value="start">From start</option><option value="end">From end</option></NativeSelect>
          </Label>}
          {route && <p className="text-xs text-muted-foreground">{(route.length / 1000).toFixed(1)} m · {route.end}</p>}
        </>}
        {mode === 'flight' && !running && <>
          <p className="text-xs text-muted-foreground">Frame a shot in the model, then capture its position and aim. Edited waypoints stay in this tab.</p>
          {shot && <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Label className="grid gap-1 text-xs">Waypoint
              <NativeSelect value={shotIndex} onChange={e => setShotIndex(Number(e.target.value))}>
                {shots.map((s, i) => <option key={i} value={i}>Shot {i + 1} · {Number.isFinite(s.seconds) ? s.seconds : '…'} s</option>)}
              </NativeSelect>
            </Label>
            <Label className="grid gap-1 text-xs">Seconds
              <Input type="number" step="any" min="0" disabled={!shotIndex} value={Number.isFinite(shot.seconds) ? shot.seconds : ''}
                onChange={e => saveShots(shots.map((s, i) => i === shotIndex ? { ...s, seconds: e.target.valueAsNumber } : s))} />
            </Label>
          </div>}
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => capture(false)}>Add current view</Button>
            <Button size="sm" variant="outline" disabled={!shot} onClick={() => capture(true)}>Replace shot</Button>
            <Button size="sm" variant="ghost" disabled={!shot} onClick={() => {
              const pose = viewer.camera3dState()
              if (pose && shot) void viewer.setCamera3d({ ...pose, eye: shot.eye, target: shot.target }).catch(() => setStatus('The view changed before the shot could open.'))
            }}>Go to shot</Button>
            <Button size="sm" variant="ghost" disabled={shots.length <= 2 || !shotIndex} onClick={() => {
              saveShots(shots.filter((_, i) => i !== shotIndex)); setShotIndex(shotIndex - 1)
            }}>Remove shot</Button>
          </div>
          {!validFlight(shots) && <p className="text-xs text-muted-foreground">Use at least two waypoints with increasing times.</p>}
        </>}
        {running ? <Button size="sm" className="w-full" onClick={() => stopRef.current?.()}><Square />Stop camera</Button>
          : <Button size="sm" className="w-full" disabled={!canStart} onClick={start}><Play />{mode === 'walk' ? 'Start floor walk' : mode === 'route' ? 'Track route' : 'Play flyover'}</Button>}
        {status && <p aria-live={running ? 'off' : 'polite'} className="text-xs tabular-nums text-muted-foreground">{status}</p>}
      </Card>
    </div>
  )
}
