import {
  buildLinkedReferenceIndex,
  linkedSnapCandidates,
  publishLinkedReferenceIndex,
  withdrawLinkedReferenceSources,
  REFERENCE_PLAN_HEIGHT_MM,
  type LinkedReferenceIndex,
  type LinkedReferenceModel,
  type LinkedReferenceRules,
  type ModelState,
  type ReferenceSnapCandidates,
  type Vec2,
} from '@permitzip/bim-kernel'

/**
 * The page's linked models as reference geometry, for every tool that snaps
 * (Wall, Draw space, Route, Place, Dimension) and for Find rooms from walls:
 * one index per loaded set of linked models, read by plan cell. A plain
 * store (not React) because the 3D session reads it on pointer moves.
 *
 * The state says, in words, why there is nothing to snap to: no linked
 * model, still reading it, or it has no walls at this height.
 */

export type LinkedReferenceState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly index: LinkedReferenceIndex }

let state: LinkedReferenceState = { status: 'none' }
const listeners = new Set<() => void>()

export function linkedReferenceState(): LinkedReferenceState {
  return state
}

export function subscribeLinkedReference(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function set(next: LinkedReferenceState): void {
  const before = state
  state = next
  // Dimensions follow linked elements through the kernel's catalogue.
  if (before.status === 'ready' && (next.status !== 'ready' || next.index !== before.index)) withdrawLinkedReferenceSources(before.index.sources.map((s) => s.id))
  if (next.status === 'ready') publishLinkedReferenceIndex(next.index)
  for (const l of listeners) l()
}

export function setLinkedReferenceLoading(): void {
  set({ status: 'loading' })
}

export function setLinkedReferenceError(message: string): void {
  set({ status: 'error', message })
}

export function clearLinkedReference(): void {
  set({ status: 'none' })
}

/** Index these linked models (none: there is nothing linked). */
export function setLinkedReferenceModels(models: readonly LinkedReferenceModel[], rules?: LinkedReferenceRules): void {
  if (models.length === 0) {
    set({ status: 'none' })
    return
  }
  set({ status: 'ready', index: rules ? buildLinkedReferenceIndex(models, rules) : buildLinkedReferenceIndex(models) })
}

/** The height a level's plan reads linked geometry at (its usual cut), or null when the level isn't in the model. */
export function linkedPlanHeight(model: Pick<ModelState, 'elements'> | null, levelId: string | null): number | null {
  const level = model && levelId ? model.elements[levelId] : undefined
  return level?.kind === 'level' ? level.elevationMm + REFERENCE_PLAN_HEIGHT_MM : null
}

/** The linked snap candidates near a plan point on a level, or null when no linked geometry is loaded. */
export function linkedSnapNear(model: Pick<ModelState, 'elements'> | null, levelId: string | null, at: Vec2, reachMm: number): ReferenceSnapCandidates | null {
  const s = state
  if (s.status !== 'ready') return null
  const zMm = linkedPlanHeight(model, levelId)
  if (zMm === null) return null
  return linkedSnapCandidates(s.index, { at, reachMm, zMm })
}

/** Plain words for where linked geometry stands, for a tool's hint or a side list. */
export function linkedReferenceWords(s: LinkedReferenceState): string | null {
  switch (s.status) {
    case 'none':
      return null
    case 'loading':
      return 'Still reading the linked model; its walls snap once it has loaded.'
    case 'error':
      return `The linked model's walls can't be snapped to: ${s.message}`
    case 'ready':
      return s.index.items.length === 0 ? `${s.index.sources.map((x) => x.label).join(', ')} has no walls or columns to snap to.` : null
  }
}
