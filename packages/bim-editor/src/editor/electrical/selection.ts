import { type ModelState } from '@permitzip/bim-kernel'
import { circuitReadiness, distributionOf, electricalConnections, isCircuitableLoad, memberName } from '@permitzip/bim-pack-electrical'
import type { ElectricalSelection } from './electrical-tab'

/** What of a selection the electrical workflow acts on: loads (devices, equipment with power) and distribution equipment. */
export interface ElectricalTarget {
  readonly loads: readonly string[]
  readonly panels: readonly string[]
  /** Equipment that could be circuited or fed once a field is filled in, with what to fill in. */
  readonly unready: readonly { readonly id: string; readonly reason: string }[]
}

export const NO_TARGET: ElectricalTarget = { loads: [], panels: [], unready: [] }

/** Split selected ids into loads and panels; anything else (ducts, walls, drawn items) is ignored. */
export function electricalTarget(model: ModelState | null, ids: readonly string[]): ElectricalTarget {
  if (!model) return NO_TARGET
  const loads: string[] = []
  const panels: string[] = []
  const unready: { id: string; reason: string }[] = []
  for (const id of ids) {
    const el = model.elements[id]
    if (el?.kind !== 'part') continue
    if (distributionOf(model.elements, el)) panels.push(id)
    else if (isCircuitableLoad(model.elements, el)) loads.push(id)
    else {
      const reason = circuitReadiness(model.elements, el)
      if (reason) unready.push({ id, reason })
    }
  }
  return { loads, panels, unready }
}

/** The Circuit tab's caption and counts, or null when nothing electrical is selected. */
export function ribbonElectricalSelection(model: ModelState | null, target: ElectricalTarget): ElectricalSelection | null {
  if (!model) return null
  if (target.loads.length === 0 && target.panels.length === 0) {
    if (target.unready.length === 0) return null
    const only = target.unready.length === 1 ? model.elements[target.unready[0]?.id ?? ''] : null
    return { label: only?.kind === 'part' ? memberName(model.elements, only) : `${target.unready.length} not ready to circuit`, loads: 0, circuited: 0, panels: 0, unready: target.unready.length }
  }
  const circuited = target.loads.filter((id) => electricalConnections(model.elements, id).some((c) => c.circuit !== null)).length
  const total = target.loads.length + target.panels.length
  const first = model.elements[target.loads[0] ?? target.panels[0] ?? '']
  const label = total === 1 && first?.kind === 'part' ? memberName(model.elements, first) : target.panels.length === 0 ? `${target.loads.length} devices` : target.loads.length === 0 ? `${target.panels.length} panels` : `${total} electrical`
  return { label, loads: target.loads.length, circuited, panels: target.panels.length }
}
