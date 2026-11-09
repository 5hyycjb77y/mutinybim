'use client'

import { useSyncExternalStore } from 'react'

/** What the surface's header and ribbon read from the live session: the sync channel and its branch and features. */
export interface SessionChromeChannel<B extends { readonly branchId: string; readonly name: string }> {
  branch(): B | null
  branchesAvailable(): boolean
  mergeAvailable(): boolean
}

export interface SessionChromeSource<C extends SessionChromeChannel<B>, B extends { readonly branchId: string; readonly name: string }> {
  editPausedReason(): string | null
  syncChannel(): C | null
}

export interface SessionChrome<C, B> {
  /** Why edits are paused (offline, reconnecting with edits waiting); null while they flow. */
  readonly editPaused: string | null
  readonly channel: C | null
  /** The branch the session is on; null on Main. */
  readonly branch: B | null
  readonly branchesAvailable: boolean
  readonly mergeAvailable: boolean
}

/**
 * The session's own state the surface shows (edits paused, the branch, merge
 * available), as an external store. The surface calls `notify()` from every
 * session event (status, save state, problems, branch changes, models); the
 * snapshot is recomputed there and replaced only when a value changed, so the
 * page updates when one of these changes and never because an edit happened.
 */
export class SessionChromeStore<C extends SessionChromeChannel<B>, B extends { readonly branchId: string; readonly name: string }> {
  private source: SessionChromeSource<C, B> | null = null
  private snapshot: SessionChrome<C, B> = EMPTY
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): SessionChrome<C, B> => this.snapshot

  /** The session the values come from (null when it closes). */
  setSource(source: SessionChromeSource<C, B> | null): void {
    this.source = source
    this.notify()
  }

  /** Re-read the session; listeners hear only a real change. */
  notify(): void {
    const next = read(this.source)
    if (sameChrome(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

const EMPTY: SessionChrome<never, never> = { editPaused: null, channel: null, branch: null, branchesAvailable: false, mergeAvailable: false }

function read<C extends SessionChromeChannel<B>, B extends { readonly branchId: string; readonly name: string }>(source: SessionChromeSource<C, B> | null): SessionChrome<C, B> {
  if (!source) return EMPTY
  const channel = source.syncChannel()
  return {
    editPaused: source.editPausedReason(),
    channel,
    branch: channel?.branch() ?? null,
    branchesAvailable: channel?.branchesAvailable() ?? false,
    mergeAvailable: channel?.mergeAvailable() ?? false,
  }
}

function sameBranch(a: { readonly branchId: string; readonly name: string } | null, b: { readonly branchId: string; readonly name: string } | null): boolean {
  return a === b || (a !== null && b !== null && a.branchId === b.branchId && a.name === b.name)
}

function sameChrome<C, B extends { readonly branchId: string; readonly name: string }>(a: SessionChrome<C, B>, b: SessionChrome<C, B>): boolean {
  return a.editPaused === b.editPaused && a.channel === b.channel && sameBranch(a.branch, b.branch) && a.branchesAvailable === b.branchesAvailable && a.mergeAvailable === b.mergeAvailable
}

/** Read the session's chrome values; re-renders only when one of them changes. */
export function useSessionChrome<C extends SessionChromeChannel<B>, B extends { readonly branchId: string; readonly name: string }>(store: SessionChromeStore<C, B>): SessionChrome<C, B> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
