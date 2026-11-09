import { type ModelState } from '@permitzip/bim-kernel'
import { ElectricalLoadEngine, type LinkLoad } from '../connections/engine'
import { CONNECTED_LOAD_ONLY } from '../connections/rules'

/** Connected loads for dialogs' "what it will make" lines: the same engine as the panel view, at 100% of connected. */
const connected = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY)

/** A circuit or feeder's load as the engine counts it at its source, or null when the link or its source is gone. */
export function linkLoad(model: ModelState, linkId: string): LinkLoad | null {
  const link = model.elements[linkId]
  if (link?.kind !== 'service_link') return null
  return connected.report(model, link.source.elementId)?.links.find((l) => l.linkId === linkId) ?? null
}
