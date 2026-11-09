import type { BimElement, RunPoint } from '@permitzip/bim-kernel'

/** What a press on a routed run grabs: a straight piece whole, one end of it, or an elbow's corner. */
export interface RunGrab {
  readonly id: string
  /** `segment`: moves whole; `corner`: an elbow, or a piece's end where an elbow is (moves freely); `end`: an open end (stretches). */
  readonly kind: 'segment' | 'corner' | 'end'
  readonly grip?: 'start' | 'end'
  /** Where the handle is drawn (model mm, z above the level floor). */
  readonly at: RunPoint
  /** The piece's direction, for snapping; null for a corner. */
  readonly axis: RunPoint | null
}

/** How close to an end (mm) still grabs the end: a fifth of the piece, at least 6", at most 2 ft, never more than a third. */
export function endZoneMm(lengthMm: number): number {
  return Math.min(Math.max(lengthMm * 0.2, 152.4), 609.6, lengthMm / 3)
}

/**
 * The grab for a press on `el` at `hit` (model mm, same frame as the run). The
 * middle of a straight piece moves it whole; near an end, that end moves (the
 * elbow there, so a small elbow is easy to grab); an elbow moves its corner.
 * Branch takeoffs and anything else: null (they slide or aren't runs).
 */
export function grabFor(elements: Readonly<Record<string, BimElement>>, el: BimElement | undefined, hit: RunPoint): RunGrab | null {
  if (!el) return null
  if (el.kind === 'run_fitting') return el.host ? null : { id: el.id, kind: 'corner', at: el.position, axis: null }
  if (el.kind !== 'run_segment') return null
  const d = { x: el.end.x - el.start.x, y: el.end.y - el.start.y, z: el.end.z - el.start.z }
  const len = Math.hypot(d.x, d.y, d.z)
  if (len < 1e-6) return null
  const axis = { x: d.x / len, y: d.y / len, z: d.z / len }
  const s = (hit.x - el.start.x) * axis.x + (hit.y - el.start.y) * axis.y + (hit.z - el.start.z) * axis.z
  const zone = endZoneMm(len)
  const grip = s <= zone ? 'start' : s >= len - zone ? 'end' : null
  if (!grip) return { id: el.id, kind: 'segment', at: { x: el.start.x + d.x / 2, y: el.start.y + d.y / 2, z: el.start.z + d.z / 2 }, axis }
  const link = el.links[grip]
  const other = link ? elements[link.elementId] : undefined
  const corner = other?.kind === 'run_fitting' && !other.host && other.ports.length === 2
  return { id: el.id, kind: corner ? 'corner' : 'end', grip, at: grip === 'start' ? el.start : el.end, axis }
}

/** Below this camera pitch (degrees under level) a plain drag goes up and down as well as sideways: the view is looking at the run from the side. */
export const LOW_VIEW_DEG = 35

/** How a drag goes up or down from this view, said before the drag starts. */
function upDownWords(lowView: boolean): string {
  return lowView ? 'From this low angle, dragging up or down raises or lowers it (Shift: only up or down).' : 'Hold Shift while dragging to go up or down.'
}

/** What the handle says, in operator words. `lowView`: the camera looks at the run from the side (see LOW_VIEW_DEG). */
export function grabHint(kind: RunGrab['kind'], label: string, lowView = false): string {
  switch (kind) {
    case 'segment':
      return `Drag the middle to move the ${label}; what it meets follows. ${upDownWords(lowView)}`
    case 'corner':
      return `Drag to move this corner of the ${label}; both legs keep their direction. ${upDownWords(lowView)}`
    case 'end':
      return `Drag this end to make the ${label} longer or shorter.`
  }
}
