import {
  DETAIL_COMPONENTS,
  DRAFTING_SCHEMA_VERSION,
  draftingVersionOf,
  detailComponents,
  chainLines,
  detailComponent,
  detailSnap,
  polygonLines,
  trackAngle,
  type BatchCommand,
  type DimSpec,
  type DimensionKind,
  type DrawingItem,
  type DrawingShape,
  type HatchPattern,
  type LinePattern,
  type LineWeight2D,
  type ModifyOp,
  type SnapKind,
  type Vec2,
  type ViewCommand,
} from '@permitzip/bim-kernel'
import type { SnapPoint } from '../annotation-tools'

/**
 * The Draft tools' state machine, pure: what each click means for the tool or
 * modify operation in hand, where a click snaps or tracks to, the prompt to
 * show, and the kernel command it ends in. The canvas forwards its pointer and
 * key events here (no listeners of its own) and sends what comes back.
 *
 * Points are paper mm while collecting; `toStored` turns them into the owner's
 * coordinates (model mm in a view, paper mm on a sheet) for the command.
 */

export interface DraftSettings {
  readonly weight: LineWeight2D
  readonly pattern: LinePattern
  readonly hatch: HatchPattern
  /** The Region tool draws a masking region (white, no outline) instead of a hatch. */
  readonly masking: boolean
  readonly symbolId: string
  /** Typed values: batt thickness, component size, repeat spacing; inches, or feet-inches like 2'-6". */
  readonly battThickness: string
  readonly snaps: readonly SnapKind[]
  /** Square to the paper (F8). */
  readonly ortho: boolean
  /** Polar tracking increment in degrees, or off. */
  readonly polarDeg: number | null
  readonly dimKind: DimensionKind
  readonly dimChain: 'single' | 'continuous' | 'baseline'
  /** Polygon: how many sides (3 to 64), and whether the clicked point is a corner (inscribed) or the middle of a side (circumscribed). */
  readonly polygonSides: string
  readonly polygonInscribed: boolean
}

export const DEFAULT_DRAFT_SETTINGS: DraftSettings = {
  weight: 'medium',
  pattern: 'solid',
  hatch: 'diagonal',
  masking: false,
  symbolId: DETAIL_COMPONENTS[0]?.id ?? 'gate_valve',
  battThickness: '2"',
  snaps: ['endpoint', 'midpoint', 'center', 'intersection', 'perpendicular'],
  ortho: false,
  polarDeg: null,
  dimKind: 'linear',
  dimChain: 'single',
  polygonSides: '6',
  polygonInscribed: true,
}

/** Typed values for the modify operation in hand. */
export interface ModifyParams {
  readonly angle: string
  readonly factor: string
  readonly count: string
  readonly distance: string
  readonly copy: boolean
  /** Offset: a typed distance, or two clicks that show it (graphical). */
  readonly offsetMode: 'numerical' | 'graphical'
  /** Offset leaves the original and adds the parallel copy (unchecked: the original moves). */
  readonly offsetCopy: boolean
  /** Split Element: a second click on the same line, and the piece between the two is deleted. */
  readonly deleteInner: boolean
  /** Split with Gap: the gap's length. */
  readonly gap: string
  /** Fillet Arc: the arc's radius. */
  readonly arcRadius: string
}

export const DEFAULT_MODIFY_PARAMS: ModifyParams = { angle: '90', factor: '2', count: '3', distance: '6"', copy: false, offsetMode: 'numerical', offsetCopy: true, deleteInner: false, gap: '1"', arcRadius: '6"' }

export const MODIFY_OPS = [
  'move',
  'copy',
  'rotate',
  'mirror',
  'scale',
  'array',
  'polar_array',
  'align',
  'offset',
  'trim_extend_corner',
  'trim_extend_single',
  'trim_extend_multiple',
  'split',
  'split_gap',
  'fillet_arc',
  'pin',
  'unpin',
] as const
export type ModifyOpName = (typeof MODIFY_OPS)[number]

/**
 * Operations you start with nothing selected and then click the elements
 * (BIM drafting-view conventions): the clicks name the lines, and the tool
 * stays in hand for the next ones until Esc.
 */
export const PICK_ELEMENT_OPS: ReadonlySet<ModifyOpName> = new Set<ModifyOpName>(['trim_extend_corner', 'trim_extend_single', 'trim_extend_multiple', 'split', 'split_gap', 'fillet_arc'])

/** Something waiting for clicks besides a drawing tool: a modify operation, or a leader for a note. */
export type DraftPending = { readonly kind: 'modify'; readonly op: ModifyOpName } | { readonly kind: 'leader'; readonly noteId: string; readonly elbow: boolean } | null

export const MODIFY_LABEL: Record<ModifyOpName, string> = {
  move: 'Move',
  copy: 'Copy',
  rotate: 'Rotate',
  mirror: 'Mirror',
  scale: 'Scale',
  array: 'Array',
  polar_array: 'Radial array',
  align: 'Align',
  offset: 'Offset',
  trim_extend_corner: 'Trim/Extend to Corner',
  trim_extend_single: 'Trim/Extend Single',
  trim_extend_multiple: 'Trim/Extend Multiple',
  split: 'Split Element',
  split_gap: 'Split with Gap',
  fillet_arc: 'Fillet Arc',
  pin: 'Pin',
  unpin: 'Unpin',
}

/** What each pick of a modify operation is, in order. An empty list runs on the typed values alone. */
export const MODIFY_PICKS: Record<ModifyOpName, readonly string[]> = {
  move: ['Click the base point', 'Click where it goes'],
  copy: ['Click the base point', 'Click where the copy goes'],
  rotate: ['Click the centre to turn about'],
  mirror: ['Click the first point of the mirror line', 'Click the second point of the mirror line'],
  scale: ['Click the base point that stays put'],
  array: ['Click the base point', 'Click where the next copy goes'],
  polar_array: ['Click the centre of the array'],
  align: ['Click the point on the selection to line up', 'Click the first point of the line to align to', 'Click the second point of that line'],
  offset: ['Click the side to offset to'],
  trim_extend_corner: ['Click the first line or arc, on the part to keep', 'Click the second, on the part to keep'],
  trim_extend_single: ['Click the boundary to trim or extend to', 'Click the line or arc to trim or extend, on the part to keep'],
  trim_extend_multiple: ['Click the boundary to trim or extend to', 'Click each line or arc to trim or extend, on the part to keep'],
  split: ['Click the line or arc where it splits'],
  split_gap: ['Click the line or arc where the gap goes'],
  fillet_arc: ['Click the first line', 'Click the second line'],
  pin: [],
  unpin: [],
}

/** The picks an operation takes with these values (Split with Delete inner segment takes a second click; graphical Offset two). */
export function modifyPicks(op: ModifyOpName, params: Pick<ModifyParams, 'deleteInner' | 'offsetMode'>): readonly string[] {
  if (op === 'split' && params.deleteInner) return ['Click the line or arc at the first split', 'Click it again at the second split (the piece between goes)']
  if (op === 'offset' && params.offsetMode === 'graphical') return ['Click a point to measure the offset from', 'Click where the offset goes']
  return MODIFY_PICKS[op]
}

/** Which picks name an element rather than a point. */
const ITEM_PICKS: Partial<Record<ModifyOpName, readonly number[]>> = {
  trim_extend_corner: [0, 1],
  trim_extend_single: [0, 1],
  trim_extend_multiple: [0, 1],
  split: [0, 1],
  split_gap: [0],
  fillet_arc: [0, 1],
}

/** UI-only drawing tools: a polygon is drawn as joined lines, not stored as its own shape. */
export type DraftToolShape = DrawingShape | 'polygon'
export const DRAFT_SHAPES = ['arc', 'circle', 'polyline', 'polygon', 'spline', 'region', 'component', 'repeat', 'batt'] as const satisfies readonly DraftToolShape[]
export type DraftShape = (typeof DRAFT_SHAPES)[number]
export function isDraftShape(tool: string): tool is DraftShape {
  return (DRAFT_SHAPES as readonly string[]).includes(tool)
}

/** Dimension kinds the click flow draws (linear and aligned single dimensions are a drag). */
export function clickDimension(s: Pick<DraftSettings, 'dimKind' | 'dimChain'>): boolean {
  return !((s.dimKind === 'linear' || s.dimKind === 'aligned') && s.dimChain === 'single')
}

/** Clicks a tool takes: a number, or 'open' (Enter or double-click finishes; min clicks). */
export function clicksFor(tool: DraftShape | 'dimension', s: Pick<DraftSettings, 'dimKind' | 'dimChain'>): { readonly fixed: number } | { readonly min: number } {
  switch (tool) {
    case 'component':
      return { fixed: 1 }
    case 'circle':
    case 'polygon':
    case 'repeat':
    case 'batt':
      return { fixed: 2 }
    case 'arc':
      return { fixed: 3 }
    case 'polyline':
    case 'spline':
      return { min: 2 }
    case 'region':
      return { min: 3 }
    case 'dimension':
      if (s.dimKind === 'angular' || s.dimKind === 'arc_length') return { fixed: 3 }
      if (s.dimKind === 'radial' || s.dimKind === 'diameter' || s.dimKind === 'spot_elevation' || s.dimKind === 'spot_coordinate') return { fixed: 2 }
      return { min: 2 }
  }
}

const SHAPE_PROMPTS: Record<DraftShape, readonly string[]> = {
  arc: ['Click the centre of the arc', 'Click where the arc starts', 'Click where it ends (counter-clockwise)'],
  circle: ['Click the centre', 'Click a point on the circle'],
  polyline: ['Click the first point', 'Click the next point. Each segment is its own line, joined to the last. Click the first point again to close, or Enter to finish'],
  polygon: ['Click the centre', 'Click a corner (or the middle of a side, circumscribed)'],
  spline: ['Click the first point', 'Click the next point. Enter or double-click finishes'],
  region: ['Click the first corner', 'Click the next corner', 'Click the next corner. Enter or double-click closes it'],
  component: ['Click where the component goes (its bottom-left corner)'],
  repeat: ['Click where the repeat starts', 'Click where it ends'],
  batt: ['Click where the insulation starts', 'Click where it ends'],
}

const DIM_PROMPTS: Partial<Record<DimensionKind, readonly string[]>> = {
  angular: ['Click the corner the angle opens from', 'Click a point on the first side', 'Click a point on the second side'],
  arc_length: ['Click the arc centre', 'Click where the arc starts', 'Click where it ends'],
  radial: ['Click the centre (or an arc or circle)', 'Click a point on the curve'],
  diameter: ['Click the centre (or an arc or circle)', 'Click a point on the curve'],
  spot_elevation: ['Click the point to label', 'Click where the label goes'],
  spot_coordinate: ['Click the point to label', 'Click where the label goes'],
}

export function shapePrompt(tool: DraftShape | 'dimension', s: Pick<DraftSettings, 'dimKind' | 'dimChain'>, clicks: number): string {
  const list = tool === 'dimension' ? (DIM_PROMPTS[s.dimKind] ?? ['Click the first point', 'Click the next point. Enter or double-click finishes']) : SHAPE_PROMPTS[tool]
  return `${list[Math.min(clicks, list.length - 1)] ?? ''}. Esc cancels.`
}

export function modifyPrompt(op: ModifyOpName, picks: number, selected: number, params: Pick<ModifyParams, 'deleteInner' | 'offsetMode'> = DEFAULT_MODIFY_PARAMS): string {
  const list = modifyPicks(op, params)
  if (PICK_ELEMENT_OPS.has(op)) {
    const step = list[Math.min(picks, list.length - 1)] ?? ''
    return `${MODIFY_LABEL[op]}: ${step.charAt(0).toLowerCase()}${step.slice(1)}. Esc finishes.`
  }
  if (selected === 0) return `${MODIFY_LABEL[op]}: select drawn items first (Shift+click adds more), then pick ${MODIFY_LABEL[op]} again.`
  return `${MODIFY_LABEL[op]} ${selected} item${selected === 1 ? '' : 's'}: ${(list[picks] ?? 'Press Apply').toLowerCase()}. Esc cancels.`
}

/** Inches, feet-inches (2'-6", 2' 6", 1.5'), or millimetres ("150mm") → mm; null when it isn't a length. */
export function parseLength(text: string): number | null {
  const mm = parseLengthRaw(text)
  return mm === null ? null : Math.round(mm * 1e6) / 1e6
}

/** Inches with an optional fraction: 6, 1.5, 3/4, 1-1/2, 1 1/2. */
function inches(t: string): number | null {
  const m = /^(\d+(?:\.\d+)?)?(?:(?:^|\s+|-)(\d+)\/(\d+))?$/.exec(t.trim())
  if (!m || (!m[1] && !m[2])) return null
  const whole = m[1] ? Number(m[1]) : 0
  const frac = m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0
  return Number.isFinite(frac) ? whole + frac : null
}

function parseLengthRaw(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s*(?:"|in)$/, '')
  if (!t) return null
  const neg = t.startsWith('-') ? -1 : 1
  const body = neg < 0 ? t.slice(1) : t
  const mm = /^(\d+(?:\.\d+)?)\s*mm$/.exec(body)
  if (mm?.[1]) return neg * Number(mm[1])
  const ft = /^(\d+(?:\.\d+)?)\s*'\s*-?\s*(.*)$/.exec(body)
  if (ft?.[1] !== undefined) {
    const rest = ft[2]?.trim() ?? ''
    const inch = rest ? inches(rest) : 0
    return inch === null ? null : neg * (Number(ft[1]) * 12 + inch) * 25.4
  }
  const inch = inches(body)
  return inch === null ? null : neg * inch * 25.4
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })

export interface Constrained {
  readonly at: Vec2
  /** What it snapped to, in words, for the marker's tooltip and the hint. */
  readonly snapLabel: string | null
  /** A dimension point's element / item it follows. */
  readonly snapRef: SnapPoint['ref'] | null
  /** The tracking line drawn from the last point, when tracking. */
  readonly tracking: { readonly from: Vec2; readonly angleDeg: number } | null
  /** The drawn item under the snap, if any (trim / extend boundaries, radial dimensions). */
  readonly itemId: string | null
}

const SNAP_WORDS: Record<SnapKind, string> = { endpoint: 'endpoint', midpoint: 'midpoint', center: 'centre', intersection: 'intersection', perpendicular: 'perpendicular', nearest: 'nearest point' }

/**
 * Where a click lands: a model / dimension snap point first (it is followed),
 * then a detail-linework snap, then ortho or polar tracking from the last
 * point, else the pointer.
 */
export function constrainPoint(input: {
  readonly at: Vec2
  readonly from: Vec2 | null
  readonly items: readonly DrawingItem[]
  readonly toPaper: (p: Vec2) => Vec2
  readonly settings: Pick<DraftSettings, 'snaps' | 'ortho' | 'polarDeg'>
  readonly reachMm: number
  /** Points dimensions follow (model ends and edges), when a dimension is being drawn. */
  readonly anchors?: readonly SnapPoint[]
  /** Also snap to the nearest point on a line (picking a trim / extend boundary). */
  readonly nearest?: boolean
  /** Picking an element: only the nearest point on a line counts (an endpoint snap at a corner would name either line). */
  readonly pickElement?: boolean
  /** Degrees counter-clockwise from paper-right that ortho and polar steps start from: the working angle on paper. Absent: 0. */
  readonly trackBaseDeg?: number
}): Constrained {
  const { at, from, settings, reachMm } = input
  let bestAnchor: SnapPoint | null = null
  let bestD = reachMm
  for (const a of input.anchors ?? []) {
    const d = Math.hypot(a.at.x - at.x, a.at.y - at.y)
    if (d < bestD) {
      bestAnchor = a
      bestD = d
    }
  }
  if (input.pickElement) {
    const snap = detailSnap(input.items, input.toPaper, at, { kinds: new Set<SnapKind>(['nearest']), reachMm })
    return snap ? { at: snap.at, snapLabel: SNAP_WORDS.nearest, snapRef: null, tracking: null, itemId: snap.itemId } : { at, snapLabel: null, snapRef: null, tracking: null, itemId: null }
  }
  if (bestAnchor) return { at: bestAnchor.at, snapLabel: bestAnchor.label, snapRef: bestAnchor.ref, tracking: null, itemId: input.items.some((i) => i.id === bestAnchor.ref.elementId) ? bestAnchor.ref.elementId : null }
  const kinds = new Set<SnapKind>(settings.snaps)
  if (input.nearest) kinds.add('nearest')
  if (kinds.size > 0) {
    const snap = detailSnap(input.items, input.toPaper, at, { kinds, reachMm, ...(from ? { from } : {}) })
    if (snap) return { at: snap.at, snapLabel: SNAP_WORDS[snap.kind], snapRef: null, tracking: null, itemId: snap.itemId }
  }
  if (from && (settings.ortho || settings.polarDeg)) {
    const t = trackFrom(from, at, settings.ortho ? 90 : (settings.polarDeg ?? 90), input.trackBaseDeg ?? 0)
    if (t) return { at: t.at, snapLabel: null, snapRef: null, tracking: { from, angleDeg: t.angleDeg }, itemId: null }
  }
  return { at, snapLabel: null, snapRef: null, tracking: null, itemId: null }
}

/** Paper y runs down: turning counter-clockwise by `deg` on screen. */
function turnPaper(v: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180
  return { x: v.x * Math.cos(a) + v.y * Math.sin(a), y: -v.x * Math.sin(a) + v.y * Math.cos(a) }
}

/** Ortho / polar tracking whose steps start from `baseDeg` (the working angle on paper) instead of paper-right. */
export function trackFrom(from: Vec2, at: Vec2, incrementDeg: number, baseDeg: number): { at: Vec2; angleDeg: number } | null {
  if (baseDeg === 0) return trackAngle(from, at, incrementDeg)
  const local = turnPaper(sub(at, from), -baseDeg)
  const t = trackAngle({ x: 0, y: 0 }, local, incrementDeg)
  if (!t) return null
  const back = turnPaper(t.at, baseDeg)
  return { at: { x: from.x + back.x, y: from.y + back.y }, angleDeg: (((t.angleDeg + baseDeg) % 360) + 360) % 360 }
}

/** The add command for a finished drawing-tool shape, or why it can't be drawn. */
export function shapeCommand(input: {
  readonly tool: DraftShape
  readonly paper: readonly Vec2[]
  readonly settings: DraftSettings
  readonly toStored: (p: Vec2) => Vec2
  /** Paper mm → stored length (× view scale in a view, 1 on a sheet). */
  readonly storedPerPaperMm: number
  readonly ownerId: string
  readonly itemId: string
}): ViewCommand | BatchCommand | string {
  const { tool, paper, settings, toStored, ownerId, itemId } = input
  const pts = paper.map(toStored)
  const lineStyle = settings.weight !== 'medium' || settings.pattern !== 'solid' ? { lineStyle: { ...(settings.weight !== 'medium' ? { weight: settings.weight } : {}), ...(settings.pattern !== 'solid' ? { pattern: settings.pattern } : {}) } } : {}
  const base = { type: 'add_drawing_item' as const, itemId, ownerId, ...lineStyle }
  const symbol = detailComponent(settings.symbolId)
  const joined = (sides: ReadonlyArray<readonly [Vec2, Vec2]>, label: string): BatchCommand => ({
    type: 'batch_documents',
    label,
    commands: sides.map(([p, q], k) => ({ ...base, itemId: `${itemId}-${k}`, shape: 'line' as const, points: [p, q] })),
  })
  switch (tool) {
    case 'arc':
      return { ...base, shape: 'arc', points: pts.slice(0, 3), ccw: true }
    case 'circle':
      return { ...base, shape: 'circle', points: pts.slice(0, 2) }
    case 'polyline': {
      // Joined detail lines, one per segment; landing back on the first point closes the chain.
      if (pts.length < 2) return 'Click at least two points.'
      const firstPaper = paper[0]
      const lastPaper = paper[paper.length - 1]
      const closes = paper.length >= 4 && firstPaper && lastPaper && Math.hypot(lastPaper.x - firstPaper.x, lastPaper.y - firstPaper.y) < 0.3
      const sides = chainLines(closes ? pts.slice(0, -1) : pts, Boolean(closes))
      return sides.length > 0 ? joined(sides, closes ? 'Draw a closed chain of lines' : 'Draw a chain of lines') : 'Click at least two different points.'
    }
    case 'polygon': {
      const sides = Number(settings.polygonSides)
      if (!Number.isInteger(sides) || sides < 3 || sides > 64) return `Type the number of sides, 3 to 64 ("${settings.polygonSides}" isn't).`
      const [center, corner] = pts
      if (!center || !corner || Math.hypot(corner.x - center.x, corner.y - center.y) < 1e-6) return 'Click the centre, then a corner away from it.'
      return joined(polygonLines(center, corner, sides, settings.polygonInscribed), `Draw a ${sides}-sided polygon`)
    }
    case 'spline':
      return pts.length >= 2 ? { ...base, shape: tool, points: pts } : 'Click at least two points.'
    case 'region':
      if (pts.length < 3) return 'A region needs three corners or more.'
      return { ...base, shape: 'region', points: pts, fill: settings.masking ? { pattern: 'solid', masking: true } : { pattern: settings.hatch } }
    case 'component':
      if (!symbol) return 'Pick a component from the library first.'
      return { ...base, shape: 'component', points: pts.slice(0, 1), component: { symbolId: symbol.id } }
    case 'repeat':
      if (!symbol) return 'Pick a component from the library first.'
      return { ...base, shape: 'repeat', points: pts.slice(0, 2), component: { symbolId: symbol.id } }
    case 'batt': {
      const thickness = parseLength(settings.battThickness)
      if (!thickness || thickness <= 0) return `Type the insulation thickness (like 2" or 50mm); "${settings.battThickness}" isn't a length.`
      // A typed thickness is the real one in a view (model inches), or paper inches on a sheet.
      return { ...base, shape: 'batt', points: pts.slice(0, 2), batt: { thicknessMm: thickness } }
    }
  }
}

/** A dimension from clicked points (and what each snapped to), for every kind but a single linear / aligned drag. */
export function dimensionCommand(input: {
  readonly paper: readonly Constrained[]
  readonly settings: Pick<DraftSettings, 'dimKind' | 'dimChain'>
  readonly toStored: (p: Vec2) => Vec2
  readonly items: readonly DrawingItem[]
  readonly ownerId: string
  readonly itemId: string
}): ViewCommand | string {
  const { paper, settings, toStored, ownerId, itemId } = input
  const kind = settings.dimKind
  const refs = paper.map((c) => c.snapRef)
  let points = paper.map((c) => c.at)
  let dimRefs = refs
  if (kind === 'radial' || kind === 'diameter') {
    // A first click on an arc or circle measures it from its centre.
    const curve = paper[0]?.itemId ? input.items.find((i) => i.id === paper[0]?.itemId && (i.shape === 'arc' || i.shape === 'circle')) : undefined
    if (curve && paper[1]) {
      points = [paper[0]?.at ?? paper[1].at, paper[1].at]
      dimRefs = [{ elementId: curve.id, anchor: 'center' }, null]
    }
  }
  const square = (a: Vec2, b: Vec2) => (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'horizontal' : 'vertical')
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return 'Click the points to dimension.'
  const dim: DimSpec = {
    kind,
    ...(kind === 'linear' ? { direction: square(first, last) } : {}),
    ...(settings.dimChain !== 'single' && (kind === 'linear' || kind === 'aligned') ? { chain: settings.dimChain } : {}),
    ...(dimRefs.some((r) => r) ? { refs: dimRefs } : {}),
    offsetMm: kind === 'angular' ? 12 : kind === 'arc_length' ? 4 : -8,
  }
  return { type: 'add_drawing_item', itemId, ownerId, shape: 'dimension', points: points.map(toStored), dim }
}

/** The modify operation from its picks (paper mm) and typed values, in stored coordinates. */
export function modifyOperation(op: ModifyOpName, picks: readonly Constrained[], params: ModifyParams, toStored: (p: Vec2) => Vec2): ModifyOp | string {
  const p = picks.map((c) => toStored(c.at))
  const num = (text: string, what: string): number | string => {
    const v = Number(text)
    return Number.isFinite(v) ? v : `Type a number for the ${what}.`
  }
  const length = (text: string, what: string): number | string => parseLength(text) ?? `Type the ${what} as a length, like 6" or 1'-6".`
  const [a, b, c] = p
  switch (op) {
    case 'move':
    case 'copy':
      return a && b ? { op, delta: sub(b, a) } : 'Click the base point, then where it goes.'
    case 'array': {
      const count = num(params.count, 'count')
      if (typeof count === 'string') return count
      return a && b ? { op, count: Math.round(count), delta: sub(b, a) } : 'Click the base point, then where the next copy goes.'
    }
    case 'rotate': {
      const angleDeg = num(params.angle, 'angle')
      if (typeof angleDeg === 'string') return angleDeg
      return a ? { op, center: a, angleDeg, ...(params.copy ? { copy: true } : {}) } : 'Click the centre.'
    }
    case 'polar_array': {
      const angleDeg = num(params.angle, 'angle the array spans')
      const count = num(params.count, 'count')
      if (typeof angleDeg === 'string') return angleDeg
      if (typeof count === 'string') return count
      return a ? { op, center: a, angleDeg, count: Math.round(count) } : 'Click the centre.'
    }
    case 'scale': {
      const factor = num(params.factor, 'scale factor')
      if (typeof factor === 'string') return factor
      return a ? { op, center: a, factor } : 'Click the base point.'
    }
    case 'mirror':
      return a && b ? { op, a, b, ...(params.copy ? { copy: true } : {}) } : 'Click two points on the mirror line.'
    case 'align':
      return a && b && c ? { op, from: a, a: b, b: c } : 'Click the point to line up, then two points on the line.'
    case 'offset': {
      const copy = params.offsetCopy ? {} : { copy: false }
      if (params.offsetMode === 'graphical') {
        if (!a || !b) return 'Click a point to measure from, then where the offset goes.'
        const distance = Math.hypot(b.x - a.x, b.y - a.y)
        return distance > 1e-6 ? { op, distance, side: b, ...copy } : 'Click two different points to show the offset distance.'
      }
      const distance = length(params.distance, 'offset distance')
      if (typeof distance === 'string') return distance
      return a ? { op, distance, side: a, ...copy } : 'Click the side to offset to.'
    }
    case 'trim_extend_corner':
      return a && b ? { op, keep1: a, keep2: b } : 'Click the two lines, each on the part to keep.'
    case 'trim_extend_single':
      return picks[0]?.itemId && b ? { op, boundaryId: picks[0].itemId, keep: b } : 'Click the boundary, then the line to trim or extend.'
    case 'trim_extend_multiple':
      return picks[0]?.itemId && b ? { op, boundaryId: picks[0].itemId, keeps: [b] } : 'Click the boundary, then each line to trim or extend.'
    case 'split':
      if (!a) return 'Click the line or arc where it splits.'
      return params.deleteInner ? (b ? { op, at: a, to: b } : 'Click the line again at the second split.') : { op, at: a }
    case 'split_gap': {
      const gap = length(params.gap, 'gap')
      if (typeof gap === 'string') return gap
      return a ? { op, at: a, gap } : 'Click the line or arc where the gap goes.'
    }
    case 'fillet_arc': {
      const radius = length(params.arcRadius, 'arc radius')
      if (typeof radius === 'string') return radius
      if (!(radius > 0)) return 'Type a radius above zero (Trim/Extend to Corner makes a sharp corner).'
      return a && b ? { op, radius, near1: a, near2: b } : 'Click the two lines to round the corner between.'
    }
    case 'pin':
    case 'unpin':
      return { op }
  }
}

/**
 * The operation and the elements it acts on: the clicked elements for the
 * pick-the-element tools (Trim/Extend, Split, Fillet Arc), else what is
 * selected.
 */
export function modifyRequest(op: ModifyOpName, picks: readonly Constrained[], params: ModifyParams, toStored: (p: Vec2) => Vec2, selectedIds: readonly string[]): { readonly operation: ModifyOp; readonly ids: readonly string[] } | string {
  const operation = modifyOperation(op, picks, params, toStored)
  if (typeof operation === 'string') return operation
  if (!PICK_ELEMENT_OPS.has(op)) return { operation, ids: selectedIds }
  const at = (i: number) => picks[i]?.itemId ?? null
  switch (op) {
    case 'trim_extend_corner':
    case 'fillet_arc': {
      const first = at(0)
      const second = at(1)
      if (!first || !second) return 'Click right on two drawn lines.'
      // One rectangle from an earlier drawing picked twice stands for the two sides at that corner.
      return { operation, ids: first === second ? [first] : [first, second] }
    }
    case 'trim_extend_single':
    case 'trim_extend_multiple': {
      const boundary = at(0)
      const target = at(1)
      if (!boundary || !target) return 'Click the boundary, then the line to trim or extend.'
      if (boundary === target) return 'Pick a different line than the boundary.'
      return { operation, ids: [target] }
    }
    case 'split':
    case 'split_gap': {
      const target = at(0)
      if (!target) return 'Click right on a drawn line or arc.'
      if (op === 'split' && params.deleteInner && at(1) !== target) return 'Click the same line both times to delete the piece between.'
      return { operation, ids: [target] }
    }
    default:
      return { operation, ids: selectedIds }
  }
}

/**
 * Whether the picked items stay selected after the operation: it changed them where they are
 * (move, rotate, mirror, scale, align, pin), so a second change needs no re-pick. Operations
 * that make copies or new pieces leave nothing selected, and so does an edit that first
 * replaces an item from an older drawing (a rectangle becomes four lines with new ids).
 */
export function keepsSelection(operation: ModifyOp, items: readonly DrawingItem[], ids: readonly string[]): boolean {
  if (items.some((i) => ids.includes(i.id) && draftingVersionOf(i) < DRAFTING_SCHEMA_VERSION)) return false
  switch (operation.op) {
    case 'move':
    case 'scale':
    case 'align':
    case 'pin':
    case 'unpin':
      return true
    case 'rotate':
    case 'mirror':
      return operation.copy !== true
    default:
      return false
  }
}

/** Whether the pick at this index must land on a drawn element. */
export function pickNeedsItem(op: ModifyOpName, index: number): boolean {
  return ITEM_PICKS[op]?.includes(index) ?? false
}

/** The library grouped for a picker: category → components. */
export function componentGroups(): Array<{ category: string; items: Array<{ id: string; name: string }> }> {
  const out = new Map<string, Array<{ id: string; name: string }>>()
  for (const c of detailComponents()) out.set(c.category, [...(out.get(c.category) ?? []), { id: c.id, name: c.name }])
  return [...out].map(([category, items]) => ({ category, items }))
}
