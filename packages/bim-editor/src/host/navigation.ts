'use client'

import { useMemo } from 'react'
import type { EditorRouter } from '@permitzip/bim-editor-host'
import { useEditorHost } from './context'

/** Where the editor's page is and how to move within it (branch, docked schedule), through the host's router. */
export interface EditorNavigation {
  readonly router: EditorRouter
  readonly pathname: string
  readonly searchParams: URLSearchParams
}

export function useEditorNavigation(): EditorNavigation {
  const { router } = useEditorHost()
  const { pathname, search } = router.useLocation()
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  return useMemo(() => ({ router, pathname, searchParams }), [router, pathname, searchParams])
}
