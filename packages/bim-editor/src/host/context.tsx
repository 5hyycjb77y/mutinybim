'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { EditorHost } from '@permitzip/bim-editor-host'

const EditorHostContext = createContext<EditorHost | null>(null)

/** Gives the editor below it its host (a hosting app, the standalone app, …). */
export function EditorHostProvider({ host, children }: { readonly host: EditorHost; readonly children?: ReactNode }) {
  return <EditorHostContext.Provider value={host}>{children}</EditorHostContext.Provider>
}

/** The host the editor runs in. Throws when the editor was mounted without one: that is a wiring bug, not a state to draw. */
export function useEditorHost(): EditorHost {
  const host = useContext(EditorHostContext)
  if (!host) throw new Error('The Building Model editor was mounted without an EditorHostProvider.')
  return host
}

/** The host, or null where the editor may also render without one (while screens move behind the provider). */
export function useOptionalEditorHost(): EditorHost | null {
  return useContext(EditorHostContext)
}
