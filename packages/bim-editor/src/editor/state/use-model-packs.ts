'use client'

import { useEffect } from 'react'
import type { ModelState } from '@permitzip/bim-kernel'
import { addOns, requireAddOns } from '../../contracts/building-model/add-ons'

/**
 * Binds the open model to the add-ons it pins that this deployment has
 * (`INSTALLED_PACKS`, empty on live servers), so lint, schedules, calcs and
 * space uses read in the browser see the same rows the model server does.
 * Mounted once by the Building Model surface; reads also bind on first use
 * (`withPinnedPacks`), so the order of effects never matters.
 */
export function useModelPacks(model: Pick<ModelState, 'modelId' | 'settings'> | null): void {
  const modelId = model?.modelId ?? null
  useEffect(() => {
    // Idempotent: an edit that keeps the model's id and pins keeps its set.
    if (model) requireAddOns().host.bindPinnedPacks(model)
  }, [model])
  useEffect(() => {
    if (modelId === null) return
    return () => addOns()?.host.releasePinnedPacks(modelId)
  }, [modelId])
}
