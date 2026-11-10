'use client'

import { useCallback, useEffect, useState } from 'react'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import type { SheetBlockReport } from '../../contracts/bim/block-reports'

export type BlockFreshnessState =
  | { readonly status: 'unavailable' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly revision: number; readonly blocks: readonly SheetBlockReport[] }

function isReport(value: unknown): value is { revision: number; blocks: SheetBlockReport[] } {
  if (typeof value !== 'object' || value === null) return false
  return 'revision' in value && typeof value.revision === 'number' && 'blocks' in value && Array.isArray(value.blocks)
}

function errorOf(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : null
}

/**
 * Live blocks on sheets against their latest issue, read again whenever the
 * saved model's revision moves (an edit can change a load summary).
 * A host without the optional blocks service cannot check issues; that is
 * unavailable, not a failed request.
 */
export function useBlockFreshnessFrom(port: EditorDataHost['blocks'], projectId: string, modelId: string, sheets: readonly string[], revision: number): BlockFreshnessState & { readonly retry: () => void } {
  const [state, setState] = useState<BlockFreshnessState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const sheetKey = sheets.join(',')
  useEffect(() => {
    if (!port) return
    const ctrl = new AbortController()
    port
      .freshness({ projectId, modelId, sheets: sheetKey }, { signal: ctrl.signal })
      .then(async (res) => {
        const body: unknown = await res.json().catch((err: unknown) => {
          console.error('[useBlockFreshness] response was not JSON', err)
          return null
        })
        if (!res.ok) throw new Error(errorOf(body) ?? `The server answered ${res.status}.`)
        if (!isReport(body)) throw new Error('The server sent an answer this page cannot read.')
        setState({ status: 'ready', revision: body.revision, blocks: body.blocks })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        console.error('[useBlockFreshness] load failed', err)
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' })
      })
    return () => ctrl.abort()
  }, [port, projectId, modelId, sheetKey, revision, attempt])
  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])
  if (!port) return { status: 'unavailable', retry }
  return { ...state, retry }
}
