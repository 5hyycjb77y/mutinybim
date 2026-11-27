'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { definitionTypes, PART_CATEGORY_LABELS, partTypeDefinitionSchema, type PartTypeDefinition } from '@permitzip/bim-kernel'
import type { EditorDataAnswer, EditorDataHost, EditorHostCapabilities } from '@permitzip/bim-editor-host'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'
import { partItemSizes, type LibraryPartTypeEntry } from '../../contracts/bim/firm-part-versions'
import type { CatalogEntry } from '../model-session'
import { fetchLibraryPartTypesFrom, LibraryReadError } from './part-type-library'

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
  readonly itemsById?: ReadonlyMap<string, LibraryPartTypeEntry>
  readonly parts: readonly { readonly key?: string; readonly definition: PartTypeDefinition }[]
}

function parseLibrary(body: unknown): Loaded {
  if (typeof body !== 'object' || body === null) throw new Error('The firm library answered with nothing')
  const canWrite = Reflect.get(body, 'canWrite') === true
  const parts: unknown = Reflect.get(body, 'parts')
  if (!Array.isArray(parts)) throw new Error('The firm library answered without its parts')
  const definitions: { definition: PartTypeDefinition }[] = []
  for (const p of parts) {
    const parsed = partTypeDefinitionSchema.safeParse(typeof p === 'object' && p !== null ? Reflect.get(p, 'definition') : null)
    if (parsed.success) definitions.push({ definition: parsed.data })
    else console.error('[firm-library] a part did not parse; leaving it out', parsed.error.issues[0])
  }
  return { canWrite, parts: definitions }
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

async function readParts(port: NonNullable<EditorDataHost['firmLibrary']>): Promise<Loaded> {
  if (port.publishPartTypeAtRevision) {
    const { canPublish, partTypes } = await fetchLibraryPartTypesFrom(port)
    return { canWrite: canPublish, parts: partTypes, itemsById: new Map(partTypes.map(p => [p.id, p])) }
  }
  const res = await port.firmParts()
  if (!res.ok) throw new LibraryReadError(await errorText(res), res.status)
  return parseLibrary(await res.json())
}

export function useFirmPartLibraryFrom(port: EditorDataHost['firmLibrary'], wanted: boolean, capabilities?: EditorHostCapabilities | null) {
  const [status, setStatus] = useState<FirmLibraryStatus>({ state: 'idle' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const lastRequest = useRef(0)
  const fetchLibrary = useCallback(async (): Promise<string | null> => {
    const request = ++lastRequest.current
    if (!port) {
      console.info('[firm-library] this host has no firm library; Place part offers the built-in and model parts')
      setLoaded(null)
      setStatus({ state: 'none' })
      return null
    }
    try {
      const next = await readParts(port)
      if (request === lastRequest.current) {
        setLoaded(next)
        setStatus({ state: 'ready' })
      }
      return null
    } catch (err) {
      if (request !== lastRequest.current) return null
      setLoaded(null)
      if (err instanceof LibraryReadError && (err.status === 403 || err.status === 401)) {
        setStatus({ state: 'none' })
        return err.message
      }
      console.error('[firm-library] load failed', err)
      const message = err instanceof Error ? err.message : 'the library did not load'
      setStatus({ state: 'failed', message })
      return message
    }
  }, [port])
  const load = useCallback(async () => {
    setStatus({ state: 'loading' })
    await fetchLibrary()
  }, [fetchLibrary])

  const cancelPending = useCallback(() => {
    ++lastRequest.current
  }, [])

  useEffect(() => {
    if (wanted) void fetchLibrary()
    return cancelPending
  }, [wanted, fetchLibrary, cancelPending])

  const entries = useMemo((): CatalogEntry[] => {
    if (!loaded) return []
    const out: CatalogEntry[] = []
    for (const { key, definition } of loaded.parts) {
      try {
        const sizes = key === undefined ? definitionTypes(definition) : partItemSizes({ key, definition })
        for (const t of sizes) out.push({ typeId: t.typeId, definition: t.definition, inModel: false, library: 'firm', categoryLabel: PART_CATEGORY_LABELS[definition.category] })
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
      return fetchLibrary()
    },
    [port, capabilities, fetchLibrary],
  )

  // Wanted but not answered yet reads as loading.
  const shown: FirmLibraryStatus = status.state === 'idle' && wanted ? { state: 'loading' } : status
  const afterPublish = port?.publishPartTypeAtRevision ? fetchLibrary : save
  return { status: shown, entries, canWrite: loaded?.canWrite ?? false, itemsById: loaded?.itemsById, save, afterPublish, retry: load }
}
