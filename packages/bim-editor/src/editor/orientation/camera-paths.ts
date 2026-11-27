import { fittingBody, flexPoints, type ModelState, type Point3, type PortRef, type RunFitting, type RunSegment, type View3dCamera } from '@permitzip/bim-kernel'

export type CameraPose = Pick<View3dCamera, 'eye' | 'target'>
export type Waypoint = CameraPose & { readonly seconds: number }
export type RunEnd = 'start' | 'end'

const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const mix = (a: Point3, b: Point3, t: number): Point3 => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
})

/** Distances include vertical travel and every vertex on a flexible run. */
function measured(points: readonly Point3[]) {
  const stations = [0]
  for (let i = 1; i < points.length; i++) stations.push(stations[i - 1]! + distance(points[i - 1]!, points[i]!))
  return { points, stations, length: stations[stations.length - 1]! }
}
type MeasuredPath = ReturnType<typeof measured>

export function pointAlong(path: MeasuredPath, at: number): Point3 {
  const { points, stations } = path
  let lo = 0, hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (stations[mid]! <= at) lo = mid
    else hi = mid
  }
  const t = Math.max(0, Math.min(1, (at - stations[lo]!) / (stations[hi]! - stations[lo]! || 1)))
  return mix(points[lo]!, points[hi]!, t)
}

function fittingCenterline(
  elements: ModelState['elements'],
  fitting: RunFitting,
  incoming: RunFitting['ports'][number],
  outgoing: RunFitting['ports'][number],
): { readonly cutIn: number; readonly cutOut: number; readonly points: readonly Point3[] } | null {
  const body = fittingBody(elements, fitting)
  const tube = body.tubes[0]
  const inFace = body.faces[incoming.id]?.center
  const outFace = body.faces[outgoing.id]?.center
  if (!tube || tube.rings.length < 2 || !inFace || !outFace) return null
  const first = tube.rings[0]!.center
  const last = tube.rings[tube.rings.length - 1]!.center
  const forward = distance(first, inFace) + distance(last, outFace) <= distance(last, inFace) + distance(first, outFace)
  const ordered = forward ? tube.rings : [...tube.rings].reverse()
  if (distance(ordered[0]!.center, inFace) > 1 || distance(ordered[ordered.length - 1]!.center, outFace) > 1) return null
  return {
    cutIn: Math.max(0, body.takeoffs[incoming.id] ?? 0),
    cutOut: Math.max(0, body.takeoffs[outgoing.id] ?? 0),
    points: ordered.map(r => r.center),
  }
}

/** Follow only mutually connected ports on this system. A branch is a choice for the operator. */
export function traceCameraRoute(model: ModelState, first: RunSegment, entry: RunEnd) {
  const points: Point3[] = []
  const visited = new Set<string>()
  const tolerance = model.settings.connectorToleranceMm
  const finish = (end: string) => ({ ...measured(points), end })
  const append = (p: Point3) => {
    const last = points[points.length - 1]
    if (!last || distance(last, p) > 0.01) points.push(p)
  }
  const world = (el: RunSegment | RunFitting, p: Point3): Point3 => {
    const level = model.elements[el.levelId]
    return { x: p.x, y: p.y, z: p.z + (level?.kind === 'level' ? level.elevationMm : 0) }
  }
  const onSystem = (el: RunSegment | RunFitting) => el.systemId === first.systemId && el.domain === first.domain
  const matches = (link: PortRef | undefined, from: PortRef) => link?.elementId === from.elementId && link.port === from.port
  const junction = (f: RunFitting) => f.fittingType === 'tee' || f.fittingType === 'tap' || f.fittingType === 'wye'
  const appendSlice = (path: MeasuredPath, fromAt: number, toAt: number, reverse: boolean) => {
    append(pointAlong(path, fromAt))
    for (let i = 0; i < path.points.length; i++) {
      const index = reverse ? path.points.length - 1 - i : i
      const s = path.stations[index]!
      if (reverse ? (s < fromAt && s > toAt) : (s > fromAt && s < toAt)) append(path.points[index]!)
    }
    append(pointAlong(path, toAt))
  }
  let segment = first
  let entryCut = 0
  for (;;) {
    if (visited.has(segment.id)) return finish('Loop')
    visited.add(segment.id)
    const path = measured(flexPoints(segment).map(p => world(segment, p)))
    const reverse = entry === 'end'
    const start = reverse ? path.length : 0
    const fromAt = segment.flex ? start : Math.max(0, Math.min(path.length, reverse ? path.length - entryCut : entryCut))
    let nearest: { at: number; type: string } | undefined
    for (const id of segment.branches) {
      const f = model.elements[id]
      if (f?.kind !== 'run_fitting' || !onSystem(f) || !junction(f) || f.host?.segmentId !== segment.id) continue
      const at = Math.max(0, Math.min(path.length, f.host.s))
      if (!nearest || Math.abs(at - start) < Math.abs(nearest.at - start)) nearest = { at, type: f.fittingType }
    }
    if (nearest) {
      const toAt = reverse ? Math.min(fromAt, nearest.at) : Math.max(fromAt, nearest.at)
      appendSlice(path, fromAt, toAt, reverse)
      return finish(`First ${nearest.type}`)
    }

    const exit: RunEnd = reverse ? 'start' : 'end'
    let from: PortRef = { elementId: segment.id, port: exit }
    let link = segment.links[exit]
    let anchor = world(segment, segment[exit])
    let next = link ? model.elements[link.elementId] : undefined
    let curve: ReturnType<typeof fittingCenterline> = null
    let fitting: RunFitting | null = null
    let incoming: RunFitting['ports'][number] | undefined
    let outgoing: RunFitting['ports'][number] | undefined
    if (link && next?.kind === 'run_fitting' && onSystem(next)) {
      const candidate = next
      const inPort = candidate.ports.find(p => p.id === link?.port)
      if (inPort && matches(inPort.link, from) && distance(anchor, world(candidate, inPort.position)) <= tolerance) {
        fitting = candidate
        incoming = inPort
        if (!junction(candidate) && candidate.ports.length === 2) {
          outgoing = candidate.ports.find(p => p !== inPort)
          if (outgoing) curve = fittingCenterline(model.elements, candidate, inPort, outgoing)
        }
      }
    }

    const exitCut = !segment.flex && curve ? curve.cutIn : 0
    const endAt = reverse ? Math.min(fromAt, Math.max(0, exitCut)) : Math.max(fromAt, Math.min(path.length, path.length - exitCut))
    appendSlice(path, fromAt, endAt, reverse)

    if (!link) return finish('Open end')
    if (next?.kind === 'run_fitting' && onSystem(next)) {
      if (!fitting || !incoming) return finish('End of connected run')
      if (junction(fitting)) {
        append(world(fitting, incoming.position))
        append(world(fitting, fitting.position))
        return finish(`First ${fitting.fittingType}`)
      }
      if (!outgoing) {
        append(world(fitting, incoming.position))
        append(world(fitting, fitting.position))
        return finish(fitting.label || 'End fitting')
      }
      if (curve) {
        for (const pt of curve.points) append(world(fitting, pt))
      } else {
        append(world(fitting, incoming.position))
        append(world(fitting, fitting.position))
        append(world(fitting, outgoing.position))
      }
      anchor = world(fitting, outgoing.position)
      from = { elementId: fitting.id, port: outgoing.id }
      link = outgoing.link
      if (!link) return finish('Open end')
      next = model.elements[link.elementId]
    }
    if (next?.kind !== 'run_segment' || !onSystem(next) || (link.port !== 'start' && link.port !== 'end')
      || !matches(next.links[link.port], from) || distance(anchor, world(next, next[link.port])) > tolerance) {
      return finish('End of connected run')
    }
    entry = link.port
    entryCut = curve ? curve.cutOut : 0
    segment = next
  }
}

export function trackingPose(target: Point3, from: CameraPose): CameraPose {
  const span = Math.max(1, distance(from.eye, from.target))
  const scale = Math.max(1800, Math.min(4500, span)) / span
  return { target, eye: {
    x: target.x + (from.eye.x - from.target.x) * scale,
    y: target.y + (from.eye.y - from.target.y) * scale,
    z: target.z + (from.eye.z - from.target.z) * scale,
  } }
}

/** Three starting shots around what is currently framed. Both aim and position are editable by capturing a view. */
export function defaultFlight(camera: CameraPose): Waypoint[] {
  const { eye, target } = camera
  const angle = Math.atan2(eye.y - target.y, eye.x - target.x)
  const radius = Math.max(Math.hypot(eye.x - target.x, eye.y - target.y), distance(eye, target) * 0.4, 1000)
  const shot = (seconds: number, turn: number, lift: number): Waypoint => ({
    seconds, target, eye: { x: target.x + radius * Math.cos(angle + turn), y: target.y + radius * Math.sin(angle + turn), z: eye.z + radius * lift },
  })
  return [{ eye, target, seconds: 0 }, shot(4, Math.PI / 3, 0.22), shot(9, Math.PI * 2 / 3, 0.06)]
}

export function validFlight(shots: readonly Waypoint[]): boolean {
  return shots.length >= 2 && shots.every((s, i) => Number.isFinite(s.seconds) && (i ? s.seconds > shots[i - 1]!.seconds : s.seconds === 0)
    && [s.eye, s.target].every(p => [p.x, p.y, p.z].every(Number.isFinite)) && distance(s.eye, s.target) > 1)
}

export function flightPose(shots: readonly Waypoint[], seconds: number): CameraPose {
  const next = shots.findIndex(s => s.seconds >= seconds)
  if (next <= 0) return shots[next === 0 ? 0 : shots.length - 1]!
  const a = shots[next - 1]!, b = shots[next]!
  if (seconds === b.seconds) return b
  const t = (seconds - a.seconds) / (b.seconds - a.seconds)
  const ease = t * t * (3 - 2 * t)
  const eye = mix(a.eye, b.eye, ease)
  const target = mix(a.target, b.target, ease)
  // Opposing shots can put the camera exactly on its aim between waypoints.
  if (distance(eye, target) < 1) return { eye, target: { x: eye.x + a.target.x - a.eye.x, y: eye.y + a.target.y - a.eye.y, z: eye.z + a.target.z - a.eye.z } }
  return { eye, target }
}
