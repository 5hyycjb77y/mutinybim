'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RouteDefaultDomain, RouteDefaults, RouteDefaultsRead } from '../contracts/building-model/route-defaults'
import type { EditorDataAnswer, EditorDataHost } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

export type RouteDefaultsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly RouteDefaultsRead[] }
  | { readonly status: 'error'; readonly message: string }

export interface RouteDefaultsApi {
  readonly state: RouteDefaultsState
  /** Save (or, with null, forget) one scope; resolves to the reason it failed, or null. */
  save(domain: RouteDefaultDomain, scope: 'project' | 'all', settings: RouteDefaults | null): Promise<string | null>
}

function isReads(v: unknown): v is { defaults: RouteDefaultsRead[] } {
  return typeof v === 'object' && v !== null && 'defaults' in v && Array.isArray(v.defaults)
}

async function errorText(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[useRouteDefaults] error body unreadable', err)
    return null
  })
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `The server answered ${res.status}`
}

/**
 * A person's saved Route defaults on this project (from the database, so they
 * follow the person to any tab or machine). `onLoaded` runs once with what
 * applies, so the Route panel opens on them.
 */
const SAVED_DEFAULTS = 'Saved route defaults'

export function useRouteDefaultsFrom(port: EditorDataHost['routeDefaults'], projectId: string, onLoaded: (rows: readonly RouteDefaultsRead[]) => void): RouteDefaultsApi {
  const capabilities = useOptionalEditorHost()?.capabilities ?? null
  const [state, setState] = useState<RouteDefaultsState>({ status: 'loading' })
  const loaded = useRef(onLoaded)
  loaded.current = onLoaded
  useEffect(() => {
    if (!port) return
    let live = true
    port
      .read({ projectId })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorText(res))
        const body: unknown = await res.json()
        if (!isReads(body)) throw new Error('The saved route defaults came back in a shape this page does not read')
        if (!live) return
        setState({ status: 'ready', rows: body.defaults })
        loaded.current(body.defaults)
      })
      .catch((err: unknown) => {
        console.error('[useRouteDefaults] load failed', { projectId, err })
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [port, projectId])

  const save = useCallback(
    async (domain: RouteDefaultDomain, scope: 'project' | 'all', settings: RouteDefaults | null): Promise<string | null> => {
      if (!port) return unavailableWords(SAVED_DEFAULTS, capabilities)
      try {
        const res = await port.save({ projectId, domain, scope, settings })
        if (!res.ok) return await errorText(res)
        const body: unknown = await res.json()
        if (!isReads(body)) return 'Saved, but the answer came back in a shape this page does not read; reload to see it'
        setState({ status: 'ready', rows: body.defaults })
        return null
      } catch (err) {
        console.error('[useRouteDefaults] save failed', { projectId, domain, scope, err })
        return err instanceof Error ? err.message : String(err)
      }
    },
    [port, capabilities, projectId],
  )
  return { state: port ? state : { status: 'error', message: unavailableWords(SAVED_DEFAULTS, capabilities) }, save }
}
