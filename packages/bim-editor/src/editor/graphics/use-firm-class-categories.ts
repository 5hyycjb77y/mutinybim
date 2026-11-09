'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ExtraClass } from '@permitzip/bim-kernel'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { useOptionalEditorHost } from '@permitzip/bim-editor/host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

/**
 * The firm's own object classes (Settings › MutinyBIM library), so
 * Visibility/Graphics lists a class such as "Fire alarm device" the moment
 * the firm adds it, with no code change. Read on the person's own session;
 * RLS on the library decides what they may see.
 */
export type FirmClassesState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly classes: readonly ExtraClass[] }
  | { readonly state: 'error'; readonly message: string }

interface Summary {
  readonly key: string
  readonly name: string
  readonly deprecated?: boolean
}

function isSummary(v: unknown): v is Summary {
  return typeof v === 'object' && v !== null && 'key' in v && typeof v.key === 'string' && 'name' in v && typeof v.name === 'string'
}

function summariesOf(body: unknown): Summary[] | null {
  if (typeof body !== 'object' || body === null || !('items' in body) || !Array.isArray(body.items)) return null
  return body.items.filter(isSummary)
}

function errorOf(body: unknown): string | null {
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : null
}

export function useFirmClassCategoriesFrom(port: EditorDataHost['firmLibrary']): FirmClassesState & { readonly retry: () => void } {
  const capabilities = useOptionalEditorHost()?.capabilities ?? null
  const [state, setState] = useState<FirmClassesState>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!port) return
    let live = true
    port
      .listOfType({ scope: 'firm', type: 'class' })
      .then(async (res) => {
        const body: unknown = await res.json().catch((err: unknown) => {
          console.error('[useFirmClassCategories] library response was not JSON', err)
          return null
        })
        if (!res.ok) throw new Error(errorOf(body) ?? `the library answered ${res.status}`)
        const items = summariesOf(body)
        if (!items) throw new Error('the library sent a list it could not read')
        return items.filter((i) => !i.deprecated).map((i): ExtraClass => ({ id: i.key, label: i.name }))
      })
      .then((classes) => {
        if (live) setState({ state: 'ready', classes })
      })
      .catch((err: unknown) => {
        console.error('[useFirmClassCategories] loading the firm classes failed', err)
        if (live) setState({ state: 'error', message: err instanceof Error ? err.message : 'the request failed' })
      })
    return () => {
      live = false
    }
  }, [port, attempt])
  const retry = useCallback(() => {
    setState({ state: 'loading' })
    setAttempt((n) => n + 1)
  }, [])
  if (!port) return { state: 'error', message: unavailableWords("The firm's own object classes", capabilities), retry }
  return { ...state, retry }
}
