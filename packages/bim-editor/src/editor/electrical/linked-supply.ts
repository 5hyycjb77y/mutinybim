import { resolveField, type ModelState } from '@permitzip/bim-kernel'
import { circuitServing, circuitTextMismatch, fedByLink, fedFromTextMismatch } from '@permitzip/bim-pack-electrical/host'

/**
 * What serves a part, read from its link, for the parameter that used to be typed:
 * a panel's feeder replaces its typed Fed from, a device's circuit replaces its typed Circuit.
 */
export interface LinkedSupply {
  /** The typed parameter the link replaces. */
  readonly param: 'fed_from' | 'circuit'
  /** The live text ("MDP via 225 A 3-pole breaker", "P1-1"). */
  readonly text: string
  /** The typed text when it names something else; null when it agrees or is empty. */
  readonly typedMismatch: string | null
}

/** Null when no feeder or circuit serves the part (the typed value is still all there is). */
export function linkedSupplyOf(model: ModelState | null, partId: string): LinkedSupply | null {
  if (!model) return null
  if (fedByLink(model.elements, partId)) {
    return { param: 'fed_from', text: resolveField(model.elements, partId, 'supply_from').text, typedMismatch: fedFromTextMismatch(model.elements, partId)?.typed ?? null }
  }
  if (circuitServing(model.elements, partId)) {
    return { param: 'circuit', text: resolveField(model.elements, partId, 'circuit').text, typedMismatch: circuitTextMismatch(model.elements, partId)?.typed ?? null }
  }
  return null
}
