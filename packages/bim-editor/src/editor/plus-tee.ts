import { ROUTING_PLUS_EVERY_RUN_FEATURE, ROUTING_TAP_FACES_FEATURE, ROUTING_TAP_OFFSET_FEATURE, isPitchedOrLevel, type BimElement, type RunFitting, type RunPoint, type RunSegment } from '@permitzip/bim-kernel'

type Elements = Readonly<Record<string, BimElement>>

/** What the "+" on an elbow's side needs from the kernel module (passed in so this stays a plain function). */
export interface TeeHandleKernel {
  runLabel(elements: Elements, el: RunSegment | RunFitting): string
  serviceOf(kind: Extract<BimElement, { kind: 'mep_system' }>['systemKind']): string | null
}

/** True when a system of this kind drains by gravity (the service its row names). */
export function isDrainService(kernel: Pick<TeeHandleKernel, 'serviceOf'>, kind: Extract<BimElement, { kind: 'mep_system' }>['systemKind']): boolean {
  return kernel.serviceOf(kind) === 'drainage'
}

export interface TeeHandleSide {
  /** The elbow port whose leg runs on through the corner. */
  readonly port: string
  readonly direction: RunPoint
  readonly label: string
  /** The level run's face the other leg joins (`elbow_to_tee` `face`): an elbow that turns up joins the top, one that turns down the bottom. Absent: a level tee. */
  readonly face?: BranchFace
}

/** Steepest a leg can fall and still take a tee: matches the kernel's `elbow_to_tee` (a drain at 1/2" per ft is 4%). */
const MAX_TEE_PITCH = 0.1
const levelOrPitched = (d: RunPoint) => Math.abs(d.z) <= MAX_TEE_PITCH * Math.hypot(d.x, d.y) && Math.hypot(d.x, d.y) > 1e-6
const isLevel = (d: RunPoint) => Math.abs(d.z) < 1e-6 && Math.hypot(d.x, d.y) > 1e-6
const isPlumb = (d: RunPoint) => Math.hypot(d.x, d.y) < 1e-6 && Math.abs(d.z) > 1e-6

/** A run with flat sides (not round, not square) can't take a branch off its riser yet: the kernel refuses it in words. */
const hasFlatSides = (size: RunSegment['size']) => (size.shape === 'rect' || size.shape === 'oval') && Math.abs(size.width - size.height) > 0.5

/** Does this straight piece fall away from the end joined at `port`? */
function fallsAway(seg: RunSegment, port: string): boolean {
  const here = port === 'start' ? seg.start : seg.end
  const there = port === 'start' ? seg.end : seg.start
  return there.z < here.z - 1e-6
}

/**
 * The sides of a two-way elbow that can take a "+" (become a tee with that
 * leg running on through the corner). Level and pitched elbows between two
 * straight pieces qualify, so a drain at 1/8" per ft gets one too. On a
 * drain only the side whose leg carries the flow away is offered: running
 * the other leg on would make the trunk drain back up the branch, which the
 * kernel refuses. Drains say "wye" (the kernel picks the combination wye the
 * direction rules allow); everything else says "tee".
 *
 * An elbow between a level leg and one that rises or drops gets one "+" on
 * the level leg's side, joining the other leg to that run's top or bottom,
 * only on a model server that takes a branch off a face (`serverFeatures`
 * includes `routing:tap_faces`). A drain's riser is a stack, not a tap: on a
 * drain that turns down, the "+" runs the drop on up through the corner and
 * the level drain joins it with the system's branch fitting into a stack.
 */
export function teeHandleSides(elements: Elements, el: BimElement, kernel: TeeHandleKernel, serverFeatures: readonly string[] = []): TeeHandleSide[] {
  if (el.kind !== 'run_fitting' || el.fittingType !== 'elbow' || el.host || el.ports.length !== 2) return []
  // The leg that runs on has to be a straight piece; the other may meet a fitting (a transition) or a part, which the branch is routed to.
  if (!el.ports.every((p) => p.link && elements[p.link.elementId])) return []
  const legs = el.ports.map((p) => {
    const seg = elements[p.link?.elementId ?? '']
    return seg?.kind === 'run_segment' && p.link ? { port: p, seg, end: p.link.port } : null
  })
  // A leg meeting a fitting or part, and a riser running on through the corner, need a model server that takes them.
  const everyRun = serverFeatures.includes(ROUTING_PLUS_EVERY_RUN_FEATURE)
  if (legs.every((l) => l === null) || (!everyRun && legs.some((l) => l === null))) return []
  const system = elements[el.systemId]
  const drain = el.domain === 'pipe' && system?.kind === 'mep_system' && isDrainService(kernel, system.systemKind)
  if (!el.ports.every((p) => levelOrPitched(p.direction))) {
    if (drain) {
      const level = legs.find((l) => l && levelOrPitched(l.port.direction))
      // The base of a stack (the stack comes down into the corner, the building drain falls away from it): the drain runs on back through the corner, open to route on, and the stack drops into its top.
      const stack = legs.find((l) => l && isPlumb(l.port.direction) && l.port.direction.z > 0)
      if (stack && level && fallsAway(level.seg, level.end)) {
        if (!serverFeatures.includes(ROUTING_TAP_FACES_FEATURE)) return []
        const drainName = kernel.runLabel(elements, level.seg)
        return [{ port: level.port.id, direction: level.port.direction, face: 'top', label: `Continue the ${drainName} from the base of the stack: it runs on back through the corner (route on from there) and the stack drops into its top` }]
      }
      // A drain that turns down (into a drop or stack): the drop runs on up through the corner and the level leg, which drains into the corner, joins it.
      const drop = legs.find((l) => l && isPlumb(l.port.direction) && l.port.direction.z < 0)
      if (!drop || !level || fallsAway(level.seg, level.end)) return []
      const name = kernel.runLabel(elements, drop.seg)
      return [{ port: drop.port.id, direction: drop.port.direction, label: `Add a branch here: the ${name} runs on up through the corner (a stack above) and the level drain joins it` }]
    }
    const out: TeeHandleSide[] = []
    // A round riser runs on through the corner and the level leg joins its side, on every kind of run.
    const riser = legs.find((l) => l && isPlumb(l.port.direction))
    const flat = el.ports.find((p) => levelOrPitched(p.direction))
    if (everyRun && riser && flat && !hasFlatSides(riser.seg.size)) {
      const name = kernel.runLabel(elements, riser.seg)
      out.push({ port: riser.port.id, direction: riser.port.direction, label: `Add a tee here: the ${name} runs on ${riser.port.direction.z > 0 ? 'down' : 'up'} through the corner and the level leg joins its side` })
    }
    if (!serverFeatures.includes(ROUTING_TAP_FACES_FEATURE)) return out
    const level = legs.find((l) => l && isLevel(l.port.direction))
    const other = el.ports.find((p) => isPlumb(p.direction))
    if (!level || !other) return out
    const face: BranchFace = other.direction.z > 0 ? 'top' : 'bottom'
    const name = kernel.runLabel(elements, level.seg)
    return [...out, { port: level.port.id, direction: level.port.direction, face, label: `Add a tap here: the ${name} runs on through the corner and the ${face === 'top' ? 'rising' : 'dropping'} leg joins its ${face}` }]
  }
  const out: TeeHandleSide[] = []
  for (const leg of legs) {
    if (!leg) continue
    if (drain && !fallsAway(leg.seg, leg.end)) continue
    const name = kernel.runLabel(elements, leg.seg)
    out.push({
      port: leg.port.id,
      direction: leg.port.direction,
      label: drain ? `Add a wye here: the ${name} runs on through the corner and the other leg drains into it` : `Add a tee here: the ${name} runs on through the corner`,
    })
  }
  return out
}

/** What the "+" spots on a selected piece need from the kernel module, besides the elbow's. */
export interface PlusSpotKernel extends TeeHandleKernel {
  portInfo(elements: Elements, ref: { readonly elementId: string; readonly port: string }): { readonly position: RunPoint; readonly direction: RunPoint } | null
}

/** A "+" on a selected piece, in model space (level-relative mm): drawn a little beyond `at`, the way `toward` points, in any view or drawing. */
export interface PlusSpot {
  /** `continue`: route on from an open end (a turn on the first leg puts its elbow right on the end); `tee`: the elbow becomes a tee with this port's leg running on. */
  readonly kind: 'continue' | 'tee'
  readonly elementId: string
  readonly port: string
  readonly label: string
  readonly face?: BranchFace
  readonly at: RunPoint
  readonly toward: RunPoint
}

/**
 * Every "+" on a selected straight piece or fitting: one past each open end
 * and, on an elbow, one on each side a leg could run on through the corner.
 * The 3D view and the printed drawings draw the same list.
 */
export function plusSpots(elements: Elements, el: BimElement, kernel: PlusSpotKernel, serverFeatures: readonly string[] = []): PlusSpot[] {
  if (el.kind !== 'run_segment' && el.kind !== 'run_fitting') return []
  const label = kernel.runLabel(elements, el)
  const out: PlusSpot[] = []
  const open = el.kind === 'run_segment' ? (['start', 'end'] as const).filter((p) => !el.links[p]) : el.ports.filter((p) => !p.link).map((p) => p.id)
  for (const port of open) {
    const info = kernel.portInfo(elements, { elementId: el.id, port })
    if (!info) continue
    const turn = el.kind === 'run_segment' && serverFeatures.includes(ROUTING_PLUS_EVERY_RUN_FEATURE) ? '; click to one side for an elbow right at the end' : ''
    out.push({ kind: 'continue', elementId: el.id, port, label: `Continue the ${label} from this end${turn}`, at: info.position, toward: info.direction })
  }
  if (el.kind === 'run_fitting') {
    for (const t of teeHandleSides(elements, el, kernel, serverFeatures)) {
      // A riser that runs on through the corner: the "+" sits where it will continue (above a drop).
      const plumb = Math.hypot(t.direction.x, t.direction.y) < 1e-6
      out.push({ kind: 'tee', elementId: el.id, port: t.port, label: t.label, at: el.position, toward: plumb ? { x: 0, y: 0, z: -Math.sign(t.direction.z) } : { x: -t.direction.x, y: -t.direction.y, z: 0 }, ...(t.face ? { face: t.face } : {}) })
    }
  }
  return out
}

/** The faces a "+" offers a branch from on a level run, besides its sides. */
export type BranchFace = 'top' | 'bottom'
export const BRANCH_FACES: readonly BranchFace[] = ['top', 'bottom']

export interface FaceHandleSide {
  readonly face: BranchFace
  /** Where along the run the branch leaves (mm from its start): the middle, until the person drags it. */
  readonly s: number
  readonly label: string
}

const FACE_WORD: Readonly<Record<BranchFace, string>> = { top: 'top', bottom: 'bottom' }

/** A level straight run's top and bottom "+" (a vertical or sloped piece has none). */
export function faceHandleSides(elements: Elements, el: BimElement, kernel: Pick<TeeHandleKernel, 'runLabel'>): FaceHandleSide[] {
  if (el.kind !== 'run_segment' || Math.abs(el.start.z - el.end.z) > 1) return []
  const length = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y)
  if (length < 1) return []
  const name = kernel.runLabel(elements, el)
  return BRANCH_FACES.map((face) => ({ face, s: Math.round((length / 2) * 1000) / 1000, label: `Add a branch off the ${FACE_WORD[face]} of the ${name}` }))
}

export interface SlopedSideHandle {
  /** Plan left (1) or right (-1) of the run's direction. */
  readonly side: 1 | -1
  /** mm along the plan length from the start: the middle. */
  readonly s: number
  /** The centreline point there (mm above the level floor). */
  readonly at: RunPoint
  /** Unit plan vector to the run's left. */
  readonly left: { readonly x: number; readonly y: number }
  readonly label: string
}

/**
 * The "+" on each side of a sloped straight pipe (a drain at 1/8" or 1/4" per
 * ft): a branch leaves there and the kernel places the system's branch fitting
 * and pitches the branch towards it. Level runs have their top and bottom "+"
 * and a tap on hover instead; a riser has none.
 */
export function slopedSideHandles(elements: Elements, el: BimElement, kernel: Pick<TeeHandleKernel, 'runLabel'>): SlopedSideHandle[] {
  if (el.kind !== 'run_segment' || el.domain !== 'pipe' || Math.abs(el.start.z - el.end.z) <= 1 || !isPitchedOrLevel(el)) return []
  const ax = el.end.x - el.start.x
  const ay = el.end.y - el.start.y
  const length = Math.hypot(ax, ay)
  if (length < 1) return []
  const s = Math.round((length / 2) * 1000) / 1000
  const at = { x: el.start.x + ax / 2, y: el.start.y + ay / 2, z: (el.start.z + el.end.z) / 2 }
  const left = { x: -ay / length, y: ax / length }
  const name = kernel.runLabel(elements, el)
  return ([1, -1] as const).map((side) => ({ side, s, at, left, label: `Add a branch off this side of the ${name}: it joins with the system's branch fitting and falls toward the ${name}` }))
}

/** The other face, for Tab in plan (where top and bottom are drawn on top of each other). */
export function nextBranchFace(face: BranchFace): BranchFace {
  return face === 'top' ? 'bottom' : 'top'
}

/** What the plan "+" says on hover: which face it would branch from, and how to switch. */
export function planFaceHint(face: BranchFace): string {
  return face === 'top' ? 'Top face — Tab for bottom' : 'Bottom face — Tab for top'
}

/**
 * The offset across the face a tap is sent with (mm from the face's centre
 * line, `HostedOn.t`): only to a model server that reads it (`routing:tap_offset`),
 * only off the centre line, and kept on the face. Absent: a centre-line tap,
 * stored exactly as before.
 */
export function tapOffsetFor(serverFeatures: readonly string[], acrossMm: number, t: number): number | undefined {
  if (!serverFeatures.includes(ROUTING_TAP_OFFSET_FEATURE) || !Number.isFinite(t) || !Number.isFinite(acrossMm) || acrossMm <= 0) return undefined
  const half = acrossMm / 2
  const kept = Math.round(Math.max(-half, Math.min(half, t)))
  return Math.abs(kept) < 1 ? undefined : kept
}
