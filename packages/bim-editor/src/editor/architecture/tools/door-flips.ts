import { elementsOfKind, elementValueSource, type BimElement, type Command, type ParamValue } from '@permitzip/bim-kernel'
import { DOOR_HANDING_KEY, DOOR_OPERATION_KEY, DOOR_SWING_KEY, flipDoorOperation, resolveDoorOperation, resolveDoorSide } from '@permitzip/bim-pack-architecture'

/**
 * A placed door's two flips (Revit's flip arrows), as edits: Flip hinge moves
 * the hinge/hand to the other jamb (left ↔ right for single swing, double-acting,
 * swing+fixed, sliding, and folding doors), Flip swing opens it to the other
 * side of the wall. And the mark a new door or window takes, so it is tagged in
 * the live plan from the click that makes it.
 */

/** The instance value the kernel writes for the side of the wall an opening faces (`create_hosted`'s `side`). */
const HOST_SIDE_KEY = 'host.side'

type Elements = Readonly<Record<string, BimElement>>

const HANDING_SWING_FLIP: Readonly<Record<string, string>> = { LH: 'LHR', LHR: 'LH', RH: 'RHR', RHR: 'RH' }
const HANDING_HINGE_FLIP: Readonly<Record<string, string>> = { LH: 'RH', RH: 'LH', LHR: 'RHR', RHR: 'LHR' }

export function doorFlipCommand(elements: Elements, el: BimElement, which: 'hinge' | 'swing'): Command | string {
  if (el.kind !== 'opening' || el.openingType !== 'door') return 'Select one door to flip it.'
  if (which === 'swing') {
    const side = resolveDoorSide(el, elements)
    const nextSide = side === 1 ? -1 : 1
    const values: Record<string, ParamValue | null> = { [HOST_SIDE_KEY]: nextSide }
    const curSwing = elementValueSource(elements, el, DOOR_SWING_KEY)?.value
    if (typeof curSwing === 'string') values[DOOR_SWING_KEY] = nextSide === -1 ? 'OUTWARD' : 'INWARD'
    const curHanding = elementValueSource(elements, el, DOOR_HANDING_KEY)?.value
    if (typeof curHanding === 'string' && HANDING_SWING_FLIP[curHanding.toUpperCase()]) {
      values[DOOR_HANDING_KEY] = HANDING_SWING_FLIP[curHanding.toUpperCase()]!
    }
    return { type: 'set_element_values', elementIds: [el.id], values }
  }
  const op = resolveDoorOperation(el, elements)
  const flipped = flipDoorOperation(op)
  if (!flipped) return 'This door is symmetric (pair, overhead, or revolving): there is no hinge side to flip. Flip swing still changes the side it opens to.'
  const values: Record<string, ParamValue | null> = { [DOOR_OPERATION_KEY]: flipped }
  const curHanding = elementValueSource(elements, el, DOOR_HANDING_KEY)?.value
  if (typeof curHanding === 'string' && HANDING_HINGE_FLIP[curHanding.toUpperCase()]) {
    values[DOOR_HANDING_KEY] = HANDING_HINGE_FLIP[curHanding.toUpperCase()]!
  }
  return { type: 'set_element_values', elementIds: [el.id], values }
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
