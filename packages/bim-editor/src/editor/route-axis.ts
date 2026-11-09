import { MODEL_FRAME, directionFromWorkFrame, directionToWorkFrame, fromWorkFrame, routeSnapHeadings, toWorkFrame, type Vec2, type WorkFrame } from '@permitzip/bim-kernel'
import { GRID_MM } from './placement'

/**
 * Where the next route point goes, and which axis it is locked to.
 *
 * - Auto: the nearest snap heading from the last point (every 15° and every
 *   22.5°: 15, 22.5, 30, 45, 60, 67.5, 75, 90…; `routeSnapHeadings`), at a 6"
 *   length step. Duct elbows are made at any of those angles; pipe stays on 45°.
 * - Any angle (`free`, or Alt / Option held): exactly where the pointer is, at a 6" length step.
 * - X / Y: along the working X or Y axis from the last point.
 *
 * Square, 45° and X / Y are measured in the work frame (`work-frame.ts`): on a
 * building with a working angle they run parallel and square to its walls,
 * not to model east. Without one the frame is the model's axes.
 * - Z: straight up or down from the last point. Locked by Z, by holding
 *   Shift, or by bringing the pointer near the last point's vertical line
 *   (the vertical gizmo) in 3D.
 */
export type AxisLock = 'auto' | 'x' | 'y' | 'z' | 'free'
/** `${n}°`: a snapped heading from the working X axis other than X, Y or a 45° diagonal. */
export type RouteAxis = 'x' | 'y' | 'z' | '45' | 'free' | `${number}°`

const SNAP_HEADINGS_RAD = routeSnapHeadings().map((d) => (d * Math.PI) / 180)

/** Pixels from the vertical line through the last point within which the route snaps to vertical. */
export const VERTICAL_SNAP_PX = 14

export interface RoutePointInput {
  readonly prev: { readonly x: number; readonly y: number; readonly elevationMm: number }
  /** The pointer on the horizontal plane at the current height. */
  readonly raw: Vec2 | null
  /** The pointer's nearest point on the vertical line through `prev`, and how far it is on screen. */
  readonly vertical: { readonly elevationMm: number; readonly pixelDistance: number } | null
  readonly lock: AxisLock
  readonly shift: boolean
  /** The work frame the snaps follow; absent: the model's axes. */
  readonly frame?: WorkFrame
  /** Pipe: 45° steps only (pipe fittings are made at 45° and 90°). */
  readonly pipe?: boolean
}

export interface RoutePointResult {
  readonly point: Vec2
  readonly elevationMm: number
  readonly axis: RouteAxis
}

/** The snap heading nearest `a` (radians, from the working X axis). */
function nearestHeading(a: number): number {
  const turn = 2 * Math.PI
  const t = ((a % turn) + turn) % turn
  let best = 0
  let gap = Number.POSITIVE_INFINITY
  for (const h of [...SNAP_HEADINGS_RAD, turn]) {
    const g = Math.abs(h - t)
    if (g < gap) {
      gap = g
      best = h
    }
  }
  return best
}

/**
 * Snap a pointer point to the nearest snap heading from `from` (measured from the working angle), at a 6" length step.
 * `steps`: '45' keeps 45° steps only (pipe); 'free' keeps the pointer's own direction.
 */
export function angleLock(from: Vec2, raw: Vec2, angleDeg = 0, steps: 'snap' | '45' | 'free' = 'snap'): Vec2 {
  const d = directionToWorkFrame({ angleDeg, origin: MODEL_FRAME.origin }, { x: raw.x - from.x, y: raw.y - from.y })
  const len = Math.hypot(d.x, d.y)
  if (len === 0) return from
  const raw0 = Math.atan2(d.y, d.x)
  const a = steps === 'free' ? raw0 : steps === '45' ? Math.round(raw0 / (Math.PI / 4)) * (Math.PI / 4) : nearestHeading(raw0)
  const ux = Math.round(Math.cos(a) * 1e9) / 1e9
  const uy = Math.round(Math.sin(a) * 1e9) / 1e9
  const along = Math.max(GRID_MM, Math.round((d.x * ux + d.y * uy) / GRID_MM) * GRID_MM)
  const u = directionFromWorkFrame({ angleDeg, origin: MODEL_FRAME.origin }, { x: ux, y: uy })
  return { x: Math.round((from.x + u.x * along) * 1000) / 1000, y: Math.round((from.y + u.y * along) * 1000) / 1000 }
}

const snap = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1000) / 1000

function axisOf(from: Vec2, to: Vec2, frame: WorkFrame): RouteAxis {
  const d = directionToWorkFrame(frame, { x: to.x - from.x, y: to.y - from.y })
  const dx = Math.abs(d.x)
  const dy = Math.abs(d.y)
  if (dy < 0.5) return 'x'
  if (dx < 0.5) return 'y'
  if (Math.abs(dx - dy) < 0.5) return '45'
  const deg = Math.round(((((Math.atan2(d.y, d.x) * 180) / Math.PI) % 360) + 360) % 360 * 10) / 10
  const snapped = routeSnapHeadings().some((h) => Math.abs(h - deg) < 0.05)
  return snapped ? `${deg}°` : 'free'
}

export function resolveRoutePoint(input: RoutePointInput): RoutePointResult | null {
  const { prev, raw, vertical, lock, shift } = input
  const frame = input.frame ?? MODEL_FRAME
  const plan = { x: prev.x, y: prev.y }
  const wantsZ = lock === 'z' || shift || (lock === 'auto' && vertical !== null && vertical.pixelDistance <= VERTICAL_SNAP_PX)
  if (wantsZ && vertical) {
    const elevationMm = snap(vertical.elevationMm, GRID_MM)
    if (Math.abs(elevationMm - prev.elevationMm) >= GRID_MM / 2) return { point: plan, elevationMm, axis: 'z' }
  }
  if (!raw) return null
  if (lock === 'x' || lock === 'y') {
    // In the work frame: q is the pointer, p the last point; the locked coordinate steps on the 6" grid through the frame's origin.
    const q = toWorkFrame(frame, raw)
    const p = toWorkFrame(frame, plan)
    const along = (r: number, from: number) => (Math.abs(r - from) < GRID_MM ? from + GRID_MM * Math.sign(r - from || 1) : snap(r, GRID_MM))
    const local = lock === 'x' ? { x: along(q.x, p.x), y: p.y } : { x: p.x, y: along(q.y, p.y) }
    return { point: fromWorkFrame(frame, local), elevationMm: prev.elevationMm, axis: lock }
  }
  const point = angleLock(plan, raw, frame.angleDeg, lock === 'free' ? 'free' : input.pipe ? '45' : 'snap')
  return { point, elevationMm: prev.elevationMm, axis: axisOf(plan, point, frame) }
}

/** What the axis lock does now, in the tool hint. */
export function axisLockHint(lock: AxisLock): string {
  switch (lock) {
    case 'auto':
      return 'Axis lock off: duct snaps to 15°, 22.5°, 30°, 45°, 60° and 90° from the working angle (pipe to 45°), and vertical near the last point. Hold Alt (Option) for any angle.'
    case 'free':
      return 'Any angle: the next leg goes where the pointer is, and its elbow is made to that angle. Press it again (or let go of Alt) to snap again.'
    case 'z':
      return 'Locked to Z: move up or down to rise or drop. Press it again to unlock.'
    default:
      return `Locked to ${lock.toUpperCase()}. Press it again to unlock.`
  }
}

/** The badge shown at the cursor while routing. */
export function axisBadge(axis: RouteAxis, lock: AxisLock): string {
  const locked = lock !== 'auto' && lock !== 'free' ? ' (locked)' : ''
  if (axis.endsWith('°')) return axis
  switch (axis) {
    case 'x':
      return `X${locked}`
    case 'y':
      return `Y${locked}`
    case 'z':
      return `Z${locked || ' (vertical)'}`
    case '45':
      return '45°'
    case 'free':
      return lock === 'free' ? 'Any angle' : 'Free'
  }
  return axis
}

// ------------------------------------------------------------------ dragging a routed piece

export interface DragSnap {
  readonly delta: { readonly x: number; readonly y: number; readonly z: number }
  readonly mode: 'square' | 'along' | 'corner'
}

/**
 * The drag a pointer move asks for. A straight piece moves square to itself
 * or along itself, whichever the pointer favours; a corner (an elbow) moves
 * freely; an open end only stretches along its piece. Distances land on the
 * 6" grid (for a 45° or sloped piece, the distance square to it does).
 */
export function snapDrag(kind: 'segment' | 'corner' | 'end', axis: { readonly x: number; readonly y: number; readonly z: number } | null, raw: { readonly x: number; readonly y: number; readonly z: number }): DragSnap {
  const g = (v: number) => snap(v, GRID_MM) || 0
  if (kind === 'corner' || !axis) return { delta: { x: g(raw.x), y: g(raw.y), z: g(raw.z) }, mode: 'corner' }
  const along = raw.x * axis.x + raw.y * axis.y + raw.z * axis.z
  const square = { x: raw.x - axis.x * along, y: raw.y - axis.y * along, z: raw.z - axis.z * along }
  const squareLen = Math.hypot(square.x, square.y, square.z)
  if (kind === 'end' || Math.abs(along) > squareLen) {
    const s = g(along)
    return { delta: { x: axis.x * s, y: axis.y * s, z: axis.z * s }, mode: 'along' }
  }
  // Square to a level piece in plan: keep to the one plan direction square to it.
  if (Math.abs(axis.z) < 1e-6) {
    const left = { x: -axis.y, y: axis.x }
    const k = g(square.x * left.x + square.y * left.y)
    return { delta: { x: left.x * k, y: left.y * k, z: g(square.z) }, mode: 'square' }
  }
  // A vertical piece moves in plan.
  if (Math.abs(axis.x) < 1e-6 && Math.abs(axis.y) < 1e-6) return { delta: { x: g(square.x), y: g(square.y), z: 0 }, mode: 'square' }
  // A sloped piece: exactly square to it, the distance on the grid.
  const k = g(squareLen) / (squareLen || 1)
  return { delta: { x: square.x * k, y: square.y * k, z: square.z * k }, mode: 'square' }
}
