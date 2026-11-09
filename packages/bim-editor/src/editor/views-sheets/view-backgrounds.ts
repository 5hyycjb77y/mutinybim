'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { isReferencePlan, type Level, type SheetReference, type ViewBackgrounds, type ViewElement } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { backgroundCutFor, sheetReferenceOf, type ViewBackgroundCut } from '../../contracts/building-model/view-background-request'

/**
 * Linked-model backgrounds for the drawing views on screen: each plan's cut of
 * the linked models at its level, each section's cut along its line, fetched
 * once per distinct cut and shared by the sheet canvas, the printed preview
 * and Print PDF (the server caches the cut; this keeps the answer per tab).
 *
 * A cut takes the server about 1.6 s per view on a large architect's floor
 * (scripts/perf/mutinybim/linked-background-switch.ts), so:
 *  - `useWarmViewBackgrounds` cuts every drawing view's background one at a
 *    time once the model is open, and opening a sheet reads them from this tab;
 *  - while a view's settings change (cut height, leaving small things out) it
 *    keeps drawing the background it had until the new cut arrives.
 */

export interface BackgroundNote {
  readonly referenceId: string
  readonly label: string
  readonly reason: string
  /** The linked model's levels could not be told apart from the view's: the person picks one, kept on the level for that link. */
  readonly levelChoice?: { readonly linkId: string; readonly level: string; readonly options: readonly string[] }
}

export type BackgroundState =
  | { readonly state: 'loading' }
  /** The view's settings changed: the previous background still draws while the new cut is made. */
  | { readonly state: 'updating'; readonly drawn: readonly string[] }
  | {
      readonly state: 'ready'
      readonly drawn: readonly string[]
      readonly notes: readonly BackgroundNote[]
      /** The linked models drew something under the view's previous settings and nothing under these. */
      readonly leftNothing: boolean
    }
  | { readonly state: 'error'; readonly message: string }

interface Answer {
  readonly references: readonly SheetReference[]
  readonly drawn: readonly string[]
  readonly notes: readonly BackgroundNote[]
}

function isLevelChoice(value: unknown): value is NonNullable<BackgroundNote['levelChoice']> {
  if (typeof value !== 'object' || value === null || !('linkId' in value) || !('level' in value) || !('options' in value)) return false
  return typeof value.linkId === 'string' && typeof value.level === 'string' && Array.isArray(value.options) && value.options.every((o: unknown) => typeof o === 'string')
}

function isNote(value: unknown): value is BackgroundNote {
  if (typeof value !== 'object' || value === null || !('referenceId' in value) || !('label' in value) || !('reason' in value)) return false
  return !('levelChoice' in value) || value.levelChoice === undefined || isLevelChoice(value.levelChoice)
}

type ViewBackgroundsPort = EditorDataHost['viewBackgrounds']

/** A host with no linked-model cuts draws no linked models under any view (it serves no linked models to cut). */
const NO_BACKGROUND: Answer = { references: [], drawn: [], notes: [] }

async function fetchBackgrounds(port: ViewBackgroundsPort, projectId: string, req: ViewBackgroundCut): Promise<Answer> {
  if (!port) return NO_BACKGROUND
  const res = await port.cut({ projectId, request: req })
  const body: unknown = await res.json()
  if (!res.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`
    throw new Error(message)
  }
  const backgrounds = typeof body === 'object' && body !== null && 'backgrounds' in body && Array.isArray(body.backgrounds) ? body.backgrounds : []
  const skipped = typeof body === 'object' && body !== null && 'skipped' in body && Array.isArray(body.skipped) ? body.skipped : []
  const references: SheetReference[] = []
  const drawn: string[] = []
  for (const b of backgrounds) {
    const plan: unknown = typeof b === 'object' && b !== null && 'plan' in b ? b.plan : null
    if (!isReferencePlan(plan)) continue
    references.push(sheetReferenceOf(plan))
    drawn.push(typeof b === 'object' && b !== null && 'label' in b ? String(b.label) : plan.id)
  }
  return { references, drawn, notes: skipped.filter(isNote) }
}

/** Line segments a background draws (0: nothing of the linked models shows). */
export function backgroundSegmentCount(references: readonly SheetReference[]): number {
  let n = 0
  for (const r of references) {
    for (const l of r.plan.layers) n += l.segments.length
    n += r.plan.labels.length
  }
  return n
}

/** Cut answers this tab holds, per project and cut, newest last; a cut is seconds of server work. */
const CACHE_MAX = 64
const cache = new Map<string, Promise<Answer>>()
const settled = new Map<string, Answer>()

function cacheKey(projectId: string, key: string): string {
  return `${projectId}|${key}`
}

/** The answer for one cut: from this tab when held or on its way, otherwise asked once. A failure is forgotten so the next look asks again. */
export function backgroundForFrom(port: ViewBackgroundsPort, projectId: string, req: ViewBackgroundCut, key = JSON.stringify(req)): Promise<Answer> {
  const k = cacheKey(projectId, key)
  const held = cache.get(k)
  if (held) {
    cache.delete(k)
    cache.set(k, held)
    return held
  }
  const asked = fetchBackgrounds(port, projectId, req).then(
    (answer) => {
      settled.set(k, answer)
      return answer
    },
    (err: unknown) => {
      cache.delete(k)
      settled.delete(k)
      throw err
    },
  )
  cache.set(k, asked)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
    settled.delete(oldest.value)
  }
  return asked
}

/** Forget every held cut (tests; a linked model's new version arrives as a new cut key anyway). */
export function clearViewBackgroundCache(): void {
  cache.clear()
  settled.clear()
}

const NO_LEVELS: readonly Level[] = []

type Slot = { readonly kind: 'ready'; readonly answer: Answer } | { readonly kind: 'error'; readonly message: string }

/** Backgrounds keyed by view id for `views`, and each view's loading state. */
/** `levels`: the model's levels, so a plan's cut carries the linked levels a person chose for its level. */
export function useViewBackgroundsFrom(
  port: ViewBackgroundsPort,
  projectId: string,
  views: readonly ViewElement[],
  levels: readonly Level[] = NO_LEVELS,
): { backgrounds: ViewBackgrounds; states: Readonly<Record<string, BackgroundState>> } {
  const keyed = useMemo(() => views.flatMap((v) => {
    const req = backgroundCutFor(v, levels)
    return req ? [{ viewId: v.id, req, key: JSON.stringify(req) }] : []
  }), [views, levels])
  const [slots, setSlots] = useState<Readonly<Record<string, Slot>>>(() => {
    const held: Record<string, Slot> = {}
    for (const { key } of keyed) {
      const answer = settled.get(cacheKey(projectId, key))
      if (answer) held[key] = { kind: 'ready', answer }
    }
    return held
  })
  /** The last cut each view drew, kept on screen while its next cut is made. */
  const shown = useRef(new Map<string, string>())

  useEffect(() => {
    let live = true
    for (const { req, key } of keyed) {
      if (slots[key] || settled.has(cacheKey(projectId, key))) continue
      backgroundForFrom(port, projectId, req, key)
        .then((answer) => {
          if (live) setSlots((prev) => (prev[key]?.kind === 'ready' ? prev : { ...prev, [key]: { kind: 'ready', answer } }))
        })
        .catch((err: unknown) => {
          console.error('[useViewBackgrounds] linked-model background failed', { projectId, req, err })
          if (live) setSlots((prev) => ({ ...prev, [key]: { kind: 'error', message: err instanceof Error ? err.message : 'The linked models could not be cut for this view.' } }))
        })
    }
    return () => {
      live = false
    }
  }, [keyed, port, projectId, slots])

  const result = useMemo(() => {
    const backgrounds: Record<string, readonly SheetReference[]> = {}
    const states: Record<string, BackgroundState> = {}
    const slotOf = (key: string): Slot | undefined => {
      const held = settled.get(cacheKey(projectId, key))
      return slots[key] ?? (held ? { kind: 'ready', answer: held } : undefined)
    }
    for (const { viewId, key } of keyed) {
      const slot = slotOf(key)
      const previousKey = shown.current.get(viewId)
      const previous = previousKey && previousKey !== key ? slotOf(previousKey) : undefined
      if (slot?.kind === 'ready') {
        backgrounds[viewId] = slot.answer.references
        const leftNothing = previous?.kind === 'ready' && backgroundSegmentCount(previous.answer.references) > 0 && backgroundSegmentCount(slot.answer.references) === 0
        states[viewId] = { state: 'ready', drawn: slot.answer.drawn, notes: slot.answer.notes, leftNothing }
      } else if (slot?.kind === 'error') {
        backgrounds[viewId] = previous?.kind === 'ready' ? previous.answer.references : []
        states[viewId] = { state: 'error', message: slot.message }
      } else if (previous?.kind === 'ready') {
        backgrounds[viewId] = previous.answer.references
        states[viewId] = { state: 'updating', drawn: previous.answer.drawn }
      } else {
        backgrounds[viewId] = []
        states[viewId] = { state: 'loading' }
      }
    }
    return { backgrounds, states }
  }, [keyed, slots, projectId])

  // Remember what each view drew, once its cut arrived; a later change keeps it on screen until the next one does.
  useEffect(() => {
    for (const { viewId, key } of keyed) if (slots[key]?.kind === 'ready' || settled.has(cacheKey(projectId, key))) shown.current.set(viewId, key)
  }, [keyed, slots, projectId])

  return result
}

/** Cuts warmed per project in this tab, so a re-render never queues them twice. */
const warming = new Set<string>()

/**
 * Cut every drawing view's linked background once the model is open, one at
 * a time, starting when the browser is idle: opening a sheet then draws its
 * plans from this tab instead of waiting on the server. Never blocks the view.
 */
export function useWarmViewBackgroundsFrom(port: ViewBackgroundsPort, projectId: string, views: readonly ViewElement[], enabled = true, levels: readonly Level[] = NO_LEVELS): void {
  const pending = useMemo(() => {
    const seen = new Set<string>()
    const out: { readonly req: ViewBackgroundCut; readonly key: string }[] = []
    for (const v of views) {
      const req = backgroundCutFor(v, levels)
      if (!req) continue
      const key = JSON.stringify(req)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ req, key })
    }
    return out
  }, [views, levels])

  useEffect(() => {
    if (!port || !enabled || pending.length === 0) return
    let stopped = false
    const run = async () => {
      for (const { req, key } of pending) {
        if (stopped) return
        const k = cacheKey(projectId, key)
        if (warming.has(k) || cache.has(k)) continue
        warming.add(k)
        try {
          await backgroundForFrom(port, projectId, req, key)
        } catch (err) {
          console.error('[useWarmViewBackgrounds] warming a linked-model background failed (it is cut again when the view opens)', { projectId, req, err })
        } finally {
          warming.delete(k)
        }
      }
    }
    const start = () => {
      run().catch((err: unknown) => console.error('[useWarmViewBackgrounds] warming stopped', { projectId, err }))
    }
    const idle = typeof window !== 'undefined' && 'requestIdleCallback' in window ? window.requestIdleCallback(start, { timeout: 3000 }) : null
    const timer = idle === null ? setTimeout(start, 500) : null
    return () => {
      stopped = true
      if (idle !== null) window.cancelIdleCallback(idle)
      if (timer !== null) clearTimeout(timer)
    }
  }, [enabled, pending, port, projectId])
}
