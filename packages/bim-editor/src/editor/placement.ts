import { MODEL_FRAME, elementsOfKind, fromWorkFrame, mountingPlaneUnder, paperToModelPoint, toWorkFrame, viewModelLevel, type BimElement, type Command, type Level, type ModelState, type PartCategory, type PartInstance, type PartTypeDefinition, type ReferenceSnapCandidates, type Vec2, type ViewOnPaper, type WorkFrame } from '@permitzip/bim-kernel'

/**
 * Placement helpers for the Building Model tools: where a part lands under
 * the pointer (grid, other parts, the architect's model), default heights,
 * and the plain words shown while placing. Pure: no React, no three.js.
 */

export const MM_PER_FT = 304.8
export const MM_PER_IN = 25.4

/** Plan grid the pointer snaps to when nothing closer applies. */
export const GRID_MM = 6 * MM_PER_IN
/** How close (plan mm) the pointer must be to another part's insertion point to land on it. */
export const POINT_SNAP_MM = 300
/** How close (plan mm) to another part's x or y to line up with it. */
export const ALIGN_SNAP_MM = 150

export type SnapKind = 'part' | 'align' | 'reference' | 'linked' | 'grid'

export interface Snapped {
  readonly point: Vec2
  readonly kind: SnapKind
  /** What it snapped to, in words ("SD-1", "the architect's model"). */
  readonly label: string
}

export interface SnapTarget {
  readonly id: string
  readonly label: string
  readonly point: Vec2
}

/** Insertion points of the parts on one level (the snap targets), excluding the ones being moved. */
export function snapTargets(model: ModelState, levelId: string, exclude: ReadonlySet<string> = new Set()): SnapTarget[] {
  const out: SnapTarget[] = []
  for (const el of elementsOfKind(model.elements, 'part')) {
    // A part that isn't placed yet sits at a placeholder (the level origin): nothing to snap to.
    if (el.levelId !== levelId || exclude.has(el.id) || el.planned !== undefined) continue
    out.push({ id: el.id, label: partLabel(model, el), point: el.position })
  }
  return out
}

function round(n: number, step: number): number {
  return Math.round(n / step) * step
}

/**
 * Where a part lands for a raw pointer point. Order: onto another part's
 * insertion point, onto a linked model's wall end or corner, then its face or
 * centre line (`linked`), onto a point the pointer hit on the architect's model,
 * lined up with another part (each axis), then the plan grid. Lining up and
 * the grid work in the work frame (`work-frame.ts`): on a building with a
 * working angle the grid and the "lined up" axes run along its walls.
 */
export function snapPoint(raw: Vec2, targets: readonly SnapTarget[], reference: Vec2 | null = null, frame: WorkFrame = MODEL_FRAME, linked: ReferenceSnapCandidates | null = null): Snapped {
  let nearest: SnapTarget | null = null
  let best = POINT_SNAP_MM
  for (const t of targets) {
    const d = Math.hypot(t.point.x - raw.x, t.point.y - raw.y)
    if (d <= best) {
      best = d
      nearest = t
    }
  }
  if (nearest) return { point: nearest.point, kind: 'part', label: nearest.label }
  const onLinked = linked ? linkedSnap(raw, linked) : null
  if (onLinked) return onLinked
  if (reference) return { point: { x: Math.round(reference.x), y: Math.round(reference.y) }, kind: 'reference', label: "the architect's model" }
  const q = toWorkFrame(frame, raw)
  let x = round(q.x, GRID_MM)
  let y = round(q.y, GRID_MM)
  const labels: string[] = []
  let bx = ALIGN_SNAP_MM
  let by = ALIGN_SNAP_MM
  let ax: { readonly label: string; readonly at: Vec2 } | null = null
  let ay: { readonly label: string; readonly at: Vec2 } | null = null
  for (const t of targets) {
    const at = toWorkFrame(frame, t.point)
    const dx = Math.abs(at.x - q.x)
    const dy = Math.abs(at.y - q.y)
    if (dx <= bx) {
      bx = dx
      ax = { label: t.label, at }
    }
    if (dy <= by) {
      by = dy
      ay = { label: t.label, at }
    }
  }
  if (ax) {
    x = ax.at.x
    labels.push(ax.label)
  }
  if (ay) {
    y = ay.at.y
    if (ay.at !== ax?.at) labels.push(ay.label)
  }
  const point = fromWorkFrame(frame, { x, y })
  if (labels.length > 0) return { point, kind: 'align', label: labels.join(' and ') }
  return { point, kind: 'grid', label: frame.angleDeg === 0 ? '6" grid' : '6" grid along the working angle' }
}

/** A linked model's end or corner within the point reach, else the nearest face or centre line within the line-up reach. */
function linkedSnap(raw: Vec2, linked: ReferenceSnapCandidates): Snapped | null {
  let point: Snapped | null = null
  let best = POINT_SNAP_MM
  for (const p of linked.points) {
    const d = Math.hypot(p.at.x - raw.x, p.at.y - raw.y)
    if (d <= best) {
      best = d
      point = { point: { x: Math.round(p.at.x), y: Math.round(p.at.y) }, kind: 'linked', label: p.label }
    }
  }
  if (point) return point
  let line: Snapped | null = null
  best = ALIGN_SNAP_MM
  for (const l of linked.lines) {
    const dx = l.end.x - l.start.x
    const dy = l.end.y - l.start.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((raw.x - l.start.x) * dx + (raw.y - l.start.y) * dy) / len2))
    const q = { x: l.start.x + dx * t, y: l.start.y + dy * t }
    const d = Math.hypot(q.x - raw.x, q.y - raw.y)
    if (d <= best) {
      best = d
      line = { point: { x: Math.round(q.x), y: Math.round(q.y) }, kind: 'linked', label: l.label }
    }
  }
  return line
}

export function snapHint(s: Snapped): string {
  switch (s.kind) {
    case 'linked':
      return s.label
    case 'part':
      return `On ${s.label}`
    case 'align':
      return `Lined up with ${s.label}`
    case 'reference':
      return `On ${s.label}`
    case 'grid':
      return `On the ${s.label}`
  }
}

/** Where a part's insertion point usually sits above its level when first placed. */
export function defaultHeightMm(category: PartCategory): number {
  switch (category) {
    case 'air_terminal':
    case 'lighting_fixture':
      return 9 * MM_PER_FT
    case 'electrical_device':
      return 18 * MM_PER_IN
    case 'electrical_equipment':
      return 0
    case 'duct_accessory':
      return 10 * MM_PER_FT
    default:
      return 0
  }
}

export function levelsOf(model: ModelState | null): Level[] {
  if (!model) return []
  return elementsOfKind(model.elements, 'level')
    .sort((a, b) => a.elevationMm - b.elevationMm)
}

export function partTypeOf(model: ModelState, part: PartInstance): PartTypeDefinition | null {
  const t = model.elements[part.typeId]
  return t?.kind === 'part_type' ? t.definition : null
}

export function partLabel(model: ModelState, part: PartInstance): string {
  if (part.mark) return part.mark
  const def = partTypeOf(model, part)
  return def ? def.typeName : 'part'
}

/** Things that would be removed or cut with a delete, in words, for the confirmation. */
export function describeElement(model: ModelState, el: BimElement): string {
  switch (el.kind) {
    case 'part':
      return partLabel(model, el)
    case 'tag':
      return `Tag "${el.text}"`
    case 'dimension':
      return 'Dimension'
    case 'level':
      return `Level ${el.name}`
    case 'part_type':
      return el.definition.typeName
    case 'terminal':
    case 'equipment':
      return el.mark
    default:
      return el.kind.replace(/_/g, ' ')
  }
}

export function feetInches(mm: number): string {
  const totalIn = Math.abs(mm) / MM_PER_IN
  let ft = Math.floor(totalIn / 12)
  let inches = Math.round((totalIn - ft * 12) * 4) / 4
  if (inches >= 12) {
    ft += 1
    inches = 0
  }
  return `${mm < 0 ? '-' : ''}${ft}'-${inches}"`
}

/** A new element id for this browser (unique per click, stable across retries of the same request). */
export function newElementId(prefix: string): string {
  const uuid = createSecureElementId()
  return `${prefix}-${uuid}`
}

let elementIdFallbackCounter = 0

function createSecureElementId(): string {
  const cryptoObj: Crypto | undefined =
    typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    // Secure fallback: derive from cryptographically secure bytes — element
    // ids must not be guessable, never Math.random().
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Last resort for runtimes with no Web Crypto: timestamp + monotonic
  // counter. Unique per call; not a secret.
  elementIdFallbackCounter += 1
  return `${Date.now().toString(36)}-${elementIdFallbackCounter.toString(36)}`
}

// ---------------------------------------------------------------- placing on a drawing

/** Where a click on a plan or section drawing puts a part: the level it goes on, its plan point and its height above that level. */
export interface DrawingPlacementTarget {
  readonly levelId: string
  readonly position: Vec2
  readonly offsetMm: number
  /** The mounting plane under the pointer the part goes on (it moves with the plane); absent: on the level. */
  readonly planeId?: string
  /** In words, for the status line ("On Level 1, 1'-6\" up, on the 6\" grid"). */
  readonly where: string
}

export type DrawingPlacement = { readonly ok: true; readonly target: DrawingPlacementTarget } | { readonly ok: false; readonly reason: string }

/**
 * The placement for a paper point on the drawing the person is on (a plan or
 * section by itself, or the viewport opened on a sheet). Plans: on the view's
 * level, `heightMm` up. Sections and elevations: the point's height decides
 * the level (the highest one at or below it) and the height above it; the plan
 * point is on the cut line. Never switches view.
 */
export function drawingPlacementTarget(model: ModelState, vop: ViewOnPaper, paper: Vec2, heightMm: number, frame: WorkFrame = MODEL_FRAME, opts: { readonly ignorePlanes?: boolean; /** A linked model's snap candidates near a plan point on a level. */ readonly linked?: (levelId: string, at: Vec2) => ReferenceSnapCandidates | null } = {}): DrawingPlacement {
  const mapping = vop.mapping
  if (mapping.modelReason) return { ok: false, reason: mapping.modelReason }
  const levels = levelsOf(model)
  if (levels.length === 0) return { ok: false, reason: 'This model has no levels yet; add a level before placing parts.' }
  if (mapping.kind === 'plan') {
    const level = viewModelLevel(model, vop.view.props?.level, vop.view.props?.levelElevationMm) ?? levels.find((l) => Math.abs(l.elevationMm - mapping.floorMm) < 1)
    if (!level) return { ok: false, reason: `This plan's level (${vop.view.props?.level ?? 'none'}) isn't in the model; set the view's level in View properties.` }
    const at = paperToModelPoint(vop, paper, { elevationMm: level.elevationMm + heightMm })
    if (!at) return { ok: false, reason: 'Point inside the view to place it.' }
    // A mounting plane on this level under the pointer is where the part goes (Shift: the level instead).
    const under = opts.ignorePlanes ? null : mountingPlaneUnder(model, (mm) => paperToModelPoint(vop, paper, { elevationMm: mm }), new Set([level.id]))
    if (under) {
      const onPlane = snapPoint(under.point, snapTargets(model, level.id), null, frame)
      return {
        ok: true,
        target: { levelId: level.id, position: onPlane.point, offsetMm: Math.round(under.plane.heightMm), planeId: under.plane.id, where: `On mounting plane ${under.plane.name}, ${feetInches(under.plane.heightMm)} up, ${snapHint(onPlane).toLowerCase()} (Shift: on ${level.name} instead)` },
      }
    }
    const snapped = snapPoint({ x: at.x, y: at.y }, snapTargets(model, level.id), null, frame, opts.linked?.(level.id, { x: at.x, y: at.y }) ?? null)
    return { ok: true, target: { levelId: level.id, position: snapped.point, offsetMm: Math.round(heightMm), where: `On ${level.name}, ${feetInches(heightMm)} up, ${snapHint(snapped).toLowerCase()}` } }
  }
  if (mapping.kind === 'section') {
    const at = paperToModelPoint(vop, paper, { depthMm: 0 })
    if (!at) return { ok: false, reason: 'Point inside the view to place it.' }
    const below = [...levels].reverse().find((l) => l.elevationMm <= at.z + 1) ?? levels[0]
    if (!below) return { ok: false, reason: 'This model has no levels yet; add a level before placing parts.' }
    const offsetMm = Math.round((at.z - below.elevationMm) / 25.4) * 25.4
    return { ok: true, target: { levelId: below.id, position: { x: Math.round(at.x), y: Math.round(at.y) }, offsetMm: Math.round(offsetMm), where: `On ${below.name}, ${feetInches(offsetMm)} up, on the section's cut line` } }
  }
  return { ok: false, reason: 'Parts are placed in a plan or a section; this view has no model point under the pointer.' }
}

/** What is being placed: a new part of a type, or a part that exists and isn't placed yet. */
export type DrawingPlacementSpec =
  | { readonly kind: 'new'; readonly typeId: string; readonly definition: PartTypeDefinition; readonly inModel: boolean; readonly heightMm: number; readonly rotationDeg: number }
  | { readonly kind: 'planned'; readonly partId: string; readonly label: string; readonly heightMm: number; readonly rotationDeg: number }

/** The one command a click on the drawing sends. The new part's id is chosen once per click by the caller. */
export function drawingPlacementCommand(spec: DrawingPlacementSpec, target: DrawingPlacementTarget, newPartId: string): Command {
  if (spec.kind === 'planned') {
    return { type: 'place_planned_part', partId: spec.partId, levelId: target.levelId, position: target.position, ...(target.planeId ? { planeId: target.planeId } : { offsetMm: target.offsetMm }), rotationDeg: spec.rotationDeg }
  }
  return {
    type: 'place_part',
    partId: newPartId,
    typeId: spec.typeId,
    ...(spec.inModel ? {} : { partType: spec.definition }),
    levelId: target.levelId,
    position: target.position,
    ...(target.planeId ? { planeId: target.planeId } : { offsetMm: target.offsetMm }),
    rotationDeg: spec.rotationDeg,
  }
}
