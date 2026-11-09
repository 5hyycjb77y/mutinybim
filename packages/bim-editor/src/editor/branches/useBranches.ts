'use client'

import { useCallback, useEffect, useState } from 'react'
import type { BranchRef } from '@permitzip/bim-kernel'
import type { BranchRequest, BranchServerMessage } from '@permitzip/bim-sync'

/** The model socket as the branch screens use it (SyncClient implements it). */
export interface BranchChannel {
  request(msg: BranchRequest): Promise<BranchServerMessage>
  branchesAvailable(): boolean
  branch(): BranchRef | null
}

export type BranchListState =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly branches: readonly BranchRef[] }

/** One answer, or an Error carrying the server's words (a refusal) or the client's (offline, timeout). */
export async function ask<T extends BranchServerMessage['type']>(channel: BranchChannel, msg: BranchRequest, expect: T): Promise<Extract<BranchServerMessage, { type: T }>> {
  const answer = await channel.request(msg)
  if (answer.type === 'request_refused') throw new Error(answer.reason)
  if (answer.type !== expect) {
    console.error('[branches] unexpected answer', { asked: msg.type, expect, got: answer.type })
    throw new Error("The model server's answer didn't match the question. Try again.")
  }
  return answer as Extract<BranchServerMessage, { type: T }>
}

export function isOpenBranch(b: BranchRef): boolean {
  return b.state === 'open' || b.state === 'merge_proposed'
}

/**
 * The branches of the open model, from the model server. `channel` null: not
 * connected yet (loading). A server without branches: `unavailable` (the
 * picker hides). Failures show with Retry; nothing is silently empty.
 */
export function useBranches(channel: BranchChannel | null, connected: boolean) {
  const [nonce, setNonce] = useState(0)
  // The answer remembers which channel and request it answers; anything else reads as loading.
  const [answer, setAnswer] = useState<{ readonly channel: BranchChannel; readonly nonce: number; readonly state: BranchListState } | null>(null)
  const available = channel !== null && connected && channel.branchesAvailable()

  useEffect(() => {
    if (!channel || !available) return
    let live = true
    ask(channel, { type: 'branch_list' }, 'branches').then(
      (got) => live && setAnswer({ channel, nonce, state: { status: 'ready', branches: got.branches } }),
      (err: unknown) => {
        console.error('[branches] listing branches failed', err)
        if (live) setAnswer({ channel, nonce, state: { status: 'error', message: err instanceof Error ? err.message : "Couldn't list branches." } })
      },
    )
    return () => {
      live = false
    }
  }, [channel, available, nonce])

  const state: BranchListState =
    channel !== null && connected && !available ? { status: 'unavailable' } : answer && answer.channel === channel && answer.nonce === nonce ? answer.state : { status: 'loading' }

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const create = useCallback(
    async (name: string, fromRevision?: number): Promise<BranchRef> => {
      if (!channel) throw new Error('Not connected to the model server yet. Try again in a moment.')
      const answer = await ask(channel, { type: 'branch_create', name, ...(fromRevision !== undefined ? { fromRevision } : {}) }, 'branch_saved')
      reload()
      return answer.branch
    },
    [channel, reload],
  )

  const close = useCallback(
    async (branchId: string): Promise<BranchRef> => {
      if (!channel) throw new Error('Not connected to the model server yet. Try again in a moment.')
      const answer = await ask(channel, { type: 'branch_close', branchId }, 'branch_saved')
      reload()
      return answer.branch
    },
    [channel, reload],
  )

  return { state, reload, create, close }
}
