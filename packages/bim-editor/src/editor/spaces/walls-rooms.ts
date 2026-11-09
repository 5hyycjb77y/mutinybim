import { detectRoomsFromWalls, LINKED_WALL_ROOM_DETECTOR_ID, type Command, type ElementId, type LinkedRoomBounds, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import { newElementId } from '../placement'
import type { ReviewedProposal } from './propose-rooms'
import { nextSpaceNumber } from './space-rows'

/**
 * "Find rooms from walls": every closed room the walls on the plan's level
 * make that has no space yet, as proposals for the same review the drawing
 * detector uses; the accepted ones become spaces bounded by their walls in one
 * undoable step. Pure, so the hook and the tests share it.
 *
 * With a linked model's walls (`linked`), they bound rooms too. A room any
 * linked wall bounds becomes a space with that outline (it can't follow our
 * walls), recorded as found from the linked walls.
 */

export const NO_WALL_ROOMS = 'No rooms without a space are closed by walls on this level. Draw the walls around the room first, or use Room from walls to see where they leave a gap.'
export const NO_LINKED_WALL_ROOMS = "No rooms without a space are closed by walls on this level, ours or the linked model's. Check the linked model has walls at this level's height, or draw the walls around the room first."

export type WallRoomsOutcome =
  | { readonly kind: 'review'; readonly proposals: readonly ReviewedProposal[]; readonly seeds: Readonly<Record<string, Vec2>>; readonly linkedOutlines?: Readonly<Record<string, readonly Vec2[]>> }
  | { readonly kind: 'empty'; readonly message: string }

export function proposeRoomsFromWalls(model: ModelState, levelId: ElementId, linked: LinkedRoomBounds | null = null): WallRoomsOutcome {
  const found = detectRoomsFromWalls(model.elements, levelId, linked ?? undefined)
  if (found.length === 0) return { kind: 'empty', message: linked ? NO_LINKED_WALL_ROOMS : NO_WALL_ROOMS }
  const linkedOutlines = Object.fromEntries(found.filter((p) => p.linkedBoundary).map((p) => [p.key, p.outline]))
  return {
    kind: 'review',
    proposals: found.map((room) => ({ room, decision: 'pending' as const })),
    seeds: Object.fromEntries(found.map((p) => [p.key, p.seed])),
    ...(Object.keys(linkedOutlines).length > 0 ? { linkedOutlines } : {}),
  }
}

type BatchStep = Extract<Command, { type: 'batch_edits' }>['commands'][number]

/** The accepted rooms as one batch of Room from walls, numbered on from the level's highest; null when none are accepted. */
export function acceptedWallRoomsCommand(model: ModelState, levelId: ElementId, proposals: readonly ReviewedProposal[], seeds: Readonly<Record<string, Vec2>>, linkedOutlines: Readonly<Record<string, readonly Vec2[]>> = {}): Command | null {
  const accepted = proposals.filter((p) => p.decision === 'accepted' && seeds[p.room.key])
  if (accepted.length === 0) return null
  let n = Number(nextSpaceNumber(model, levelId))
  const commands = accepted.map((p): BatchStep => {
    const number = Number.isFinite(n) ? String(n++) : ''
    const seed = seeds[p.room.key] as Vec2
    const outline = linkedOutlines[p.room.key]
    if (outline) {
      // Bounded by a linked model's wall somewhere: drawn from the outline found, and it says where it came from.
      return {
        type: 'create_space',
        spaces: [{ spaceId: newElementId('space'), number, name: `Space ${number}`, levelId, outline: outline.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })), origin: { kind: 'detected', detector: LINKED_WALL_ROOM_DETECTOR_ID, confidence: 1, accepted: true } }],
      }
    }
    return { type: 'place_space_in_walls' as const, spaceId: newElementId('space'), levelId, seed: { x: Math.round(seed.x), y: Math.round(seed.y) }, number, name: `Space ${number}` }
  })
  return { type: 'batch_edits', label: accepted.length === 1 ? 'Add a room found from walls' : `Add ${accepted.length} rooms found from walls`, commands }
}
