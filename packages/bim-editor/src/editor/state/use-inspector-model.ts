'use client'

import type { ModelState } from '@permitzip/bim-kernel'
import { selectModel, type ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'

/**
 * The model the inspector shows, read from a store instead of the live
 * session while rendering. The surface keeps two: the shown model (drag
 * preview included) for the organization and diagram fields, and the
 * session's committed view (no preview) for part and run properties, which
 * is what `session.currentView()` gave them. Re-renders on every publish:
 * the inspector is one of the two panels an edit may re-render.
 */
export function useInspectorModel(store: ModelStore): ModelState | null {
  return useModelSelector(store, selectModel)
}
