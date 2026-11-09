import { type ModelState } from '@permitzip/bim-kernel'
import { defaultCircuitDescription, isCircuitableLoad, polesForMembers } from '../connections/panel'
import { distributionOf } from '../connections/systems'
import { planAddToCircuit, planEditCircuit, type CircuitPlanResult } from './plan'

/**
 * Dropping devices on a panel (in the plan or the panel view) is Add to
 * circuit with the panel already chosen: the same plan, dry-run before the
 * drop so the hint can say what it will make or the plain reason it can't
 * ("MUA-1 needs 480 V 3-phase; L1 is 120/208 V…"). Dropped on a free slot,
 * the circuit starts there; on a circuit, they join it; anywhere else on the
 * panel, the slots that best balance its phases are chosen.
 */

/** The loads among `ids` (what a drag carries): devices and equipment with a power connector. */
export function draggableLoads(model: ModelState, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const el = model.elements[id]
    return el?.kind === 'part' && isCircuitableLoad(model.elements, el)
  })
}

export function isPanelTarget(model: ModelState, id: string | null): boolean {
  const el = id ? model.elements[id] : undefined
  return el?.kind === 'part' && distributionOf(model.elements, el) !== null
}

export interface DropTarget {
  readonly panelId: string
  /** A free slot to start at, when dropped on one. */
  readonly slot?: number
  /** A circuit to join, when dropped on one. */
  readonly linkId?: string
}

export function planCircuitDrop(model: ModelState, memberIds: readonly string[], target: DropTarget, newLinkId: string): CircuitPlanResult {
  const loads = draggableLoads(model, memberIds)
  if (loads.length === 0) return { ok: false, reason: 'Drag receptacles, lights or equipment: that has no power connection to circuit.' }
  if (target.linkId) return planAddToCircuit(model, loads, target.panelId, { kind: 'existing', linkId: target.linkId })
  const poles = polesForMembers(model.elements, loads.map((elementId) => ({ elementId })))
  if (target.slot !== undefined && poles === null) return { ok: false, reason: 'These need different breakers (1-, 2- and 3-pole loads, or one has no voltage set); drag loads that can share one circuit.' }
  const positions = target.slot !== undefined && poles !== null ? Array.from({ length: poles }, (_, i) => (target.slot as number) + 2 * i) : null
  return planAddToCircuit(model, loads, target.panelId, { kind: 'new', linkId: newLinkId, positions, ratingA: null, description: defaultCircuitDescription(model.elements, loads) })
}

/** Moving a circuit by dragging it to another free slot on the same panel. */
export function planCircuitMove(model: ModelState, linkId: string, slot: number): CircuitPlanResult {
  const link = model.elements[linkId]
  if (link?.kind !== 'service_link') return { ok: false, reason: 'That circuit is gone.' }
  const poles = Math.max(1, link.source.positions.length)
  return planEditCircuit(model, linkId, { positions: Array.from({ length: poles }, (_, i) => slot + 2 * i) })
}
