/**
 * Press-and-drag on placed drafting items with Select: the same move the
 * ribbon's Move tool makes (one command, one undo step), driven by the pointer.
 */
import { drawDetailItem, expandDetailGroups, modifyCommand, type DrawingItem, type Primitive, type Vec2 } from '@permitzip/bim-kernel'

/** How far the pointer travels on screen before a press on an item becomes a drag; less is a click. */
export const DRAG_START_PX = 4

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Whether a press at `from` has travelled far enough (paper mm, at `pxPerMm` on screen) to be a drag. */
export function dragStarted(from: Vec2, at: Vec2, pxPerMm: number): boolean {
  return Math.hypot(at.x - from.x, at.y - from.y) * pxPerMm >= DRAG_START_PX
}

/** Where the pointer has taken the press, paper mm; ortho (F8) keeps the travel square to the working angle on paper (`baseDeg`, counter-clockwise; 0: square to the paper). */
export function dragTo(from: Vec2, at: Vec2, ortho: boolean, baseDeg = 0): Vec2 {
  if (!ortho) return at
  if (baseDeg === 0) return Math.abs(at.x - from.x) >= Math.abs(at.y - from.y) ? { x: at.x, y: from.y } : { x: from.x, y: at.y }
  const a = (baseDeg * Math.PI) / 180
  // The working X axis on paper (y down) and the travel's components along it and square to it.
  const ux = { x: Math.cos(a), y: -Math.sin(a) }
  const uy = { x: Math.sin(a), y: Math.cos(a) }
  const d = { x: at.x - from.x, y: at.y - from.y }
  const alongX = d.x * ux.x + d.y * ux.y
  const alongY = d.x * uy.x + d.y * uy.y
  return Math.abs(alongX) >= Math.abs(alongY) ? { x: from.x + ux.x * alongX, y: from.y + ux.y * alongX } : { x: from.x + uy.x * alongY, y: from.y + uy.y * alongY }
}

/** The Move tool's command for a drag from `from` to `to` on paper. */
export function dragMoveCommand(input: {
  readonly items: readonly DrawingItem[]
  readonly ids: readonly string[]
  readonly from: Vec2
  readonly to: Vec2
  readonly toStored: (p: Vec2) => Vec2
  readonly ownerId: string
  readonly idPrefix: string
}): ReturnType<typeof modifyCommand> {
  const a = input.toStored(input.from)
  const b = input.toStored(input.to)
  return modifyCommand(input.items, input.ids, { op: 'move', delta: { x: b.x - a.x, y: b.y - a.y } }, input.ownerId, input.idPrefix)
}

/** Where the dragged items (and the rest of their detail groups, as Move brings them) will land, as preview linework on paper. */
export function dragGhost(input: {
  readonly items: readonly DrawingItem[]
  readonly ids: readonly string[]
  readonly delta: Vec2
  readonly toPaper: (p: Vec2) => Vec2
  readonly storedPerPaperMm: number
  readonly boxOf: (item: DrawingItem) => Box | null
}): Primitive[] {
  const { delta } = input
  const shifted = (p: Vec2): Vec2 => {
    const q = input.toPaper(p)
    return { x: q.x + delta.x, y: q.y + delta.y }
  }
  const prims: Primitive[] = []
  for (const item of expandDetailGroups(input.items, input.ids).items) {
    if (drawDetailItem({ toPaper: shifted, scale: input.storedPerPaperMm, prims }, item)) continue
    const [a, b] = item.points.map(shifted)
    if (item.shape === 'line' && a && b) {
      prims.push({ kind: 'line', a, b, pen: 'medium' })
      continue
    }
    const box = input.boxOf(item)
    if (!box) continue
    const x = box.x + delta.x
    const y = box.y + delta.y
    const corners = [{ x, y }, { x: x + box.w, y }, { x: x + box.w, y: y + box.h }, { x, y: y + box.h }]
    corners.forEach((c, i) => prims.push({ kind: 'line', a: c, b: corners[(i + 1) % 4] ?? c, pen: 'thin', dash: [1.2, 0.8] }))
  }
  return prims
}
