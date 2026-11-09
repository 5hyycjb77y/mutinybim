import {
  anchorInView,
  dimensionPoints,
  defaultTagStyleFor,
  elementsOfKind,
  organizationOf,
  tagHasLeader,
  tagItemBox,
  tagStyleCategoryOf,
  tagStyleName,
  viewLevelElements,
  type AnchorName,
  type AnchorRef,
  type DimSpec,
  type DrawingItem,
  type ModelState,
  type TagSpec,
  type Vec2,
  type ViewElement,
} from '@permitzip/bim-kernel'

/**
 * The Annotate tools' geometry: where a click snaps to (element ends, middles,
 * duct and wall edges, part insertion points, detail linework points), what a
 * click tags, and a tag's or dimension's box for selection. Pure: the canvas
 * owns pointer state and sends the kernel commands.
 */

export interface SnapPoint {
  readonly ref: AnchorRef
  /** Paper mm on the drawing. */
  readonly at: Vec2
  readonly label: string
}

const TAGGABLE = new Set(['run_segment', 'duct_segment', 'terminal', 'equipment', 'part'])

function anchorsFor(kind: string): readonly AnchorName[] {
  if (kind === 'run_segment' || kind === 'duct_segment' || kind === 'wall') return ['start', 'end', 'mid', 'edge_left', 'edge_right']
  if (kind === 'grid') return ['start', 'end', 'mid']
  return ['insertion']
}

const ANCHOR_WORDS: Record<AnchorName, string> = { start: 'end', end: 'end', mid: 'middle', center: 'centre', insertion: 'insertion point', edge_left: 'edge', edge_right: 'edge' }

/** Every point a dimension can follow in this drawing. */
export function snapPoints(model: ModelState, view: ViewElement, items: readonly DrawingItem[], toPaper: (p: Vec2) => Vec2): SnapPoint[] {
  const out: SnapPoint[] = []
  if (view.viewType === 'detail') {
    for (const item of items) {
      if (item.deleted || item.dim || item.tag || item.shape === 'text') continue
      item.points.forEach((p, index) => out.push({ ref: { elementId: item.id, anchor: 'start', index }, at: toPaper(p), label: `${item.shape} corner` }))
      if (item.points.length === 2) {
        const mid = anchorInView(model, view, { elementId: item.id, anchor: 'mid' })
        if (mid) out.push({ ref: { elementId: item.id, anchor: 'mid' }, at: toPaper(mid), label: `${item.shape} middle` })
      }
    }
    return out
  }
  for (const el of viewLevelElements(model, view)) {
    if ('deleted' in el && el.deleted) continue
    for (const anchor of anchorsFor(el.kind)) {
      if (anchor === 'insertion' && !TAGGABLE.has(el.kind) && el.kind !== 'column') continue
      const at = anchorInView(model, view, { elementId: el.id, anchor })
      if (at) out.push({ ref: { elementId: el.id, anchor }, at: toPaper(at), label: `${el.kind.replace(/_/g, ' ')} ${ANCHOR_WORDS[anchor]}` })
    }
  }
  return out
}

/** The nearest snap point within `reachMm` of a paper point. */
export function nearestSnap(points: readonly SnapPoint[], at: Vec2, reachMm: number): SnapPoint | null {
  let best: SnapPoint | null = null
  let bestD = reachMm
  for (const p of points) {
    const d = Math.hypot(p.at.x - at.x, p.at.y - at.y)
    if (d < bestD) {
      best = p
      bestD = d
    }
  }
  return best
}

/** Whether a paper point is inside a closed paper outline (even-odd). */
function insidePaper(outline: readonly Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]
    const b = outline[j]
    if (!a || !b) continue
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Rooms and spaces this plan shows: rooms by their level, spaces placed on the plan's level. */
function floorAreasInView(model: ModelState, view: ViewElement): Array<{ readonly id: string; readonly outlines: ReadonlyArray<readonly Vec2[]> }> {
  if (view.viewType !== 'floor_plan' && view.viewType !== 'ceiling_plan') return []
  const out: Array<{ readonly id: string; readonly outlines: ReadonlyArray<readonly Vec2[]> }> = []
  for (const el of viewLevelElements(model, view)) {
    if (el.kind === 'room' && !('deleted' in el && el.deleted)) out.push({ id: el.id, outlines: [el.outline] })
  }
  const levelName = view.props?.level
  for (const space of elementsOfKind(model.elements, 'space')) {
    const level = space.levelId ? model.elements[space.levelId] : undefined
    if (levelName === undefined || level?.kind !== 'level' || level.name !== levelName) continue
    const bounds = space.bounds
    if (bounds.kind === 'outline' || bounds.kind === 'bounded') out.push({ id: space.id, outlines: [bounds.outline] })
    else if (bounds.kind === 'rooms') out.push({ id: space.id, outlines: bounds.roomIds.flatMap((rid) => { const r = model.elements[rid]; return r?.kind === 'room' ? [r.outline] : [] }) })
  }
  return out
}

/**
 * The element a Tag click lands on: the nearest taggable element's middle
 * within reach; failing that, the space or room the click is inside (a space
 * wins over the room it sits on, as the smaller, more specific thing to label).
 * `floor` says the tag labels an area: its head goes where the person clicked.
 */
export function tagTargetAt(model: ModelState, view: ViewElement, toPaper: (p: Vec2) => Vec2, at: Vec2, reachMm: number): { elementId: string; at: Vec2; floor?: boolean } | null {
  let best: { elementId: string; at: Vec2; floor?: boolean } | null = null
  let bestD = reachMm
  for (const el of viewLevelElements(model, view)) {
    if (!TAGGABLE.has(el.kind) || ('deleted' in el && el.deleted)) continue
    const p = anchorInView(model, view, { elementId: el.id, anchor: 'mid' })
    if (!p) continue
    const q = toPaper(p)
    const d = Math.hypot(q.x - at.x, q.y - at.y)
    if (d < bestD) {
      best = { elementId: el.id, at: q }
      bestD = d
    }
  }
  if (best) return best
  const areas = floorAreasInView(model, view).filter((a) => a.outlines.some((o) => o.length >= 3 && insidePaper(o.map(toPaper), at)))
  const pick = areas.find((a) => model.elements[a.id]?.kind === 'space') ?? areas[0]
  if (!pick) return null
  const centre = anchorInView(model, view, { elementId: pick.id, anchor: 'insertion' })
  return { elementId: pick.id, at: centre ? toPaper(centre) : at, floor: true }
}

/**
 * A dimension from two paper points, snapped where they land on something: a
 * horizontal or vertical linear dimension when the drag is nearly square to
 * the paper, otherwise aligned. Points it snapped follow their element.
 */
export function dimensionFromDrag(a: { at: Vec2; snap: SnapPoint | null }, b: { at: Vec2; snap: SnapPoint | null }): { dim: DimSpec; paper: [Vec2, Vec2] } {
  const pa = a.snap?.at ?? a.at
  const pb = b.snap?.at ?? b.at
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI) % 180
  const square = angle < 4 || angle > 176 ? 'horizontal' : Math.abs(angle - 90) < 4 ? 'vertical' : null
  const refs = [a.snap?.ref ?? null, b.snap?.ref ?? null]
  const dim: DimSpec = {
    kind: square ? 'linear' : 'aligned',
    ...(square ? { direction: square } : {}),
    ...(refs.some((r) => r) ? { refs } : {}),
    offsetMm: -8,
  }
  return { dim, paper: [pa, pb] }
}

/** A new tag on an element: automatic words, in the default tag style for its kind when one is set. */
export function tagSpecFor(model: ModelState, elementId: string, leader: boolean): TagSpec {
  const el = model.elements[elementId]
  const styleId = el ? defaultTagStyleFor(model, el) : null
  return { elementId, template: 'auto', leader, ...(styleId ? { styleId } : {}) }
}

/**
 * Create similar on a tag: a new tag on `elementId` that looks like `like`
 * (its style, words, leader, background and elbow), so C S then a click tags
 * the next element the same way. A room or space takes no leader of its own
 * (its words sit inside it) unless the tag set one by hand. A style made for another kind of element
 * doesn't carry; the new element's default style does, and the rest still
 * copies.
 */
export function tagSpecLike(model: ModelState, like: TagSpec, elementId: string, opts: { readonly floor: boolean }): TagSpec {
  const el = model.elements[elementId]
  const kind = el ? tagStyleCategoryOf(model, el) : null
  const style = like.styleId ? organizationOf(model).tagStyleById.get(like.styleId) : undefined
  const appliesTo = style?.entry.appliesTo ?? []
  const styleFits = style !== undefined && (appliesTo.length === 0 || (kind !== null && appliesTo.includes(kind)))
  const fallbackStyle = el ? defaultTagStyleFor(model, el) : null
  const styleId = styleFits ? like.styleId : fallbackStyle
  return {
    elementId,
    template: like.template,
    ...(like.fields ? { fields: like.fields } : {}),
    leader: opts.floor ? false : like.leader,
    ...(like.leaderOverride !== undefined ? { leaderOverride: like.leaderOverride } : {}),
    ...(like.mask ? { mask: true } : {}),
    ...(like.textSizeMm !== undefined ? { textSizeMm: like.textSizeMm } : {}),
    ...(styleId ? { styleId } : {}),
    ...(like.elbow !== undefined ? { elbow: 'auto' as const } : {}),
  }
}

/** A tag's spec with its own leader choice: on a styled tag it overrides the style only when it differs from it. */
export function withLeader(model: ModelState, tag: TagSpec, on: boolean): TagSpec {
  const { leaderOverride: _old, ...rest } = tag
  if (!tag.styleId || !tagStyleName(model, tag)) return { ...rest, leader: on }
  const styleSays = tagHasLeader(model, rest)
  return styleSays === on ? rest : { ...rest, leaderOverride: on }
}

/** How far one arrow press moves annotations on paper, mm: 1, or 10 with Shift (paper y runs down). */
export function nudgePaperStep(key: string, shift: boolean): Vec2 | null {
  const d = shift ? 10 : 1
  switch (key) {
    case 'ArrowLeft':
      return { x: -d, y: 0 }
    case 'ArrowRight':
      return { x: d, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -d }
    case 'ArrowDown':
      return { x: 0, y: d }
    default:
      return null
  }
}

export type NudgeCommand = { readonly type: 'update_drawing_item'; readonly itemId: string; readonly points: Vec2[] }

/**
 * The edits that move the picked drawing items by `delta` (stored
 * coordinates: model mm in a view, paper mm on a sheet), or why not. A tag
 * moves its head; the kernel carries a hand-placed elbow with it.
 */
export function nudgeEdits(items: readonly DrawingItem[], ids: readonly string[], delta: Vec2): { readonly ok: true; readonly commands: NudgeCommand[] } | { readonly ok: false; readonly reason: string } {
  const picked = ids.flatMap((id) => {
    const it = items.find((i) => i.id === id)
    return it && !it.deleted ? [it] : []
  })
  if (picked.length === 0) return { ok: false, reason: 'Select a tag, note or line to nudge it with the arrow keys.' }
  if (picked.some((it) => it.pinned)) return { ok: false, reason: "It's pinned. Unpin it first (Modify > Unpin), then nudge it." }
  return { ok: true, commands: picked.map((it) => ({ type: 'update_drawing_item', itemId: it.id, points: it.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) })) }
}

/** Paper box for selecting a tag or a dimension. */
export function annotationBox(model: ModelState, view: ViewElement | null, item: DrawingItem, toPaper: (p: Vec2) => Vec2): { x: number; y: number; w: number; h: number } | null {
  if (item.tag && item.points[0]) {
    const b = tagItemBox(model, view, item, toPaper)
    return b ? { x: b.min.x, y: b.min.y, w: b.max.x - b.min.x, h: b.max.y - b.min.y } : null
  }
  if (item.dim) {
    const pts = dimensionPoints(model, view, item).points.map(toPaper)
    if (pts.length === 0) return null
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const pad = Math.abs(item.dim.offsetMm) + 3
    const horizontal = item.dim.kind === 'linear' && item.dim.direction !== 'vertical'
    const vertical = item.dim.kind === 'linear' && item.dim.direction === 'vertical'
    return {
      x: Math.min(...xs) - (vertical ? pad : 1),
      y: Math.min(...ys) - (horizontal ? pad : 1),
      w: Math.max(...xs) - Math.min(...xs) + (vertical ? pad * 2 : 2),
      h: Math.max(...ys) - Math.min(...ys) + (horizontal ? pad * 2 : 2),
    }
  }
  return null
}
