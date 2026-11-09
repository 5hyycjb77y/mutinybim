import { paperMapping, planTagSpread, tagHasLeader, tagTarget, type Command, type DrawingItem, type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'

/**
 * Tag elbow leaders on drawings (ROADMAP U9), as the commands the canvas
 * sends. Pure: the canvas owns the pointer and the selection. Every move of a
 * tag head, bend of a grip and Spread tags is the ordinary drawing-item
 * update, so Undo and the agent see the same edits.
 */

/** Further than this from its element (paper mm), a dragged tag gets a leader with an elbow. */
export const TAG_AWAY_MM = 6

export interface TagCommand {
  readonly command: Command
  /** The undo label, lower case ("move the tag"). */
  readonly label: string
}

function paperDistance(view: ViewElement, a: Vec2, b: Vec2): number {
  const { toPaper } = paperMapping(view)
  const p = toPaper(a)
  const q = toPaper(b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/**
 * A tag's head dropped at `head` (stored model mm). Dragged away from its
 * element, a tag gets a leader with an elbow (its hand elbow is kept, else
 * "auto"); near it, it just moves. A non-tag item just moves.
 */
export function tagMoveCommand(model: ModelState, view: ViewElement | null, item: DrawingItem, head: Vec2): TagCommand {
  const plain: TagCommand = { command: { type: 'update_drawing_item', itemId: item.id, points: [head] }, label: item.tag ? 'move the tag' : 'move it' }
  const tag = item.tag
  if (!tag || !view) return plain
  const target = tagTarget(model, view, tag)
  if (!target || paperDistance(view, head, target) <= TAG_AWAY_MM) return plain
  if (tagHasLeader(model, tag) && tag.elbow !== undefined) return plain
  return { command: { type: 'update_drawing_item', itemId: item.id, points: [head], tag: { ...tag, leader: true, elbow: tag.elbow ?? 'auto' } }, label: 'move the tag out on an elbow leader' }
}

/** The elbow grip dropped at `elbow` (stored model mm): a hand elbow, which always wins over Spread tags. */
export function elbowGripCommand(item: DrawingItem, elbow: Vec2): TagCommand | null {
  if (!item.tag) return null
  return { command: { type: 'update_drawing_item', itemId: item.id, tag: { ...item.tag, elbow } }, label: 'bend the leader' }
}

/** Right-click › Straighten leader: back to the automatic elbow. Null when there is no hand elbow to take off. */
export function straightenLeaderCommand(item: DrawingItem): TagCommand | null {
  if (!item.tag || item.tag.elbow === undefined || item.tag.elbow === 'auto') return null
  return { command: { type: 'update_drawing_item', itemId: item.id, tag: { ...item.tag, elbow: 'auto' } }, label: 'straighten the leader' }
}

export function straightenBlocked(item: DrawingItem | null, editBlocked: string | null): string | null {
  if (editBlocked) return editBlocked
  if (!item?.tag) return 'Select a tag first.'
  if (item.tag.elbow === undefined || item.tag.elbow === 'auto') return 'Its leader has no hand-placed bend to straighten.'
  return null
}

export function spreadBlocked(view: ViewElement | null, items: readonly DrawingItem[], selectedIds: readonly string[], editBlocked: string | null): string | null {
  if (editBlocked) return editBlocked
  if (!view || (view.viewType !== 'floor_plan' && view.viewType !== 'ceiling_plan' && view.viewType !== 'section')) return 'Tags spread in plans and sections. Open one, or the view on the sheet.'
  const chosen = new Set(selectedIds)
  const tags = items.filter((i) => chosen.has(i.id) && i.tag && !i.deleted).length
  return tags < 2 ? 'Select two or more tags' : null
}

export interface SpreadTags {
  /** One `batch_documents` labelled "Spread tags" (one undo); null when nothing moves. */
  readonly command: Command | null
  /** The toast: "Spread 12 tags", or "Spread 10 tags; 2 need a hand: no clear spot near them". */
  readonly message: string
  /** Why chosen tags were left alone ("its elbow was placed by hand"), for the toast detail. */
  readonly detail: string | null
  /** Tags with no clear spot: select these so a person places them. */
  readonly needHand: readonly string[]
}

/** Spread the chosen tags clear of each other, of notes, dimensions and leaders (the kernel's `planTagSpread`). */
export function planSpreadTags(model: ModelState, viewId: string, selectedIds: readonly string[]): SpreadTags {
  const plan = planTagSpread(model, viewId, selectedIds)
  const needHand = plan.updates.filter((u) => !u.clear).map((u) => u.itemId)
  const placed = plan.updates.length - needHand.length
  const tags = (n: number) => `${n} tag${n === 1 ? '' : 's'}`
  const message =
    plan.updates.length === 0
      ? 'Nothing to spread: every chosen tag is kept where it is'
      : needHand.length === 0
        ? `Spread ${tags(placed)}`
        : `Spread ${tags(placed)}; ${needHand.length} need${needHand.length === 1 ? 's' : ''} a hand: no clear spot near ${needHand.length === 1 ? 'it' : 'them'}`
  const reasons = [...new Set(plan.kept.map((k) => k.reason))]
  const detail = plan.kept.length > 0 ? `${plan.kept.length} kept as ${plan.kept.length === 1 ? 'it was' : 'they were'}: ${reasons.join('; ')}` : null
  const command: Command | null =
    plan.updates.length > 0 ? { type: 'batch_documents', label: 'Spread tags', commands: plan.updates.map((u) => ({ type: 'update_drawing_item' as const, itemId: u.itemId, points: [u.at], tag: u.tag })) } : null
  return { command, message, detail, needHand }
}
