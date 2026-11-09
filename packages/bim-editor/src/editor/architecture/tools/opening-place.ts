import { hostLineOf, type BimElement, type Command, type Vec2 } from '@permitzip/bim-kernel'

/**
 * Placing a door, window or plain opening: hover a wall, the ghost follows
 * along it, Space flips which side it opens to, a click puts it in. Off a
 * wall it says why at the pointer, before any click.
 */

export type OpeningKind = 'door' | 'window' | 'opening'

const DEFAULT_WIDTH_MM: Readonly<Record<OpeningKind, number>> = { door: 915, window: 1220, opening: 1000 }
const DEFAULT_HEIGHT_MM: Readonly<Record<OpeningKind, number>> = { door: 2134, window: 1220, opening: 2134 }

export type OpeningAim =
  | { readonly ok: true; readonly hostId: string; readonly s: number; readonly at: Vec2; readonly widthMm: number }
  | { readonly ok: false; readonly reason: string }

function word(kind: OpeningKind): string {
  return kind === 'opening' ? 'An opening' : `A ${kind}`
}

/** Where the opening would go for what the pointer is over, or why it can't. */
export function aimOpening(elements: Readonly<Record<string, BimElement>>, kind: OpeningKind, hoveredIds: readonly string[], pointer: Vec2 | null, widthMm = DEFAULT_WIDTH_MM[kind]): OpeningAim {
  const refusal = { ok: false as const, reason: `${word(kind)} needs a wall to sit in; point at a wall` }
  if (!pointer) return refusal
  for (const id of hoveredIds) {
    const host = elements[id]
    const line = host ? hostLineOf(host, elements) : null
    if (!host || !line) continue
    const dx = line.end.x - line.start.x
    const dy = line.end.y - line.start.y
    const len = Math.hypot(dx, dy)
    if (len < widthMm) return { ok: false, reason: `This wall is ${Math.round(len)} mm long; a ${Math.round(widthMm)} mm ${kind} doesn't fit` }
    const along = ((pointer.x - line.start.x) * dx + (pointer.y - line.start.y) * dy) / len
    const s = Math.round(Math.min(len - widthMm / 2, Math.max(widthMm / 2, along)))
    return { ok: true, hostId: host.id, s, at: { x: line.start.x + (dx / len) * s, y: line.start.y + (dy / len) * s }, widthMm }
  }
  return refusal
}

export function placeOpening(aim: Extract<OpeningAim, { ok: true }>, kind: OpeningKind, side: 1 | -1, elementId: string, typeId?: string, mark?: string, heightMm = DEFAULT_HEIGHT_MM[kind]): Command {
  return {
    type: 'create_hosted',
    elementId,
    kind: 'opening',
    openingType: kind === 'opening' ? 'cased_opening' : kind,
    hostId: aim.hostId,
    s: aim.s,
    side,
    size: { widthMm: aim.widthMm, heightMm },
    ...(typeId ? { typeId } : {}),
    ...(mark ? { mark } : {}),
  }
}

export function openingHint(kind: OpeningKind, aim: OpeningAim | null): string {
  if (!aim) return `Point at a wall to put the ${kind} in`
  if (!aim.ok) return aim.reason
  return `Click to put the ${kind} in · Space flips the side it opens to · Esc to stop`
}
