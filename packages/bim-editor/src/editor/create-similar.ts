'use client'

import { useEffect, useRef } from 'react'
import type { BimElement, PartInstance, RunFitting, RunSegment } from '@permitzip/bim-kernel'

/**
 * Create similar (review video V1 1:37: "a similar CS command for any time I select
 * something, it should just create the similar thing at the same elevation").
 * One command for every trade: it starts the tool that makes another of the
 * selected thing, already set to match it. Nothing is created until the
 * person clicks, so Esc backs out like any other tool.
 *
 * - a pipe, duct or fitting: Route (pipe or duct) with its system, size,
 *   material, insulation and height (the same path as "Route another like this");
 * - a part: Place part with its type, on its level, at its mounting height.
 *
 * Agents reproduce it with the tools they already have (read the element, then
 * `bim_route_run` / `bim_place_part` with the same values); see the
 * mutinybim-ducts-pipes skill.
 */
export type SimilarStart =
  | { readonly kind: 'route'; readonly element: RunSegment | RunFitting }
  | { readonly kind: 'place'; readonly part: PartInstance }
  | { readonly kind: 'refused'; readonly reason: string }

export function similarStartFor(el: BimElement | null): SimilarStart {
  if (!el) return { kind: 'refused', reason: 'Select a pipe, duct or part first, then press C S to start another like it.' }
  switch (el.kind) {
    case 'run_segment':
    case 'run_fitting':
      return el.domain === 'conduit' ? { kind: 'refused', reason: "Conduit can't be routed from the Route panel yet, so there is nothing to start." } : { kind: 'route', element: el }
    case 'part':
      return { kind: 'place', part: el }
    default:
      return { kind: 'refused', reason: 'Create similar works on pipe, duct, fittings and parts. Select one of those.' }
  }
}

/** How long after C the S still counts as Create similar (ms). */
export const CHORD_MS = 1200

/** Tracks the two-key chord C then S. `press` says when the chord completes; any other key in between breaks it. */
export class CreateSimilarChord {
  private armedAt: number | null = null

  press(key: string, now: number): boolean {
    const k = key.toLowerCase()
    if (k === 'c') {
      this.armedAt = now
      return false
    }
    const done = k === 's' && this.armedAt !== null && now - this.armedAt <= CHORD_MS
    this.armedAt = null
    return done
  }
}

function typingInField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

export interface CreateSimilarOptions {
  /** Editing is live, the model view (not a sheet) is showing, and the Select tool is on. */
  readonly active: boolean
  readonly selected: BimElement | null
  /** Route tool preloaded from a run piece ("Route another like this"). */
  readonly routeLike: (el: RunSegment | RunFitting) => void
  /** Place tool preloaded from a part: its type, level and height. Null when started, else why not. */
  readonly placeLike: (part: PartInstance) => string | null
  readonly onHint: (text: string) => void
}

/** Start Create similar for the selection; a refusal goes to the status line in plain words. */
export function runCreateSimilar(opts: Omit<CreateSimilarOptions, 'active'>): void {
  const start = similarStartFor(opts.selected)
  if (start.kind === 'route') opts.routeLike(start.element)
  else if (start.kind === 'place') {
    const refused = opts.placeLike(start.part)
    if (refused) opts.onHint(refused)
  } else opts.onHint(start.reason)
}

/**
 * Keyboard C then S runs Create similar. Listens in the capture phase so the
 * S doesn't also switch to Split; a lone S still does.
 */
export function useCreateSimilar(opts: CreateSimilarOptions): () => void {
  const latest = useRef(opts)
  useEffect(() => {
    latest.current = opts
  })
  useEffect(() => {
    const chord = new CreateSimilarChord()
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typingInField(e.target) || !latest.current.active) return
      if (!chord.press(e.key, e.timeStamp)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      runCreateSimilar(latest.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return () => runCreateSimilar(opts)
}
