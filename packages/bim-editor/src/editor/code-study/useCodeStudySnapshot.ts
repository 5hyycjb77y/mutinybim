'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { bindCodeStudySnapshot, unbindCodeStudySnapshot } from './bind-snapshot'
import { CodeStudyBinder, type CodeStudyBinderDeps, type CodeStudyBindingState } from './code-study-binder'

/** The binder's reads through the host's code-study port (the client module loads on first use). */
function hostDeps(port: EditorDataHost['codeStudy']): CodeStudyBinderDeps {
  return {
    fetchSnapshot: (projectId) => import('./code-study-client').then((m) => m.fetchCodeStudySnapshotFrom(port, projectId)),
    fetchRevision: (projectId) => import('./code-study-client').then((m) => m.fetchCodeStudyRevisionFrom(port, projectId)),
    bind: bindCodeStudySnapshot,
    unbind: unbindCodeStudySnapshot,
  }
}

/**
 * Binds the project's PermitZIP code study to the open model, and rebinds it
 * when the window comes back into focus and the code study changed meanwhile.
 * A failure is said once in a toast (and logged); someone without code-study
 * access simply sees no PermitZIP requirements.
 */
export function useCodeStudySnapshot(projectId: string, modelId: string | null, override?: CodeStudyBinderDeps): CodeStudyBindingState {
  const port = useOptionalEditorHost()?.data.codeStudy
  const fromHost = useMemo(() => hostDeps(port), [port])
  const deps = override ?? fromHost
  const [state, setState] = useState<CodeStudyBindingState>({ status: 'idle' })
  const binderRef = useRef<CodeStudyBinder | null>(null)
  const lastToast = useRef<string | null>(null)

  useEffect(() => {
    const binder = new CodeStudyBinder(projectId, deps, (next) => {
      setState(next)
      if (next.status === 'error' && lastToast.current !== next.reason) {
        lastToast.current = next.reason
        toast.error(`The PermitZIP code study didn't load into the model: ${next.reason} It will try again when you come back to this window.`)
      }
      if (next.status === 'bound') lastToast.current = null
    })
    binderRef.current = binder
    return () => {
      binder.dispose()
      binderRef.current = null
    }
  }, [projectId, deps])

  useEffect(() => {
    const binder = binderRef.current
    if (!binder || modelId === null) return
    void binder.open(modelId)
    return () => binder.close()
  }, [projectId, deps, modelId])

  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'hidden') return
      void binderRef.current?.check()
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return state
}
