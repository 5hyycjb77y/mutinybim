import { modelPackSet, type PackSet } from '@permitzip/bim-kernel/packs'
import type { ModelStore } from '../model-store'

/**
 * The discipline registry of the model open in `store`: the set the surface
 * bound for it (`useModelPacks`: its pins, add-on switches and pinned firm
 * disciplines). Null before a model is open or bound; pickers then fall back
 * to the built-in and first-party rows.
 */
export function openModelPackSet(store: ModelStore): PackSet | null {
  const modelId = store.getSnapshot().model?.modelId
  return modelId ? modelPackSet(modelId) : null
}
