'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Command, ElementId, ModelState, RatedZoneProposal } from '@permitzip/bim-kernel'
import type { RatingKindRow } from '@permitzip/bim-kernel/rated-routes'
import type { RatedPick } from './fire-areas'

// The finder and the rating kinds load on first use, off the Building Model's first download.
const loadFireAreas = () => import('./fire-areas')
type FireAreasLib = Awaited<ReturnType<typeof loadFireAreas>>

export type FireAreaDecision = 'pending' | 'added' | 'dismissed'

export interface FireAreaRow {
  readonly proposal: RatedZoneProposal
  readonly decision: FireAreaDecision
}

export type FireAreasState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'review'; readonly rows: readonly FireAreaRow[]; readonly alreadyZones: number }

export interface FireAreaControls {
  readonly state: FireAreasState
  /** Why "Fire areas from rated walls" is off, in words; null when it can run. */
  readonly reason: string | null
  /** The rating kinds that can close an area (amounts, not yes / no); empty until the first search. */
  readonly kinds: readonly RatingKindRow[]
  readonly pick: RatedPick | null
  /** Change the rating; an open review is found again with it. */
  readonly setPick: (pick: RatedPick) => void
  readonly start: () => void
  /** Adds one as a fire-area zone (one undo step); the refusal in words, or null. */
  readonly accept: (key: string) => string | null
  /** Adds every one not added or dismissed, in one undo step; the refusal in words, or null. */
  readonly acceptAll: () => string | null
  /** Leaves one out (nothing is written); again brings it back. */
  readonly dismiss: (key: string) => void
  /** Close with nothing more written. */
  readonly close: () => void
}

interface Options {
  readonly model: ModelState | null
  readonly levelId: ElementId | null
  readonly submit: (command: Command, undoLabel: string) => string | null
  readonly currentModel?: () => ModelState | null
  /** Why another plan tool keeps it off (drawing, a room review), or null. */
  readonly busyReason: string | null
}

/** The fire-area review's state: found off the render (its spinner shows), Esc closes, a plan change leaves it. */
export function useFireAreas({ model, levelId, submit, currentModel, busyReason }: Options): FireAreaControls {
  const [kinds, setKinds] = useState<readonly RatingKindRow[]>([])
  const [pick, setPickState] = useState<RatedPick | null>(null)
  const [raw, setRaw] = useState<FireAreasState>({ kind: 'idle' })
  const [startedOn, setStartedOn] = useState<ElementId | null>(null)
  const state = useMemo<FireAreasState>(() => (startedOn === levelId ? raw : { kind: 'idle' }), [raw, startedOn, levelId])
  const run = useRef(0)
  const lib = useRef<FireAreasLib | null>(null)

  const find = useCallback(
    (wanted: RatedPick | null) => {
      const now = currentModel?.() ?? model
      if (!now || !levelId) return
      const ticket = ++run.current
      setStartedOn(levelId)
      setRaw({ kind: 'loading' })
      loadFireAreas()
        .then((loaded) => {
          if (ticket !== run.current) return
          lib.current = loaded
          const found = loaded.areaRatingKinds(loaded.packSetOf(now))
          const chosen = wanted && found.some((k) => k.id === wanted.kindId) ? wanted : loaded.defaultRatedPick(found)
          setKinds(found)
          setPickState(chosen)
          if (!chosen) {
            setRaw({ kind: 'empty', message: loaded.NO_RATING_KINDS })
            return
          }
          const outcome = loaded.proposeFireAreas(now, levelId, chosen)
          setRaw(outcome.kind === 'review' ? { kind: 'review', rows: outcome.proposals.map((proposal) => ({ proposal, decision: 'pending' })), alreadyZones: outcome.alreadyZones } : outcome)
        })
        .catch((err: unknown) => {
          if (ticket !== run.current) return
          console.error('[use-fire-areas] finding fire areas failed', { levelId, pick: wanted, err })
          setRaw({ kind: 'error', message: `The fire areas couldn’t be found: ${err instanceof Error ? err.message : String(err)}` })
        })
    },
    [model, levelId, currentModel],
  )

  const close = useCallback(() => {
    run.current++
    setRaw({ kind: 'idle' })
  }, [])

  const open = state.kind !== 'idle'
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const reason = !levelId ? 'Open a floor plan to find the fire areas on its level.' : busyReason

  const add = useCallback(
    (keys: ReadonlySet<string>, label: (n: number) => string): string | null => {
      const now = currentModel?.() ?? model
      const loaded = lib.current
      if (state.kind !== 'review' || !now || !levelId || !loaded) return 'Nothing to add.'
      const chosen = state.rows.filter((r) => r.decision === 'pending' && keys.has(r.proposal.key)).map((r) => r.proposal)
      const command = loaded.fireAreaZonesCommand(now, levelId, chosen)
      if (!command) return 'Every fire area here is already added or dismissed.'
      const refused = submit(command, label(chosen.length))
      if (refused === null) {
        const added = new Set(chosen.map((p) => p.key))
        setRaw((s) => (s.kind === 'review' ? { ...s, rows: s.rows.map((r) => (added.has(r.proposal.key) ? { ...r, decision: 'added' } : r)) } : s))
      }
      return refused
    },
    [state, model, levelId, submit, currentModel],
  )

  return useMemo<FireAreaControls>(
    () => ({
      state,
      reason,
      kinds,
      pick,
      setPick: (next) => {
        setPickState(next)
        if (state.kind !== 'idle') find(next)
      },
      start: () => find(pick),
      accept: (key) => add(new Set([key]), () => 'Add fire area'),
      acceptAll: () => add(new Set(state.kind === 'review' ? state.rows.map((r) => r.proposal.key) : []), (n) => (n === 1 ? 'Add fire area' : `Add ${n} fire areas`)),
      dismiss: (key) => setRaw((s) => (s.kind === 'review' ? { ...s, rows: s.rows.map((r) => (r.proposal.key === key && r.decision !== 'added' ? { ...r, decision: r.decision === 'dismissed' ? 'pending' : 'dismissed' } : r)) } : s)),
      close,
    }),
    [state, reason, kinds, pick, find, add, close],
  )
}
