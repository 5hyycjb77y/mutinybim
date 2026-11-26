import {
  DETAIL_COMPONENTS,
  DRAFTING_SCHEMA_VERSION,
  arcStartEndRadius,
  chainLines,
  detailComponent,
  detailComponents,
  detailSnap,
  draftingVersionOf,
  polygonLines,
  rectangleLines,
  tangentEndArc,
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
  type RegionTone,
  type SnapKind,
  type Vec2,
  type ViewCommand,
} from '@permitzip/bim-kernel'
import { snapToGraphics, type GraphicsSnapIndex, type SnapPoint } from '../annotation-tools'

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
  /** Filled region ink density: black ink, 50% halftone, or 32% screened. */
  readonly regionTone: RegionTone
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
  regionTone: 'ink',
  masking: false,
  symbolId: DETAIL_COMPONENTS[0]?.id ?? 'gate_valve',
  battThickness: '2"',
  snaps: ['endpoint', 'midpoint', 'center', 'quadrant', 'intersection', 'perpendicular'],
  ortho: false,
  polarDeg: 90,
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
  /** Chamfer: distance back along the first and second lines. */
  readonly chamferD1: string
  readonly chamferD2: string
}

export const DEFAULT_MODIFY_PARAMS: ModifyParams = {
  angle: '90',
  factor: '2',
  count: '3',
  distance: '6"',
  copy: false,
  offsetMode: 'numerical',
  offsetCopy: true,
  deleteInner: false,
  gap: '1"',
  arcRadius: '6"',
  chamferD1: '4"',
  chamferD2: '4"',
}

export const MODIFY_OPS = [
  'move',
  'copy',
  'rotate',
  'mirror',
  'mirror_pick',
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
  'chamfer',
  'match_type',
  'pin',
  'unpin',
] as const
export type ModifyOpName = (typeof MODIFY_OPS)[number]

/**
 * Operations you start with nothing selected and then click the elements
 * (BIM drafting-view conventions): the clicks name the lines, and the tool
 * stays in hand for the next ones until Esc.
 */
export const PICK_ELEMENT_OPS: ReadonlySet<ModifyOpName> = new Set<ModifyOpName>([
  'trim_extend_corner',
  'trim_extend_single',
  'trim_extend_multiple',
  'split',
  'split_gap',
  'fillet_arc',
  'chamfer',
  'match_type',
])

/** Something waiting for clicks besides a drawing tool: a modify operation, or a leader for a note. */
export type DraftPending = { readonly kind: 'modify'; readonly op: ModifyOpName } | { readonly kind: 'leader'; readonly noteId: string; readonly elbow: boolean } | null

export const MODIFY_LABEL: Record<ModifyOpName, string> = {
  move: 'Move',
  copy: 'Copy',
  rotate: 'Rotate',
  mirror: 'Mirror (draw axis)',
  mirror_pick: 'Mirror (pick axis)',
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
  chamfer: 'Chamfer',
  match_type: 'Match Type',
  pin: 'Pin',
  unpin: 'Unpin',
}

/** What each pick of a modify operation is, in order. An empty list runs on the typed values alone. */
export const MODIFY_PICKS: Record<ModifyOpName, readonly string[]> = {
  move: ['Click the base point', 'Click where it goes'],
  copy: ['Click the base point', 'Click where the copy goes'],
  rotate: ['Click the centre to turn about'],
  mirror: ['Click the first point of the mirror line', 'Click the second point of the mirror line'],
  mirror_pick: ['Click an existing line to mirror across'],
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
  chamfer: ['Click the first line', 'Click the second line'],
  match_type: ['Click the source item whose style to copy', 'Click each target item to receive that style'],
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
  mirror_pick: [0],
  trim_extend_corner: [0, 1],
  trim_extend_single: [0, 1],
  trim_extend_multiple: [0, 1],
  split: [0, 1],
  split_gap: [0],
  fillet_arc: [0, 1],
  chamfer: [0, 1],
  match_type: [0, 1],
}

/** UI-only drawing tools: polygon, start-end-radius arc and tangent-end arc compile to stored lines/arcs. */
export type DraftToolShape = DrawingShape | 'polygon' | 'arc_radius' | 'arc_tangent'
export const DRAFT_SHAPES = ['line', 'rect', 'arc', 'arc_radius', 'arc_tangent', 'circle', 'polyline', 'polygon', 'spline', 'region', 'component', 'repeat', 'batt'] as const satisfies readonly DraftToolShape[]
export type DraftShape = (typeof DRAFT_SHAPES)[number]
export function isDraftShape(tool: string): tool is DraftShape {
  return (DRAFT_SHAPES as readonly string[]).includes(tool)
}

/** Dimension kinds the click flow draws (linear and aligned single dimensions are a drag). */
export function clickDimension(s: Pick<DraftSettings, 'dimKind' | 'dimChain'>): boolean {
  return s.dimKind !== 'linear' && s.dimKind !== 'aligned' ? true : s.dimChain !== 'single'
}

/** How many clicks a tool takes, or the minimum before Enter / double-click finishes. */
export function clicksFor(tool: DraftShape | 'dimension', s: Pick<DraftSettings, 'dimKind' | 'dimChain'>): { fixed: number } | { min: number } {
  switch (tool) {
    case 'component':
      return { fixed: 1 }
    case 'line':
    case 'rect':
    case 'circle':
    case 'polygon':
    case 'repeat':
    case 'batt':
      return { fixed: 2 }
    case 'arc':
    case 'arc_radius':
    case 'arc_tangent':
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
  line: ['Click the start point', 'Click the end point (or type length + Enter)'],
  rect: ['Click the first corner', 'Click the opposite corner'],
  arc: ['Click the centre of the arc', 'Click where the arc starts', 'Click where it ends (counter-clockwise)'],
  arc_radius: ['Click where the arc starts', 'Click where the arc ends', 'Click a point on the bulge of the arc'],
  arc_tangent: ['Click the start point', 'Click a point along the tangent direction', 'Click where the arc ends'],
  circle: ['Click the centre', 'Click a point on the circle (or type radius + Enter)'],
  polyline: ['Click the first point', 'Click the next point (or type length + Enter). Click the first point to close, or Enter / double-click to finish'],
  polygon: ['Click the centre', 'Click a corner (or type radius + Enter)'],
  spline: ['Click the first point', 'Click the next point. Enter or double-click finishes'],
  region: ['Click the first corner', 'Click the next corner', 'Click the next corner. Click the first corner, Enter, or double-click to close'],
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
  /** Snap kind, for distinct CAD snap glyphs (square, triangle, diamond, tangent, etc.). */
  readonly snapKind?: SnapKind | null
  /** A dimension point's element / item it follows. */
  readonly snapRef: SnapPoint['ref'] | null
  /** The tracking line drawn from the last point, when tracking. */
  readonly tracking: { readonly from: Vec2; readonly angleDeg: number } | null
  /** Optional Revit-style dashed alignment guide connecting an aligned corner/edge to `at`. */
  readonly guideLine?: readonly [Vec2, Vec2] | null
  /** True when hovering/snapping back onto the start point of an open polyline or region to close the loop. */
  readonly closeLoop?: boolean
  /** The drawn item under the snap, if any (trim / extend boundaries, radial dimensions). */
  readonly itemId: string | null
}

const SNAP_WORDS: Record<SnapKind, string> = {
  endpoint: 'endpoint',
  midpoint: 'midpoint',
  center: 'centre',
  quadrant: 'quadrant',
  tangent: 'tangent',
  intersection: 'intersection',
  perpendicular: 'perpendicular',
  nearest: 'nearest point',
}

/**
 * Where a click lands: active chain start/vertices (close loop), then model /
 * dimension anchors, then detail-linework snaps, then real model graphics
 * (walls, wall corners, grid lines & intersections, orthogonal alignment guides),
 * then ortho or polar tracking from the last point, else the pointer.
 */
export function constrainPoint(input: {
  readonly at: Vec2
  readonly from: Vec2 | null
  readonly items: readonly DrawingItem[]
  readonly toPaper: (p: Vec2) => Vec2
  readonly settings: Pick<DraftSettings, 'snaps' | 'ortho' | 'polarDeg'>
  readonly reachMm: number
  /** Points dimensions and detail lines follow (model ends and edges). */
  readonly anchors?: readonly SnapPoint[]
  /** When true (dimensions), prefer anchor snaps over detail-line CAD snaps so dimensions bind to corners. */
  readonly preferAnchors?: boolean
  /** Real rendered model graphics index (wall corners/faces, grid lines/intersections). */
  readonly graphicsIndex?: GraphicsSnapIndex | null
  /** Vertices already clicked in the current polyline / region / line chain. */
  readonly chainPoints?: readonly Vec2[]
  /** Allow snapping to the start point to close a loop (polyline / region with >= 3 points). */
  readonly allowCloseLoop?: boolean
  /** Also snap to the nearest point on a line (picking a trim / extend boundary). */
  readonly nearest?: boolean
  /** Picking an element: only the nearest point on a line counts (an endpoint snap at a corner would name either line). */
  readonly pickElement?: boolean
  /** Degrees counter-clockwise from paper-right that ortho and polar steps start from: the working angle on paper. Absent: 0. */
  readonly trackBaseDeg?: number
}): Constrained {
  const { at, from, settings, reachMm } = input
  if (input.pickElement) {
    const snap = detailSnap(input.items, input.toPaper, at, { kinds: new Set<SnapKind>(['nearest']), reachMm })
    return snap ? { at: snap.at, snapLabel: SNAP_WORDS.nearest, snapKind: 'nearest', snapRef: null, tracking: null, itemId: snap.itemId } : { at, snapLabel: null, snapKind: null, snapRef: null, tracking: null, itemId: null }
  }

  // 1. Active chain vertices (start point closes loop when >= 3 vertices clicked).
  const chain = input.chainPoints ?? []
  if (chain.length >= 3 && input.allowCloseLoop) {
    const first = chain[0]!
    if (Math.hypot(first.x - at.x, first.y - at.y) < reachMm * 1.25) {
      return { at: first, snapLabel: 'close loop', snapKind: 'endpoint', snapRef: null, tracking: null, closeLoop: true, itemId: null }
    }
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const pt = chain[i]!
    if (Math.hypot(pt.x - at.x, pt.y - at.y) < reachMm) {
      return { at: pt, snapLabel: 'chain corner', snapKind: 'endpoint', snapRef: null, tracking: null, itemId: null }
    }
  }

  // 2. Model / dimension anchor points (preferred ahead of detail CAD snaps for dimensions or non-detail model elements).
  let bestAnchor: SnapPoint | null = null
  let bestD = reachMm
  for (const a of input.anchors ?? []) {
    const d = Math.hypot(a.at.x - at.x, a.at.y - at.y)
    if (d < bestD) {
      bestAnchor = a
      bestD = d
    }
  }
  const anchorIsDetailItem = bestAnchor !== null && input.items.some((i) => i.id === bestAnchor.ref.elementId)
  if (bestAnchor && (input.preferAnchors || !anchorIsDetailItem)) {
    return { at: bestAnchor.at, snapLabel: bestAnchor.label, snapKind: 'endpoint', snapRef: bestAnchor.ref, tracking: null, itemId: anchorIsDetailItem ? bestAnchor.ref.elementId : null }
  }

  // 3. Existing detail linework snaps (endpoint, midpoint, intersection, perpendicular, etc.).
  const kinds = new Set<SnapKind>(settings.snaps)
  if (input.nearest) kinds.add('nearest')
  if (kinds.size > 0) {
    const snap = detailSnap(input.items, input.toPaper, at, { kinds, reachMm, ...(from ? { from } : {}) })
    if (snap) return { at: snap.at, snapLabel: SNAP_WORDS[snap.kind], snapKind: snap.kind, snapRef: null, tracking: null, itemId: snap.itemId }
  }
  if (bestAnchor) {
    return { at: bestAnchor.at, snapLabel: bestAnchor.label, snapKind: 'endpoint', snapRef: bestAnchor.ref, tracking: null, itemId: anchorIsDetailItem ? bestAnchor.ref.elementId : null }
  }

  // 4. Real model graphics snaps (wall corners, wall faces, grids, intersections, and chain corner alignment guides).
  if (input.graphicsIndex || chain.length > 0) {
    const gHit = snapToGraphics(input.graphicsIndex ?? null, at, reachMm, {
      alignRefs: chain,
      orthoFrom: settings.ortho ? from : null,
    })
    if (gHit) {
      const snapKind: SnapKind = gHit.kind === 'intersection' ? 'intersection' : gHit.kind === 'corner' ? 'endpoint' : gHit.kind === 'ortho' ? 'perpendicular' : 'nearest'
      return {
        at: gHit.at,
        snapLabel: gHit.label,
        snapKind,
        snapRef: null,
        tracking: null,
        guideLine: gHit.guideLine ?? null,
        itemId: null,
      }
    }
  }

  // 5. Ortho / polar tracking (Ortho locks to 90° with 45° tolerance; Polar uses gentle 4° magnetic snap).
  if (from && (settings.ortho || settings.polarDeg)) {
    const t = trackFrom(from, at, settings.ortho ? 90 : (settings.polarDeg ?? 90), input.trackBaseDeg ?? 0, settings.ortho ? 45 : 4)
    if (t) return { at: t.at, snapLabel: null, snapKind: null, snapRef: null, tracking: { from, angleDeg: t.angleDeg }, itemId: null }
  }
  return { at, snapLabel: null, snapKind: null, snapRef: null, tracking: null, itemId: null }
}

/** Paper y runs down: turning counter-clockwise by `deg` on screen. */
function turnPaper(v: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180
  return { x: v.x * Math.cos(a) + v.y * Math.sin(a), y: -v.x * Math.sin(a) + v.y * Math.cos(a) }
}

/** Ortho / polar tracking whose steps start from `baseDeg` (the working angle on paper) instead of paper-right. */
export function trackFrom(from: Vec2, at: Vec2, incrementDeg: number, baseDeg: number, toleranceDeg?: number): { at: Vec2; angleDeg: number } | null {
  if (baseDeg === 0) return trackAngle(from, at, incrementDeg, toleranceDeg)
  const local = turnPaper(sub(at, from), -baseDeg)
  const t = trackAngle({ x: 0, y: 0 }, local, incrementDeg, toleranceDeg)
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
    case 'line': {
      const [a, b] = pts
      if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return 'Click two different points for the line.'
      return { ...base, shape: 'line', points: [a, b] }
    }
    case 'rect': {
      const [a, b] = pts
      if (!a || !b || (Math.abs(b.x - a.x) < 1e-6 && Math.abs(b.y - a.y) < 1e-6)) return 'Click two opposite corners for the rectangle.'
      return joined(rectangleLines(a, b), 'Draw a rectangle')
    }
    case 'arc':
      return { ...base, shape: 'arc', points: pts.slice(0, 3), ccw: true }
    case 'arc_radius': {
      const [s, e, through] = pts
      if (!s || !e || !through) return 'Click start, end, and a point on the arc.'
      // Compute circumcircle radius through (s, e, through) so dragging sets the exact bulge cleanly.
      const ax = s.x, ay = s.y, bx = e.x, by = e.y, cx = through.x, cy = through.y
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
      if (Math.abs(d) < 1e-6) return 'The three points are in a straight line — click off the chord to bulge the arc.'
      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
      const radius = Math.hypot(s.x - ux, s.y - uy)
      const built = arcStartEndRadius(s, e, radius, through)
      if (!built) return 'Could not construct an arc through those three points.'
      return { ...base, shape: 'arc', points: built.points, ccw: built.ccw }
    }
    case 'arc_tangent': {
      const [s, dirPt, e] = pts
      if (!s || !dirPt || !e) return 'Click the start, a point along the tangent, and the end.'
      const built = tangentEndArc(s, { x: dirPt.x - s.x, y: dirPt.y - s.y }, e)
      if (!built) return 'Click an end point off the tangent line.'
      return { ...base, shape: 'arc', points: built.points, ccw: built.ccw }
    }
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
      return {
        ...base,
        shape: 'region',
        points: pts,
        fill: settings.masking ? { pattern: 'solid', masking: true } : { pattern: settings.hatch, ...(settings.regionTone !== 'ink' ? { tone: settings.regionTone } : {}) },
      }
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
export function modifyOperation(
  op: ModifyOpName,
  picks: readonly Constrained[],
  params: ModifyParams,
  toStored: (p: Vec2) => Vec2,
  items?: readonly DrawingItem[],
): ModifyOp | string {
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
    case 'mirror_pick': {
      const axisId = picks[0]?.itemId
      const axis = axisId ? items?.find((i) => i.id === axisId) : undefined
      if (!axis || axis.shape !== 'line' || axis.points.length < 2) return 'Click a straight detail line to mirror across.'
      const [p0, p1] = axis.points
      return p0 && p1 ? { op: 'mirror', a: p0, b: p1, ...(params.copy ? { copy: true } : {}) } : 'Click a straight detail line to mirror across.'
    }
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
    case 'chamfer': {
      const d1 = length(params.chamferD1, 'first chamfer distance')
      if (typeof d1 === 'string') return d1
      const d2 = params.chamferD2.trim() ? length(params.chamferD2, 'second chamfer distance') : d1
      if (typeof d2 === 'string') return d2
      if (!(d1 > 0) || !(d2 > 0)) return 'Type chamfer distances above zero.'
      return a && b ? { op, d1, d2, near1: a, near2: b } : 'Click the two lines to bevel their corner.'
    }
    case 'match_type': {
      const sourceId = picks[0]?.itemId
      return sourceId ? { op, sourceId } : 'Click the source item first.'
    }
    case 'pin':
    case 'unpin':
      return { op }
  }
}

/**
 * The operation and the elements it acts on: the clicked elements for the
 * pick-the-element tools (Trim/Extend, Split, Fillet Arc, Chamfer, Match Type),
 * else what is selected.
 */
export function modifyRequest(
  op: ModifyOpName,
  picks: readonly Constrained[],
  params: ModifyParams,
  toStored: (p: Vec2) => Vec2,
  selectedIds: readonly string[],
  items?: readonly DrawingItem[],
): { readonly operation: ModifyOp; readonly ids: readonly string[] } | string {
  const operation = modifyOperation(op, picks, params, toStored, items)
  if (typeof operation === 'string') return operation
  if (!PICK_ELEMENT_OPS.has(op)) return { operation, ids: selectedIds }
  const at = (i: number) => picks[i]?.itemId ?? null
  switch (op) {
    case 'trim_extend_corner':
    case 'fillet_arc':
    case 'chamfer': {
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
    case 'match_type': {
      const source = at(0)
      const target = at(1)
      if (!source || !target) return 'Click the source item, then the item to match.'
      if (source === target) return 'Pick a different item than the source.'
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

/**
 * Listening dimension helper: compute the point `lengthPaperMm` from `from`
 * along the ray toward `toward` (defaults to +X if `toward` coincides with `from`).
 */
export function listeningPoint(from: Vec2, toward: Vec2, lengthPaperMm: number): Vec2 | null {
  if (!Number.isFinite(lengthPaperMm) || lengthPaperMm <= 0) return null
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const d = Math.hypot(dx, dy)
  const ux = d > 1e-6 ? dx / d : 1
  const uy = d > 1e-6 ? dy / d : 0
  return { x: from.x + ux * lengthPaperMm, y: from.y + uy * lengthPaperMm }
}

/**
 * Window (left-to-right: fully enclosed) vs crossing (right-to-left: touched or enclosed)
 * marquee hit-test over drafted items in paper coordinates.
 */
export function marqueeHits(items: readonly DrawingItem[], toPaper: (p: Vec2) => Vec2, a: Vec2, b: Vec2): string[] {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  const crossing = b.x < a.x
  const hits: string[] = []
  for (const item of items) {
    if (item.points.length === 0) continue
    const pts = item.points.map(toPaper)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of pts) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
    if (item.shape === 'circle' && pts[0] && pts[1]) {
      const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      x0 = pts[0].x - r; x1 = pts[0].x + r; y0 = pts[0].y - r; y1 = pts[0].y + r
    }
    if (crossing) {
      if (x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY) hits.push(item.id)
    } else {
      if (x0 >= minX && x1 <= maxX && y0 >= minY && y1 <= maxY) hits.push(item.id)
    }
  }
  return hits
}
