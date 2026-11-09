'use client'

import { useMemo, useState } from 'react'
import { DOCUMENT_ZONE, documentIndex, type DocumentIndex, type ModelState } from '@permitzip/bim-kernel'
import { selectModel, selectModelForZones, type ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'

const DOCUMENT_ZONES: ReadonlySet<string> = new Set([DOCUMENT_ZONE])

/**
 * The model as the documents zone last saw it: refreshed only when a view,
 * sheet, viewport or drawing item changes. Only for readers of that zone
 * (`documentIndex`, the pictures placed on sheets); never for anything that
 * reads ducts, parts or levels.
 */
export function useDocumentsModel(store: ModelStore): ModelState | null {
  // Incremental selectors remember the last snapshot they saw: one per reader, kept for the store's life.
  const [selector] = useState(() => selectModelForZones(DOCUMENT_ZONES))
  return useModelSelector(store, selector)
}

/** Views, sheets and what is placed on them; the same object while no document changes (a duct move keeps it). */
export function useDocumentIndex(store: ModelStore): DocumentIndex | null {
  const documents = useDocumentsModel(store)
  return useMemo(() => (documents ? documentIndex(documents) : null), [documents])
}

/** The whole model, for canvas readers that draw everything (the sheet engine, the 3D crop box, the origin marker, the schedule grid). */
export function useCanvasModel(store: ModelStore): ModelState | null {
  return useModelSelector(store, selectModel)
}
