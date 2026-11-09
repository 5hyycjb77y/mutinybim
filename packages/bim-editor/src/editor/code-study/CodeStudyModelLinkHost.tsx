'use client'

import type { ModelSession } from '../model-session'
import { useCodeStudyModelLink } from './useCodeStudyModelLink'

/** Mounts the code study's model link (select from the link, keep the snapshot) for the open model. Renders nothing. */
export function CodeStudyModelLinkHost({ projectId, modelId, session }: { readonly projectId: string; readonly modelId: string | null; readonly session: Pick<ModelSession, 'selectElement' | 'currentView'> | null }): null {
  useCodeStudyModelLink(projectId, modelId, session)
  return null
}
