'use client'

import type { EditorLinkProps } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from './context'

/** A link through the host's own link component (client-side navigation), or a plain anchor when it has none. */
export function HostLink(props: EditorLinkProps) {
  const HostOwnLink = useOptionalEditorHost()?.shell.Link
  if (HostOwnLink) return <HostOwnLink {...props} />
  const { prefetch: _prefetch, ...anchor } = props
  return <a {...anchor} />
}

export default HostLink
