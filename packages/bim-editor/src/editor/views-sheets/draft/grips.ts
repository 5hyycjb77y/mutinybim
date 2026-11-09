import { dimensionPoints, endsOf, figureFrame, modifyCommand, resolveNote, type BatchCommand, type DrawingItem, type ModelState, type NoteLeader, type Vec2, type ViewCommand, type ViewElement } from '@permitzip/bim-kernel'
import type { SnapPoint } from '../annotation-tools'

/**
 * Grips on a selected dimension, tag, note or detail line: what each one is,
 * where it sits on paper, and the one command a drag on it sends. A
 * dimension's end that lands on a snap point follows it from then on; dragged
 * off one, it stops following. The offset grip moves the dimension line (or
 * an angle's arc). A detail line's or arc's end grip drags that end, and the
 * lines joined there come along (BIM drafting-view conventions).
 */

export type GripKind = 'dim-point' | 'dim-offset' | 'tag-head' | 'leader-tip' | 'leader-elbow' | 'detail-end' | 'frame-corner'

export interface Grip {
  readonly key: string
  readonly kind: GripKind
  readonly index: number
  /** Paper mm. */
  readonly at: Vec2
  /** A dimension point that follows something: drawn solid. */
  readonly follows: boolean
  readonly label: string
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
  if (item.shape === 'figure') {
    const frame = figureFrame(item.points)
    if (!frame) return out
    const corners = [frame.min, { x: frame.max.x, y: frame.min.y }, frame.max, { x: frame.min.x, y: frame.max.y }]
    corners.forEach((c, index) => out.push({ key: `corner${index}`, kind: 'frame-corner', index, at: toPaper(c), follows: false, label: 'Drag to resize; the opposite corner stays put' }))
    return out
  }
  if (item.tag && item.points[0]) out.push({ key: 'head', kind: 'tag-head', index: 0, at: toPaper(item.points[0]), follows: false, label: 'Drag to move the tag; its words stay with the element' })
  if (item.shape === 'text' && item.note) {
    noteLeaders(item).forEach((l, index) => {
      out.push({ key: `tip${index}`, kind: 'leader-tip', index, at: toPaper(l.to), follows: false, label: 'Drag the arrow to what it points at' })
      if (l.elbow) out.push({ key: `elbow${index}`, kind: 'leader-elbow', index, at: toPaper(l.elbow), follows: false, label: 'Drag the bend' })
    })
  }
  return out
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
      const leaders = noteLeaders(item).map((l, i) => (i !== grip.index ? l : grip.kind === 'leader-tip' ? { ...l, to: toStored(to) } : { ...l, elbow: toStored(to) }))
      return { type: 'move_text_note', itemId: item.id, leaders }
    }
  }
}
