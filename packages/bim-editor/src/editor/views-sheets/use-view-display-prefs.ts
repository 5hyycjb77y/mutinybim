'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ViewElement } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import type { ViewDisplay } from './ViewPropertiesPanel'

/**
 * Whether each view opens on the live model or its printed drawing, for the
 * signed-in person: loaded once per project from the database and saved there
 * each time they pick, so it follows them across reloads and machines.
 */

export interface ViewDisplayPrefs {
  /** False until the saved choices have arrived (or failed to). */
  readonly loaded: boolean
  /** What a view opens on: the person's saved choice, else sections on their drawing and the rest on the live model. */
  readonly displayFor: (view: Pick<ViewElement, 'id' | 'viewType'>) => ViewDisplay
  /** Remember the person's pick for a view (saved in the background; a failure says so). */
  readonly remember: (viewId: string, display: ViewDisplay) => void
}

/**
 * What a view opens on the moment it is made: plans and ceiling plans as the
 * printed drawing (what goes on the sheet), the rest on the live model. The
 * person's later pick is remembered as usual.
 */
export function newViewDisplay(viewType: ViewElement['viewType']): ViewDisplay {
  return viewType === 'floor_plan' || viewType === 'ceiling_plan' || viewType === 'section' ? 'drawing' : 'model'
}

function isDisplays(value: unknown): value is { displays: Record<string, ViewDisplay> } {
  if (typeof value !== 'object' || value === null || !('displays' in value)) return false
  const displays: unknown = value.displays
  return typeof displays === 'object' && displays !== null && Object.values(displays).every((d) => d === 'model' || d === 'drawing')
}

type ViewPrefsPort = EditorDataHost['viewPrefs']

export function useViewDisplayPrefsFrom(port: ViewPrefsPort, projectId: string): ViewDisplayPrefs {
  const [saved, setSaved] = useState<Readonly<Record<string, ViewDisplay>>>({})
  const [loaded, setLoaded] = useState(false)
  /** Picks made before the saved choices arrived win over what arrives. */
  const picked = useRef(new Set<string>())
  const warned = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    if (!port) {
      setLoaded(true)
      return () => controller.abort()
    }
    port
      .displays({ projectId }, { signal: controller.signal })
      .then(async (res) => {
        const body: unknown = await res.json()
        if (!res.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`)
        if (!isDisplays(body)) throw new Error('The saved view choices came back in an unexpected shape.')
        setSaved((prev) => {
          const next: Record<string, ViewDisplay> = { ...body.displays }
          for (const id of picked.current) {
            const mine = prev[id]
            if (mine) next[id] = mine
          }
          return next
        })
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[useViewDisplayPrefs] loading saved view choices failed', { projectId, err })
        toast.error("Your saved choice of live model or printed drawing for each view couldn't be loaded. Views open on the live model until you reload.")
        setLoaded(true)
      })
    return () => controller.abort()
  }, [port, projectId])

  const displayFor = useCallback<ViewDisplayPrefs['displayFor']>((view) => saved[view.id] ?? (view.viewType === 'section' ? 'drawing' : 'model'), [saved])

  const remember = useCallback<ViewDisplayPrefs['remember']>(
    (viewId, display) => {
      picked.current.add(viewId)
      setSaved((prev) => (prev[viewId] === display ? prev : { ...prev, [viewId]: display }))
      if (!port) {
        if (warned.current) return
        warned.current = true
        toast.info(unavailableWords('Remembering whether each view opens on the live model or its printed drawing'))
        return
      }
      port
        .saveDisplay({ projectId, viewId, display })
        .then(async (res) => {
          if (res.ok) return
          const body: unknown = await res.json().catch((err: unknown) => {
            console.error('[useViewDisplayPrefs] reading the refusal failed', err)
            return null
          })
          throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${res.status}`)
        })
        .catch((err: unknown) => {
          console.error('[useViewDisplayPrefs] saving the view choice failed', { projectId, viewId, display, err })
          toast.error(`This view shows the ${display === 'drawing' ? 'printed drawing' : 'live model'} now, but that choice couldn't be saved for next time.`)
        })
    },
    [port, projectId],
  )

  return useMemo(() => ({ loaded, displayFor, remember }), [loaded, displayFor, remember])
}
