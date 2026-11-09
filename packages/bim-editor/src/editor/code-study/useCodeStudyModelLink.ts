'use client'

import type { ModelSession } from '../model-session'
import type { CodeStudyBindingState } from './code-study-binder'
import { useCodeStudySnapshot } from './useCodeStudySnapshot'
import { useSelectFromUrl } from './useSelectFromUrl'

/**
 * Everything the Building Model does with PermitZIP's code study, mounted with
 * one line where the surface opens a model: bind the snapshot (and rebind on
 * focus when it changed), and select what Code Map "Show in model" asked for.
 */
export function useCodeStudyModelLink(projectId: string, modelId: string | null, session: Pick<ModelSession, 'selectElement' | 'currentView'> | null): CodeStudyBindingState {
  useSelectFromUrl(session)
  return useCodeStudySnapshot(projectId, modelId)
}
