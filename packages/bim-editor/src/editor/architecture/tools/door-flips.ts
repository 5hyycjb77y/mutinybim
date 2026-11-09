import { elementsOfKind, elementValueSource, type BimElement, type Command } from '@permitzip/bim-kernel'
import { DOOR_OPERATION_KEY } from '@permitzip/bim-pack-architecture'

/**
 * A placed door's two flips (Revit's flip arrows), as edits: Flip hinge moves
 * the hinge to the other jamb (left ↔ right), Flip swing opens it to the
 * other side of the wall. And the mark a new door or window takes, so it is
 * tagged in the live plan from the click that makes it.
 */

/** The instance value the kernel writes for the side of the wall an opening faces (`create_hosted`'s `side`). */
const HOST_SIDE_KEY = 'host.side'
const DEFAULT_OPERATION = 'SINGLE_SWING_LEFT'

type Elements = Readonly<Record<string, BimElement>>

export function doorFlipCommand(elements: Elements, el: BimElement, which: 'hinge' | 'swing'): Command | string {
  if (el.kind !== 'opening' || el.openingType !== 'door') return 'Select one door to flip it.'
  if (which === 'swing') {
    const side = elementValueSource(elements, el, HOST_SIDE_KEY)?.value === -1 ? -1 : 1
    return { type: 'set_element_values', elementIds: [el.id], values: { [HOST_SIDE_KEY]: side === 1 ? -1 : null } }
  }
  const op = String(elementValueSource(elements, el, DOOR_OPERATION_KEY)?.value ?? DEFAULT_OPERATION)
  if (op === 'SINGLE_SWING_LEFT') return { type: 'set_element_values', elementIds: [el.id], values: { [DOOR_OPERATION_KEY]: 'SINGLE_SWING_RIGHT' } }
  if (op === 'SINGLE_SWING_RIGHT') return { type: 'set_element_values', elementIds: [el.id], values: { [DOOR_OPERATION_KEY]: 'SINGLE_SWING_LEFT' } }
  return 'This door has a leaf on each jamb, or slides: there is no hinge side to flip. Flip swing still changes the side it opens to.'
}

const PREFIX: Readonly<Record<string, string>> = { door: 'D', window: 'W' }

/** The next free mark for a new door (D1, D2, …) or window (W1, …); empty for a plain opening. */
export function nextOpeningMark(elements: Elements, openingType: string): string {
  const prefix = PREFIX[openingType]
  if (!prefix) return ''
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  let top = 0
  for (const o of elementsOfKind(elements, 'opening')) {
    const n = pattern.exec(o.mark.trim())?.[1]
    if (n !== undefined) top = Math.max(top, Number(n))
  }
  return `${prefix}${top + 1}`
}
