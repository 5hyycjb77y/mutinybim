import {
  anchorInView,
  dimensionPoints,
  defaultTagStyleFor,
  elementsOfKind,
  hostAreaOutlinesInView,
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

const TAGGABLE = new Set(['run_segment', 'duct_segment', 'terminal', 'equipment', 'part', 'opening'])

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

/** Rooms and spaces this view shows: floor polygons in plans/RCPs, and exact sliced room rectangles in sections/elevations. */
function floorAreasInView(model: ModelState, view: ViewElement): Array<{ readonly id: string; readonly outlines: ReadonlyArray<readonly Vec2[]> }> {
  if (view.viewType !== 'floor_plan' && view.viewType !== 'ceiling_plan' && view.viewType !== 'section' && view.viewType !== 'elevation') return []
  const out: Array<{ readonly id: string; readonly outlines: ReadonlyArray<readonly Vec2[]> }> = []
  const seen = new Set<string>()
  for (const el of viewLevelElements(model, view)) {
    if (el.kind === 'room' && !('deleted' in el && el.deleted)) {
      const outlines = hostAreaOutlinesInView(model, view, el)
      if (outlines.length > 0) {
        out.push({ id: el.id, outlines })
        seen.add(el.id)
      }
    }
  }
  const levelName = view.props?.level
  const isVertical = view.viewType === 'section' || view.viewType === 'elevation'
  for (const space of elementsOfKind(model.elements, 'space')) {
    if (seen.has(space.id)) continue
    if (!isVertical) {
      const level = space.levelId ? model.elements[space.levelId] : undefined
      if (levelName === undefined || level?.kind !== 'level' || level.name !== levelName) continue
    }
    const outlines = hostAreaOutlinesInView(model, view, space)
    if (outlines.length > 0) out.push({ id: space.id, outlines })
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

/** A model-graphics snap target on paper: either an exact corner/intersection or a projection along a wall face / grid line. */
export interface GraphicsSnapHit {
  readonly at: Vec2
  readonly label: string
  readonly kind: 'corner' | 'intersection' | 'edge' | 'ortho'
  readonly guideLine?: readonly [Vec2, Vec2]
}

export interface GraphicsSnapIndex {
  readonly points: readonly { readonly at: Vec2; readonly label: string; readonly kind: 'corner' | 'intersection' }[]
  readonly segments: readonly { readonly a: Vec2; readonly b: Vec2; readonly label: string }[]
}

function lineIntersection2(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dx1 = a2.x - a1.x
  const dy1 = a2.y - a1.y
  const dx2 = b2.x - b1.x
  const dy2 = b2.y - b1.y
  const denom = dx1 * dy2 - dy1 * dx2
  if (Math.abs(denom) < 1e-6) return null
  const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom
  const u = ((b1.x - a1.x) * dy1 - (b1.y - a1.y) * dx1) / denom
  if (t < -0.02 || t > 1.02 || u < -0.02 || u > 1.02) return null
  return { x: a1.x + t * dx1, y: a1.y + t * dy1 }
}

function projectPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { readonly at: Vec2; readonly dist: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return { at: a, dist: Math.hypot(p.x - a.x, p.y - a.y) }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  const at = { x: a.x + t * dx, y: a.y + t * dy }
  return { at, dist: Math.hypot(p.x - at.x, p.y - at.y) }
}

/**
 * Build a paper-space graphics snap index for a view: wall exterior & interior
 * face corners and face segments, structural grid lines and grid intersections,
 * plus column/opening/part corners so callout boundaries and P-lines snap
 * cleanly to real architectural & MEP graphics (Revit behavior).
 */
export function buildGraphicsSnapIndex(model: ModelState, view: ViewElement, toPaper: (p: Vec2) => Vec2): GraphicsSnapIndex {
  const points: { at: Vec2; label: string; kind: 'corner' | 'intersection' }[] = []
  const segments: { a: Vec2; b: Vec2; label: string }[] = []
  const grids: { a: Vec2; b: Vec2; label: string }[] = []

  for (const el of viewLevelElements(model, view)) {
    if ('deleted' in el && el.deleted) continue
    if (el.kind === 'wall') {
      const dx = el.end.x - el.start.x
      const dy = el.end.y - el.start.y
      const len = Math.hypot(dx, dy)
      if (len < 1) continue
      const half = (el.thickness || 150) / 2
      const nx = (-dy / len) * half
      const ny = (dx / len) * half
      const c0 = toPaper({ x: el.start.x + nx, y: el.start.y + ny })
      const c1 = toPaper({ x: el.end.x + nx, y: el.end.y + ny })
      const c2 = toPaper({ x: el.end.x - nx, y: el.end.y - ny })
      const c3 = toPaper({ x: el.start.x - nx, y: el.start.y - ny })
      const sC = toPaper(el.start)
      const eC = toPaper(el.end)
      points.push(
        { at: c0, label: 'wall corner', kind: 'corner' },
        { at: c1, label: 'wall corner', kind: 'corner' },
        { at: c2, label: 'wall corner', kind: 'corner' },
        { at: c3, label: 'wall corner', kind: 'corner' },
        { at: sC, label: 'wall centerline end', kind: 'corner' },
        { at: eC, label: 'wall centerline end', kind: 'corner' },
      )
      segments.push(
        { a: c0, b: c1, label: 'wall face' },
        { a: c3, b: c2, label: 'wall face' },
        { a: c0, b: c3, label: 'wall end face' },
        { a: c1, b: c2, label: 'wall end face' },
        { a: sC, b: eC, label: 'wall centerline' },
      )
    } else if (el.kind === 'grid') {
      const a = toPaper(el.start)
      const b = toPaper(el.end)
      grids.push({ a, b, label: `grid ${el.label}` })
      segments.push({ a, b, label: `grid ${el.label}` })
      points.push({ at: a, label: `grid ${el.label} end`, kind: 'corner' }, { at: b, label: `grid ${el.label} end`, kind: 'corner' })
    } else if (el.kind === 'column') {
      const hw = (el.size.x || 300) / 2
      const hd = (el.size.y || 300) / 2
      const c0 = toPaper({ x: el.position.x - hw, y: el.position.y - hd })
      const c1 = toPaper({ x: el.position.x + hw, y: el.position.y - hd })
      const c2 = toPaper({ x: el.position.x + hw, y: el.position.y + hd })
      const c3 = toPaper({ x: el.position.x - hw, y: el.position.y + hd })
      points.push(
        { at: c0, label: 'column corner', kind: 'corner' },
        { at: c1, label: 'column corner', kind: 'corner' },
        { at: c2, label: 'column corner', kind: 'corner' },
        { at: c3, label: 'column corner', kind: 'corner' },
      )
      segments.push(
        { a: c0, b: c1, label: 'column face' },
        { a: c1, b: c2, label: 'column face' },
        { a: c2, b: c3, label: 'column face' },
        { a: c3, b: c0, label: 'column face' },
      )
    } else if (el.kind === 'opening' || el.kind === 'part') {
      const p = anchorInView(model, view, { elementId: el.id, anchor: 'mid' })
      if (p) points.push({ at: toPaper(p), label: el.kind === 'opening' ? el.openingType : 'part', kind: 'corner' })
    }
  }

  // Exact structural grid intersections + perpendicular wall-face intersections
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const hit = lineIntersection2(grids[i]!.a, grids[i]!.b, grids[j]!.a, grids[j]!.b)
      if (hit) points.push({ at: hit, label: 'grid intersection', kind: 'intersection' })
    }
  }
  // Wall-face corner intersections (e.g. L/T wall joints where two wall faces meet)
  const wallFaces = segments.filter((s) => s.label === 'wall face')
  if (wallFaces.length <= 240) {
    for (let i = 0; i < wallFaces.length; i++) {
      for (let j = i + 1; j < wallFaces.length; j++) {
        const hit = lineIntersection2(wallFaces[i]!.a, wallFaces[i]!.b, wallFaces[j]!.a, wallFaces[j]!.b)
        if (hit) points.push({ at: hit, label: 'wall face intersection', kind: 'intersection' })
      }
    }
  }
  return { points, segments }
}

/**
 * Snap a paper point `at` to real model graphics (wall corners/intersections,
 * grid intersections, wall face lines, grid lines) plus optional orthogonal
 * alignment against reference vertices (for clean 90° L-shapes and P-lines).
 */
export function snapToGraphics(
  index: GraphicsSnapIndex | null,
  at: Vec2,
  reachMm: number,
  opts?: {
    /** Reference vertices for 90° orthogonal alignment tracking (e.g. adjacent/start P-line corners). */
    readonly alignRefs?: readonly Vec2[]
    /** Restrict movement strictly along X or Y (e.g. single-edge drag or Shift/Ortho lock). */
    readonly lockAxis?: 'x' | 'y' | null
    /** Previous vertex when Ortho mode (F8 / Shift) is active. */
    readonly orthoFrom?: Vec2 | null
  },
): GraphicsSnapHit | null {
  const alignRefs = opts?.alignRefs ?? []
  const lockAxis = opts?.lockAxis ?? null

  // Optional ortho projection when Shift/Ortho is active from a prior vertex
  let query = at
  let orthoGuide: readonly [Vec2, Vec2] | undefined
  if (opts?.orthoFrom && !lockAxis) {
    const dx = Math.abs(at.x - opts.orthoFrom.x)
    const dy = Math.abs(at.y - opts.orthoFrom.y)
    if (dx >= dy) {
      query = { x: at.x, y: opts.orthoFrom.y }
      orthoGuide = [opts.orthoFrom, query]
    } else {
      query = { x: opts.orthoFrom.x, y: at.y }
      orthoGuide = [opts.orthoFrom, query]
    }
  }

  // 1. Exact corner / intersection snap
  if (index) {
    let bestPt: { at: Vec2; label: string; kind: 'corner' | 'intersection'; d: number } | null = null
    for (const p of index.points) {
      const d = lockAxis === 'x' ? Math.abs(p.at.x - query.x) : lockAxis === 'y' ? Math.abs(p.at.y - query.y) : Math.hypot(p.at.x - query.x, p.at.y - query.y)
      // When locked to a single axis (dragging an edge), only snap to points near the edge's span
      if (lockAxis === 'x' && Math.abs(p.at.y - query.y) > reachMm * 8) continue
      if (lockAxis === 'y' && Math.abs(p.at.x - query.x) > reachMm * 8) continue
      if (d <= reachMm && (!bestPt || d < bestPt.d - 0.05 || (Math.abs(d - bestPt.d) <= 0.05 && p.kind === 'intersection' && bestPt.kind !== 'intersection'))) {
        bestPt = { ...p, d }
      }
    }
    if (bestPt) {
      const snapped = lockAxis === 'x' ? { x: bestPt.at.x, y: query.y } : lockAxis === 'y' ? { x: query.x, y: bestPt.at.y } : bestPt.at
      return { at: snapped, label: bestPt.label, kind: bestPt.kind, ...(orthoGuide ? { guideLine: [opts!.orthoFrom!, snapped] } : {}) }
    }
  }

  // 2. Check alignment to adjacent/start P-line vertices (horizontal or vertical tracking!)
  let bestAlignX: { ref: Vec2; d: number } | null = null
  let bestAlignY: { ref: Vec2; d: number } | null = null
  if (!lockAxis) {
    for (const ref of alignRefs) {
      const dx = Math.abs(query.x - ref.x)
      const dy = Math.abs(query.y - ref.y)
      if (dx <= reachMm && (!bestAlignX || dx < bestAlignX.d)) bestAlignX = { ref, d: dx }
      if (dy <= reachMm && (!bestAlignY || dy < bestAlignY.d)) bestAlignY = { ref, d: dy }
    }
  }

  // 3. Nearest point on a wall face or grid line (combining with alignment axis if both hit!)
  if (index) {
    let bestSeg: { at: Vec2; label: string; d: number } | null = null
    const probe = {
      x: bestAlignX ? bestAlignX.ref.x : query.x,
      y: bestAlignY ? bestAlignY.ref.y : query.y,
    }
    for (const seg of index.segments) {
      const proj = projectPointOnSegment(probe, seg.a, seg.b)
      if (proj.dist <= reachMm && (!bestSeg || proj.dist < bestSeg.d)) {
        bestSeg = { at: proj.at, label: seg.label, d: proj.dist }
      }
    }
    if (bestSeg) {
      const snapped = lockAxis === 'x' ? { x: bestSeg.at.x, y: query.y } : lockAxis === 'y' ? { x: query.x, y: bestSeg.at.y } : bestSeg.at
      const guide = bestAlignX
        ? ([bestAlignX.ref, snapped] as const)
        : bestAlignY
          ? ([bestAlignY.ref, snapped] as const)
          : orthoGuide
            ? ([opts!.orthoFrom!, snapped] as const)
            : undefined
      return { at: snapped, label: bestSeg.label, kind: 'edge', ...(guide ? { guideLine: guide } : {}) }
    }
  }

  // 4. Pure alignment / ortho snap when no graphic is under the pointer
  if (bestAlignX || bestAlignY) {
    const snapped = {
      x: bestAlignX ? bestAlignX.ref.x : query.x,
      y: bestAlignY ? bestAlignY.ref.y : query.y,
    }
    const ref = bestAlignX && (!bestAlignY || bestAlignX.d <= bestAlignY.d) ? bestAlignX.ref : bestAlignY!.ref
    return { at: snapped, label: 'square alignment', kind: 'ortho', guideLine: [ref, snapped] }
  }
  if (orthoGuide) {
    return { at: query, label: 'ortho 90°', kind: 'ortho', guideLine: orthoGuide }
  }
  return null
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
    const spec = item.dim
    const [p0, p1] = pts
    if (p0 && p1 && (spec.kind === 'linear' || spec.kind === 'aligned')) {
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const dist = Math.hypot(dx, dy) || 1
      const axis = spec.kind === 'aligned' ? { x: dx / dist, y: dy / dist } : spec.direction === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 }
      const n = { x: -axis.y, y: axis.x }
      const lineAt = (p: Vec2) => {
        const along = (p.x - p0.x) * axis.x + (p.y - p0.y) * axis.y
        return { x: p0.x + axis.x * along + n.x * spec.offsetMm, y: p0.y + axis.y * along + n.y * spec.offsetMm }
      }
      const a2 = lineAt(p0)
      const b2 = lineAt(p1)
      const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 }
      const vertical = Math.abs(axis.x) < 0.3
      const side = n.x * (spec.offsetMm >= 0 ? 1 : -1) >= 0 ? 1 : -1
      // Tight band around the actual dimension line + its text label so clicking the dimension
      // selects it immediately without creating a giant invisible box over surrounding geometry.
      const labelHalfW = Math.max(8, ((spec.prefix?.length ?? 0) + (spec.suffix?.length ?? 0) + 6) * 1.4)
      const xs = [a2.x, b2.x, ...(vertical ? [mid.x + side * (labelHalfW * 1.6)] : [mid.x - labelHalfW, mid.x + labelHalfW])]
      const ys = [a2.y, b2.y, ...(vertical ? [mid.y - 3, mid.y + 3] : [mid.y - 5.5, mid.y + 2.5])]
      const minX = Math.min(...xs) - 2
      const maxX = Math.max(...xs) + 2
      const minY = Math.min(...ys) - 2
      const maxY = Math.max(...ys) + 2
      return { x: minX, y: minY, w: Math.max(4, maxX - minX), h: Math.max(4, maxY - minY) }
    }
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const pad = Math.max(4, Math.abs(spec.offsetMm) + 3)
    return {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    }
  }
  return null
}
