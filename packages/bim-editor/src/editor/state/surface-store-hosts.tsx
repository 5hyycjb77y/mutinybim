'use client'

import type { ReactNode } from 'react'
import type { AuthorRef } from '@permitzip/bim-kernel'
import { selectModel, type ModelStore } from '../model-store'
import { useModelSelector } from '../use-model-selector'
import { useStaleAnswerNotices } from '../questions/use-stale-answer-notices'

/**
 * The bell's "may no longer hold" notices, watching every edit from the
 * store, mounted by the surface so the surface itself doesn't re-render on
 * each edit. Draws nothing.
 */
export function StaleAnswerNoticesHost({ store, me, projectId, modelId }: { readonly store: ModelStore; readonly me: AuthorRef | null; readonly projectId: string; readonly modelId: string | null }): ReactNode {
  const model = useModelSelector(store, selectModel)
  useStaleAnswerNotices({ model, me, projectId, modelId })
  return null
}
