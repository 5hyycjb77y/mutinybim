'use client'

import { useState, type ReactNode } from 'react'
import type { ModelState } from '@permitzip/bim-kernel'
import { selectModel, selectModelForZones, type ModelSelector, type ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'

/**
 * Hands `children` the open model read from `store`, so a dialog, inspector
 * field or the status bar re-renders when the model changes without the
 * surface passing its own `model` down. `zones`: the partition zones the
 * reader looks in (the status bar reads only the organization zone), so an
 * edit elsewhere skips it; omit for readers of the whole model. Read once on
 * mount; a different set needs a new mount.
 */
export function ModelFromStore({ store, zones, children }: { store: ModelStore; zones?: ReadonlySet<string>; children: (model: ModelState | null) => ReactNode }): ReactNode {
  const [selector] = useState<ModelSelector<ModelState | null>>(() => (zones ? selectModelForZones(zones) : selectModel))
  return children(useModelSelector(store, selector))
}
