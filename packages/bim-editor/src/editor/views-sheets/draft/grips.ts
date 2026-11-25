import {
  boxToPaper,
  calloutBoundaryPolygon,
  calloutSyncCommands,
  dimensionPoints,
  endsOf,
  figureFrame,
  modifyCommand,
  noteAutoShoulderPaper,
  paperToBox,
  resolveNote,
  textBlockFor,
  type BatchCommand,
  type DrawingItem,
  type ModelState,
  type NoteLeader,
  type Vec2,
  type ViewCommand,
  type ViewElement,
} from '@permitzip/bim-kernel'
import type { SnapPoint } from '../annotation-tools'

/**
 * Grips on a selected dimension, tag, note, callout or detail line: what each
 * one is, where it sits on paper, and the command a drag on it sends. A
 * dimension's end that lands on a snap point follows it from then on; dragged
 * off one, it stops following. Callout corner, edge-extent and P-line vertex
 * grips resize the callout AND atomically sync the referenced enlarged plan's
 * crop box / polygonal crop region (Revit behavior).
 */

export type GripKind =
  | 'dim-point'
  | 'dim-offset'
  | 'tag-head'
  | 'leader-tip'
  | 'leader-elbow'
  | 'detail-end'
  | 'frame-corner'
  | 'callout-corner'
  | 'callout-edge'
  | 'callout-poly-edge'
  | 'callout-vertex'
  | 'callout-head'

export interface Grip {
  readonly key: string
  readonly kind: GripKind
  readonly index: number
  /** Paper mm. */
  readonly at: Vec2
  /** A dimension point that follows something: drawn solid. */
  readonly follows: boolean
  readonly label: string
  /** Edge axis for `callout-edge` grips ('x' moves east/west, 'y' moves north/south). */
  readonly axis?: 'x' | 'y'
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const unit = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}

function noteLeaders(item: DrawingItem): NoteLeader[] {
  return [...(item.note?.leader ? [item.note.leader] : []), ...(item.note?.leaders ?? [])]
}

/** The axis and normal a linear / aligned dimension line runs on, on paper. */
function dimAxis(item: DrawingItem, paper: readonly Vec2[]): { axis: Vec2; normal: Vec2 } | null {
  const spec = item.dim
  const [p0, p1] = paper
  if (!spec || !p0 || !p1) return null
  const axis = spec.kind === 'aligned' ? unit(sub(p1, p0)) : spec.direction === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 }
  return { axis, normal: { x: -axis.y, y: axis.x } }
}

export function annotationGrips(model: ModelState, view: ViewElement | null, item: DrawingItem, toPaper: (p: Vec2) => Vec2): Grip[] {
  const out: Grip[] = []
  if (item.dim) {
    const spec = item.dim
    const paper = dimensionPoints(model, view, item).points.map(toPaper)
    paper.forEach((at, index) => out.push({ key: `p${index}`, kind: 'dim-point', index, at, follows: Boolean(spec.refs?.[index]), label: spec.refs?.[index] ? 'Follows the model. Drag it off to measure a fixed point instead.' : 'Drag to a point; it follows what it lands on.' }))
    const [p0, p1] = paper
    if (p0 && p1 && (spec.kind === 'linear' || spec.kind === 'aligned') && !spec.chain) {
      const ax = dimAxis(item, paper)
      if (ax) {
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
        const along = dot(sub(mid, p0), ax.axis)
        out.push({ key: 'offset', kind: 'dim-offset', index: 0, at: { x: p0.x + ax.axis.x * along + ax.normal.x * spec.offsetMm, y: p0.y + ax.axis.y * along + ax.normal.y * spec.offsetMm }, follows: false, label: 'Drag to move the dimension line' })
      }
    }
    if (p0 && p1 && spec.kind === 'angular') {
      const r = Math.max(4, Math.abs(spec.offsetMm))
      const d = unit(sub(p1, p0))
      out.push({ key: 'offset', kind: 'dim-offset', index: 0, at: { x: p0.x + d.x * r, y: p0.y + d.y * r }, follows: false, label: 'Drag to change the arc radius' })
    }
    return out
  }
  if ((item.shape === 'line' || item.shape === 'arc') && !item.dim) {
    const ends = endsOf(item)
    if (ends) {
      out.push({ key: 'start', kind: 'detail-end', index: 0, at: toPaper(ends.start), follows: false, label: 'Drag this end; lines joined to it follow' })
      out.push({ key: 'end', kind: 'detail-end', index: 1, at: toPaper(ends.end), follows: false, label: 'Drag this end; lines joined to it follow' })
    }
    return out
  }
  if (item.shape === 'callout' && item.callout) {
    const head = item.points[2]
    if (item.callout.boundary && item.callout.boundary.length >= 3) {
      const bnd = item.callout.boundary
      bnd.forEach((pt, index) => {
        out.push({ key: `v${index}`, kind: 'callout-vertex', index, at: toPaper(pt), follows: false, label: `Drag callout corner ${index + 1} (snaps to walls & grids)` })
      })
      // Direct edge-slide handles for every P-line edge (like dragging a wall in/out without opening Edit Boundary).
      for (let i = 0; i < bnd.length; i++) {
        const p0 = bnd[i]!
        const p1 = bnd[(i + 1) % bnd.length]!
        const dx = Math.abs(p1.x - p0.x)
        const dy = Math.abs(p1.y - p0.y)
        if (Math.hypot(dx, dy) < 25) continue
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
        const axis: 'x' | 'y' | undefined = dy < dx * 0.2 ? 'y' : dx < dy * 0.2 ? 'x' : undefined
        out.push({
          key: `pe${i}`,
          kind: 'callout-poly-edge',
          index: i,
          ...(axis ? { axis } : {}),
          at: toPaper(mid),
          follows: false,
          label: 'Drag callout edge in or out (snaps to walls & grids)',
        })
      }
    } else if (item.points[0] && item.points[1]) {
      const a = item.points[0]
      const b = item.points[1]
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
      const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }
      const midX = (min.x + max.x) / 2
      const midY = (min.y + max.y) / 2
      const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }]
      corners.forEach((c, index) => {
        out.push({ key: `c${index}`, kind: 'callout-corner', index, at: toPaper(c), follows: false, label: 'Drag callout corner (snaps to walls & grids; syncs enlarged view crop)' })
      })
      // 4 Revit-style edge extent grips: 0=north(+y), 1=east(+x), 2=south(-y), 3=west(-x)
      out.push(
        { key: 'e0', kind: 'callout-edge', index: 0, axis: 'y', at: toPaper({ x: midX, y: max.y }), follows: false, label: 'Drag top extent (snaps to walls & grids)' },
        { key: 'e1', kind: 'callout-edge', index: 1, axis: 'x', at: toPaper({ x: max.x, y: midY }), follows: false, label: 'Drag right extent (snaps to walls & grids)' },
        { key: 'e2', kind: 'callout-edge', index: 2, axis: 'y', at: toPaper({ x: midX, y: min.y }), follows: false, label: 'Drag bottom extent (snaps to walls & grids)' },
        { key: 'e3', kind: 'callout-edge', index: 3, axis: 'x', at: toPaper({ x: min.x, y: midY }), follows: false, label: 'Drag left extent (snaps to walls & grids)' },
      )
    }
    if (head) out.push({ key: 'head', kind: 'callout-head', index: 0, at: toPaper(head), follows: true, label: 'Drag the callout bubble' })
    return out
  }
  if (item.shape === 'figure') {
    const frame = figureFrame(item.points)
    if (!frame) return out
    const corners = [frame.min, { x: frame.max.x, y: frame.min.y }, frame.max, { x: frame.min.x, y: frame.max.y }]
    corners.forEach((c, index) => out.push({ key: `corner${index}`, kind: 'frame-corner', index, at: toPaper(c), follows: false, label: 'Drag to resize; the opposite corner stays put' }))
    return out
  }
  if (item.tag && item.points[0]) out.push({ key: 'head', kind: 'tag-head', index: 0, at: toPaper(item.points[0]), follows: false, label: 'Drag to move the tag; its words stay with the element' })
  if (item.shape === 'text' && item.note) {
    const block = textBlockFor(item, toPaper)
    noteLeaders(item).forEach((l, index) => {
      const tipPaper = toPaper(l.to)
      out.push({ key: `tip${index}`, kind: 'leader-tip', index, at: tipPaper, follows: false, label: 'Drag the arrow to what it points at' })
      const elbowPaper = l.elbow ? toPaper(l.elbow) : block ? noteAutoShoulderPaper(block, tipPaper) : null
      if (elbowPaper) out.push({ key: `elbow${index}`, kind: 'leader-elbow', index, at: elbowPaper, follows: false, label: 'Drag the leader landing / bend (snaps to note lines and flips side)' })
    })
  }
  return out
}

/** Compute the updated callout boundary polygon (in owner model mm) and head after dragging one callout grip to `storedTo`. */
export function calloutBoundaryAfterGrip(
  item: DrawingItem,
  grip: Grip,
  storedTo: Vec2,
): { readonly boundary: Vec2[]; readonly head: Vec2; readonly headOnly: boolean } | null {
  if (item.shape !== 'callout' || !item.callout) return null
  const poly = calloutBoundaryPolygon(item)
  if (!poly || poly.length < 3) return null
  const currentHead = item.points[2] ?? poly[0]!
  if (grip.kind === 'callout-head') return { boundary: poly, head: storedTo, headOnly: true }
  if (grip.kind === 'callout-vertex') {
    if (grip.index < 0 || grip.index >= poly.length) return null
    return { boundary: poly.map((p, i) => (i === grip.index ? storedTo : p)), head: currentHead, headOnly: false }
  }
  if (grip.kind === 'callout-poly-edge') {
    const i0 = grip.index
    const i1 = (i0 + 1) % poly.length
    const p0 = poly[i0]
    const p1 = poly[i1]
    if (!p0 || !p1) return null
    const ex = p1.x - p0.x
    const ey = p1.y - p0.y
    const len = Math.hypot(ex, ey)
    if (len < 1e-3) return null
    // Project displacement onto the edge normal so horizontal/vertical edges slide cleanly orthogonally like walls.
    const nx = -ey / len
    const ny = ex / len
    const midX = (p0.x + p1.x) / 2
    const midY = (p0.y + p1.y) / 2
    const proj = (storedTo.x - midX) * nx + (storedTo.y - midY) * ny
    const dx = nx * proj
    const dy = ny * proj
    return {
      boundary: poly.map((p, idx) => (idx === i0 || idx === i1 ? { x: p.x + dx, y: p.y + dy } : p)),
      head: currentHead,
      headOnly: false,
    }
  }
  const [a, b] = item.points
  if (!a || !b) return null
  let minX = Math.min(a.x, b.x)
  let maxX = Math.max(a.x, b.x)
  let minY = Math.min(a.y, b.y)
  let maxY = Math.max(a.y, b.y)
  if (grip.kind === 'callout-corner') {
    if (grip.index === 0) {
      minX = storedTo.x
      minY = storedTo.y
    } else if (grip.index === 1) {
      maxX = storedTo.x
      minY = storedTo.y
    } else if (grip.index === 2) {
      maxX = storedTo.x
      maxY = storedTo.y
    } else if (grip.index === 3) {
      minX = storedTo.x
      maxY = storedTo.y
    }
  } else if (grip.kind === 'callout-edge') {
    if (grip.index === 0) maxY = storedTo.y
    else if (grip.index === 1) maxX = storedTo.x
    else if (grip.index === 2) minY = storedTo.y
    else if (grip.index === 3) minX = storedTo.x
  } else {
    return null
  }
  const loX = Math.min(minX, maxX)
  const hiX = Math.max(minX, maxX)
  const loY = Math.min(minY, maxY)
  const hiY = Math.max(minY, maxY)
  return {
    boundary: [
      { x: loX, y: loY },
      { x: hiX, y: loY },
      { x: hiX, y: hiY },
      { x: loX, y: hiY },
    ],
    head: currentHead,
    headOnly: false,
  }
}

/** The command for dropping `grip` at paper point `to` (snapped to `snap` when it landed on one), null for no change, or why it can't. */
export function gripCommand(input: {
  readonly model: ModelState
  readonly view: ViewElement | null
  readonly item: DrawingItem
  readonly grip: Grip
  readonly to: Vec2
  readonly snap: SnapPoint | null
  readonly toPaper: (p: Vec2) => Vec2
  readonly toStored: (p: Vec2) => Vec2
  /** Every item in the owner (joined ends follow) and the owner, for a detail line's end grip. */
  readonly items?: readonly DrawingItem[]
  readonly ownerId?: string
  readonly idPrefix?: string
}): ViewCommand | BatchCommand | string | null {
  const { model, view, item, grip, snap, toPaper, toStored } = input
  const to = snap?.at ?? input.to
  if (Math.hypot(to.x - grip.at.x, to.y - grip.at.y) < 0.3) return null
  switch (grip.kind) {
    case 'callout-head':
    case 'callout-corner':
    case 'callout-edge':
    case 'callout-poly-edge':
    case 'callout-vertex': {
      const updated = calloutBoundaryAfterGrip(item, grip, toStored(to))
      if (!updated) return null
      if (updated.headOnly) {
        const pts = item.points.map((p, i) => (i === 2 ? { x: Math.round(updated.head.x * 10) / 10, y: Math.round(updated.head.y * 10) / 10 } : p))
        return { type: 'update_drawing_item', itemId: item.id, points: pts, ...(item.callout ? { callout: item.callout } : {}) }
      }
      const cmds = calloutSyncCommands(model, item, updated.boundary, updated.head)
      if (typeof cmds === 'string') return cmds
      if (cmds.length === 1 && cmds[0]) return cmds[0]
      return { type: 'batch_documents', label: 'Resize callout and sync enlarged plan crop', commands: cmds }
    }
    case 'dim-point': {
      const spec = item.dim
      if (!spec) return null
      const resolved = dimensionPoints(model, view, item).points
      const points = resolved.map((p, i) => (i === grip.index ? toStored(to) : p))
      const refs = resolved.map((_, i) => (i === grip.index ? (snap?.ref ?? null) : (spec.refs?.[i] ?? null)))
      const { refs: _old, ...rest } = spec
      return { type: 'update_drawing_item', itemId: item.id, points, dim: { ...rest, ...(refs.some((r) => r) ? { refs } : {}) } }
    }
    case 'dim-offset': {
      const spec = item.dim
      if (!spec) return null
      const paper = dimensionPoints(model, view, item).points.map(toPaper)
      const p0 = paper[0]
      if (!p0) return null
      if (spec.kind === 'angular') return { type: 'update_drawing_item', itemId: item.id, dim: { ...spec, offsetMm: Math.round(Math.max(4, Math.hypot(to.x - p0.x, to.y - p0.y)) * 10) / 10 } }
      const ax = dimAxis(item, paper)
      if (!ax) return null
      return { type: 'update_drawing_item', itemId: item.id, dim: { ...spec, offsetMm: Math.round(dot(sub(to, p0), ax.normal) * 10) / 10 } }
    }
    case 'tag-head':
      return { type: 'update_drawing_item', itemId: item.id, points: [toStored(to)] }
    case 'detail-end': {
      if (!input.items || !input.ownerId) return null
      const made = modifyCommand(input.items, [item.id], { op: 'move_end', end: grip.index === 0 ? 'start' : 'end', to: toStored(to) }, input.ownerId, input.idPrefix ?? 'grip')
      return made.ok ? made.command : made.reason
    }
    case 'frame-corner': {
      const frame = figureFrame(item.points)
      if (!frame) return null
      const corners = [frame.min, { x: frame.max.x, y: frame.min.y }, frame.max, { x: frame.min.x, y: frame.max.y }]
      const fixed = corners[(grip.index + 2) % 4]
      if (!fixed) return null
      const a = toStored(to)
      const b = toStored(toPaper(fixed))
      if (Math.abs(a.x - b.x) < 5 || Math.abs(a.y - b.y) < 5) return 'Too small: keep the frame at least 5 mm each way.'
      const min = { x: Math.round(Math.min(a.x, b.x) * 10) / 10, y: Math.round(Math.min(a.y, b.y) * 10) / 10 }
      const max = { x: Math.round(Math.max(a.x, b.x) * 10) / 10, y: Math.round(Math.max(a.y, b.y) * 10) / 10 }
      return { type: 'update_drawing_item', itemId: item.id, points: [min, max] }
    }
    case 'leader-tip':
    case 'leader-elbow': {
      if (!resolveNote(item)) return null
      const leaders = noteLeaders(item).map((l, i) => {
        if (i !== grip.index) return l
        if (grip.kind === 'leader-tip') return { ...l, to: toStored(to) }
        // Snap elbow cleanly to a horizontal shoulder with any line of the note when within 2.5 paper mm
        const block = textBlockFor(item, toPaper)
        if (block) {
          const local = paperToBox(block, to)
          const mids = block.layout.lines.length > 0 ? block.layout.lines.map((ln) => ln.top + ln.height / 2) : [block.layout.height / 2]
          let bestMid: number | null = null
          let bestDist = 2.5
          for (const m of mids) {
            const d = Math.abs(local.y - m)
            if (d <= bestDist) {
              bestDist = d
              bestMid = m
            }
          }
          if (bestMid !== null) {
            return { ...l, elbow: toStored(boxToPaper(block, { x: local.x, y: bestMid })) }
          }
        }
        return { ...l, elbow: toStored(to) }
      })
      return { type: 'move_text_note', itemId: item.id, leaders }
    }
  }
}
