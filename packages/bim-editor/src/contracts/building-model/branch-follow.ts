/**
 * The Building Model page follows the branch its thread's agent works on.
 *
 * The rule (round 8b): the page follows the thread's bookmark branch when
 * that bookmark moves, unless the person picked a branch on this page since
 * the page last saw the bookmark; then the person's pick wins and the page
 * says what the agent did instead. The page never moves on first sight (the
 * address the person opened wins), and never because of its own navigation.
 *
 * Why it matters: the agent edits the branch named in the thread's durable
 * bookmark, and this page's address is what the bookmark tracker saves. A
 * page left on Main after the agent started a branch would, on the person's
 * next click, write Main back into the bookmark and quietly send the agent's
 * next edits to Main.
 */

export interface FollowState {
  /** The thread's bookmark branch the page expects (null: Main); undefined: not read yet. */
  readonly seen: string | null | undefined
  /** The person picked a branch on this page and its echo hasn't come back in the bookmark yet. */
  readonly chosenSince: boolean
}

export const FOLLOW_START: FollowState = { seen: undefined, chosenSince: false }

export type FollowDecision =
  | { readonly kind: 'stay' }
  | { readonly kind: 'follow'; readonly branchId: string | null }
  /** The thread was elsewhere but the person picked since: their pick stays, and the thread follows the page from now on. */
  | { readonly kind: 'tell'; readonly branchId: string | null }

const settled = (thread: string | null): FollowState => ({ seen: thread, chosenSince: false })

/**
 * What the page does when it learns the thread's bookmark branch. `seen`
 * undefined (the first read on opening) never moves the page: the address
 * the person opened wins, and the bookmark tracker then saves it.
 */
export function decideFollow(state: FollowState, page: string | null, thread: string | null): { readonly decision: FollowDecision; readonly next: FollowState } {
  if (state.seen === undefined || thread === state.seen || thread === page) return { decision: { kind: 'stay' }, next: settled(thread) }
  if (state.chosenSince) return { decision: { kind: 'tell', branchId: thread }, next: settled(thread) }
  return { decision: { kind: 'follow', branchId: thread }, next: settled(thread) }
}

/** An agent's tool card on this screen said the thread moved: decide as if the page had last seen its own branch. */
export function decideAnnounced(state: FollowState, page: string | null, thread: string | null): { readonly decision: FollowDecision; readonly next: FollowState } {
  return decideFollow(state.seen === undefined ? { seen: page, chosenSince: state.chosenSince } : state, page, thread)
}

/** The person picked a branch on the page (picker, Back to Main, New branch, a version): the bookmark will echo it. */
export function notePersonChose(_state: FollowState, pick: string | null): FollowState {
  return { seen: pick, chosenSince: true }
}

export const THREAD_BRANCH_EVENT = 'permitzip:bim-thread-branch'

export interface ThreadBranchDetail {
  readonly branchId: string | null
}

function isThreadBranchDetail(value: unknown): value is ThreadBranchDetail {
  return typeof value === 'object' && value !== null && 'branchId' in value && (value.branchId === null || typeof value.branchId === 'string')
}

/** A tool card saw this thread's agent start (or leave) a branch: tell the page on this screen at once. */
export function announceThreadBranch(branchId: string | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ThreadBranchDetail>(THREAD_BRANCH_EVENT, { detail: { branchId } }))
}

/** Listen for `announceThreadBranch`; returns the unsubscribe. */
export function onThreadBranchAnnounced(listener: (branchId: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handle = (event: Event) => {
    const detail = event instanceof CustomEvent ? (event as CustomEvent<unknown>).detail : null
    if (isThreadBranchDetail(detail)) listener(detail.branchId)
    else console.error('[branch-follow] ignored a thread branch event without a branch', { detail })
  }
  window.addEventListener(THREAD_BRANCH_EVENT, handle)
  return () => window.removeEventListener(THREAD_BRANCH_EVENT, handle)
}
