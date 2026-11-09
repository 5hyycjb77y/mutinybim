'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { linkedReferenceRules, type LinkedReferenceElement, type LinkedReferenceModel, type ModelState } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { requireAddOns } from '../../contracts/building-model/add-ons'
import { clearLinkedReference, linkedReferenceState, setLinkedReferenceError, setLinkedReferenceLoading, setLinkedReferenceModels, subscribeLinkedReference, type LinkedReferenceState } from './linked-reference-store'

/** The page's linked reference geometry, re-read when it changes. */
export function useLinkedReferenceState(): LinkedReferenceState {
  return useSyncExternalStore(subscribeLinkedReference, linkedReferenceState, linkedReferenceState)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function isElement(v: unknown): v is LinkedReferenceElement {
  return isObject(v) && typeof v.globalId === 'string' && typeof v.name === 'string' && typeof v.ifcClass === 'string' && Array.isArray(v.box) && v.box.length === 6 && v.box.every((n) => typeof n === 'number') && (v.hull === undefined || (Array.isArray(v.hull) && v.hull.every((n) => typeof n === 'number')))
}

/** The linked models in the coordination answer (`linked`), shape-checked. */
export function linkedModelsOf(body: unknown): LinkedReferenceModel[] | null {
  if (!isObject(body) || !Array.isArray(body.linked)) return null
  const out: LinkedReferenceModel[] = []
  for (const m of body.linked) {
    if (!isObject(m) || typeof m.modelId !== 'string' || typeof m.label !== 'string' || !Array.isArray(m.elements)) return null
    const elements = m.elements.filter(isElement)
    // Keyed by the link (stable across versions), so dimensions and copies survive an update; the index's own id is the version.
    out.push({ modelId: typeof m.linkId === 'string' && m.linkId.length > 0 ? m.linkId : m.modelId, version: m.modelId, label: m.label, elements })
  }
  return out
}

interface Args {
  readonly port: EditorDataHost['coordination']
  readonly projectId: string
  /** The model server's id for this model; null until it is known. */
  readonly modelId: string | null
  /** The model whose add-ons say which linked categories are references; null until it opens. */
  readonly model: ModelState | null
  /** Changes when the linked models do (added, removed, a new version): the index is read again. */
  readonly linkedKey: string
}

/**
 * Loads the linked models' element index (the same one Manage › Coordination
 * reads) and indexes it as reference geometry for the page. Mounted once by
 * the surface.
 */
export function useLinkedReferenceLoader({ port, projectId, modelId, model, linkedKey }: Args): void {
  const ready = model !== null
  useEffect(() => {
    if (!port || !modelId || !ready || linkedKey === '') {
      clearLinkedReference()
      return
    }
    let cancelled = false
    setLinkedReferenceLoading()
    port
      .read({ projectId, modelId })
      .then(async (res) => {
        const body: unknown = await res.json().catch((err: unknown) => {
          console.error('[linked-reference] the answer was not JSON', err)
          return null
        })
        if (!res.ok) throw new Error(isObject(body) && typeof body.error === 'string' ? body.error : `reading the linked models failed (HTTP ${res.status})`)
        const models = linkedModelsOf(body)
        if (!models) throw new Error('the server sent an unexpected answer')
        return models
      })
      .then((models) => {
        if (cancelled) return
        const current = model
        const rules = current ? requireAddOns().host.withPinnedPacks(current, () => linkedReferenceRules()) : undefined
        setLinkedReferenceModels(models, rules)
      })
      .catch((err: unknown) => {
        console.error('[linked-reference] loading the linked models as reference geometry failed', { projectId, modelId, err })
        if (!cancelled) setLinkedReferenceError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
    // The model object changes on every edit; the index only needs its add-ons once it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, projectId, modelId, ready, linkedKey])
  useEffect(() => () => clearLinkedReference(), [])
}
