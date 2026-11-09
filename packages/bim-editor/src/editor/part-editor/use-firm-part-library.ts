'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { definitionTypes, PART_CATEGORY_LABELS, partTypeDefinitionSchema, type PartTypeDefinition } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost, EditorHostCapabilities } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import type { CatalogEntry } from '../model-session'

/**
 * The firm part library for the Building Model: every size of every firm part
 * as a Place part entry, and a save the part editor calls. Loaded through the
 * editor host's firm library when first wanted; a person without the library
 * permission (or a host with no firm library) simply has no firm library
 * (status "none"), everything else that goes wrong is shown with a retry.
 */

const FIRM_PART_LIBRARY = 'The firm part library'

export type FirmLibraryStatus = { state: 'idle' | 'loading' | 'ready' | 'none' } | { state: 'failed'; message: string }

interface Loaded {
  readonly canWrite: boolean
  readonly definitions: readonly PartTypeDefinition[]
}

function parseLibrary(body: unknown): Loaded {
  if (typeof body !== 'object' || body === null) throw new Error('The firm library answered with nothing')
  const canWrite = Reflect.get(body, 'canWrite') === true
  const parts: unknown = Reflect.get(body, 'parts')
  if (!Array.isArray(parts)) throw new Error('The firm library answered without its parts')
  const definitions: PartTypeDefinition[] = []
  for (const p of parts) {
    const parsed = partTypeDefinitionSchema.safeParse(typeof p === 'object' && p !== null ? Reflect.get(p, 'definition') : null)
    if (parsed.success) definitions.push(parsed.data)
    else console.error('[firm-library] a part did not parse; leaving it out', parsed.error.issues[0])
  }
  return { canWrite, definitions }
}

async function errorText(res: EditorDataAnswer): Promise<string> {
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[firm-library] error body unreadable', err)
    return null
  })
  const message = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null
  return typeof message === 'string' ? message : `HTTP ${res.status}`
}

export function useFirmPartLibrary(wanted: boolean) {
  const host = useEditorHost()
  return useFirmPartLibraryFrom(host.data.firmLibrary, wanted, host.capabilities)
}

export function useFirmPartLibraryFrom(port: EditorDataHost['firmLibrary'], wanted: boolean, capabilities?: EditorHostCapabilities | null) {
  const [status, setStatus] = useState<FirmLibraryStatus>({ state: 'idle' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  // State changes only after the request answers, so the first load can run from an effect.
  const fetchLibrary = useCallback(async () => {
    if (!port) {
      console.info('[firm-library] this host has no firm library; Place part offers the built-in and model parts')
      setLoaded(null)
      setStatus({ state: 'none' })
      return
    }
    try {
      const res = await port.firmParts()
      if (res.status === 403 || res.status === 401) {
        setLoaded(null)
        setStatus({ state: 'none' })
        return
      }
      if (!res.ok) throw new Error(await errorText(res))
      setLoaded(parseLibrary(await res.json()))
      setStatus({ state: 'ready' })
    } catch (err) {
      console.error('[firm-library] load failed', err)
      setStatus({ state: 'failed', message: err instanceof Error ? err.message : 'the library did not load' })
    }
  }, [port])
  const load = useCallback(async () => {
    setStatus({ state: 'loading' })
    await fetchLibrary()
  }, [fetchLibrary])

  const started = useRef(false)
  useEffect(() => {
    if (!wanted || started.current) return
    started.current = true
    void fetchLibrary()
  }, [wanted, fetchLibrary])

  const entries = useMemo((): CatalogEntry[] => {
    if (!loaded) return []
    const out: CatalogEntry[] = []
    for (const def of loaded.definitions) {
      try {
        for (const t of definitionTypes(def)) out.push({ typeId: t.typeId, definition: t.definition, inModel: false, library: 'firm', categoryLabel: PART_CATEGORY_LABELS[def.category] })
      } catch (err) {
        console.error('[firm-library] sizes could not be listed', err)
      }
    }
    return out
  }, [loaded])

  const save = useCallback(
    async (definition: PartTypeDefinition): Promise<string | null> => {
      if (!port) return `Not saved to the firm library: ${unavailableWords(FIRM_PART_LIBRARY, capabilities)}`
      const res = await port.importPartType({ definition })
      if (!res.ok) return `Not saved to the firm library: ${await errorText(res)}`
      await load()
      return null
    },
    [port, capabilities, load],
  )

  // Wanted but not answered yet reads as loading.
  const shown: FirmLibraryStatus = status.state === 'idle' && wanted ? { state: 'loading' } : status
  return { status: shown, entries, canWrite: loaded?.canWrite ?? false, save, retry: load }
}
