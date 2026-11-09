import { datumSnapLines, hostLineOf, joinLinesNear, type BimElement, type ElementId, type ModelState, type ReferenceSnapCandidates, type Vec2 } from '@permitzip/bim-kernel'

/**
 * Where an Architecture tool's next point lands for the pointer, and what it
 * snapped to in words. Order, nearest first within each: the chain's own
 * first corner (closes the loop), wall ends, grid crossings, wall
 * midpoints, square onto a wall from the last corner (perpendicular), square
 * off the wall the last corner sits on (perpendicular, onto a wall near the
 * pointer first), where the square guide crosses a wall, onto a grid or
 * reference line, along a wall, a square angle from the last corner, then
 * the drafting grid.
 *
 * A point on a wall wins over the bare square guide (round 16 review on a sample
 * model): a wall drawn toward another landed on the 90° guide a few inches
 * short of it, missed the 5 mm tee tolerance and stayed a loose end. Points
 * on a wall are on its centreline, so the new wall tees or corners into it.
 * Reads walls through the per-level join index (a few cells round the
 * pointer), never every element.
 */

export type SnapKind = 'close' | 'end' | 'crossing' | 'middle' | 'perpendicular' | 'square_on_wall' | 'datum' | 'along' | 'square' | 'grid'

export interface Snap {
  readonly point: Vec2
  readonly kind: SnapKind
  /** What it snapped to, as the marker says it. */
  readonly label: string
  /** The line it lies on (a wall, a grid line, the square guide), drawn faint while it holds. */
  readonly guide?: { readonly start: Vec2; readonly end: Vec2 }
}

export interface SnapInput {
  readonly model: ModelState
  readonly levelId: string
  readonly raw: Vec2
  /** How far (mm at this zoom) a point may move to snap. */
  readonly toleranceMm: number
  /** Corners already put down in this draft. */
  readonly corners: readonly Vec2[]
  /** Drafting grid step, mm; null turns it off. */
  readonly gridMm: number | null
  /** Walls never snapped to (the wall whose end is being dragged). */
  readonly ignoreIds?: readonly string[]
  /** A linked model's faces, centre lines, ends and corners near the pointer (`linkedSnapNear`); absent or null: none loaded. */
  readonly linked?: ReferenceSnapCandidates | null
}

/** 6 inches. */
export const DRAFTING_GRID_MM = 152.4
/** Square angles: every 45°, within this many degrees. */
const SQUARE_WITHIN_DEG = 4

interface Line {
  readonly start: Vec2
  readonly end: Vec2
  readonly label: string
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

function closestOn(l: { readonly start: Vec2; readonly end: Vec2 }, p: Vec2, clamp: boolean): Vec2 {
  const dx = l.end.x - l.start.x
  const dy = l.end.y - l.start.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return l.start
  let t = ((p.x - l.start.x) * dx + (p.y - l.start.y) * dy) / len2
  if (clamp) t = Math.min(1, Math.max(0, t))
  return { x: l.start.x + dx * t, y: l.start.y + dy * t }
}

function crossing(a: Line, b: Line): Vec2 | null {
  const d1x = a.end.x - a.start.x
  const d1y = a.end.y - a.start.y
  const d2x = b.end.x - b.start.x
  const d2y = b.end.y - b.start.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((b.start.x - a.start.x) * d2y - (b.start.y - a.start.y) * d2x) / den
  return { x: a.start.x + d1x * t, y: a.start.y + d1y * t }
}

/** Walls (any line-joined kind) on the level within reach of `p`: the join index's cells round it. */
export function wallsNear(elements: Readonly<Record<string, BimElement>>, levelId: string, p: Vec2, reachMm: number): { readonly id: ElementId; readonly start: Vec2; readonly end: Vec2; readonly widthMm: number }[] {
  const ids = new Set<string>()
  for (const q of [p, { x: p.x - reachMm, y: p.y }, { x: p.x + reachMm, y: p.y }, { x: p.x, y: p.y - reachMm }, { x: p.x, y: p.y + reachMm }]) for (const id of joinLinesNear(elements, levelId, q)) ids.add(id)
  const out: { id: ElementId; start: Vec2; end: Vec2; widthMm: number }[] = []
  for (const id of ids) {
    const el = elements[id]
    const line = el ? hostLineOf(el, elements) : null
    if (el && line) out.push({ id: el.id, ...line })
  }
  return out
}

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) })

/** True when `p` (on the wall's line) lies between its ends. */
function onRun(w: { readonly start: Vec2; readonly end: Vec2 }, p: Vec2): boolean {
  return dist(closestOn(w, p, true), p) < 1
}

/** The square angle (every 45°) from `last` that the pointer is within a few degrees of, or null. */
function squareGuide(last: Vec2, raw: Vec2): { readonly far: Vec2; readonly along: Vec2; readonly deg: number } | null {
  const angle = Math.atan2(raw.y - last.y, raw.x - last.x)
  const step = Math.PI / 4
  const snapped = Math.round(angle / step) * step
  if (Math.abs(angle - snapped) > (SQUARE_WITHIN_DEG * Math.PI) / 180) return null
  const far = { x: last.x + Math.cos(snapped), y: last.y + Math.sin(snapped) }
  const deg = ((Math.round((snapped * 180) / Math.PI) % 360) + 360) % 360
  return { far, along: closestOn({ start: last, end: far }, raw, false), deg }
}

/** How far (mm) the last corner may sit off a wall's centreline beyond its half width and still count as on it. */
const ON_WALL_SLACK_MM = 5

/**
 * The direction square to the wall `last` sits on (its face, end or
 * centreline), when the pointer is within a few degrees of it: the far point
 * of that square line and the pointer's point along it. Null when `last` is on
 * no wall, or the pointer heads elsewhere. Reads the join index round `last`.
 */
export function squareOffWall(elements: Readonly<Record<string, BimElement>>, levelId: string, last: Vec2, raw: Vec2, ignoreIds: readonly string[] = []): { readonly wallId: string; readonly far: Vec2; readonly along: Vec2 } | null {
  if (dist(last, raw) < 1) return null
  const heading = Math.atan2(raw.y - last.y, raw.x - last.x)
  for (const w of wallsNear(elements, levelId, last, ON_WALL_SLACK_MM)) {
    if (ignoreIds.includes(w.id)) continue
    const foot = closestOn(w, last, true)
    if (dist(foot, last) > w.widthMm / 2 + ON_WALL_SLACK_MM) continue
    const len = dist(w.start, w.end)
    if (len < 1) continue
    const n = { x: -(w.end.y - w.start.y) / len, y: (w.end.x - w.start.x) / len }
    for (const s of [1, -1]) {
      const a = Math.atan2(n.y * s, n.x * s)
      let diff = Math.abs(heading - a) % (2 * Math.PI)
      if (diff > Math.PI) diff = 2 * Math.PI - diff
      if (diff > (SQUARE_WITHIN_DEG * Math.PI) / 180) continue
      const far = { x: last.x + n.x * s, y: last.y + n.y * s }
      return { wallId: w.id, far, along: closestOn({ start: last, end: far }, raw, false) }
    }
  }
  return null
}

export function snapPoint(input: SnapInput): Snap {
  const { model, levelId, raw, toleranceMm: tol, corners } = input
  const best = (cands: readonly Snap[]): Snap | null => {
    let hit: Snap | null = null
    let d = tol
    for (const c of cands) {
      const dd = dist(c.point, raw)
      if (dd <= d) {
        d = dd
        hit = c
      }
    }
    return hit
  }

  const first = corners[0]
  if (first && corners.length >= 2) {
    const close = best([{ point: first, kind: 'close', label: 'First corner: closes the loop' }])
    if (close) return close
  }

  const ignored = input.ignoreIds
  const walls = ignored && ignored.length > 0 ? wallsNear(model.elements, levelId, raw, tol).filter((w) => !ignored.includes(w.id)) : wallsNear(model.elements, levelId, raw, tol)
  // A linked model's walls snap like ours, and the marker says they are the link's.
  const linkedLines: Line[] = (input.linked?.lines ?? []).map((l) => ({ start: l.start, end: l.end, label: l.label }))
  const linkedPoints: Snap[] = (input.linked?.points ?? []).map((p) => ({ point: p.at, kind: 'end' as const, label: p.label }))
  const ends = best([...walls.flatMap((w) => [{ point: w.start, kind: 'end' as const, label: 'Wall end' }, { point: w.end, kind: 'end' as const, label: 'Wall end' }]), ...corners.slice(0, -1).map((c) => ({ point: c, kind: 'end' as const, label: 'Corner' })), ...linkedPoints])
  if (ends) return { ...ends, point: round(ends.point) }

  const datums: Line[] = datumSnapLines(model, levelId as ElementId).map((d) => ({ start: d.start, end: d.end, label: d.label }))
  const crossings: Snap[] = []
  for (let i = 0; i < datums.length; i++) {
    for (let j = i + 1; j < datums.length; j++) {
      const a = datums[i] as Line
      const b = datums[j] as Line
      const x = crossing(a, b)
      if (x) crossings.push({ point: x, kind: 'crossing', label: `${a.label} / ${b.label}` })
    }
  }
  for (const d of datums) for (const w of walls) {
    const x = crossing(d, { ...w, label: '' })
    if (x && dist(closestOn(w, x, true), x) < 1) crossings.push({ point: x, kind: 'crossing', label: `${d.label} at the wall` })
  }
  const cross = best(crossings)
  if (cross) return { ...cross, point: round(cross.point) }

  const middle = best(walls.map((w) => ({ point: { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 }, kind: 'middle' as const, label: 'Wall midpoint' })))
  if (middle) return { ...middle, point: round(middle.point) }

  const last = corners[corners.length - 1]
  const square = last && dist(last, raw) > tol ? squareGuide(last, raw) : null

  if (last) {
    // Square onto a wall: the foot of the perpendicular from the last corner, on the wall's run.
    const feet = walls.flatMap((w) => {
      const foot = closestOn(w, last, false)
      return dist(foot, last) > 1 && onRun(w, foot) ? [{ point: foot, kind: 'perpendicular' as const, label: 'Perpendicular to the wall', guide: { start: last, end: foot } }] : []
    })
    for (const l of linkedLines) {
      const foot = closestOn(l, last, false)
      if (dist(foot, last) > 1 && onRun(l, foot)) feet.push({ point: foot, kind: 'perpendicular', label: `Perpendicular to the linked ${l.label.replace(/^On the linked /, '')}`, guide: { start: last, end: foot } })
    }
    const perpendicular = best(feet)
    if (perpendicular) return { ...perpendicular, point: round(perpendicular.point) }
  }

  if (last) {
    const off = dist(last, raw) > tol ? squareOffWall(model.elements, levelId, last, raw, ignored) : null
    if (off) {
      // Square off the wall the chain starts from, onto a wall near the pointer: both square and on that wall.
      const hits = walls.flatMap((w) => {
        if (w.id === off.wallId) return []
        const x = crossing({ start: last, end: off.far, label: '' }, { ...w, label: '' })
        const ahead = x !== null && (x.x - last.x) * (off.far.x - last.x) + (x.y - last.y) * (off.far.y - last.y) > 0
        return x && ahead && onRun(w, x) ? [{ point: x, kind: 'perpendicular' as const, label: 'Perpendicular to the wall, onto a wall', guide: { start: last, end: x } }] : []
      })
      const onto = best(hits)
      if (onto) return { ...onto, point: round(onto.point) }
      // Off a wall at any angle, square to it wins over the plan's 45° guide when the pointer is within a few degrees of it.
      return { point: round(off.along), kind: 'perpendicular', label: 'Perpendicular to the wall', guide: { start: last, end: off.along } }
    }
  }

  if (last && square) {
    // The square guide where it crosses a wall: both the angle and a point on the wall.
    const hits = walls.flatMap((w) => {
      const x = crossing({ start: last, end: square.far, label: '' }, { ...w, label: '' })
      const ahead = x !== null && (x.x - last.x) * (square.far.x - last.x) + (x.y - last.y) * (square.far.y - last.y) > 0
      return x && ahead && onRun(w, x) && dist(x, last) > 1 ? [{ point: x, kind: 'square_on_wall' as const, label: `${square.deg}° on the wall`, guide: { start: last, end: x } }] : []
    })
    for (const l of linkedLines) {
      const x = crossing({ start: last, end: square.far, label: '' }, l)
      const ahead = x !== null && (x.x - last.x) * (square.far.x - last.x) + (x.y - last.y) * (square.far.y - last.y) > 0
      if (x && ahead && onRun(l, x) && dist(x, last) > 1) hits.push({ point: x, kind: 'square_on_wall', label: `${square.deg}° ${l.label.replace(/^On /, 'on ')}`, guide: { start: last, end: x } })
    }
    const hit = best(hits)
    if (hit) return { ...hit, point: round(hit.point) }
  }

  const onDatum = best(datums.map((d) => ({ point: closestOn(d, raw, false), kind: 'datum' as const, label: `On ${d.label}`, guide: { start: d.start, end: d.end } })))
  if (onDatum) return { ...onDatum, point: round(onDatum.point) }

  const onWall = best([...walls.map((w) => ({ point: closestOn(w, raw, true), kind: 'along' as const, label: 'On the wall', guide: { start: w.start, end: w.end } })), ...linkedLines.map((l) => ({ point: closestOn(l, raw, true), kind: 'along' as const, label: l.label, guide: { start: l.start, end: l.end } }))])
  if (onWall) return { ...onWall, point: round(onWall.point) }

  if (last && square) return { point: round(square.along), kind: 'square', label: `${square.deg}°`, guide: { start: last, end: square.along } }

  if (input.gridMm) {
    const g = input.gridMm
    return { point: round({ x: Math.round(raw.x / g) * g, y: Math.round(raw.y / g) * g }), kind: 'grid', label: g === DRAFTING_GRID_MM ? '6" drafting grid' : `${Math.round(g)} mm drafting grid` }
  }
  return { point: round(raw), kind: 'grid', label: 'Free' }
}
