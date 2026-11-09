'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BimElement } from '@permitzip/bim-kernel'
import { STATE_AT_MAX_IDS } from '@permitzip/bim-sync/branch-limits'
import { ask, type BranchChannel } from './useBranches'

export type MainCompareState =
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready'
      /** Main's head revision the comparison read. */
      readonly mainRevision: number
      /** The asked elements as they are on Main (null: not on Main). */
      readonly main: Readonly<Record<string, BimElement | null>>
      /** Ids that differ between Main and this branch (either side changed them). */
      readonly changed: ReadonlySet<string>
    }

/**
 * "Show Main beside" (a schedule's Main column) and "Re-opened against Main"
 * (the Checklist) read through this: Main's records for the rows on screen and
 * which ids differ, from the model server's history reads. Only on a branch;
 * one request per toggle or page of ids, never a model scan.
 */
export function useMainCompare(channel: BranchChannel | null, enabled: boolean, ids: readonly string[]) {
  const [nonce, setNonce] = useState(0)
  const asked = useMemo(() => [...new Set(ids)].slice(0, STATE_AT_MAX_IDS), [ids])
  const key = `${nonce}:${asked.join(',')}`
  const [answer, setAnswer] = useState<{ readonly key: string; readonly state: MainCompareState } | null>(null)
  const onBranch = enabled && channel !== null && channel.branch() !== null

  useEffect(() => {
    if (!onBranch || !channel) return
    let live = true
    Promise.all([
      ask(channel, { type: 'state_at', model: 'main', revision: 'head', ids: asked }, 'state_at_result'),
      ask(channel, { type: 'changed_between', from: { model: 'main', revision: 'head' }, to: 'head' }, 'changed_between_result'),
    ]).then(
      ([main, changed]) => live && setAnswer({ key, state: { status: 'ready', mainRevision: main.revision, main: main.elements, changed: new Set(changed.ids) } }),
      (err: unknown) => {
        console.error('[branches] comparing with Main failed', err)
        if (live) setAnswer({ key, state: { status: 'error', message: err instanceof Error ? err.message : "Couldn't compare with Main." } })
      },
    )
    return () => {
      live = false
    }
  }, [onBranch, channel, asked, key])

  const retry = useCallback(() => setNonce((n) => n + 1), [])
  const state: MainCompareState = !onBranch ? { status: 'off' } : answer?.key === key ? answer.state : { status: 'loading' }
  return { state, retry }
}
