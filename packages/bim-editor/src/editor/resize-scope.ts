import type { Command, FittingChoice, ModelState, RunSize } from '@permitzip/bim-kernel'

/**
 * What Resize changes is what is selected: one piece, a stretch, a run, a
 * branch, a system or a box. Every case is one `resize_stretch` over the
 * routed segments in the selection, so the pieces either side of it keep
 * their size and get a transition (a reducer on pipe) at the boundary.
 * `resize_run` is never sent from here: it walks every same-size piece
 * through the elbows, which is what made a split half resize the whole run.
 */
export type ResizeRequest = { readonly ok: true; readonly command: Extract<Command, { type: 'resize_stretch' }> } | { readonly ok: false; readonly reason: string }

const MAX_PIECES = 500

export function resizeRequestFor(view: Pick<ModelState, 'elements'>, ids: readonly string[], size: RunSize, idPrefix: string, transition?: FittingChoice): ResizeRequest {
  const segmentIds = ids.filter((id) => view.elements[id]?.kind === 'run_segment')
  if (segmentIds.length === 0) return { ok: false, reason: 'There is no routed duct or pipe in this selection to resize.' }
  if (segmentIds.length > MAX_PIECES) return { ok: false, reason: `That is ${segmentIds.length} pieces; resize at most ${MAX_PIECES} at once.` }
  return { ok: true, command: { type: 'resize_stretch', idPrefix, segmentIds, size, ...(transition ? { transition } : {}) } }
}
