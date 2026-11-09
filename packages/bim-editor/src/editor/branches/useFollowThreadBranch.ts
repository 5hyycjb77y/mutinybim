'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import type { EditorAgentHost, EditorDataHost } from '@permitzip/bim-editor-host'
import { FOLLOW_START, decideAnnounced, decideFollow, notePersonChose, onThreadBranchAnnounced, type FollowDecision, type FollowState } from '../../contracts/building-model/branch-follow'

export const FOLLOWING_AGENT = "Following this thread's agent onto its branch. Main is not changed; Back to Main is on the banner."
export const FOLLOWING_AGENT_TO_MAIN = "This thread's agent went back to Main, so the page did too."
export const KEPT_YOUR_PICK = "You picked a different branch than this thread's agent was on. Your pick stays, and the agent now works where you are."

const noThreads = () => () => {}

/** The active thread on this project that the person owns (its bookmark is what the agent follows), or null. None without a built-in agent. */
function useOwnThreadOn(agent: EditorAgentHost | undefined, projectId: string): string | null {
  return useSyncExternalStore(
    agent ? agent.subscribe : noThreads,
    () => (agent ? agent.ownThreadIdOn(projectId) : null),
    () => null,
  )
}

/**
 * The Building Model page follows the branch its thread's agent works on
 * (rule in lib/building-model/branch-follow.ts). Learns it two ways: a tool
 * card on this screen announcing a started branch (at once), and the
 * thread's bookmark read when the page regains focus (the agent ran while
 * the person was elsewhere). `navigate` moves the page; a pick the person
 * makes on the page goes through `personChose`.
 */
export function useFollowThreadBranchFrom(
  host: { readonly agent: EditorAgentHost | undefined; readonly threadBranch: EditorDataHost['threadBranch'] },
  input: { readonly projectId: string; readonly pageBranch: string | null; readonly navigate: (branchId: string | null) => void },
) {
  const { agent, threadBranch } = host
  const { projectId, pageBranch, navigate } = input
  const threadId = useOwnThreadOn(agent, projectId)
  const state = useRef<FollowState>(FOLLOW_START)
  const page = useRef(pageBranch)
  useEffect(() => {
    page.current = pageBranch
  }, [pageBranch])

  const act = useCallback(
    (decision: FollowDecision) => {
      if (decision.kind === 'follow') {
        navigate(decision.branchId)
        toast.info(decision.branchId ? FOLLOWING_AGENT : FOLLOWING_AGENT_TO_MAIN)
      } else if (decision.kind === 'tell') {
        toast.info(KEPT_YOUR_PICK)
      }
    },
    [navigate],
  )

  const personChose = useCallback((pick: string | null) => {
    state.current = notePersonChose(state.current, pick)
  }, [])

  useEffect(() => {
    if (!threadId) return
    let live = true
    const read = () => {
      // Without the host's bookmark reader the page follows only what this screen announces.
      if (!threadBranch) return
      threadBranch
        .read({ projectId, threadId })
        .then(async (res) => {
          const body: unknown = await res.json()
          if (!res.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`)
          const branchId = typeof body === 'object' && body !== null && 'branchId' in body && (body.branchId === null || typeof body.branchId === 'string') ? body.branchId : null
          if (!live) return
          const { decision, next } = decideFollow(state.current, page.current, branchId)
          state.current = next
          act(decision)
        })
        .catch((err: unknown) => console.error("[building-model] reading the thread's open branch failed; the page stays where it is", { projectId, threadId, err }))
    }
    read()
    const onVisible = () => {
      if (document.visibilityState === 'visible') read()
    }
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', onVisible)
    const stopListening = onThreadBranchAnnounced((branchId) => {
      const { decision, next } = decideAnnounced(state.current, page.current, branchId)
      state.current = next
      act(decision)
    })
    return () => {
      live = false
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', onVisible)
      stopListening()
    }
  }, [threadId, threadBranch, projectId, act])

  return { personChose }
}
