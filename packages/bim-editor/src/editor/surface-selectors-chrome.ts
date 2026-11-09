import { DOCUMENT_ZONE, ORGANIZATION_ZONE, partitionOf, type BimElement, type ModelState } from '@permitzip/bim-kernel'
import type { ModelSelector } from './model-store'

/**
 * What the Building Model surface itself reads from the model while it
 * renders (round 9 lane H9): its levels, part types, systems, the site, the
 * drawings under plans, and the documents and organization zones (views,
 * sheets, groups, phases, add-on switches). Everything else the surface
 * shows from the model (the canvas, the drawing, the Inspector, dialogs, the
 * add-on workflows, the loads chip, revision badges) reads the store itself,
 * and handlers read `store.getSnapshot().model` when they run, so a run
 * moved or routed, or a part placed does not re-render the surface.
 */
export const SURFACE_CHROME_KINDS: ReadonlySet<string> = new Set(['level', 'part_type', 'mep_system', 'site', 'drawing_underlay'])
export const SURFACE_CHROME_ZONES: ReadonlySet<string> = new Set([DOCUMENT_ZONE, ORGANIZATION_ZONE])

/** Whether a change to this element can change what the surface's own chrome shows. */
export function touchesSurfaceChrome(el: BimElement | undefined): boolean {
  if (!el) return false
  if (SURFACE_CHROME_KINDS.has(el.kind)) return true
  return SURFACE_CHROME_ZONES.has(partitionOf(el).zone)
}

/**
 * The model for the surface's chrome: the newest model when an edit touched
 * something the chrome reads (or the change is unknown, or the model, its id
 * or its settings changed), else the model it last returned. Never give the
 * result to a reader of other elements: hand those the store, or read
 * `store.getSnapshot().model` in the handler. One per surface (it remembers
 * the last snapshot it saw).
 */
export function createSurfaceChromeSelector(): ModelSelector<ModelState | null> {
  let lastVersion = -1
  return (s, prev) => {
    const follows = s.version === lastVersion + 1
    lastVersion = s.version
    const model = s.model
    if (!model || !prev || !s.changedIds || !follows) return model
    if (model.modelId !== prev.modelId || model.settings !== prev.settings) return model
    for (const id of s.changedIds) {
      const now = model.elements[id]
      const before = prev.elements[id]
      if (!now && !before) return model
      if (touchesSurfaceChrome(now) || touchesSurfaceChrome(before)) return model
    }
    return prev
  }
}

/** Whether a model is open (true from the first snapshot); flips only when the model opens or closes. */
export const selectModelReady: ModelSelector<boolean> = (s) => s.model !== null

/**
 * The model for readers of the selection (its label, totals, copy, the "+"
 * handles): the newest model when an edit touched one of `ids` (or the change
 * is unknown), else the model it last returned. Make a new one when the
 * selection changes (`useMemo` on the ids).
 */
export function createModelForIdsSelector(ids: readonly string[]): ModelSelector<ModelState | null> {
  const watched = new Set(ids)
  let lastVersion = -1
  return (s, prev) => {
    const follows = s.version === lastVersion + 1
    lastVersion = s.version
    const model = s.model
    if (!model || !prev || !s.changedIds || !follows || model.modelId !== prev.modelId) return model
    for (const id of s.changedIds) if (watched.has(id)) return model
    return prev
  }
}
