'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { clampLayoutWidth, type LayoutSurfacePrefs } from '../../contracts/building-model/layout-prefs'

/**
 * How this person left the Building Model's sidebars (collapsed sections, rail
 * width), read once from the database when the surface opens and saved back a
 * moment after each change. Never browser storage: the layout follows the
 * person to every computer (round 15, DECISIONS 8).
 */

export type LayoutLoadStatus = 'loading' | 'ready' | 'error'

interface LayoutPrefsValue {
  readonly status: LayoutLoadStatus
  /** Why the saved layout could not be read (the default layout is showing). */
  readonly loadError: string | null
  /** Why the last change could not be saved (it stays for this visit). */
  readonly saveError: string | null
  isCollapsed(surface: string, sectionId: string, defaultCollapsed: boolean): boolean
  setCollapsed(surface: string, sectionId: string, collapsed: boolean): void
  width(surface: string): number | null
  setWidth(surface: string, px: number): void
  retryLoad(): void
}

const LayoutPrefsContext = createContext<LayoutPrefsValue | null>(null)

/** How long after the last change the layout is saved (a drag of the rail edge is one save). */
export const LAYOUT_SAVE_DELAY_MS = 600

type Surfaces = Readonly<Record<string, LayoutSurfacePrefs>>

function isSurfacePrefs(value: unknown): value is LayoutSurfacePrefs {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.surface === 'string' && typeof v.collapsed === 'object' && v.collapsed !== null && (v.widthPx === null || typeof v.widthPx === 'number')
}

async function responseError(res: EditorDataAnswer, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[LayoutPrefs] error body was not JSON', err)
    return null
  })
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error
  return `${fallback} (${res.status})`
}

export function LayoutPrefsProviderFrom({ port, children }: { port: EditorDataHost['layoutPrefs']; children: ReactNode }) {
  const [surfaces, setSurfaces] = useState<Surfaces>({})
  const [status, setStatus] = useState<LayoutLoadStatus>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  // Surfaces the person changed before the saved layout arrived: their change wins over the loaded one.
  const touched = useRef(new Set<string>())
  const latest = useRef<Surfaces>({})
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    if (!port) return
    const controller = new AbortController()
    port
      .read({ signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseError(res, "Couldn't read your saved layout"))
        const body: unknown = await res.json()
        const rows = body && typeof body === 'object' && 'surfaces' in body && Array.isArray(body.surfaces) ? body.surfaces.filter(isSurfacePrefs) : []
        setSurfaces((current) => {
          const next: Record<string, LayoutSurfacePrefs> = {}
          for (const row of rows) next[row.surface] = row
          for (const key of touched.current) if (current[key]) next[key] = current[key]
          latest.current = next
          return next
        })
        setLoadError(null)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[LayoutPrefs] loading the saved layout failed; showing the default layout', err)
        setLoadError(err instanceof Error ? err.message : "Couldn't read your saved layout")
        setStatus('error')
      })
    return () => controller.abort()
  }, [port, loadAttempt])

  const send = useCallback((surface: string, keepalive: boolean) => {
    const prefs = latest.current[surface]
    if (!prefs || !port) return
    port
      .save({ surface, collapsed: prefs.collapsed, widthPx: prefs.widthPx }, { keepalive })
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseError(res, "Couldn't save your layout"))
        setSaveError(null)
      })
      .catch((err: unknown) => {
        console.error('[LayoutPrefs] saving the layout failed', { surface, err })
        const message = err instanceof Error ? err.message : "Couldn't save your layout"
        setSaveError(message)
        toast.error("Your layout wasn't saved", { id: 'bim-layout-save', description: `${message}. It stays this way until you reload; the next change tries again.` })
      })
  }, [port])

  // Leaving the model a moment after a change still saves it.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const [surface, timer] of pending) {
        clearTimeout(timer)
        send(surface, true)
      }
      pending.clear()
    }
  }, [send])

  const save = useCallback(
    (surface: string) => {
      const existing = timers.current.get(surface)
      if (existing) clearTimeout(existing)
      timers.current.set(
        surface,
        setTimeout(() => {
          timers.current.delete(surface)
          send(surface, false)
        }, LAYOUT_SAVE_DELAY_MS),
      )
    },
    [send],
  )

  const update = useCallback(
    (surface: string, change: (prev: LayoutSurfacePrefs) => LayoutSurfacePrefs) => {
      touched.current.add(surface)
      setSurfaces((current) => {
        const prev = current[surface] ?? { surface, collapsed: {}, widthPx: null }
        const next = { ...current, [surface]: change(prev) }
        latest.current = next
        return next
      })
      save(surface)
    },
    [save],
  )

  const missing = port ? null : unavailableWords('Saving your layout')
  const value = useMemo<LayoutPrefsValue>(
    () => ({
      status: missing ? 'error' : status,
      loadError: missing ?? loadError,
      saveError,
      isCollapsed: (surface, sectionId, defaultCollapsed) => surfaces[surface]?.collapsed[sectionId] ?? defaultCollapsed,
      setCollapsed: (surface, sectionId, collapsed) => update(surface, (prev) => ({ ...prev, collapsed: { ...prev.collapsed, [sectionId]: collapsed } })),
      width: (surface) => surfaces[surface]?.widthPx ?? null,
      setWidth: (surface, px) => update(surface, (prev) => ({ ...prev, widthPx: clampLayoutWidth(px) })),
      retryLoad: () => {
        setStatus('loading')
        setLoadAttempt((n) => n + 1)
      },
    }),
    [missing, status, loadError, saveError, surfaces, update],
  )

  return <LayoutPrefsContext.Provider value={value}>{children}</LayoutPrefsContext.Provider>
}

/** Outside a provider (a test, a host that has none) sections keep their defaults and nothing is saved. */
const NO_PREFS: LayoutPrefsValue = {
  status: 'ready',
  loadError: null,
  saveError: null,
  isCollapsed: (_surface, _id, defaultCollapsed) => defaultCollapsed,
  setCollapsed: () => undefined,
  width: () => null,
  setWidth: () => undefined,
  retryLoad: () => undefined,
}

export function useLayoutPrefs(): LayoutPrefsValue {
  return useContext(LayoutPrefsContext) ?? NO_PREFS
}
