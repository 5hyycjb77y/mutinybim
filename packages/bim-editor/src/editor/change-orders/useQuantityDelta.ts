'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { changeTargetKey, hostedIds, type ChangeTarget, type ModelState } from '@permitzip/bim-kernel'
import { readQuantityDelta, type HistoryReads, type QuantityDeltaRead } from '../../contracts/bim/change-orders/delta-read'
import { ask, type BranchChannel } from '../branches/useBranches'

export type QuantityDeltaState =
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly read: QuantityDeltaRead }

/** Lane B's history reads over the model socket. */
export function channelHistoryReads(channel: BranchChannel): HistoryReads {
  return {
    async changedBetween(from, to) {
      return (await ask(channel, { type: 'changed_between', from, to }, 'changed_between_result')).ids
    },
    async stateAt(revision, ids, fromMain) {
      return (await ask(channel, { type: 'state_at', revision, ids: [...ids], ...(fromMain ? { model: 'main' as const } : {}) }, 'state_at_result')).elements
    },
  }
}

/**
 * What a version range (or this branch against Main) does to quantities, read
 * when `target` is set. One read per target; Retry asks again. Never a model
 * scan: the changed ids, then those elements and what they name.
 */
export function useQuantityDelta(channel: BranchChannel | null, model: ModelState | null, target: ChangeTarget | null) {
  const [nonce, setNonce] = useState(0)
  const key = target ? `${changeTargetKey(target)}|${target.kind === 'branch' ? target.branchHead : ''}|${nonce}` : null
  const [answer, setAnswer] = useState<{ readonly key: string; readonly state: QuantityDeltaState } | null>(null)
  const head = model?.revision ?? null
  // The head's elements, for "what a host holds now"; read through a ref so every edit's new view object doesn't restart the read.
  const elementsRef = useRef<ModelState['elements'] | null>(model?.elements ?? null)
  const targetRef = useRef<ChangeTarget | null>(target)
  useEffect(() => {
    elementsRef.current = model?.elements ?? null
    targetRef.current = target
  })

  useEffect(() => {
    const wanted = targetRef.current
    if (!wanted || !key || !channel || head === null) return
    let live = true
    readQuantityDelta(channelHistoryReads(channel), wanted, { head, onBranch: channel.branch() !== null, hostedNow: (host) => (elementsRef.current ? hostedIds(elementsRef.current, host) : []) }).then(
      (read) => live && setAnswer({ key, state: { status: 'ready', read } }),
      (err: unknown) => {
        console.error('[change-orders] reading the quantity change failed', err)
        if (live) setAnswer({ key, state: { status: 'error', message: err instanceof Error ? err.message : "Couldn't work out the quantity change." } })
      },
    )
    return () => {
      live = false
    }
  }, [channel, key, head])

  const retry = useCallback(() => setNonce((n) => n + 1), [])
  const state: QuantityDeltaState = !target ? { status: 'off' } : !channel ? { status: 'error', message: 'Not connected to the model server yet. Try again in a moment.' } : answer && answer.key === key ? answer.state : { status: 'loading' }
  return { state, retry }
}
