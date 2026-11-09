'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SavedVersion } from '@permitzip/bim-kernel'
import { versionEntries, type IssuedSet, type VersionEntry } from '../../contracts/building-model/branch-versions'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { fetchSetStatusFrom } from '../views-sheets/drawing-set-client'
import { ask, type BranchChannel } from '../branches/useBranches'

export type VersionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly entries: readonly VersionEntry[]; readonly issuedError: string | null }

/**
 * Manage › Versions: saved versions and "now" from the model server, issued
 * sets from Views & Sheets' set history. An issued-set failure keeps the rest
 * of the list and says what is missing; a model-server failure shows Retry.
 */
export function useVersions(input: { readonly channel: BranchChannel | null; readonly connected: boolean; readonly projectId: string; readonly modelId: string | null; readonly names?: Readonly<Record<string, string>> }) {
  const { channel, connected, projectId, modelId, names } = input
  const drawingSets = useEditorHost().data.drawingSets
  const [nonce, setNonce] = useState(0)
  // The answer remembers which request it answers; anything else reads as loading.
  const [answer, setAnswer] = useState<{ readonly key: string; readonly channel: BranchChannel; readonly state: VersionsState } | null>(null)
  const key = `${modelId ?? ''}:${nonce}`

  useEffect(() => {
    if (!channel || !connected || !modelId) return
    let live = true
    const issued: Promise<{ readonly sets: readonly IssuedSet[]; readonly error: string | null }> = fetchSetStatusFrom(drawingSets, projectId, modelId).then(
      (status) => ({ sets: status.history.issues, error: null }),
      (err: unknown) => {
        console.error('[versions] reading issued sets failed; listing the rest', err)
        return { sets: [], error: err instanceof Error ? err.message : "Couldn't read issued sets." }
      },
    )
    Promise.all([ask(channel, { type: 'version_list' }, 'versions'), issued]).then(
      ([saved, sets]) => {
        if (!live) return
        const versions: readonly SavedVersion[] = saved.versions
        setAnswer({ key, channel, state: { status: 'ready', entries: versionEntries({ head: saved.head, saved: versions, issued: sets.sets, ...(names ? { names } : {}) }), issuedError: sets.error } })
      },
      (err: unknown) => {
        console.error('[versions] listing versions failed', err)
        if (live) setAnswer({ key, channel, state: { status: 'error', message: err instanceof Error ? err.message : "Couldn't list versions." } })
      },
    )
    return () => {
      live = false
    }
  }, [drawingSets, channel, connected, projectId, modelId, names, key])

  const state: VersionsState = answer && answer.key === key && answer.channel === channel ? answer.state : { status: 'loading' }

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const save = useCallback(
    async (name: string) => {
      if (!channel) throw new Error('Not connected to the model server yet. Try again in a moment.')
      await ask(channel, { type: 'version_save', name }, 'version_saved')
      reload()
    },
    [channel, reload],
  )

  return { state, reload, save }
}
